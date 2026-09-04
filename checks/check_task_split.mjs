#!/usr/bin/env node
/**
 * Guard: three columns, and nothing lost behind them.
 *
 * Cutting a table down is the easy half. The half that goes wrong quietly is
 * the field that was in a column yesterday and is now in neither the table nor
 * the pane - visible nowhere, still in storage, and impossible to notice
 * without looking for it by name. So every field the table dropped is asserted
 * present in the pane, by label.
 *
 * The detail must also open BESIDE the list rather than under it, which is the
 * thing that was asked for; a pane that renders while a detail row also
 * appears would pass a naive "the pane exists" check.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);

await page.evaluate(() => localStorage.setItem("tracker.tasks", JSON.stringify([
  { id: "t-1", name: "First task", project: "GLASS", description: "Something to do",
    given: "2026-09-01", due: "2026-09-30", ref: "https://example.test/ref",
    status: "In progress", assignee: "Jim", attachments: [] },
  { id: "t-2", name: "Second task", project: "EDRMS ADB", attachments: [], status: "To do" },
])));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(300);

/* --- the table is three columns ------------------------------------------- */
const headers = await page.$$eval("table.tasktable thead th", (th) => th.map((h) => h.innerText.trim()));
ok("the table shows exactly three columns", headers.length === 3, headers.join(" | "));
ok("they are Task No., Name of task and Project",
   /task no/i.test(headers[0]) && /name of task/i.test(headers[1]) && /project/i.test(headers[2]),
   headers.join(" | "));
const cells = await page.$$eval("tr.taskrow:first-child td", (td) => td.length);
ok("the rows carry three cells too", cells === 3, String(cells));

/* --- with nothing selected the pane says so ------------------------------- */
ok("the pane is there before anything is clicked",
   (await page.locator(".taskpane").count()) === 1);
ok("it says what to do", /click a task/i.test(await page.locator(".taskpane").innerText()),
   (await page.locator(".taskpane").innerText()).slice(0, 60));

/* --- clicking opens BESIDE the list, not under it ------------------------- */
await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(300);
ok("clicking a task fills the pane", (await page.locator(".taskpane .taskdetail").count()) === 1);
ok("nothing is inserted into the table itself",
   (await page.locator("table.tasktable tr.detail").count()) === 0);

// Beside, not below: the pane's left edge is to the right of the table's.
const geom = await page.evaluate(() => {
  const t = document.querySelector(".tasklist").getBoundingClientRect();
  const p = document.querySelector(".taskpane").getBoundingClientRect();
  return { tableRight: t.right, paneLeft: p.left, paneTop: p.top, tableTop: t.top };
});
ok("the pane sits beside the list, not under it",
   geom.paneLeft >= geom.tableRight - 2 && Math.abs(geom.paneTop - geom.tableTop) < 120,
   JSON.stringify(geom));

/* --- every field the table dropped is still reachable --------------------- */
const paneText = await page.locator(".taskpane").innerText();
for (const label of ["Task Create Date", "Due Date", "Reference link", "Status",
                     "Assignee", "Description", "Attachments"]) {
  ok(`the pane still carries ${label}`, paneText.includes(label),
     paneText.replace(/\s+/g, " ").slice(0, 70));
}
ok("the values are there, not just the labels",
   paneText.includes("2026-09-30") && paneText.includes("Jim") &&
   paneText.includes("Something to do"),
   paneText.replace(/\s+/g, " ").slice(0, 100));

/* --- clicking a second task swaps the pane -------------------------------- */
await page.locator("tr.taskrow").nth(1).click();
await page.waitForTimeout(300);
const second = await page.locator(".taskpane").innerText();
ok("clicking another task shows that one instead",
   second.includes("Second task") && !second.includes("Something to do"),
   second.replace(/\s+/g, " ").slice(0, 70));

/* --- narrow screens stack rather than splitting --------------------------- */
await page.setViewportSize({ width: 700, height: 1000 });
await page.waitForTimeout(300);
const stacked = await page.evaluate(() => {
  const t = document.querySelector(".tasklist").getBoundingClientRect();
  const p = document.querySelector(".taskpane").getBoundingClientRect();
  return p.top >= t.bottom - 4;
});
ok("on a narrow screen the pane stacks under the list", stacked);
await page.setViewportSize({ width: 1440, height: 1000 });

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} split-view check(s) failed`
                   : "\nPASS: three columns, and the rest of the task beside them");
process.exit(failed ? 1 : 0);
