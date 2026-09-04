/* The text helper behind the Standardize button.
 *
 * One job: take what you typed and hand back a better-written version of the
 * same thing. Everything about talking to a model lives here, so ui.js owns
 * the button and knows nothing about who improves the text.
 *
 * Two engines, both free to run: Google Gemini, whose AI Studio key needs no
 * card, and OpenRouter, whose ":free" models cost nothing per token. Anthropic
 * was here and was removed once a free path worked; it needed purchased credit
 * and credit expires a year after purchase.
 *
 * PROVIDERS is a list, and nothing outside it counts the entries. An engine is
 * a new entry declaring the same members - key, model, listModels, run, plus
 * a wire naming its reply shape and optionally its own classify. The Settings
 * dialog and the guard both enumerate this list at runtime, so a third engine
 * is one entry here and no edit anywhere else.
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

  /**
   * What a model is for, and which side of the bill it usually falls on.
   *
   * Google's ListModels reports name, description, supported methods and token
   * limits - and nothing at all about billing. So the tier here is this app's
   * own labelling by name, not a fact read from the account, and the dialog
   * says so. The rules are ordered most specific first, and anything that
   * matches nothing falls through to free text rather than vanishing: a stale
   * rule should put a model in the wrong group, never out of reach.
   */
  const PURPOSE_ORDER = ["text", "image", "speech", "music", "research", "special"];
  const PURPOSE_LABEL = {
    text: "Text generation",
    image: "Image generation",
    speech: "Speech and audio",
    music: "Music",
    research: "Research",
    special: "Specialised",
  };

  function classify(name) {
    const m = String(name || "").toLowerCase();
    const purpose =
      /(^|-)tts|transcribe|speech|audio/.test(m) ? "speech" :
      /lyria/.test(m)                           ? "music"  :
      /image|nano-banana|imagen/.test(m)        ? "image"  :
      /deep-research/.test(m)                   ? "research" :
      /computer-use|robotics|customtools|embedding/.test(m) ? "special" :
      "text";
    const paid =
      /deep-research|lyria|computer-use|robotics|nano-banana-pro|pro-image/.test(m);
    return { tier: paid ? "paid" : "free", purpose };
  }

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
    // The shape its replies come back in. The guard reads this rather than
    // matching on the id, so a third engine cannot be tested by accident
    // against another engine's response body.
    wire: "gemini",
    classify,
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

  /* ------------------------------------------------------------ OpenRouter */
  /*
   * The second engine, and the reason the Engine picker is a picker again.
   *
   * OpenRouter issues a key with no card, and the models whose id ends ":free"
   * cost nothing per token. Unlike Google it publishes its prices in the same
   * listing as the models, so its free-and-paid split is read from the account
   * rather than guessed from the name - which is why it carries its own
   * classify rather than borrowing Gemini's.
   *
   * Not verified: no call has been made to this host from the build
   * environment, which cannot reach it (the proxy answers 403 to CONNECT). Its
   * documented support for browser calls is the basis for it being here. The
   * first real proof is a key pasted into Settings.
   */
  const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
  const OPENROUTER_FALLBACK_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

  /* What the last listing said about each model, so classify can answer from
   * the account's own prices instead of the name. Empty until a list is read;
   * an id that is not in it is treated as paid, because guessing "free" about
   * something unknown is the guess that costs money. */
  const orMeta = new Map();

  function orClassify(name) {
    const id = String(name || "");
    const m = id.toLowerCase();
    const meta = orMeta.get(id);
    const purpose =
      /(^|[-\/])tts|whisper|audio|speech/.test(m) ? "speech" :
      /(^|[-\/])(sd|flux|dall-e|imagen|stable-diffusion)|image/.test(m) ? "image" :
      /deep-research|(^|[-\/])research/.test(m) ? "research" :
      /embed|rerank|moderation|guard/.test(m) ? "special" :
      "text";
    const free = meta ? meta.free : /:free$/.test(m);
    return { tier: free ? "free" : "paid", purpose };
  }

  const openrouter = {
    id: "openrouter",
    label: "OpenRouter (free models)",
    keySetting: "tracker.openrouterKey",
    modelSetting: "tracker.openrouterModel",
    keyHelp: "openrouter.ai/keys → Create key. No card needed.",
    free: true,
    wire: "openai",
    classify: orClassify,
    key: () => get("tracker.openrouterKey"),
    model: () => get("tracker.openrouterModel") || OPENROUTER_FALLBACK_MODEL,

    /** Every model the catalogue offers, with its price remembered. */
    async listModels(key) {
      if (!key) return [];
      const res = await send(`${OPENROUTER_BASE}/models`, {
        method: "GET",
        headers: { authorization: "Bearer " + key },
      }, "OpenRouter");
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(explain(res.status, body && body.error && body.error.message, "OpenRouter"));
      const rows = (body && body.data) || [];
      orMeta.clear();
      const zero = (v) => v === 0 || v === "0" || Number(v) === 0;
      for (const r of rows) {
        const id = String(r && r.id || "");
        if (!id) continue;
        const pr = (r && r.pricing) || {};
        orMeta.set(id, { free: zero(pr.prompt) && zero(pr.completion) });
      }
      // Free first, then by name: the same intent as Gemini's rank, expressed
      // with the fact rather than with a guess about it.
      return [...orMeta.keys()].sort((a, b) =>
        (orMeta.get(a).free === orMeta.get(b).free ? 0 : orMeta.get(a).free ? -1 : 1) ||
        a.localeCompare(b));
    },

    async run(text, kind) {
      const key = openrouter.key();
      if (!key) throw new Error("Add an OpenRouter key in Settings to use this.");
      const res = await send(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + key,
          // The browser sets Referer itself and will not let a page forge it,
          // so only the title is sent by hand.
          "x-title": "Project Tracker",
        },
        body: JSON.stringify({
          model: openrouter.model(),
          messages: [
            { role: "system", content: prompt(kind) },
            { role: "user", content: text },
          ],
          temperature: 0.3,
          max_tokens: 2000,
        }),
      }, "OpenRouter");

      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(explain(res.status, body && body.error && body.error.message, "OpenRouter"));
      const choice = body && body.choices && body.choices[0];
      const out = choice && choice.message && choice.message.content;
      if (!out) throw new Error("Nothing came back. Your text is unchanged.");
      return String(out).trim();
    },
  };

  /**
   * Move a Google key out of the slot the removed engine used.
   *
   * A build served from a stale cache saved keys under tracker.aiKey, because
   * that was the only engine the code of the day knew about. Anyone who pasted
   * an AI Studio key during that window has it filed where nothing reads it,
   * and the button would say "add a key" while a perfectly good key sat in
   * storage. Moved once, and only when it is unmistakably a Google key and the
   * Gemini slot is empty, so nothing can be overwritten.
   */
  function adopt() {
    const stale = get("tracker.aiKey");
    if (!stale || !/^AIza/.test(stale)) return false;
    if (get("tracker.geminiKey")) return false;
    window.TrackerStore.setText("tracker.geminiKey", stale);
    window.TrackerStore.remove("tracker.aiKey");
    return true;
  }
  adopt();

  /* -------------------------------------------------------------- dispatch */
  const PROVIDERS = [gemini, openrouter];
  const DEFAULT_ENGINE = gemini.id;

  const byId = (id) => PROVIDERS.find((p) => p.id === id);
  /** The chosen engine, falling back to the default if the setting is stale. */
  const engine = () => byId(get("tracker.aiEngine")) || byId(DEFAULT_ENGINE);
  const hasKey = () => PROVIDERS.some((p) => p.key());

  /**
   * Improve `text`. Resolves with the new text, or throws with a readable
   * reason - ui.js shows the message and leaves what you typed alone.
   *
   * If the chosen engine has no key, the first engine that does have one runs
   * rather than refusing. Someone who set up one engine and then changed the
   * default should get a working button, not a lecture.
   */
  async function standardize(text, { kind = "description" } = {}) {
    const chosen = engine();
    const provider = chosen.key() ? chosen : PROVIDERS.find((p) => p.key());
    if (!provider) {
      throw new Error("Add a key in Settings to use this. Google AI Studio is free.");
    }
    return provider.run(text, kind);
  }

  window.TrackerAI = { standardize, hasKey, engine, PROVIDERS, DEFAULT_ENGINE, adopt,
                     classify, PURPOSE_ORDER, PURPOSE_LABEL };
})();
