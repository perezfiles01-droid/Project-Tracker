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
   * Its first paragraph used to end with a licence to fill any perceived gap
   * in the message, and that sentence is deliberately gone - it is not quoted
   * here, so check_prompt.mjs can scan this file for it strictly rather than
   * having to tiptoe around a comment about it. Standardize is asked to tidy
   * what you wrote, and an instruction to fill perceived gaps invites the
   * model to add a sentence you never wrote into a work note that goes out
   * under your name. The
   * remaining rules are the ones that keep it to a rewrite: retain the
   * message, do not make it longer than it needs to be, and invent no
   * specifics.
   *
   * The last line is not decoration. A model told to improve text will often
   * hand back "Here is the improved version:" and a rewrite in quotes, and
   * that whole string would land in the field. The dash rule is repeated in
   * TrackerUI.tidyDashes, which strips them afterwards regardless - the
   * prompt is the request, the regex is the guarantee.
   */
  const SYSTEM = [
    "Improve the tone of the text the user gives you. Fix the grammar, retain",
    "the message, and make it clear and easy to understand.",
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
   * The second job this file does: read a batch of tasks and say what they add
   * up to, for the .txt report the To Do List exports.
   *
   * A separate instruction rather than another KIND_HINT, because SYSTEM asks
   * for a REWRITE of the text it is given - "improve the tone", "retain the
   * message" - and a report is not a tidied copy of its input. Hinting the
   * rewrite instruction towards summarising would have produced a politely
   * reworded field dump.
   *
   * The no-invention rule is repeated here in its own words rather than
   * inherited, and it matters more here than it does there. Standardize hands
   * its answer back into a field you are looking at, where an invented detail
   * is in front of you; this text is written into a file that gets read later,
   * by which time nothing distinguishes a sentence the model made up from one
   * your own notes support. The report is built so that it CANNOT do damage
   * beyond its own paragraphs - export.js prints every fact verbatim from
   * storage and lets this text sit beside them, never in place of them - and
   * the instruction is the second line of defence, not the first.
   *
   * The reply shape is asked for strictly because it is parsed back: export.js
   * splits on the TASK n headings to place each line under the right task. A
   * reply that ignores the shape costs the per-task lines and nothing else -
   * the summary and every task still reach the file.
   */
  const REPORT = [
    "You are writing the summary section of a work report, from a list of",
    "tasks the user has recorded. Read all of them and say what the batch of",
    "work adds up to: what it is about, what is moving, what is waiting on",
    "someone, what is blocked or overdue, and anything several tasks have in",
    "common. Write for someone who has not seen the list.",
    "",
    "Use ONLY what the tasks say. Invent no names, dates, systems, numbers,",
    "statuses or outcomes, and do not guess at what a task means if it does",
    "not say. If the tasks are too thin to summarise, say that in one line.",
    "",
    "Never use an em dash or an en dash. Write plainly, in the register of a",
    "work note. No preamble, no sign-off, no markdown headings, no bullets.",
    "",
    "Reply in exactly this shape, and nothing else:",
    "",
    "SUMMARY",
    "One to three short paragraphs about the batch as a whole.",
    "",
    "TASK 1",
    "One or two sentences saying what this task is about in plain terms.",
    "",
    "TASK 2",
    "One or two sentences.",
    "",
    "Use the task numbers exactly as they are given to you, and write one",
    "TASK block for every task in the list.",
  ].join("\n");

  const prompt = (kind) =>
    kind === "report" ? REPORT
                      : SYSTEM + "\n\n" + (KIND_HINT[kind] || KIND_HINT.description);

  /**
   * Room to answer in.
   *
   * A rewrite is about as long as what it was given, so 2000 has always been
   * ample. A report over twenty tasks is not: the same ceiling truncates it
   * mid-sentence, and a Gemini reply cut off at the limit still arrives as a
   * 200 with a candidate, so it would have read as a short summary rather
   * than as a failure. Read by both engines, which is the point of it being
   * here rather than written into each one.
   */
  const MAX_TOKENS = (kind) => (kind === "report" ? 8000 : 2000);
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

  /**
   * base64 to a Blob, without a data: URI.
   *
   * Deliberately not `fetch("data:...")`, which is the short way and puts the
   * whole picture in a string first. A generated image is a megabyte or two,
   * and the one rule this app does not bend is that image bytes never travel
   * as text through anything that could persist them - check_images.mjs
   * asserts no data: URI reaches localStorage anywhere in the app. Decoding
   * to bytes here means the picture is a Blob from the moment it exists, and
   * the only place it is ever written is IndexedDB.
   */
  function b64ToBlob(data, type) {
    const bin = atob(String(data || "").replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || "image/png" });
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
    // "pro" is paid wherever it appears as a segment of the name - Pro, Pro
    // preview, pro-latest and the pro TTS and image models alike. Written with
    // boundaries so it reads a segment and never a substring: preview, prompt
    // and product are not pro models, and a rule that caught them would empty
    // the free tier.
    const paid =
      /(^|-)pro(-|$)/.test(m) ||
      /deep-research|lyria|computer-use|robotics|nano-banana|imagen/.test(m);
    return { tier: paid ? "paid" : "free", purpose };
  }

  /* ---------------------------------------------------------------- Gemini */
  const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
  // Used only until the picker is filled from the account itself. Model names
  // churn, so this file does not pretend to know the current best one:
  // listModels asks, and a name baked in here would be wrong within months.
  const GEMINI_FALLBACK_MODEL = "gemini-2.0-flash";

  /**
   * Models Google has withdrawn, which the picker must stop offering.
   *
   * The 2.5 flash family answers a request with 404 "This model ... is no
   * longer available to new users", so leaving it in the list is offering a
   * name that cannot work. This is the one place a model is taken out of reach
   * rather than merely relabelled, which is why the rule is narrow, named and
   * exposed: a withdrawal is a fact about the service, not a guess about a
   * price, and the guard checks it by calling this rather than by scraping.
   */
  const GEMINI_RETIRED = /^gemini-2\.5-flash/;

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
    retired: (name) => GEMINI_RETIRED.test(String(name || "")),
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
        // Dropped here rather than in the dialog, so run() cannot reach one
        // either, whichever tier is on screen.
        .filter((m) => !gemini.retired(m))
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
            generationConfig: { temperature: 0.3, maxOutputTokens: MAX_TOKENS(kind) },
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

    /* ---- the image side of the same engine ----

       Deliberately the same entry, the same key and the same listModels as
       the text side above, rather than a second "Gemini images" engine. One
       AI Studio key does both jobs, and two entries would mean pasting it
       twice and keeping two copies in step.

       canImage says this engine can draw; canBasis says it can be given a
       picture to work from. They are separate because they are separately
       true - Pollinations below can draw and cannot take a basis - and the
       Image Generator reads both rather than assuming that drawing implies
       the rest. */
    canImage: true,
    canBasis: true,
    imageModelSetting: "tracker.geminiImageModel",
    // Named rather than discovered, as the fallback only. listImageModels
    // asks the account what it actually has; this is what runs before anyone
    // has opened the picker, and it is the current image model at the time of
    // writing. A name baked in here goes stale, which is why it is a fallback
    // and not the answer.
    imageModel: () => get("tracker.geminiImageModel") || "gemini-2.5-flash-image",

    /** The account's own models, narrowed to the ones that draw. */
    async listImageModels(key) {
      const all = await gemini.listModels(key);
      // Narrowed through the SAME classify the Settings dialog groups by, not
      // a second pattern of its own. Two lists that decide "is this an image
      // model" separately are two lists that will disagree.
      return all.filter((m) => classify(m).purpose === "image");
    },

    /**
     * Draw `prompt`, optionally working from `basis`.
     *
     * The reply is read for inlineData rather than text, which is the whole
     * reason this is not a call to run(): image bytes arrive as base64 on a
     * part, and run()'s `.map((p) => p.text || "")` above drops them and
     * hands back an empty string. That is not a hypothetical - it is what
     * pointing the wand at an image model did before this existed.
     */
    async image(prompt, { basis } = {}) {
      const key = gemini.key();
      if (!key) throw new Error("Add a Google AI Studio key in the settings above to use this.");
      const parts = [{ text: prompt }];
      // The basis goes in the same contents array as the prompt, which is how
      // this API takes a reference picture: one turn carrying both.
      if (basis && basis.base64) {
        parts.push({ inline_data: { mime_type: basis.type || "image/png", data: basis.base64 } });
      }
      const res = await send(
        `${GEMINI_BASE}/models/${encodeURIComponent(gemini.imageModel())}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            // Asked for explicitly. An image model handed no modalities can
            // answer with a paragraph describing the picture it would have
            // drawn, which arrives as a perfectly valid 200 with no bytes in
            // it at all.
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          }),
        }, "Google");

      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(explain(res.status, body && body.error && body.error.message, "Google"));
      const cand = body && body.candidates && body.candidates[0];
      if (!cand) {
        const why = body && body.promptFeedback && body.promptFeedback.blockReason;
        throw new Error(why ? `Gemini declined that prompt (${why}).`
                            : "Nothing came back, so no picture was made.");
      }
      const bits = (cand.content && cand.content.parts) || [];
      // Both spellings. The REST API answers in snake_case and the client
      // libraries in camelCase, and which one arrives is not worth betting a
      // blank picture on.
      const img = bits.map((x) => x.inlineData || x.inline_data).find((x) => x && x.data);
      if (!img) {
        // A model that replied in words instead of pixels is the single most
        // likely failure here, so its words are what the message carries.
        const said = bits.map((x) => x.text || "").join(" ").trim();
        throw new Error(said ? "That engine answered with text rather than a picture: " +
                               said.slice(0, 200)
                             : "The reply carried no image data.");
      }
      return b64ToBlob(img.data, img.mimeType || img.mime_type || "image/png");
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
          max_tokens: MAX_TOKENS(kind),
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

  /* --------------------------------------------------------- Pollinations */
  /*
   * The keyless engine, and the reason the Image Generator works the moment
   * it ships.
   *
   * Every other engine in this file needs a key pasted in before it does
   * anything. This one needs nothing: the prompt is the URL, and the reply is
   * the picture. That makes it the honest answer to "free image generation on
   * a static site" - there is no key to leak, no account to create, and no
   * free tier to run out.
   *
   * It is image-only. canText is false, so PROVIDERS below excludes it and it
   * is never offered as a Standardize engine, which it cannot do. The guard
   * asserts that exclusion rather than trusting this comment.
   *
   * canBasis is false, and that is a real limitation rather than an omission.
   * Working from a reference picture here means handing the service a public
   * URL it can fetch, and an image you just chose off your own disk does not
   * have one. Uploading a basis and having it silently ignored would be worse
   * than being told, so the Image Generator reads canBasis and says so.
   *
   * NOT VERIFIED: no call has been made to this host from the build
   * environment, which cannot reach it - the egress proxy answers CONNECT
   * with 403 for everything outside its allowlist. Its documented keyless GET
   * interface is the basis for it being here, exactly as OpenRouter's
   * documented browser support was above. The first real proof is a click.
   */
  const POLLINATIONS_BASE = "https://image.pollinations.ai";

  const pollinations = {
    id: "pollinations",
    label: "Pollinations (free, no key needed)",
    keyHelp: "No key needed. Nothing to set up.",
    free: true,
    keyless: true,
    canText: false,
    canImage: true,
    canBasis: false,
    wire: "pollinations",
    modelSetting: "tracker.pollinationsModel",
    imageModelSetting: "tracker.pollinationsModel",
    key: () => "",
    model: () => get("tracker.pollinationsModel") || "flux",
    imageModel: () => get("tracker.pollinationsModel") || "flux",
    classify: (name) => ({ tier: "free", purpose: "image" }),

    /**
     * The models the service offers.
     *
     * Every one is an image model and every one is free, so unlike the other
     * engines there is nothing to filter or label - which is why classify
     * above answers the same thing for any name. A dead or changed endpoint
     * falls back to the names known at the time of writing rather than
     * emptying the picker: an engine that needs no key should never present
     * as unusable because a list request failed.
     */
    async listImageModels() {
      try {
        const res = await send(`${POLLINATIONS_BASE}/models`, { method: "GET" }, "Pollinations");
        if (!res.ok) return ["flux", "turbo"];
        const body = await res.json().catch(() => null);
        const names = (Array.isArray(body) ? body : [])
          .map((m) => (typeof m === "string" ? m : m && (m.name || m.id)))
          .filter(Boolean).map(String);
        return names.length ? names.sort() : ["flux", "turbo"];
      } catch {
        return ["flux", "turbo"];
      }
    },

    async image(prompt, { width = 1024, height = 1024 } = {}) {
      // The prompt is a path segment, so it is encoded rather than
      // interpolated: a prompt containing a slash or a question mark would
      // otherwise change the URL rather than the picture.
      const qs = new URLSearchParams({
        model: pollinations.imageModel(),
        width: String(width), height: String(height),
        nologo: "true",
        // Without this the same prompt returns the same picture from cache,
        // so pressing Generate twice would look like a button that does
        // nothing. A seed per call is what makes a second press a second try.
        seed: String(Math.floor(Math.random() * 1e9)),
      });
      const url = `${POLLINATIONS_BASE}/prompt/${encodeURIComponent(prompt)}?${qs}`;
      const res = await send(url, { method: "GET" }, "Pollinations");
      if (!res.ok) throw new Error(explain(res.status, "", "Pollinations"));
      const blob = await res.blob();
      // A service under load can answer 200 with an error page. A picture
      // that is not an image type, or is too small to be one, is a failure
      // however healthy the status line looked.
      if (!blob || !/^image\//.test(blob.type || "") || blob.size < 100) {
        throw new Error("Pollinations answered, but not with a picture. Try again shortly.");
      }
      return blob;
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
  /**
   * Let go of a model the service has withdrawn.
   *
   * Someone whose saved model is gemini-2.5-flash-lite gets a 404 on every
   * click, and the picker cannot help because it reads the saved name straight
   * back. Cleared once, so the next open falls to whatever the account itself
   * offers. Only a withdrawn name is touched; anything else is left exactly as
   * it was chosen.
   */
  function retire() {
    const saved = get("tracker.geminiModel");
    if (!saved || !gemini.retired(saved)) return false;
    window.TrackerStore.remove("tracker.geminiModel");
    return true;
  }
  retire();

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
  /**
   * Every engine this file knows, and the two capability views onto it.
   *
   * ENGINES is the registry. PROVIDERS is the TEXT-capable subset and keeps
   * its old name and old contents on purpose: the Settings dialog in drive.js
   * enumerates it to build the Standardize engine picker, and check_models
   * and check_standardize assert against it. Adding an image-only engine to
   * that list would offer Pollinations as a text rewriter, which it cannot
   * do - so the capability decides membership, not the registry.
   *
   * Both views are derived here rather than written out, so a fourth engine
   * is one entry above and appears in exactly the pickers its own flags say
   * it belongs in. The guard enumerates ENGINES at runtime and asserts each
   * engine reaches the right view, which is what stops a new one landing in
   * a picker that cannot use it.
   */
  const ENGINES = [gemini, openrouter, pollinations];
  const PROVIDERS = ENGINES.filter((p) => p.canText !== false);
  /** The engines that can draw, for the Image Generator's own picker. */
  const imageEngines = () => ENGINES.filter((p) => p.canImage);
  const DEFAULT_ENGINE = gemini.id;
  const DEFAULT_IMAGE_ENGINE = pollinations.id;

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
    return dispatch(text, kind);
  }

  /**
   * Which engine actually runs this, whatever kind of work it is.
   *
   * Lifted out of standardize unchanged so that report() cannot acquire a
   * second, subtly different answer to the same question - the fallback to the
   * first engine holding a key is the behaviour someone who set up OpenRouter
   * and then changed the default depends on, and it should not be a thing that
   * works for the wand and not for the report.
   */
  async function dispatch(text, kind) {
    const chosen = engine();
    const provider = chosen.key() ? chosen : PROVIDERS.find((p) => p.key());
    if (!provider) {
      throw new Error("Add a key in Settings to use this. Google AI Studio is free.");
    }
    return provider.run(text, kind);
  }

  /**
   * Summarise a batch of tasks for the exported report.
   *
   * Throws exactly as standardize does, with the same readable reasons, and
   * export.js catches every one of them: the file is written either way, with
   * a line saying why the summary is missing. The AI makes the report easier
   * to read; it is never what decides whether you get one.
   */
  async function report(text) {
    return dispatch(text, "report");
  }

  /**
   * Which engine draws, and whether it is usable at all.
   *
   * Not a copy of dispatch() above, because the question is different: a text
   * engine is usable when it holds a key, and a keyless engine is usable
   * always. Falling back to "the first engine with a key" would also be wrong
   * here - it would silently send a prompt to an engine you did not pick.
   * The chosen one runs, or it says what it needs.
   */
  const imageEngine = () => imageEngines().find((p) => p.id === get("tracker.imageEngine")) ||
                            imageEngines().find((p) => p.id === DEFAULT_IMAGE_ENGINE) ||
                            imageEngines()[0];

  /** Can this engine be used right now, with what is saved? */
  const imageReady = (p) => !!p && (p.keyless === true || !!p.key());

  /**
   * Draw a picture. Resolves with a Blob, or throws with a readable reason.
   *
   * `basis` is an optional { base64, type } reference picture. An engine that
   * cannot take one says so rather than quietly dropping it: being told the
   * upload was ignored is the difference between a limitation and a bug.
   */
  async function image(prompt, { basis = null, engineId = null } = {}) {
    const p = engineId ? imageEngines().find((x) => x.id === engineId) : imageEngine();
    if (!p) throw new Error("No image engine is available.");
    if (!imageReady(p)) throw new Error(`Add a ${p.label} key in the settings above to use this.`);
    if (basis && !p.canBasis) {
      throw new Error(`${p.label} cannot work from an uploaded picture. ` +
                      "Pick an engine that can, or remove the basis image.");
    }
    return p.image(prompt, basis ? { basis } : {});
  }

  window.TrackerAI = { standardize, report, hasKey, engine, PROVIDERS, ENGINES,
                     DEFAULT_ENGINE, adopt, retire,
                     classify, PURPOSE_ORDER, PURPOSE_LABEL, prompt,
                     image, imageEngines, imageEngine, imageReady,
                     DEFAULT_IMAGE_ENGINE, b64ToBlob };
})();
