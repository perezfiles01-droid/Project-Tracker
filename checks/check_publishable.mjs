#!/usr/bin/env node
/**
 * Guard for what gets published.
 *
 * The Pages artifact is packed with tar from the repository root. A tracked
 * symlink pointing outside the repo - node_modules, created for the browser
 * checks - made tar exit 1 with "File removed before we read it", failing the
 * deploy while every other check stayed green. .gitignore said "node_modules/",
 * and a trailing slash matches directories only, so the symlink was tracked.
 *
 * Nothing here is hardcoded to that name: any tracked symlink, and any tracked
 * path that does not exist, fails the check.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

// Mode 120000 is a symlink in git's index.
const entries = execFileSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8" })
  .trim().split("\n").filter(Boolean)
  .map((l) => { const [meta, path] = l.split("\t"); return { mode: meta.split(" ")[0], path }; });

ok("the repository has tracked files", entries.length > 0, `${entries.length} tracked`);

const links = entries.filter((e) => e.mode === "120000");
ok("no symlink is tracked", links.length === 0,
   links.map((l) => l.path).join(", "));

const missing = entries.filter((e) => !existsSync(join(root, e.path)));
ok("every tracked path exists on disk", missing.length === 0,
   missing.map((m) => m.path).join(", "));

const outside = entries.filter((e) => {
  try { return lstatSync(join(root, e.path)).isSymbolicLink(); } catch { return false; }
});
ok("no tracked path is a symlink on disk", outside.length === 0,
   outside.map((o) => o.path).join(", "));

console.log(failed ? `\n${failed} publishable check(s) failed` : "\nPASS: nothing unpublishable is tracked");
process.exit(failed ? 1 : 0);
