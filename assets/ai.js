/* The text helper behind the Standardize button.
 *
 * One job: take what you typed and hand back a better-written version of the
 * same thing. Everything about talking to a model lives here, so ui.js owns
 * the button and knows nothing about who improves the text.
 *
 * Two engines, because the first question anyone asks is what it costs.
 * Gemini is the default: Google AI Studio issues a key with no card and a
 * free tier, so the button costs nothing to run. Anthropic writes better and
 * needs purchased credit. Both are reached the same way, and the button, the
 * Undo and the em dash rule never learn which one answered.
 *
 * Why raw fetch and not an SDK: this repository has no bundler for its
 * JavaScript. Every file is a plain <script src>, and build_standalone inlines
 * those same files into one HTML page. Adding a build step for two requests
 * would be a larger change than the feature.
 *
 * Keys live in localStorage, which is the honest position for a static site:
 * there is no server here to hold a secret. They are filed under KEYS.settings
 * rather than KEYS.data on purpose, so they never travel inside a backup file.
 */
(() => {
  /**
   * The instruction, written as asked for.
   *
   * The last line is not decoration. A model told to improve text will often
   * hand back "Here is the improved version:" and a rewrite in quotes, and
   * that whole string would land in the field. The dash rule is repeated in
   * TrackerUI.tidyDashes, which strips them afterwards regardless - the
   * prompt is the request, the regex is the guarantee.
   */
  const SYSTEM = [
    "Improve the tone of the text the user gives you. Fix the grammar, retain",
    "the message, and make it clear and easy to understand. If you think there",
    "is something lacking or a gap in the message, fill that gap.",
    "",
    "Never use an em dash or an en dash. Write plainly, in the register of a",
    "work note written by the person who typed it. Do not make it longer than",
    "it needs to be, and do not invent specifics such as names, dates, systems",
    "or numbers that the text does not already imply.",
    "",
    "Reply with the improved text and nothing else. No preamble, no quotes",
    "around it, no explanation of what you changed.",
  ].join("\n");

  /** A task title is a label, so it stays a label rather than becoming prose. */
  const KIND_HINT = {
    title: "This is a short task title. Keep it to one line, under about ten words.",
    description: "This is a task description. A short paragraph is right.",
  };

  const prompt = (kind) => SYSTEM + "\n\n" + (KIND_HINT[kind] || KIND_HINT.description);
  const get = (k) => window.TrackerStore.getText(k);

  /**
   * Turn an HTTP status into something worth reading.
   *
   * "Request failed" tells you nothing about which of these it was, and each
   * one has a different fix. `detail` is the provider's own message, which is
   * usually the most useful thing on a 400.
   */
  function explain(status, detail, who) {
    if (status === 401 || status === 403) return `That ${who} key was refused. Check it in Settings.`;
    if (status === 400) return detail ? "The request was rejected: " + detail : "The request was rejected.";
    if (status === 404) return detail ? "Not found: " + detail : "That model was not found. Pick another in Settings.";
    if (status === 429) return "Rate limited, or the free quota is used up for now. Try again shortly.";
    if (status === 402) return "There is a billing problem on the account.";
    if (status >= 500) return `${who} had a problem. Try again shortly.`;
    return `That did not work (HTTP ${status}).`;
  }

  /** fetch that reports a dead network as a sentence rather than a TypeError. */
  async function send(url, init, who) {
    try {
      return await fetch(url, init);
    } catch {
      // fetch only rejects on a network-level failure, never on a 4xx.
      throw new Error(`Could not reach ${who}. Check your connection.`);
    }
  }

  /** Rough cost and speed order, by name. Unknown names sort in the middle. */
  const rank = (m) =>
    /flash-lite/.test(m) ? 0 : /flash/.test(m) ? 1 : /pro/.test(m) ? 3 : 2;

  /* ---------------------------------------------------------------- Gemini */
  const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
  // Used only until the picker is filled from the account itself. Model names
  // churn, so this file does not pretend to know the current best one:
  // listModels asks, and a name baked in here would be wrong within months.
  const GEMINI_FALLBACK_MODEL = "gemini-2.0-flash";

  const gemini = {
    id: "gemini",
    label: "Google Gemini (free tier)",
    keySetting: "tracker.geminiKey",
    modelSetting: "tracker.geminiModel",
    keyHelp: "aistudio.google.com → Get API key. No card needed.",
    free: true,
    key: () => get("tracker.geminiKey"),
    model: () => get("tracker.geminiModel") || GEMINI_FALLBACK_MODEL,

    /** The models this key can actually use, asked of the account. */
    async listModels(key) {
      if (!key) return [];
      const res = await send(`${GEMINI_BASE}/models?key=${encodeURIComponent(key)}`,
                             { method: "GET" }, "Google");
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(explain(res.status, body && body.error && body.error.message, "Google"));
      return ((body && body.models) || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => String(m.name || "").replace(/^models\//, ""))
        .filter(Boolean)
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    },

    async run(text, kind) {
      const key = gemini.key();
      if (!key) throw new Error("Add a Google AI Studio key in Settings to use this.");
      const res = await send(
        `${GEMINI_BASE}/models/${encodeURIComponent(gemini.model())}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: prompt(kind) }] },
            contents: [{ role: "user", parts: [{ text }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
          }),
        }, "Google");

      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(explain(res.status, body && body.error && body.error.message, "Google"));

      // A blocked prompt comes back as a 200 with no candidate, so the reply
      // is read rather than assumed.
      const cand = body && body.candidates && body.candidates[0];
      if (!cand) {
        const why = body && body.promptFeedback && body.promptFeedback.blockReason;
        throw new Error(why ? `Gemini declined that (${why}).`
                            : "Nothing came back. Your text is unchanged.");
      }
      return ((cand.content && cand.content.parts) || [])
        .map((p) => p.text || "").join("").trim();
    },
  };

  /* ------------------------------------------------------------- Anthropic */
  const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
  const ANTHROPIC_MODELS = ["claude-haiku-4-5", "claude-opus-5"];

  /**
   * Which models take output_config.effort.
   *
   * Not cosmetic. Haiku 4.5 REJECTS effort with a 400, so sending it to every
   * model turns a model switch into a broken button. Opus 5 accepts it, and
   * "low" is right here: a one paragraph rewrite needs no deliberation.
   */
  const TAKES_EFFORT = (model) => /^claude-(opus|sonnet)-5/.test(model);

  const anthropic = {
    id: "anthropic",
    label: "Anthropic Claude (paid credit)",
    keySetting: "tracker.aiKey",
    modelSetting: "tracker.aiModel",
    keyHelp: "console.anthropic.com → API keys. Needs credit on the account.",
    free: false,
    key: () => get("tracker.aiKey"),
    model: () => get("tracker.aiModel") || ANTHROPIC_MODELS[0],
    listModels: async () => ANTHROPIC_MODELS.slice(),

    async run(text, kind) {
      const key = anthropic.key();
      if (!key) throw new Error("Add an Anthropic API key in Settings to use this.");
      const model = anthropic.model();
      const res = await send(ANTHROPIC_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          // Without this the browser call is refused before it reaches the API.
          "anthropic-dangerous-direct-browser-access": "true",
          "x-api-key": key,
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          ...(TAKES_EFFORT(model) ? { output_config: { effort: "low" } } : {}),
          system: prompt(kind),
          messages: [{ role: "user", content: text }],
        }),
      }, "Anthropic");

      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(explain(res.status, body && body.error && body.error.message, "Anthropic"));
      if (body && body.stop_reason === "refusal") throw new Error("The model declined to rewrite that.");
      return (Array.isArray(body && body.content) ? body.content : [])
        .filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    },
  };

  /* -------------------------------------------------------------- dispatch */
  const PROVIDERS = [gemini, anthropic];
  const DEFAULT_ENGINE = gemini.id;

  const byId = (id) => PROVIDERS.find((p) => p.id === id);
  /** The chosen engine, falling back to the default if the setting is stale. */
  const engine = () => byId(get("tracker.aiEngine")) || byId(DEFAULT_ENGINE);
  const hasKey = () => PROVIDERS.some((p) => p.key());

  /**
   * Improve `text`. Resolves with the new text, or throws with a readable
   * reason - ui.js shows the message and leaves what you typed alone.
   *
   * If the chosen engine has no key but the other one does, the other one
   * runs rather than refusing. Someone who set up one engine and then changed
   * the default should get a working button, not a lecture.
   */
  async function standardize(text, { kind = "description" } = {}) {
    const chosen = engine();
    const provider = chosen.key() ? chosen : PROVIDERS.find((p) => p.key());
    if (!provider) {
      throw new Error("Add a key in Settings to use this. Google AI Studio is free.");
    }
    return provider.run(text, kind);
  }

  window.TrackerAI = {
    standardize, hasKey, engine, PROVIDERS, DEFAULT_ENGINE, TAKES_EFFORT,
    // Kept so anything asking what Anthropic would be sent still gets it.
    MODELS: ANTHROPIC_MODELS, DEFAULT_MODEL: ANTHROPIC_MODELS[0],
  };
})();
