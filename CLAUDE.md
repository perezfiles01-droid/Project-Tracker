# Working on this repository

## Ship it. Every time. Never ask.

A change is not finished when it is committed, and not when the pull request
is open. **It is finished when it is live on the site and testable there.**

Every change requested here goes all the way through, without stopping to ask
permission at any step:

1. Commit on the working branch and push.
2. Open the pull request.
3. **Wait for the Checks workflow to finish on the PR's own head commit.**
4. Green? Merge it. Red? Fix it and push again. Never merge red.
5. Confirm the Pages deploy ran **from the merge commit**, not merely that
   some deploy succeeded.
6. Say what to click to see it, and that a hard refresh may be needed.

That list is the **full lane**. Content, wording, CSS and docs take the
**fast lane** straight to `main` (see "How we work" below).

Standing instruction from the repository owner, 14 September 2026, in their
own words:

> "every single time that i want to ask you any changes, I need you to merge
> everything that needs to be merged and most especially when done, it should
> already be testable in the site"

and, when asked once too often:

> "i need everything to be live every single time a change is requested from
> you. Make this automatic. Dont ask me this again. EVER"

**Do not ask whether to merge. Do not ask whether to deploy. Do not offer the
choice.** Both were authorised once, for every future change. Asking again is
itself the thing they asked to stop.

**The live site:** https://perezfiles01-droid.github.io/Project-Tracker/

## How we work: the exact routine, every request

Set by the owner on 4 November 2026: handle every change the same way as the
adb-tracker site, so it makes no difference which chat they are in.

### 1. Before touching anything
```bash
cd /home/user/Project-Tracker
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'   # once, if the clone lacks it
git fetch origin && git checkout main && git pull
mkdir -p node_modules && ln -sfn "$(npm root -g)/playwright" node_modules/playwright   # once per container; the checks import playwright as ESM
export CHROMIUM_PATH=/opt/pw-browsers/chromium
```

### 2. Decide the lane
- **Fast lane:** wording, content, `data/`, CSS, docs. Commit and push
  straight to `main`. About 1 to 3 minutes end to end.
- **Full lane:** anything in `assets/*.js`, `index.html` script, or new
  behaviour. Branch, PR, wait for Checks, merge, confirm the deploy.
- **Unsure?** Use the full lane.

### 3. Mockup first, when asked or for a new section
Write the mockup in the chat first, in the same structure the page will
have, and list what to confirm. Wait for "go" or corrections. **Never ask
about merging or deploying**; that is always yes.

### 4. Make the change
- Edit the files. For JSON content, a small Python script that loads,
  changes and dumps it keeps the diff clean.
- After any change to `assets/`, `index.html` or `data/`, run
  `python3 scripts/build_standalone.py` and commit the regenerated
  `Tracker-standalone.html`.

### 5. Verify
```bash
node checks/check_render.mjs && node checks/check_search.mjs     # fast lane
ls checks/check_*.mjs | xargs -P4 -I{} sh -c 'node {} >/dev/null 2>&1 || echo "FAIL {}"'   # full lane: prints only FAILs
```
- Run the specific guard for what changed, and add one if none covers it.
- **Look at a screenshot** of the changed screen; some bugs show only there.
- **If a check fails, rerun it alone and read its output.** Prove whether
  the change, the test (parallel load) or stale data is at fault before
  changing code.

### 6. Ship
**Fast lane:**
```bash
git commit -am "<what changed, plain words>"   # ends with the session's attribution lines
git push origin main
sha=$(git rev-parse HEAD)
until [ "$(gh api "repos/perezfiles01-droid/Project-Tracker/actions/runs?head_sha=$sha" --jq '[.workflow_runs[]|select(.name=="Deploy site to GitHub Pages" and .status=="completed")]|length')" -ge 1 ]; do sleep 5; done
gh api "repos/perezfiles01-droid/Project-Tracker/actions/runs?head_sha=$sha" --jq '.workflow_runs[]|select(.name=="Deploy site to GitHub Pages")|.conclusion'   # must print success
```

**Full lane:**
1. `git checkout -b claude/<topic>`, commit.
2. `git fetch origin && git merge origin/main`, so nothing on `main` is lost.
3. Push, then open the PR with the GitHub MCP `create_pull_request`: what
   changed, how it was verified, PR attribution lines.
4. Wait for **Checks** on the PR head SHA (same `until` loop with
   `.name=="Checks"`). Must be `success`, and the relevant step must have run,
   not `skipped`.
5. Merge with `merge_pull_request`, method `merge`, `expectedHeadSha` set.
6. Wait for the Pages run on the **merge SHA**. Must be `success`.
7. `git checkout main && git pull`.

### 7. Report to the owner
Short and plain:
1. **One line:** it's live, https://perezfiles01-droid.github.io/Project-Tracker/,
   press **Ctrl+Shift+R** (Cmd+Shift+R on a Mac).
