# What was actually checked

Research dated 4 September 2026. Read this before trusting the other pages.
Claims that look alike are not alike: some were observed directly, some were
read from a package registry, and some could not be checked at all.

## Observed directly

| Claim | How it was established |
| --- | --- |
| The Claude API accepts browser origin requests | A real request returned HTTP 401 for a missing key, with `access-control-allow-origin: *` and `anthropic-dangerous-direct-browser-access` named in the response `vary` header. Full command and response in [`api-key-options.md`](api-key-options.md). |
| Nothing in the page blocks such a call | `grep` for `content-security` across `index.html`, `Tracker-standalone.html` and `404.html` returned nothing. |
| An API key stored as a setting stays out of backups | Read `exportData` and `importData` in `assets/store.js`. Both walk `KEYS.data`; `KEYS.settings` is in neither. |
| Six prose fields, one shared renderer | `grep -n 'type: "textarea"' assets/*.js` returned six results across three modules, all rendered by `fieldHtml` in `assets/ui.js`. |

## Read from the npm registry, not tested

Licence, version, publish date, package size and repository URL for every
project named in [`no-key-options.md`](no-key-options.md) were read from
`registry.npmjs.org`. That is authoritative for *what a package claims about
itself*, and says nothing about whether it works well.

Repository links were taken from each package's own `repository` field rather
than typed from memory, so they point where the maintainers say they point.

## Not checked at all

Be careful here. These are the gaps most likely to embarrass a future decision.

- **None of these libraries was ever run.** Not in a browser, not in Node. No
  claim about output quality, speed, or whether Harper's suggestions are any
  good on real task descriptions is supported by anything.
- **Harper's real browser payload was never measured.** The 74 MB figure is the
  npm tarball unpacked, which includes every build variant. The `./slimBinary`
  entry point exists in the manifest, but its actual size is unknown, and
  `cdn.jsdelivr.net` was unreachable from the research environment so it could
  not be fetched.
- **LanguageTool's public API was never reached.** `api.languagetool.org`
  returned a proxy level 403 from the research environment. That is a fact about
  that environment, not about LanguageTool. Nothing is claimed either way about
  whether their endpoint accepts browser calls.
- **No star counts, no contributor counts, no issue activity.** The GitHub API
  was scoped to this repository during the research, so popularity and
  liveliness were judged only from package publish dates and the identity of the
  maintainer.
- **The cost figures are arithmetic, not observation.** Computed from published
  per token list prices against an assumed 300 input and 200 output tokens. No
  real request was ever billed.

## How to re-check, cheaply

Package metadata, which is where most of the above came from:

```sh
curl -s https://registry.npmjs.org/harper.js \
  | python3 -c "import sys,json; d=json.load(sys.stdin); \
      lat=d['dist-tags']['latest']; v=d['versions'][lat]; \
      print(lat, v.get('license'), d['time'][lat][:10], v.get('repository'))"
```

The browser access test is the `curl` in [`api-key-options.md`](api-key-options.md).
It needs no key: a 401 mentioning `x-api-key` is a pass, because it proves the
request arrived. A CORS or network error is a fail.

## Prices and models drift

The model IDs and prices quoted in `api-key-options.md` were current in
September 2026 and will not stay current. Re-read them from the vendor before
quoting them to anyone, rather than trusting this file.
