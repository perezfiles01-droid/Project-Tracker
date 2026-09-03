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
// Each page owns its search now; the header box was removed.
await page.fill('#view [data-search]', "Pinned link 1");
await page.waitForTimeout(200);
const stranded = await page.evaluate(() =>
  !!document.querySelector("table.cellgrid") &&
  document.querySelectorAll("table.cellgrid tbody td:not(.pad)").length === 0);
ok("a shrinking search never leaves an empty page", !stranded);
await page.fill('#view [data-search]', "");
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
await page.fill('#view [data-search]', "");
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
   The To Do List is a table now: six named columns, every field optional,
   and a row that expands in place to show its description.
--------------------------------------------------------------------------- */
await page.click('button[data-route="todo"]');
await page.waitForSelector("#view");
await page.click('[data-edit="task:new"]');
await page.waitForSelector("#formDialog .box");
await page.fill("#fd_description", "Draft the release note");
await page.fill("#fd_due", "2020-01-01");            // past, to prove the overdue flag
await page.fill("#fd_ref", "https://example.test/ref");
await page.click('[data-fd="save"]');
await page.waitForSelector("table.tasktable");

const taskHeads = await page.locator("table.tasktable thead th").allTextContents();
// The description moved into the row's detail; the table names the task and
// says which project it belongs to.
const wantTasks = ["Task No.", "Name of task", "Project", "Task Given Date", "Due Date", "Reference link"];
ok("the task table carries exactly the six named columns",
   JSON.stringify(taskHeads.map((h) => h.replace(/[ ↑↓]+$/, ""))) === JSON.stringify(wantTasks),
   taskHeads.join(" · "));
ok("a new task appears as a row", (await page.locator("tr.taskrow").count()) === 1);
ok("a past due date is flagged overdue", (await page.locator("tr.taskrow .tag.warn").count()) === 1);
ok("the reference link opens in a tab",
   (await page.getAttribute('tr.taskrow a.btn', "target")) === "_blank");

// Every field optional: a task with nothing filled in must still save.
await page.click('[data-edit="task:new"]');
await page.waitForSelector("#formDialog .box");
await page.click('[data-fd="save"]');
await page.waitForTimeout(150);
ok("a task saves with every field left blank", (await page.locator("tr.taskrow").count()) === 2);
ok("Task No. is filled in for you",
   (await page.locator("tr.taskrow td").first().textContent()).trim() !== "—");

// Clicking a row shows the description.
ok("no detail is shown before a row is clicked", (await page.locator("tr.detail").count()) === 0);
await page.click("tr.taskrow td:nth-child(2)");
await page.waitForTimeout(120);
ok("clicking a row reveals its description",
   (await page.locator("tr.detail").innerText()).includes("Draft the release note"));

// Sorting, from the shared helper.
await page.click('table.tasktable th[data-sortfield="no"]');
await page.waitForTimeout(120);
const firstAsc = (await page.locator("tr.taskrow td").first().textContent()).trim();
await page.click('table.tasktable th[data-sortfield="no"]');
await page.waitForTimeout(120);
const firstDesc = (await page.locator("tr.taskrow td").first().textContent()).trim();
ok("a column header sorts and reverses", firstAsc !== firstDesc, `${firstAsc} then ${firstDesc}`);

await page.reload({ waitUntil: "load" });
await page.click('button[data-route="todo"]');
await page.waitForSelector("table.tasktable");
ok("tasks survive a reload", (await page.locator("tr.taskrow").count()) === 2);

/* ---------------------------------------------------------------------------
   Daily activity is a log: empty to start, and fed by finishing a task.
--------------------------------------------------------------------------- */
await page.click('button[data-route="daily"]');
await page.waitForSelector("#view");
ok("Daily activity starts empty — the 34 workbook rows are gone",
   (await page.locator("#view table tbody tr").count()) === 0,
   (await page.locator("#view").innerText()).slice(0, 80));

await page.click('button[data-route="todo"]');
await page.waitForSelector("table.tasktable");
await page.click("tr.taskrow td:nth-child(2)");
await page.waitForSelector("[data-done]");
await page.click("[data-done]");
await page.waitForTimeout(150);
await page.click('button[data-route="daily"]');
await page.waitForTimeout(150);
ok("finishing a task logs exactly one activity",
   (await page.locator("#view table tbody tr").count()) === 1,
   String(await page.locator("#view table tbody tr").count()));
ok("the entry names the task",
   (await page.locator("#view table").innerText()).includes("Draft the release note"));

await page.reload({ waitUntil: "load" });
await page.click('button[data-route="daily"]');
await page.waitForTimeout(200);
ok("the activity entry survives a reload",
   (await page.locator("#view table tbody tr").count()) === 1);

// A manual entry, for work that never was a task.
await page.click('[data-edit="act:new"]');
await page.waitForSelector("#formDialog .box");
await page.fill("#fd_task", "Something I did by hand");
await page.click('[data-fd="save"]');
await page.waitForTimeout(150);
ok("a manual entry can be logged",
   (await page.locator("#view table").innerText()).includes("Something I did by hand"));

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
   Projects: a paginated table three across, with the picked project's tables
   opening UNDERNEATH rather than replacing the tiles.