2. **What to click** to see it.
3. **What changed**, a few bullets in their words.
4. **What was checked**, then: "I can't open github.io from here, so I haven't
   seen the live page itself."
5. **Anything open**, only if real, with a suggested next step.

No apologies, no asking permission to merge or deploy, no technical detail
they did not ask for.

## What still stops, and why it is not the same thing

Shipping is automatic. That is not a licence for everything. Stop and **state
the blocker** (a report, not a request for permission to do ordinary work):

- CI is red and the cause is not yet understood.
- A merge conflict that cannot be resolved without losing behaviour either way.
- The change would touch credentials, another account's data, or delete data.

Then keep working the blocker. A red PR is never left idle.

## Verifying the deploy from a sandboxed session

The egress proxy in the Claude Code web environment **refuses `github.io`**, so
a session here cannot fetch the live page to confirm it serves the change.
`curl` and WebFetch both fail with a policy denial. That is the environment,
not a broken deploy. Measured: `image.pollinations.ai`, `huggingface.co`,
`api.together.xyz`, `openrouter.ai` and `api.cloudflare.com` all answer `000`;
`generativelanguage.googleapis.com` is reachable.

What can be verified, and must be, every time:

- the Checks run for the PR's **head SHA** concluded `success`, and the step
  for the relevant guard actually **ran** rather than reporting `skipped` (a
  skipped step reads exactly like a passing one)
- the merge commit is on `main`
- the Pages run for **that** merge SHA concluded `success`, every step
- the new or changed files are in the deployed tree on `main`

Then say plainly that the live bytes were not read back. Never round "the
deploy succeeded" up to "I watched it work".

## Before pushing anything

```bash
python3 scripts/build_standalone.py     # REQUIRED: every check runs against this file
CHROMIUM_PATH=/opt/pw-browsers/chromium \
  node checks/check_<name>.mjs          # the guard for whatever changed
```

`Tracker-standalone.html` is generated **and committed**. Every browser check
loads *it*, not `index.html`, so a stale one means the whole suite tests the
old app and passes. Rebuild before running anything and before every commit.

Playwright's npm package is newer than the pre-installed browser, so
`CHROMIUM_PATH` must point at
`/opt/pw-browsers/chromium` (the old `chromium-1194` path no longer exists) or every browser check
dies with "Executable doesn't exist". Do not run `playwright install` — the
download host is blocked.

## Adding an asset file

Four places, and `build_standalone.py` fails loudly if one is missed:

1. `assets/<name>.js`
2. a `<script src>` in `index.html`
3. `scripts/build_standalone.py` — **both halves** of its one long literal
   (the search string *and* the replacement) plus the `inlined` map
4. the guard, and a step in `.github/workflows/checks.yml`

## House rules the guards enforce

- **Every nav route must render a `[data-search]` control.** `check_search.mjs`
  enumerates the sidebar at runtime and visits every route.
- **Image bytes never touch localStorage.** ~5 MB for the whole origin; one
  picture would take the task list with it. Bytes go to IndexedDB via
  `TrackerBlobs`; records keep a blob id.
- **Saving a file goes through `TrackerUI.saveBlob`.** Do not hand-roll a
  fifth copy of the anchor idiom.
- **`KEYS.data` is the backup.** A key outside it is not backed up, and also
  gets no undo step and no device sync — `record()` and `notify()` both gate
  on that list. `KEYS.local` exists for browser-only data; say the cost out
  loud wherever it is used.
- **Never assert a model's tier as fact.** `classify()` guesses from the name.
  A model labelled free can still be refused for want of an allowance — that
  bug shipped once.
- **Pass the provider's own error through.** A refusal that arrives with no
  detail cannot be acted on. `explain()` reads `{ message, status, details }`.

## Guard discipline

- **Enumerate the family at runtime**, never a hardcoded list. A check that
  lists today's members stops protecting the moment one is added, and the new
  member is the one most likely to carry the fault.
- **Prove a guard fails before trusting it.** Run it against the unfixed code
  and watch it fail; a check that cannot fail reads exactly like protection.
  `TRACKER_HTML=/path/to/old.html node checks/<check>.mjs` runs one against an
  older build.
- **A guard that encodes a bug is worse than none.** `check_models.mjs`
  asserted an over-broad retirement rule and so enforced the bug it should
  have caught. When a check fails on a legitimate change, ask whether the
  check or the code is wrong before changing either.
- **Stub the leaves, not the plumbing.** Replacing a dispatch function in a
  check leaves it replaced for the rest of the run and makes later assertions
  pass vacuously. That happened; it hid every Auto-mode assertion.
- **Say the true word.** Pushed is not merged, merged is not deployed,
  deployed is not verified. Never claim a step that was not observed.
