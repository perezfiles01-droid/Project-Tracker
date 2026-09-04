/* The text helper behind the Standardize button.
 *
 * One job: take what you typed and hand back a better-written version of the
 * same thing. Everything about talking to a model lives here, so ui.js owns
 * the button and knows nothing about who improves the text.
 *
 * Why a raw fetch and not the official SDK: this repository has no bundler
 * for its JavaScript. Every file is a plain <script src>, and build_standalone
 * inlines those same files into one HTML page. Adding a build step for a
 * single request would be a larger change than the feature.
 *
 * The key lives in localStorage, which is the honest position for a static
 * site: there is no server here to hold a secret. It is filed under
 * KEYS.settings rather than KEYS.data on purpose, so it never travels inside
 * a backup file you might email to yourself. Give it a spend cap in the
 * Anthropic console and the worst case stays bounded.
 */
(() => {
  const ENDPOINT = "https://api.anthropic.com/v1/messages";
  const VERSION = "2023-06-01";
  // Haiku is the default because this is a rewrite, not a reasoning problem,
   // and it runs roughly five times further on the same credit. Opus stays on
   // the list for anyone who wants the better writer.
  const DEFAULT_MODEL = "claude-haiku-4-5";

  /** Models offered in Settings. First is the default. */
  const MODELS = [
    "claude-haiku-4-5",
    "claude-opus-5",
  ];

  /**
   * Which models take output_config.effort.
   *
   * Not cosmetic. Haiku 4.5 REJECTS effort with a 400, so sending it to every
   * model turns a model switch into a broken button. Opus 5 accepts it, and
   * "low" is right here: a one paragraph rewrite needs no deliberation and the
   * button should feel immediate.
   */
  const TAKES_EFFORT = (model) => /^claude-(opus|sonnet)-5/.test(model);

  const cfg = () => ({
    key: window.TrackerStore.getText("tracker.aiKey") ||
         (window.TRACKER_CONFIG?.anthropicApiKey || ""),
    model: window.TrackerStore.getText("tracker.aiModel") || DEFAULT_MODEL,
  });

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

  /**
   * Turn a failed response into something worth reading.
   *
   * "Request failed" tells you nothing about which of these it was, and each
   * one has a different fix.
   */
  function explain(status, body) {
    if (status === 401) return "That API key was refused. Check it in Settings.";
    if (status === 403) return "That key is not allowed to use this model.";
    if (status === 400) {
      const m = body && body.error && body.error.message;
      return m ? "The request was rejected: " + m : "The request was rejected.";
    }
    if (status === 429) return "Rate limited, or the spend cap is reached. Try again shortly.";
    if (status === 402) return "There is a billing problem on the account.";
    if (status >= 500) return "Anthropic had a problem. Try again shortly.";
    return "That did not work (HTTP " + status + ").";
  }

  /**
   * Improve `text`. Resolves with the new text, or throws with a readable
   * reason - ui.js shows the message and leaves what you typed alone.
   */
  async function standardize(text, { kind = "description" } = {}) {
    const { key, model } = cfg();
    if (!key) throw new Error("Add an Anthropic API key in Settings to use this.");

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": VERSION,
          // Without this the browser call is refused before it reaches the API.
          "anthropic-dangerous-direct-browser-access": "true",
          "x-api-key": key,
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          ...(TAKES_EFFORT(model) ? { output_config: { effort: "low" } } : {}),
          system: SYSTEM + "\n\n" + (KIND_HINT[kind] || KIND_HINT.description),
          messages: [{ role: "user", content: text }],
        }),
      });
    } catch {
      // Fetch only rejects on a network-level failure, never on a 4xx.
      throw new Error("Could not reach Anthropic. Check your connection.");
    }

    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(explain(res.status, body));

    // A refusal comes back as a 200 with nothing useful in it, so the reply is
    // checked rather than assumed.
    if (body && body.stop_reason === "refusal") {
      throw new Error("The model declined to rewrite that.");
    }
    const out = (body && Array.isArray(body.content) ? body.content : [])
      .filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (!out) throw new Error("Nothing came back. Your text is unchanged.");
    return out;
  }

  const hasKey = () => !!cfg().key;

  window.TrackerAI = { standardize, hasKey, MODELS, DEFAULT_MODEL, TAKES_EFFORT };
})();
