#!/usr/bin/env node
/**
 * Guard: four columns closed, two open, and nothing lost behind them.
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

/* --- with nothing open the table is four columns -------------------------- */
const heads = () => page.$$eval("table.tasktable thead th",
  (th) => th.map((h) => h.innerText.trim().replace(/[ \u2191\u2193]+$/, "")));
const headers = await heads();
ok("the table shows exactly four columns", headers.length === 4, headers.join(" | "));
ok("they are Task No., Name of task, Project and Task Create Date",
   /task no/i.test(headers[0]) && /name of task/i.test(headers[1]) &&
   /project/i.test(headers[2]) && /task create date/i.test(headers[3]),
   headers.join(" | "));
const cells = await page.$$eval("tr.taskrow:first-child td", (td) => td.length);
ok("the rows carry four cells too", cells === 4, String(cells));
// The date is the value, not the label: a column that renders an empty cell
// for every task reads exactly like a working one.
const dateCells = await page.$$eval("tr.taskrow td:nth-child(4)",
  (td) => td.map((c) => c.innerText.trim()));
ok("the date column carries the task's create date", dateCells[0] === "2026-09-01",
   dateCells.join(" | "));
ok("a task with no create date falls back to a dash rather than an empty cell",
   dateCells[1] === "\u2014", JSON.stringify(dateCells[1]));

/* --- closed, the list is the wide half, the pane about a quarter ----------
   Measured, not read from the stylesheet: a grid rule that is present but
   overridden by a later one reads as passing when only the CSS text is
   checked, which is how table.tasktable kept a min-width nothing applied. */
const split = () => page.evaluate(() => {
  const l = document.querySelector(".tasklist").getBoundingClientRect();
  const p = document.querySelector(".taskpane").getBoundingClientRect();
  return { lw: Math.round(l.width), pw: Math.round(p.width) };
});
const closed = await split();
ok("with nothing open the pane is well under half the list",
   closed.pw > 0 && closed.pw < closed.lw * 0.45, JSON.stringify(closed));

/* --- with nothing selected the pane says so ------------------------------- */
ok("the pane is there before anything is clicked",
   (await page.locator(".taskpane").count()) === 1);
ok("it says what to do", /click a task/i.test(await page.locator(".taskpane").innerText()),
   (await page.locator(".taskpane").innerText()).slice(0, 60));

/* --- clicking opens BESIDE the list, not under it ------------------------- */
await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(300);
ok("clicking a task fills the pane", (await page.locator(".taskpane .taskdetail").count()) === 1);

/* --- open, the list collapses to two columns and the pane takes the room -- */
const openHeaders = await heads();
ok("with a task open the table shows only two columns", openHeaders.length === 2,
   openHeaders.join(" | "));
ok("they are Task No. and Name of task",
   /task no/i.test(openHeaders[0]) && /name of task/i.test(openHeaders[1]),
   openHeaders.join(" | "));
ok("the rows carry two cells too",
   (await page.$$eval("tr.taskrow:first-child td", (td) => td.length)) === 2);
const opened = await split();
ok("with a task open the pane is the wider half", opened.pw > opened.lw,
   JSON.stringify(opened));
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

/* --- the page does not repeat where things are stored --------------------
   It was true, and it is still recorded in docs/ and in the Settings copy;
   what went is a caption on this page, not the knowledge. */
ok("the lede no longer says tasks are stored in this browser only",
   !(await page.locator("#view p.lede").first().innerText()).includes("stored in this browser"),
   await page.locator("#view p.lede").first().innerText());

/* --- the two halves are the same size, both ways round -------------------
   They each took their own height, so a short list sat beside a tall pane and
   a ten-row list sat beside a short one: 130px against 535px, measured. */
const boxes = () => page.evaluate(() => {
  const l = document.querySelector(".tasklist").getBoundingClientRect();
  const p = document.querySelector(".taskpane").getBoundingClientRect();
  return { lt: Math.round(l.top), lh: Math.round(l.height), lw: Math.round(l.width),
           pt: Math.round(p.top), ph: Math.round(p.height), pw: Math.round(p.width) };
});

// Case one: a short list, a long task.
const short = await boxes();
ok("with a short list the two halves start level", Math.abs(short.lt - short.pt) <= 2,
   JSON.stringify(short));
ok("with a short list the two halves are the same height",
   Math.abs(short.lh - short.ph) <= 2, JSON.stringify(short));
// Not the same width any more, and deliberately so: with a task open the pane
// is the half that needs the space, and the list is down to two columns.
ok("with a task open the pane is still the wider half", short.pw > short.lw,
   JSON.stringify(short));

// Case two: a long list, a short task.
await page.evaluate(() => {
  const many = [];
  for (let i = 1; i <= 12; i++) {
    many.push({ id: "t-m" + i, name: "Task " + i, project: "GLASS",
                attachments: [], status: "To do" });
  }
  localStorage.setItem("tracker.tasks", JSON.stringify(many));
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(300);
await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(300);
const long = await boxes();
ok("with a long list they still start level", Math.abs(long.lt - long.pt) <= 2,
   JSON.stringify(long));
ok("with a long list they are still the same height",
   Math.abs(long.lh - long.ph) <= 2, JSON.stringify(long));

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

/* --- closing the task brings all four columns back ------------------------ */
await page.setViewportSize({ width: 1440, height: 1000 });
await page.locator("tr.taskrow.open").first().click();
await page.waitForTimeout(300);
const reclosed = await heads();
ok("closing the task restores all four columns", reclosed.length === 4,
   reclosed.join(" | "));
const reclosedSplit = await split();
ok("and the pane goes back to about a quarter",
   reclosedSplit.pw < reclosedSplit.lw * 0.45, JSON.stringify(reclosedSplit));

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} split-view check(s) failed`
                   : "\nPASS: four columns, two when open, and the rest of the task beside them");
process.exit(failed ? 1 : 0);