--------------------------------------------------------------------------- */
await page.click('button[data-route="overview"]');
await page.waitForSelector("table.cellgrid");
ok("the page is headed Projects",
   (await page.locator("h2.page").first().textContent()).trim() === "Projects");
ok("Overview shows no KPI stat row", (await page.locator(".stats").count()) === 0);

const projCols = Number(readFileSync(join(root, "assets/links.js"), "utf8")
  .match(/PROJ_COLS\s*=\s*(\d+)/)[1]);
const wide = await page.evaluate(() =>
  Math.max(...[...document.querySelectorAll("#view table.cellgrid tbody tr")]
    .map((r) => r.children.length)));
ok(`the projects table is ${projCols} across`, wide === projCols, `saw ${wide}`);
ok("Google Drive is not a project tile",
   !(await page.locator("#view table.cellgrid").innerText()).includes("Google Drive"));

ok("no link table is open before a project is picked",
   (await page.locator("table.linktable").count()) === 0);
await page.click('[data-pick="edrms-adb"]');
await page.waitForSelector("table.linktable");
ok("the projects table is still on screen with the tables open",
   (await page.locator("#view table.cellgrid").count()) === 1);
ok("EDRMS ADB opens its two workbook tables",
   (await page.locator("section.linksection").count()) === 2,
   String(await page.locator("section.linksection").count()));

const heads = await page.locator("table.linktable").first().locator("thead th").allTextContents();
ok("the link table carries Site / Description / Email Access / Link",
   JSON.stringify(heads.slice(0, 4).map((h) => h.replace(/[ ↑↓]+$/, "")))
     === JSON.stringify(["Site", "Description", "Email Access", "Link"]),
   heads.join(" · "));

// Per-section search: one box must not filter another table.
const firstSection = page.locator("section.linksection").first();
const before = await firstSection.locator("tbody tr").count();
const otherBefore = await page.locator("section.linksection").nth(1).locator("tbody tr").count();
await firstSection.locator("[data-search]").fill("zzz-no-such-site");
await page.waitForTimeout(200);
ok("a section search filters its own table",
   (await page.locator("section.linksection").first().locator("tbody tr").count()) < before);
ok("a section search leaves the other table alone",
   (await page.locator("section.linksection").nth(1).locator("tbody tr").count()) === otherBefore);
await page.locator("section.linksection").first().locator("[data-search]").fill("");
await page.waitForTimeout(200);

// The Email Access dropdown offers exactly the accounts present.
const picker = page.locator("section.linksection").first().locator("[data-account]");
const offered = (await picker.locator("option").allTextContents()).slice(1);
const present = await page.evaluate(() => [...new Set(
  [...document.querySelectorAll("section.linksection")[0].querySelectorAll("tbody tr td:nth-child(3)")]
    .map((td) => td.textContent.trim()).filter((t) => t && t !== "—"))]);
ok("the dropdown offers only accounts that are present",
   offered.every((o) => present.includes(o)), `${offered.length} offered`);

// Sorting Site alphabetically.
await page.click('section.linksection:first-of-type table.linktable th[data-sortfield="name"]');
await page.waitForTimeout(150);
const asc = await page.locator("section.linksection").first().locator("tbody tr td:first-child").first().textContent();
await page.click('section.linksection:first-of-type table.linktable th[data-sortfield="name"]');
await page.waitForTimeout(150);
const desc = await page.locator("section.linksection").first().locator("tbody tr td:first-child").first().textContent();
ok("Site sorts and reverses alphabetically", asc.trim() !== desc.trim(), `${asc.trim()} then ${desc.trim()}`);

// A table you name yourself, and a link moved into it.
await page.click("[data-newtable]");
await page.waitForSelector("#formDialog .box");
await page.fill("#fd_name", "UAT links");
await page.click('[data-fd="save"]');
await page.waitForTimeout(200);
// textContent, not innerText: h3.sec is text-transform:uppercase, so innerText
// reports the RENDERED casing ("UAT LINKS") and a case-sensitive compare fails
// against an app that is behaving correctly.
ok("a table you name appears", (await page.locator("#view").textContent()).includes("UAT links"));
await page.reload({ waitUntil: "load" });
await page.waitForSelector("table.cellgrid");
await page.click('[data-pick="edrms-adb"]');
await page.waitForTimeout(200);
ok("the created table survives a reload", (await page.locator("#view").textContent()).includes("UAT links"));

const uat = page.locator("section.linksection").filter({ hasText: "UAT links" }).first();
await uat.locator("[data-addto]").click();
await page.waitForSelector("#formDialog .box");
await page.fill("#fd_name", "A UAT site");
await page.fill("#fd_url", "https://example.test/uat");
await page.click('[data-fd="save"]');
await page.waitForTimeout(200);
ok("a link added to that table lands in it",
   (await page.locator("section.linksection").filter({ hasText: "UAT links" }).first().innerText())
     .includes("A UAT site"));

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
