#!/usr/bin/env node
/**
 * Structural guard for the rendered views.
 *
 * Every view in this app returns an HTML string built from template literals.
 * An unclosed container there does not throw and does not warn — the browser
 * silently nests whatever follows inside it, so the page renders, wrongly.
 * That is exactly how the Drive page came to stack 50 file cards in a single
 * column: two <div class="grid"> were opened and neither was closed.
 *
 * This check counts tags inside template literals only, so a tag mentioned in
 * a comment or in a quoted attribute string cannot create a false result.
 *
 * The files are enumerated at runtime — a view added tomorrow is covered
 * without anyone remembering to list it here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");

/**
 * Return the concatenated contents of every template literal in `src`.
 *
 * Hand-rolled rather than regex: template literals nest (`${cond ? `a` : `b`}`),
 * and a regex cannot track that. Walks the source tracking whether it is in a
 * comment, a quoted string, or a template, and collects only template text.
 */
export function templateText(src) {
  let out = "";
  let i = 0;
  // Stack of template-literal depths; each ${ } can open further templates.
  const tmpl = [];
  let inLine = false, inBlock = false, quote = null;
  // Last significant character, used to tell a regex literal from a division.
  let prev = "";

  while (i < src.length) {
    const c = src[i], next = src[i + 1];

    if (inLine) { if (c === "\n") inLine = false; i++; continue; }
    if (inBlock) { if (c === "*" && next === "/") { inBlock = false; i += 2; continue; } i++; continue; }
    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }

    const inTemplate = tmpl.length > 0 && tmpl[tmpl.length - 1].expr === 0;

    if (!inTemplate) {
      if (c === "/" && next === "/") { inLine = true; i += 2; continue; }
      if (c === "/" && next === "*") { inBlock = true; i += 2; continue; }
      // A regex literal may contain quotes and backticks (esc() uses /[&<>"']/g).
      // Missing them desynchronises the scanner and silently empties the output.
      if (c === "/" && "(,=:[!&|?{};+-*%~^".includes(prev)) { i = skipRegex(src, i); continue; }
      if (c === "'" || c === '"') { quote = c; i++; continue; }
    }

    if (c === "\\" && tmpl.length) { i += 2; continue; }

    if (c === "`") {
      if (inTemplate) tmpl.pop();
      else tmpl.push({ expr: 0 });
      i++; continue;
    }

    if (tmpl.length) {
      const top = tmpl[tmpl.length - 1];
      if (top.expr === 0 && c === "$" && next === "{") { top.expr = 1; i += 2; continue; }
      if (top.expr > 0) {
        if (c === "{") top.expr++;
        else if (c === "}") top.expr--;
        // Inside ${ } we are back in code: honour comments and quotes there.
        else if (c === "/" && next === "/") { inLine = true; i += 2; continue; }
        else if (c === "/" && next === "*") { inBlock = true; i += 2; continue; }
        else if (c === "/" && next === "/") { inLine = true; i += 2; continue; }
        else if (c === "/" && "(,=:[!&|?{};+-*%~^".includes(prev)) { i = skipRegex(src, i); prev = "/"; continue; }
        else if (c === "'" || c === '"') { quote = c; i++; continue; }
        if (!/\s/.test(c)) prev = c;
        i++; continue;
      }
      out += c;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Advance past a regex literal starting at `i`, honouring escapes and classes. */
function skipRegex(src, i) {
  i++; // consume the opening slash
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) { i++; break; }
    else if (c === "\n") break; // unterminated: not a regex after all
    i++;
  }
  while (i < src.length && /[a-z]/.test(src[i])) i++; // flags
  return i;
}

/** Split a source file into its named function bodies, crudely but adequately. */
function functions(src) {
  const found = [];
  const re = /(?:^|\n)\s*(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    let depth = 1, i = start;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    found.push({ name: m[1], body: src.slice(start, i - 1) });
  }
  return found;
}

const PAIRED = ["div", "table", "thead", "tbody", "tr", "td", "th", "ol", "ul", "li", "p", "a", "span", "button"];

export function imbalances(body) {
  const html = templateText(body);
  const bad = [];
  for (const tag of PAIRED) {
    const open = (html.match(new RegExp(`<${tag}\\b`, "g")) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
    if (open !== close) bad.push({ tag, open, close });
  }
  return bad;
}

function main() {
  const files = readdirSync(assets).filter((f) => f.endsWith(".js")).sort();
  if (files.length === 0) {
    console.error("FAIL: no asset scripts found — the guard is not looking at anything");
    process.exit(1);
  }

  let checked = 0, failures = 0;
  for (const file of files) {
    const src = readFileSync(join(assets, file), "utf8");
    for (const fn of functions(src)) {
      const html = templateText(fn.body);
      if (!/<\w/.test(html)) continue; // not a view — renders no markup
      checked++;
      const bad = imbalances(fn.body);
      if (bad.length) {
        failures++;
        for (const b of bad) {
          console.error(
            `FAIL ${file} ${fn.name}(): <${b.tag}> opened ${b.open}x, closed ${b.close}x ` +
            `(${b.open - b.close > 0 ? "missing " + (b.open - b.close) + " closing" : "extra " + (b.close - b.open) + " closing"})`
          );
        }
      }
    }
  }

  console.log(`checked ${checked} markup-producing function(s) across ${files.length} script(s)`);
  if (failures) {
    console.error(`\n${failures} function(s) produce unbalanced markup.`);
    process.exit(1);
  }
  console.log("PASS: all views produce balanced markup");
}

if (process.argv[1] && process.argv[1].endsWith("check_views.mjs")) main();
