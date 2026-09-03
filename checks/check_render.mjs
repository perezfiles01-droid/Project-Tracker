#!/usr/bin/env node
/**
 * Behavioural guard for the paged tables on the Drive page.
 *
 * Balanced markup is not enough: a table can be well formed and still show
 * the wrong number of rows, lose its buttons after paging, or strand the
 * reader on an empty page when a search shrinks the list. This drives the
 * real page in a real browser and asserts the invariants.
 *
 * Page sizes are read from the source rather than hardcoded here, so the
 * check follows the app if the sizes change.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "assets/drive.js"), "utf8");
const num = (name) => {
  const m = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`could not read ${name} from drive.js — check has drifted from the app`);
  return Number(m[1]);
};
const COLS = num("PINNED_COLS"), ROWS = num("PINNED_ROWS"), FILES = num("FILES_PER_PAGE");
const PINNED = COLS * ROWS;

let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const url = "file://" + join(root, "Tracker-standalone.html");

// Seed more pinned links than fit on one page, then drive the pager.
await page.goto(url, { waitUntil: "load" });
await page.evaluate((n) => {
  const links = [];
  for (let i = 1; i <= n; i++) {
    links.push({ id: "p" + i, name: "Pinned link " + i, url: "https://example.test/" + i,
                 project: "Google Drive", meta: "manual", verified: true });
  }
  localStorage.setItem("tracker.driveLinks", JSON.stringify(links));
}, PINNED + 1);
await page.goto(url, { waitUntil: "load" });
await page.click('button[data-route="drive"]');
await page.waitForSelector("table.cellgrid");

const shape = async () => page.evaluate(() => {
  const t = document.querySelector("table.cellgrid");
  const rows = [...t.querySelectorAll("tbody tr")];
  return {
    rows: rows.length,
    cols: Math.max(...rows.map((r) => r.children.length)),
    filled: rows.reduce((n, r) => n + [...r.children].filter((c) => !c.classList.contains("pad")).length, 0),
  };
});

let s = await shape();
ok(`pinned page 1 has ${ROWS} rows`, s.rows === ROWS, `saw ${s.rows}`);
ok(`pinned page 1 has ${COLS} columns`, s.cols === COLS, `saw ${s.cols}`);
ok(`pinned page 1 holds ${PINNED} links`, s.filled === PINNED, `saw ${s.filled}`);
ok("Prev is disabled on the first page",
   await page.locator('[data-page="pinned:prev"]').isDisabled());

await page.click('[data-page="pinned:next"]');
await page.waitForTimeout(150);
s = await shape();
ok("pinned page 2 holds the remaining 1 link", s.filled === 1, `saw ${s.filled}`);
ok("pinned page 2 never exceeds the page size", s.filled <= PINNED);
ok("Next is disabled on the last page",
   await page.locator('[data-page="pinned:next"]').isDisabled());
ok("Remove button survives paging",
   (await page.locator('table.cellgrid [data-remove^="drive:"]').count()) === 1);

// A search that shrinks the list must not strand the reader on an empty page.
await page.fill("#q", "Pinned link 1");
await page.waitForTimeout(200);
const stranded = await page.evaluate(() =>
  !!document.querySelector("table.cellgrid") &&
  document.querySelectorAll("table.cellgrid tbody td:not(.pad)").length === 0);
ok("a shrinking search never leaves an empty page", !stranded);
await page.fill("#q", "");
await page.waitForTimeout(150);

// Files table: seed through the app's own render path.
await page.evaluate((n) => {
  const files = [];
  for (let i = 1; i <= n; i++) {
    files.push({ id: "f" + i, name: "File " + i, mimeType: "application/vnd.google-apps.document",
                 webViewLink: "https://example.test/f" + i, modifiedTime: "2026-08-0" + ((i % 9) + 1) + "T00:00:00Z" });
  }
  window.TrackerDrive._seed(files);
}, 50);
await page.waitForSelector("table.filetable");

const fileRows = async () => page.locator("table.filetable tbody tr").count();
ok(`files page 1 shows ${FILES} rows`, (await fileRows()) === FILES, `saw ${await fileRows()}`);

let seen = await fileRows();
for (let i = 0; i < 4; i++) {
  await page.click('[data-page="files:next"]');
  await page.waitForTimeout(120);
  const n = await fileRows();
  ok(`files page ${i + 2} shows no more than ${FILES} rows`, n <= FILES, `saw ${n}`);
  seen += n;
}
ok("paging reaches every one of the 50 files", seen === 50, `counted ${seen}`);
ok("Next is disabled on the final files page",
   await page.locator('[data-page="files:next"]').isDisabled());
ok("Pin buttons survive paging",
   (await page.locator("table.filetable [data-pin]").count()) > 0);

/* ---------------------------------------------------------------------------
   Family invariant: anything you can delete, you can also correct.

   Enumerated from the rendered DOM rather than from a list kept here, so an
   item type added tomorrow with a Remove button and no Edit button fails this
   check without anyone remembering to update it.
--------------------------------------------------------------------------- */
await page.fill("#q", "");
await page.waitForTimeout(150);
const orphans = await page.evaluate(() => {
  const edits = new Set([...document.querySelectorAll("[data-edit]")].map((b) => b.dataset.edit));
  return [...document.querySelectorAll("[data-remove]")]
    .map((b) => b.dataset.remove)
    .filter((key) => !edits.has(key));
});
ok("every removable item also has an Edit control", orphans.length === 0, orphans.join(", "));

