# Adding AI to this tracker

Research notes from 4 September 2026, kept so the next AI request starts from
findings rather than from scratch.

The question that prompted this: *"can we add a button that fixes the grammar
in a task's Detailed description, simplifies the thought, and never uses an em
dash?"*

**Update, same day: it was built, and then made free.** The Standardize
button beside a task's name and description is live. It runs on Google
Gemini's free tier by default, with Anthropic as a paid alternative, so it
costs nothing. See [`free-engine.md`](free-engine.md) to set it up. See
[`api-key-options.md`](api-key-options.md) for how it works and
`assets/ai.js` for the code. The rest of this folder is kept because the
reasoning still applies to the next AI request.

One finding is worth carrying forward above all: **Harper was researched
first and cannot do this job.** Its entire API is lint, span, suggestion,
applySuggestion. It corrects; it does not rewrite, improve tone, or fill a
gap in a message. If a future request uses those words, it needs a model.

## Start here: the one constraint that decides everything

**This site is static, and a static site cannot hold a secret.**

There is no server. That is why `data/tracker.json` is read only and why every
edit you make lives in this browser's localStorage. The same fact governs AI:
any API key would sit in your browser, where anyone with DevTools can read it.

So every option below falls into one of two camps, and picking the camp is the
real decision:

| Camp | Needs a key? | What it costs you |
| --- | --- | --- |
| Runs in the browser | No | Download size, or weaker rewriting |
| Calls a hosted API | Yes | A key in localStorage, or a proxy to deploy |

See [`no-key-options.md`](no-key-options.md) and
[`api-key-options.md`](api-key-options.md).

## The request splits into three parts, and they are not equally hard

Worth separating, because "add AI" hides the fact that two thirds of it needs
no AI at all:

| The ask | Hardest honest answer |
| --- | --- |
| Fix grammar and spelling | Solved, free, offline. Harper does this. |
| Remove em dashes | Not an AI problem. Three lines of JavaScript, and unlike a prompt instruction it is a guarantee. |
| Simplify or standardise the thought | Only a language model genuinely rewrites. Rule based tools can flag complex phrasing and suggest plainer words, which covers more than you would expect, but they do not restate a sentence. |

If a future request only needs the first two, do not reach for an API.

## Recommendation as it stood

Harper for grammar, plus a code level em dash rule, plus optionally
`retext-simplify` for flagging heavy phrasing. Zero cost, zero keys, works
offline, and nothing you type leaves the browser. Reach for a hosted model only
when the request genuinely needs a paragraph rewritten rather than corrected.

## Where a button would go

Confirmed by reading the code, not assumed. Every long text field in the app is
rendered by one function, `fieldHtml` in `assets/ui.js`. There are six of them:

| Field | Where |
| --- | --- |
| Task, Detailed description | `assets/tasks.js` |
| Activity log, Activity | `assets/tasks.js` |
| Link, Description | `assets/links.js` |
| Project, Description | `assets/links.js` |
| Artifact, Description | `assets/projects.js` |
| Milestone, Notes | `assets/projects.js` |

Because they share one renderer, a button is one change rather than six, and
any prose field added later inherits it. Short single line fields (task name,
project name, table name) were deliberately left out: they are labels, not
thoughts, and a rewriter argues with them.

## Files in this folder

| File | What it holds |
| --- | --- |
| `README.md` | This page: the constraint, the split, the recommendation |
| `free-engine.md` | **Start here to run it for nothing.** The Gemini free tier setup, and what was tested |
| `no-key-options.md` | Open source projects that run in the browser with no key |
| `api-key-options.md` | The hosted API route, its verified mechanics and its costs |
| `evidence.md` | What was actually tested, what was not, and how to re-test |

Read `evidence.md` before trusting anything here. Several claims that look
alike are not alike: some were observed, some were read from a package
registry, and some could not be checked at all.
