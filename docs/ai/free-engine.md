# Running the Standardize button for nothing

The button ships with two engines. Google Gemini is the default because a
Google AI Studio key is issued with no card and has a free tier, so the
feature costs nothing to run. Anthropic writes better and spends purchased
credit. Both are reached the same way, and the button, the Undo and the em
dash rule never learn which one answered.

## Setting it up, free

1. Go to **aistudio.google.com** and click Get API key. No card is required.
2. In the tracker: **Settings → Standardize text**.
3. Engine: **Google Gemini (free tier)**. Paste the key.
4. Leave the Model box alone. Once the key is in, the list is read from your
   own account and the cheapest and fastest model is selected first.
5. Save, then click the wand beside a task's name or description.

## Why the model list is fetched rather than written down

Model names change often. A list baked into `assets/ai.js` would be wrong
within months, and a stale name produces a 404 that the reader cannot act on.
So `gemini.listModels(key)` calls `GET /v1beta/models`, keeps the ones that
support `generateContent`, and sorts flash-lite before flash before pro. The
constant `GEMINI_FALLBACK_MODEL` is used only before a key exists.

## What was verified, and how

Checked on 4 September 2026 by making the calls, not by reading about them.

**Gemini accepts browser calls.** A request carrying a GitHub Pages origin and
no key:

```
HTTP/2 403
access-control-allow-origin: https://perezfiles01-droid.github.io
"Method doesn't allow unregistered callers ... Please use API Key"
```

It refused for the missing key, not for the origin, and echoed the origin back
in the CORS header.

**The request body is the right shape.** Google validates the JSON schema
*before* the API key, which makes the body checkable without one. Sending the
exact body `assets/ai.js` builds returns "API key not valid", meaning the shape
passed. Sending `{"nonsense_field":1}` instead returns `Unknown name
"nonsense_field": Cannot find field`. Both `system_instruction` and
`systemInstruction` are accepted.

**Not verified:** no live call has ever been made with a real key, from any
engine. Every path is driven by a stubbed `fetch` in
`checks/check_standardize.mjs`. The plumbing is proven; the quality of the
writing is not.

## Options that were considered and not built

**Chrome's built-in AI**, the `Rewriter` and `LanguageModel` globals backed by
Gemini Nano. Confirmed present by asking a real Chrome 141 directly:

```
Rewriter: present   Writer: present   Summarizer: present
LanguageModel: present   Proofreader: absent
Rewriter.availability() -> "unavailable"
```

Zero key and zero cost, and fully private. Left out because a production
origin appears to need a free origin-trial token that expires around Chrome
148, it is Chrome only, and it needs roughly 22 GB free disk plus a model
download. That token requirement comes from a search summary rather than
Chrome's own docs, which were unreachable from the research environment.
Worth revisiting when the APIs reach stable.

**WebLLM**, https://github.com/mlc-ai/web-llm, Apache-2.0. A real model on the
visitor's GPU with no key, no token, no account and no expiry, in any WebGPU
browser. The only genuinely free-forever option with nothing to register.
Costs a one-time model download of roughly 1 GB, which is a lot for a button
you tap while writing a to-do item. WebGPU was confirmed working with a live
adapter in the same Chrome test above, so this remains open.

**Anthropic's own free trial.** New Console accounts appear to receive a
one-time credit of about $5, which at Haiku prices is several thousand clicks.
Reported by search results quoting Anthropic; `anthropic.com` and
`support.claude.com` were both unreachable from the research environment, so
check Console → Usage rather than trusting this line.