/* ---------------------------------------------------------------------------
   Nav groups. The old renderNav emitted "Projects" at index 1 and nothing
   after, so every later entry fell under that heading. These assert the shape
   the old code got wrong.
--------------------------------------------------------------------------- */
const nav = await page.evaluate(() => {
  const out = [];
  let cur = null;
  for (const el of document.querySelector("#nav").children) {
    if (el.classList.contains("nav-title")) { cur = { title: el.textContent.trim(), items: [] }; out.push(cur); }
    else if (el.tagName === "BUTTON") {
      if (!cur) return { orphan: true };
      cur.items.push(el.querySelector("span").textContent.trim());
    }
  }
  return { groups: out };
});
ok("no nav button appears before the first heading", !nav.orphan);
const titles = (nav.groups || []).map((g) => g.title);
ok("nav headings are Index / Projects / Task / Drive",
   JSON.stringify(titles) === JSON.stringify(["Index", "Projects", "Task", "Drive"]), titles.join(" · "));
const flat = (nav.groups || []).flatMap((g) => g.items);
ok("every nav button sits under a heading",
   flat.length === (await page.locator("#nav button").count()));
const taskGroup = (nav.groups || []).find((g) => g.title === "Task");
ok("Task group holds To Do List and Daily activity",
   JSON.stringify(taskGroup && taskGroup.items) === JSON.stringify(["To Do List", "Daily activity"]),
   String(taskGroup && taskGroup.items));
ok("LHUB has left the sidebar", !flat.includes("LHUB"), flat.join(" · "));
ok("Communications has left the sidebar", !flat.includes("Communications"));

/* ---------------------------------------------------------------------------
   Tasks: a full add -> reload -> edit -> reload -> delete round trip, because
   a task that does not survive a refresh is worse than no task list at all.
--------------------------------------------------------------------------- */
await page.click('button[data-route="todo"]');
await page.waitForSelector(".taskboard");
ok("To Do List renders a column per status",
   (await page.locator(".taskcol").count()) === 4, String(await page.locator(".taskcol").count()));

await page.click('[data-edit="task:new"]');
await page.waitForSelector("#formDialog .box");
await page.fill("#fd_title", "Draft the release note");
await page.fill("#fd_description", "Summarise 2026.2 for the BA pack.");
await page.fill("#fd_deadline", "2020-01-01");   // in the past, to prove the overdue flag
await page.fill("#fd_assignee", "Me");
await page.click('[data-fd="save"]');
await page.waitForSelector(".card.task");
ok("a new task appears on the board", (await page.locator(".card.task").count()) === 1);
ok("a past deadline is flagged overdue", (await page.locator(".card.task.late").count()) === 1);

