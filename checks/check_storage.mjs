#!/usr/bin/env node
/**
 * One module owns storage, and the backup carries everything it owns.
 *
 * Eleven keys were read and written by twenty-five direct localStorage calls
 * across five files. Nothing owned the list, so a "save everything" feature
 * had nothing to enumerate and a key added later would be missed silently -
 * discovered only when a restore came back short.
 *
 * Two invariants:
 *   1. no module outside store.js touches localStorage (static, files
 *      enumerated at runtime)
 *   2. every key any module actually uses is declared in store.js, so it is
 *      in the backup
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

/** Comments and strings out, so a mention in prose is never a hit. */

const files = readdirSync(assets).filter((f) => f.endsWith(".js"));
ok("asset files were found", files.length > 0, files.join(", "));

for (const f of files) {
  const src = readFileSync(join(assets, f), "utf8");
  const exec = code(src);
  // The stripper is machinery every assertion below leans on, so it is tested
  // on the real file: something known to execute must survive it.
  ok(`${f}: stripper kept the executable source`,
     exec.includes("window.") && (exec.includes("function") || exec.includes("=>")),
     `${exec.length} of ${src.length} chars`);
  if (f === "store.js") continue;
  const hits = [...exec.matchAll(/localStorage\s*\.\s*\w+/g)].map((m) => m[0]);
  ok(`${f}: goes through TrackerStore, not localStorage`, hits.length === 0, hits.join(" | "));
}

// Every key any module names must be declared, or the backup misses it.
const store = readFileSync(join(assets, "store.js"), "utf8");
const declared = new Set([...store.matchAll(/"(tracker\.[A-Za-z]+)"/g)].map((m) => m[1]));
ok("store.js declares keys", declared.size > 0, [...declared].join(", "));

const used = new Set();
for (const f of files) {
  if (f === "store.js") continue;
  const src = readFileSync(join(assets, f), "utf8");
  // Only string literals assigned to a const, i.e. real key definitions.
  for (const m of src.matchAll(/=\s*"(tracker\.[A-Za-z]+)"/g)) used.add(m[1]);
}
ok("keys are actually used somewhere", used.size > 0, [...used].join(", "));
for (const k of used) {
  ok(`"${k}" is declared in store.js, so the backup carries it`, declared.has(k));
}

/* The stripper's own edge cases, stated rather than assumed. A regex holding a
   quote is the one that actually broke this check: esc() is /[&<>"']/g. */
ok("stripper survives a regex containing a quote",
   code(`const esc = /[&<>"']/g;\nlocalStorage.getItem(x);`).includes("localStorage"));
ok("stripper drops a line comment",
   !code("// localStorage.getItem(x)\nconst a = 1;").includes("localStorage"));
ok("stripper drops a block comment",
   !code("/* localStorage.getItem(x) */\nconst a = 1;").includes("localStorage"));
ok("stripper drops a quoted mention",
   !code('const s = "localStorage.getItem";').includes("localStorage"));
ok("stripper drops a templated mention",
   !code("const s = `localStorage.getItem`;").includes("localStorage"));
ok("stripper keeps a real call after a template",
   code("const s = `x`; localStorage.setItem(a, b);").includes("localStorage"));

console.log(failed ? `\n${failed} storage check(s) failed` : "\nPASS: storage is owned by one module");
process.exit(failed ? 1 : 0);
