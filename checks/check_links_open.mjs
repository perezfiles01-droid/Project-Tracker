#!/usr/bin/env node
/**
 * Every link must open as a TAB in the window the reader is already in.
 *
 * window.open(url, "_blank", features) opens a stripped-down popup WINDOW
 * instead — one call in tasks.js did exactly that while the other six link
 * sites used a plain anchor. Files are enumerated at runtime, so an asset
 * added tomorrow is covered without editing this check.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { executableCode as code } from "./lib/code.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");

let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

/** Strip comments and quoted strings so a mention in prose is not a hit. */

/**
 * Comments out, strings and templates kept - attributes live inside those.
 *
 * This was a second, hand-rolled state machine that did not know what a regex
 * literal is, and lib/code.mjs exists because of exactly that bug: esc() in
 * five of these modules is /[&<>"']/g, whose " opens a string that never
 * closes, and everything after line 12 of ui.js was mis-stripped. It went
 * unnoticed for as long as ui.js happened to contain no target="_blank" to
 * miscount - the first one added was counted out of a DOC COMMENT, and this
 * check failed on prose, which is the very failure the comment above its own
 * self-test says it was already fixed once for.
 *
 * So there is no second copy any more. The shared one is regex-aware, is
 * self-tested against the real files, and cannot drift from the version the
 * popup check on the line above already uses.
 */
const stripComments = (src) => code(src, true);

const files = readdirSync(assets).filter((f) => f.endsWith(".js"));
ok("found the asset files to check", files.length > 0, files.join(", "));

for (const f of files) {
  const src = readFileSync(join(assets, f), "utf8");
  const exec = code(src);

  // The scanner must not have swallowed the file: something real has to remain.
  ok(`${f}: scanner kept the executable source`, exec.includes("function") || exec.includes("=>"),
     `${exec.length} of ${src.length} chars`);

  // window.open with a third argument is the popup shape.
  const popups = [...exec.matchAll(/window\.open\s*\(([^)]*)\)/g)]
    .filter((m) => m[1].split(",").length > 2);
  ok(`${f}: no window.open with a features argument`, popups.length === 0,
     popups.map((m) => m[0]).join(" | "));

  // Anchors that open elsewhere must also carry rel="noopener".
  //
  // Counted over the source with COMMENTS stripped but strings kept: the
  // first version of this check counted raw source, so the phrase
  // target="_blank" written in a comment above the fix registered as a real
  // anchor and the check failed on prose. It also missed the property form
  // (a.target = "_blank"), which is how the attachment opener is written.
  const noComments = stripComments(src);
  const count = (attr, val) =>
    (noComments.match(new RegExp(`${attr}\\s*=\\s*"${val}"`, "g")) || []).length;
  const blanks = count("target", "_blank");
  const rels = count("rel", "noopener");
  ok(`${f}: every target="_blank" carries rel="noopener"`, blanks === rels,
     `${blanks} blank vs ${rels} noopener`);
}

/* ---------------------------------------------------------------------------
   No handler may slice a "kind:id" attribute by a hand-counted length.

   drive.js carried unpin(...dataset.remove.slice(7)) where "drive:" is six
   characters, so Remove passed a truncated id, matched nothing and silently
   did nothing. Ten sites counted the prefix by hand and one was wrong; the
   shared TrackerUI.actionId helper replaced all of them. Files are
   enumerated at runtime, so a module added tomorrow is covered.
--------------------------------------------------------------------------- */
for (const f of files) {
  const exec = code(readFileSync(join(assets, f), "utf8"));
  const counted = [...exec.matchAll(/dataset\.(edit|remove|pick|open)\s*\.\s*slice\s*\(\s*\d+/g)];
  ok(`${f}: no hand-counted prefix slice on a data attribute`, counted.length === 0,
     counted.map((m) => m[0]).join(" | "));
}

// The stripper is machinery this check leans on, so it is tested directly
// against the real files rather than only on synthetic snippets.
for (const f of files) {
  const src = readFileSync(join(assets, f), "utf8");
  const kept = stripComments(src);
  ok(`${f}: stripper kept the real source`, kept.length > src.length * 0.4,
     `${kept.length} of ${src.length} chars`);
}
ok("stripper drops a comment", !stripComments('// target="_blank"\nx').includes("_blank"));
ok("stripper keeps a string", stripComments('const a = "target=\\"_blank\\"";').includes("_blank"));
ok("stripper keeps a template", stripComments("const a = `target=\"_blank\"`;").includes("_blank"));

console.log(failed ? `\n${failed} link-opening check(s) failed` : "\nPASS: links open as tabs");
process.exit(failed ? 1 : 0);