await page.reload({ waitUntil: "load" });
await page.click('button[data-route="todo"]');
await page.waitForSelector(".card.task");
ok("the task survives a reload",
   (await page.locator(".card.task .t").first().textContent()).includes("Draft the release note"));

await page.click(".card.task [data-edit]");
await page.waitForSelector("#formDialog .box");
await page.fill("#fd_title", "Draft the release note (v2)");
await page.click('[data-fd="save"]');
await page.waitForTimeout(150);
await page.reload({ waitUntil: "load" });
await page.click('button[data-route="todo"]');
await page.waitForSelector(".card.task");
ok("an edited title survives a reload",
   (await page.locator(".card.task .t").first().textContent()).includes("(v2)"));

// An attachment must survive a reload too: the bytes go to IndexedDB while the
// task record goes to localStorage, and a mismatch between the two loses files.
await page.click(".card.task [data-edit]");
await page.waitForSelector("#formDialog .box");
await page.setInputFiles("#fd_files", {
  name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("attachment body"),
});
await page.click('[data-fd="save"]');
await page.waitForSelector(".card.task .attchip");
await page.reload({ waitUntil: "load" });
await page.click('button[data-route="todo"]');
await page.waitForSelector(".card.task");
ok("an attachment survives a reload",
   (await page.locator(".card.task .attchip").count()) === 1);
ok("the attachment keeps its filename",
   (await page.locator(".card.task .attchip").first().textContent()).includes("note.txt"));

await page.click(".card.task [data-remove]");
await page.waitForTimeout(150);
ok("a deleted task is gone", (await page.locator(".card.task").count()) === 0);

/* ---------------------------------------------------------------------------
   Renaming a pinned link, the thing that used to cost a delete and a re-add.
--------------------------------------------------------------------------- */
await page.click('button[data-route="drive"]');
await page.waitForSelector("table.cellgrid");
await page.click('table.cellgrid [data-edit^="drive:"]');
await page.waitForSelector("#formDialog .box");
await page.fill("#fd_name", "Renamed without re-adding");
await page.click('[data-fd="save"]');
await page.waitForTimeout(150);
await page.reload({ waitUntil: "load" });
await page.click('button[data-route="drive"]');
await page.waitForSelector("table.cellgrid");
ok("a renamed pinned link survives a reload",
   (await page.locator("table.cellgrid").innerText()).includes("Renamed without re-adding"));

/* ---------------------------------------------------------------------------
   Theme. System had nothing to follow before: the stylesheet carried no
   prefers-color-scheme block and index.html hardcoded dark.
--------------------------------------------------------------------------- */
const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
await page.emulateMedia({ colorScheme: "light" });
await page.click('[data-theme-set="system"]');
await page.waitForTimeout(80);
const sysLight = await bg();
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForTimeout(80);
const sysDark = await bg();
ok("System follows the operating system", sysLight !== sysDark, `${sysLight} vs ${sysDark}`);

await page.click('[data-theme-set="light"]');
await page.waitForTimeout(80);
const light = await bg();
ok("Light overrides a dark system", light !== sysDark, `${light} vs ${sysDark}`);
await page.click('[data-theme-set="dark"]');
await page.waitForTimeout(80);
const dark = await bg();
ok("Dark differs from Light", dark !== light, `${dark} vs ${light}`);

await page.reload({ waitUntil: "load" });
await page.waitForTimeout(120);
ok("the theme choice survives a reload", (await bg()) === dark);
ok("the chosen segment is the pressed one",
   (await page.getAttribute('[data-theme-set="dark"]', "aria-pressed")) === "true");

ok("no console or page errors", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(failed ? `\n${failed} render check(s) failed` : "\nPASS: paged tables, nav groups, tasks and theme behave");
process.exit(failed ? 1 : 0);
