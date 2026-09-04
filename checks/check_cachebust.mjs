#!/usr/bin/env node
/**
 * Guard: a deploy can never serve new HTML with old JavaScript.
 *
 * GitHub Pages revalidates HTML sooner than it revalidates assets/*.js. For a
 * window after each deploy a returning visitor gets the new index.html wired
 * to the previous deploy's scripts, and the failure is SILENT: no console
 * error, no missing file, just controls rendering empty because the code
 * behind them is a version older than the markup. That happened once and was
 * reproduced by pairing a new index.html with the previous drive.js.
 *
 * scripts/stamp_assets.py makes the URL change with the commit. This asserts:
 *   1. every local asset reference in every served page gets stamped
 *   2. external URLs and already-stamped URLs are left alone
 *   3. the Pages workflow actually RUNS the stamper before uploading - a
 *      stamping step that is never called is exactly the silent failure this
 *      check exists to prevent
 *
 * References are enumerated from the real HTML, so a script tag added later
 * is covered without this file being edited.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

/** Every local .js/.css reference in a page, the same shape the stamper matches. */
const LOCAL = /(?:src|href)="((?!https?:\/\/|\/\/|#|data:)[^"?]+\.(?:js|css))"/g;
const refs = (html) => [...html.matchAll(LOCAL)].map((m) => m[1]);

/* --- the workflow must actually call it, before the upload --- */
const wf = readFileSync(join(root, ".github/workflows/pages.yml"), "utf8");
const stampAt = wf.indexOf("stamp_assets.py");
const uploadAt = wf.indexOf("upload-pages-artifact");
ok("the Pages workflow runs the stamper", stampAt !== -1);
ok("it runs before the artifact is uploaded",
   stampAt !== -1 && uploadAt !== -1 && stampAt < uploadAt,
   `stamp at ${stampAt}, upload at ${uploadAt}`);

/* --- run it on a copy, and check every reference it should have stamped --- */
const work = mkdtempSync(join(tmpdir(), "stamp-"));
cpSync(root, work, {
  recursive: true,
  filter: (src) => !src.includes("node_modules") && !src.includes("/.git/"),
});
const before = {};
for (const f of readdirSync(work).filter((f) => f.endsWith(".html") && f !== "Tracker-standalone.html")) {
  before[f] = readFileSync(join(work, f), "utf8");
}
ok("served pages were found to stamp", Object.keys(before).length > 0,
   Object.keys(before).join(", "));

execFileSync("python3", [join(work, "scripts/stamp_assets.py"), "GUARDSHA"],
             { cwd: work, encoding: "utf8" });

let checked = 0;
for (const [file, original] of Object.entries(before)) {
  const after = readFileSync(join(work, file), "utf8");
  for (const ref of refs(original)) {
    checked++;
    ok(`${file}: ${ref} is stamped`, after.includes(`${ref}?v=GUARDSHA`));
  }
  // Anything the page pulls from elsewhere must be untouched.
  for (const ext of [...original.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1])) {
    ok(`${file}: the external ${new URL(ext).host} is untouched`, after.includes(`"${ext}"`));
  }
}
ok("asset references were actually checked", checked > 0, `${checked} references`);

/* --- stamping twice must not double-stamp --- */
execFileSync("python3", [join(work, "scripts/stamp_assets.py"), "SECOND"],
             { cwd: work, encoding: "utf8" });
const twice = readFileSync(join(work, "index.html"), "utf8");
ok("running it again does not stamp a stamped URL", !twice.includes("?v=GUARDSHA?v="));
ok("the first stamp still stands after a second run", twice.includes("?v=GUARDSHA"));

/* --- a page with nothing to stamp must fail loudly, not silently pass --- */
writeFileSync(join(work, "index.html"), "<html><body>nothing here</body></html>");
writeFileSync(join(work, "404.html"), "<html><body>nor here</body></html>");
let exitCode = 0;
try {
  execFileSync("python3", [join(work, "scripts/stamp_assets.py"), "X"],
               { cwd: work, encoding: "utf8", stdio: "pipe" });
} catch (e) { exitCode = e.status; }
ok("a page with no assets is reported, not passed over", exitCode !== 0, `exit ${exitCode}`);

console.log(failed ? `\n${failed} cache-busting check(s) failed`
                   : "\nPASS: a deploy cannot serve new HTML with old JavaScript");
process.exit(failed ? 1 : 0);
