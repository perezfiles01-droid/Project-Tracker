/**
 * Source with comments, strings and template literals removed, leaving what
 * actually executes.
 *
 * The naive version of this - track quotes, track backticks, done - is wrong
 * on any file containing a regex literal that holds a quote. esc() in five of
 * these modules is /[&<>"']/g: a stripper that does not know about regex
 * literals reads that " as the start of a string, desynchronises, and swallows
 * the rest of the file. Every check built on it then reports nothing, which is
 * indistinguishable from a clean sweep. That is not hypothetical here - it
 * silently hid a planted raw localStorage call in tasks.js.
 */
export function executableCode(src) {
  let out = "", i = 0;
  let quote = null, tpl = 0, line = false, block = false;
  let prev = "";                       // last significant char, to spot a regex
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
    // A "/" here starts a regex only where a value cannot precede it.
    if (c === "/" && "(,=:[!&|?{};+-*%~^".includes(prev)) { i = skipRegex(src, i); continue; }
    if (c === "'" || c === '"') { quote = c; i++; continue; }
    if (c === "`") { tpl++; i++; continue; }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Index just past a regex literal beginning at `start`, character class aware. */
function skipRegex(src, start) {
  let i = start + 1, inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) { i++; break; }
    else if (c === "\n") break;               // not a regex after all
    i++;
  }
  while (i < src.length && /[a-z]/.test(src[i])) i++;   // flags
  return i;
}
