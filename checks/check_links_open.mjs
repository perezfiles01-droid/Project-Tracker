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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");

let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

/** Strip comments and quoted strings so a mention in prose is not a hit. */
function code(src) {
  let out = "", i = 0, quote = null, tpl = 0, line = false, block = false, prev = "";
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (line) { if (c === "\n") { line = false; out += c; } i++; continue; }
    if (block) { if (c === "*" && n === "/") { block = false; i += 2; } else i++; continue; }
    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }
    if (tpl) {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") tpl--;
      i++; continue;
    }
    if (c === "/" && n === "/") { line = true; i += 2; continue; }
    if (c === "/" && n === "*") { block = true; i += 2; continue; }
    if (c === "'" || c === '"') { quote = c; i++; continue; }
    if (c === "`") { tpl++; i++; continue; }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Comments out, strings and templates kept — attributes live inside those. */
function stripComments(src) {
  let out = "", i = 0, quote = null, tpl = 0, line = false, block = false;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (line) { if (c === "\n") { line = false; out += c; } i++; continue; }
    if (block) { if (c === "*" && n === "/") { block = false; i += 2; } else i++; continue; }
    if (quote) {
      if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (tpl) {
      if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === "`") tpl--;
      out += c; i++; continue;
    }
    if (c === "/" && n === "/") { line = true; i += 2; continue; }
    if (c === "/" && n === "*") { block = true; i += 2; continue; }
    if (c === "'" || c === '"') { quote = c; out += c; i++; continue; }
    if (c === "`") { tpl++; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

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
