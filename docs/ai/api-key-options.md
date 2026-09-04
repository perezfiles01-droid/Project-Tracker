# The hosted API route

Reach for this only when a request genuinely needs text rewritten rather than
corrected. For grammar and spelling alone, see
[`no-key-options.md`](no-key-options.md): it is free, private and offline.

## It works from the browser, and that was tested

Not inferred. On 4 September 2026 a request was sent to the Claude Messages API
carrying a browser style `Origin` header:

```
curl -i -X POST https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "origin: https://perezfiles01-droid.github.io" \
  -H "anthropic-dangerous-direct-browser-access: true" \
  -d '{"model":"claude-opus-5","max_tokens":1,
       "messages":[{"role":"user","content":"hi"}]}'
```

Response:

```
HTTP/2 401
access-control-allow-origin: *
vary: Origin, Access-Control-Request-Headers, anthropic-dangerous-direct-browser-access
{"type":"error","error":{"type":"authentication_error",
 "message":"x-api-key header is required"}}
```

Two things this proves. The request reached the API and was refused only for a
missing key, so it was not blocked by CORS. And `vary` names
`anthropic-dangerous-direct-browser-access`, which is the header that gates
direct browser access. A browser can call this API.

`index.html` also sets no Content-Security-Policy, checked at the same time, so
nothing in the page blocks the call either.

## The request shape

```js
fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-api-key": key,
  },
  body: JSON.stringify({
    model: "claude-opus-5",
    max_tokens: 2000,
    output_config: { effort: "low" },   // a one paragraph rewrite needs no deliberation
    messages: [{ role: "user", content: prompt }],
  }),
});
```

Use raw `fetch` rather than the official SDK. This repository has no bundler for
its JavaScript, every script is a plain `<script src>`, and adding a build step
for one request would be a larger change than the feature itself.

## What it would cost

Estimated from published list prices, not measured. A 100 word description is
roughly 300 input and 200 output tokens.

| Model | Input / Output per million | Per click |
| --- | --- | --- |
| `claude-opus-5` | $5 / $25 | about $0.007 |
| `claude-haiku-4-5` | $1 / $5 | about $0.001 |

Under a cent either way. Cost is not the reason to hesitate here.

## The key is the reason to hesitate

A static site cannot hide a secret, so the key would live in your browser's
localStorage, exactly as the Google Drive credentials already do. Anthropic's
own SDK documentation disables browser use by default "to avoid exposing your
secret API credentials", and names two cases where it is nonetheless
reasonable: internal tools with trusted users, and development with short lived
or frequently rotated credentials. A single user, `noindex` index like this one
is the first case, but that is a judgement to make deliberately rather than by
default.

**One thing already works in your favour, confirmed in the code.** `exportData`
in `assets/store.js` walks `KEYS.data` only, and `importData` filters to the
same list. `KEYS.settings`, where the Google keys live, is in neither. So a key
stored as a *setting* never enters the backup file you might email to yourself
or copy to another machine. That is the existing split, and any future API key
belongs on the settings side of it.

Two further precautions if this route is ever taken:

- Set a low monthly spend cap on the key in the Anthropic Console, so the worst
  case is bounded rather than open ended.
- Never commit a key. `config.js` is tracked and ships with blank values for
  exactly this reason.

## The alternative that removes the problem

Put the key in a small proxy you deploy, for example a Cloudflare Worker, and
have the site call the proxy instead. The browser then never holds the key.
Strictly safer, and the correct answer if this site ever stops being a single
user tool. The cost is a second service to deploy and keep alive.

## If a rewriter is ever built, two rules

Learned from thinking through the failure modes rather than from experience,
so treat them as design intent:

1. **Never destroy what the user typed.** Keep the original and offer an undo.
   On any failure, a 401, a rate limit, a dropped connection, leave the text
   exactly as typed and say what went wrong in words. A rewriter that eats a
   paragraph on a flaky connection is worse than no rewriter.
2. **Enforce formatting in code, not in the prompt.** The em dash rule is the
   example. Ask for it in the prompt *and* strip it afterwards with a regex.
   The instruction is a request; the regex is a guarantee.
