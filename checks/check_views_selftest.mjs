#!/usr/bin/env node
/**
 * Tests the guard's own scanner, against the REAL asset files as well as
 * planted cases.
 *
 * A tag scanner that silently swallows source makes every view look balanced,
 * which is indistinguishable from protection. So: prove it keeps real markup,
 * prove it excludes real code, prove it catches a planted fault, and prove it
 * does NOT flag the near-miss shapes (a tag in a comment, a tag in a quoted
 * attribute string) that would otherwise get this check disabled as noisy.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { templateText, imbalances } from "./check_views.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail && !cond ? " — " + detail : ""}`);
  if (!cond) failed++;
};

// --- against the real files -------------------------------------------------
const app = readFileSync(join(root, "assets/app.js"), "utf8");
const appHtml = templateText(app);

ok("real app.js: keeps markup that is really there", appHtml.includes('class="nav-title"'));
ok("real app.js: keeps the tablewrap container", appHtml.includes('class="tablewrap"'));
ok("real app.js: excludes code outside templates", !appHtml.includes("const state ="));
ok("real app.js: did not swallow the file", appHtml.length > 500 && appHtml.length < app.length,
   `extracted ${appHtml.length} of ${app.length} chars`);

const drive = readFileSync(join(root, "assets/drive.js"), "utf8");
const driveHtml = templateText(drive);
ok("real drive.js: keeps the pinned table markup", driveHtml.includes('class="cellgrid"'));
ok("real drive.js: keeps the files table markup", driveHtml.includes('class="filetable"'));

// The pager moved to the shared layer; assert it there rather than in drive.js,
// and cover the other markup-producing files so none can be silently swallowed.
const ui = readFileSync(join(root, "assets/ui.js"), "utf8");
const uiHtml = templateText(ui);
ok("real ui.js: keeps the pager markup", uiHtml.includes('class="pager"'));
ok("real ui.js: keeps the dialog field markup", uiHtml.includes('class="field"'));
ok("real ui.js: did not swallow the file", uiHtml.length > 300 && uiHtml.length < ui.length,
   `extracted ${uiHtml.length} of ${ui.length} chars`);

const links = readFileSync(join(root, "assets/links.js"), "utf8");
const linksHtml = templateText(links);
ok("real links.js: keeps the projects grid markup", linksHtml.includes('class="cellgrid"'));
ok("real links.js: keeps the section search markup", linksHtml.includes('class="search sectionsearch"'));
ok("real links.js: keeps the link table markup", linksHtml.includes('class="linktable"'));
ok("real links.js: did not swallow the file", linksHtml.length > 300 && linksHtml.length < links.length,
   `extracted ${linksHtml.length} of ${links.length} chars`);

const tasks = readFileSync(join(root, "assets/tasks.js"), "utf8");
const tasksHtml = templateText(tasks);
ok("real tasks.js: keeps the task table markup", tasksHtml.includes('class="tasktable"'));
ok("real tasks.js: did not swallow the file", tasksHtml.length > 300 && tasksHtml.length < tasks.length,
   `extracted ${tasksHtml.length} of ${tasks.length} chars`);

// --- planted cases ----------------------------------------------------------
ok("catches a genuinely unclosed div",
   imbalances("f(){ return `<div class=\"grid\"><span>x</span>`; }").some((b) => b.tag === "div"));

ok("passes balanced markup",
   imbalances("f(){ return `<div class=\"grid\"><span>x</span></div>`; }").length === 0);

// Near misses: these must NOT be reported, or the check gets ignored.
ok("ignores a tag inside a line comment",
   imbalances("f(){ // </div> left over from an edit\n return `<div>x</div>`; }").length === 0);

ok("ignores a tag inside a block comment",
   imbalances("f(){ /* <div> not real markup */ return `<div>x</div>`; }").length === 0);

ok("ignores a tag inside a plain quoted string",
   imbalances('f(){ const s = "<div>"; return `<div>x</div>`; }').length === 0);

ok("handles nested templates in ${ }",
   imbalances("f(){ return `<div>${c ? `<span>a</span>` : `<span>b</span>`}</div>`; }").length === 0);

ok("catches an imbalance inside a nested template",
   imbalances("f(){ return `<div>${c ? `<span>a` : ``}</div>`; }").some((b) => b.tag === "span"));

console.log(failed ? `\n${failed} self-test(s) failed` : "\nPASS: scanner behaves on real files and planted cases");
process.exit(failed ? 1 : 0);
