# Options that need no API key

All of these run inside the browser. No key, no server, no account, no cost,
and nothing you type is sent anywhere. That makes them the natural fit for a
static site, which cannot keep a secret.

Metadata below was read from the npm registry on 4 September 2026. Licences,
versions and dates are quoted from the package manifests, not from the
projects' own marketing.

## Harper, the closest fit

**https://github.com/automattic/harper** · https://writewithharper.com

| | |
| --- | --- |
| Package | `harper.js` 2.7.0 |
| Licence | Apache-2.0 |
| Published | 28 July 2026 |
| Maintainer | Automattic (the WordPress company) |
| How it runs | Rust compiled to WebAssembly, entirely client side |

A grammar and spelling engine built specifically so that writing never leaves
the machine. Actively maintained by a real company rather than a single
volunteer, which matters for something you intend to still be working in a
year.

The npm tarball unpacks to about 74 MB, but that includes every build variant
and its type definitions, so it is not what a browser would fetch.

**Confirmed against the package itself, September 2026.** The published
`harper.js` 2.7.0 was downloaded and its type definitions read. The complete
text facing API is `lint(text)` returning spans, each with `suggestions()`,
plus `applySuggestion(text, lint, suggestion)` and `toTitleCase`. There is no
rewrite, no tone, no generation. Measured payload: the WebAssembly binary is
15.1 MB raw and **7.7 MB gzipped** over the wire. The `slimBinary` build saves
almost nothing, 7.6 MB gzipped. It does work without a bundler: `WorkerLinter`
plus `createBinaryModuleFromUrl`, with the wasm resolved from `import.meta.url`.

**What it will not do.** Harper corrects; it does not rewrite. It catches
broken grammar, misspellings and awkward phrasing and offers fixes. It will not
take a rambling paragraph and restate the idea more simply. If a future request
needs that, this is not the tool.

## Flagging heavy phrasing, without a model

Tiny, pure JavaScript, no network. These do not rewrite either, but they find
the places worth rewriting and suggest plainer words.

| Project | Package | Licence | Size | Published |
| --- | --- | --- | --- | --- |
| https://github.com/retextjs/retext-simplify | `retext-simplify` 8.0.0 | MIT | 30 KB | 10 Sep 2023 |
| https://github.com/retextjs/retext-readability | `retext-readability` 8.0.0 | MIT | 18 KB | 11 Sep 2023 |
| https://github.com/btford/write-good | `write-good` 1.0.8 | MIT | 41 KB | 16 Feb 2021 |

`retext-simplify` swaps complexity for plain words ("utilise" for "use", "in
order to" for "to"). `retext-readability` flags sentences that are too hard to
read. `write-good` catches passive voice, weasel words and overlong sentences.

**On those dates.** These have not been published in years. That is maturity
rather than abandonment, since English phrasing rules do not rot, but it does
mean nobody is fixing bugs quickly. Judge them on output, not on release
cadence.

## A real language model, still with no key

If a future request genuinely needs rewriting rather than correcting, and you
still refuse to hold a key, a model can run in the tab itself.

| Project | Package | Licence | Published |
| --- | --- | --- | --- |
| https://github.com/mlc-ai/web-llm | `@mlc-ai/web-llm` 0.2.84 | Apache-2.0 | 27 May 2026 |
| https://github.com/huggingface/transformers.js | `@huggingface/transformers` 4.2.0 | Apache-2.0 | 22 Apr 2026 |

Both execute a model on the visitor's own GPU through WebGPU. No key, no cost,
no data leaving the device.

**The price is the download.** A usable model is hundreds of megabytes on first
use, cached afterwards, and it needs a reasonably modern GPU. For a button
tapped while jotting a to-do item, that is a heavy trade. It becomes
interesting if the app ever needs bulk rewriting, or must work with no network
at all.

## Mentioned so nobody re-researches it

**https://github.com/languagetool-org/languagetool** is the best known open
source grammar engine. It is a Java server, so self-hosting reintroduces the
server this site does not have. It also offers a public API, but that endpoint
**could not be reached** from the environment where this research was done, so
no claim is made here about whether it accepts browser calls. Check it directly
before relying on it.

## One integration detail that applies to all of them

Every package above ships as an ES module. `index.html` loads plain classic
`<script src="...">` tags, and `scripts/build_standalone.py` inlines those same
files into `Tracker-standalone.html`. Adding any of these means introducing
`<script type="module">` and teaching the standalone build about it. Small and
contained, but not zero.
