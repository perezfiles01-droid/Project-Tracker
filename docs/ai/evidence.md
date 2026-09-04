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

## Measured from the package itself

The published `harper.js` 2.7.0 tarball was downloaded from npm and unpacked,
so the following are measurements rather than claims:

| Measured | Value |
| --- | --- |
| WebAssembly binary | 15.1 MB raw, **7.7 MB gzipped** |
| The `slim` build | 14.9 MB raw, 7.6 MB gzipped, so it saves almost nothing |
| Harper's whole text API | `lint`, `Lint.span`, `Lint.suggestions`, `applySuggestion`, `toTitleCase`. No rewrite, no tone, no generation. |
| Usable without a bundler | Yes. `WorkerLinter` and `createBinaryModuleFromUrl`, wasm resolved from `import.meta.url`. |

That API listing is the reason Harper was not used for the Standardize
button. It corrects a span; it cannot restate a sentence or supply a missing
one.

## Read from the npm registry, not tested

Licence, version, publish date, package size and repository URL for every
project named in [`no-key-options.md`](no-key-options.md) were read from
`registry.npmjs.org`. That is authoritative for *what a package claims about
itself*, and says nothing about whether it works well.

Repository links were taken from each package's own `repository` field rather
than typed from memory, so they point where the maintainers say they point.

## Not checked at all

Be careful here. These are the gaps most likely to embarrass a future decision.

- **None of these libraries was ever run.** Harper's package was unpacked and
  read, but never executed. No claim about output quality or speed is
  supported by anything.
- **The live Claude call was never made.** The Standardize button was built
  and every path around it was driven with a stubbed `fetch`, including all
  six failure modes. Nobody has yet clicked it with a real API key, so the
  quality of the rewriting is unverified.
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
