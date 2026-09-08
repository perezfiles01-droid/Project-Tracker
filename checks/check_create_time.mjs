#!/usr/bin/env node
/**
 * Guard: the create date carries the time it was created, and never invents one.
 *
 * The time has to come from something the user cannot edit. `given` is a date
 * field they own and can set to any day, so the clock time is kept separately
 * as `createdAt` and shown only when the two agree about the day - otherwise a
 * date moved to last week would be printed beside a time from this morning.
 *
 * Tasks saved before `createdAt` existed still have their creation instant: the
 * id is "t-" + Date.now(). It is recovered from there, and only from there - an
 * id of any other shape gets no time rather than a plausible-looking guess.
 *
 * The whole file runs in Asia/Manila rather than UTC. The bug that hides in a
 * UTC-only run is a date derived one way and compared against a date derived
 * the other: they agree for the eight hours a CI runner happens to test, and
 * disagree every morning for anyone east of Greenwich.
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 },
                                       timezoneId: "Asia/Manila" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const dateCells = () => page.$$eval("tr.taskrow td:nth-child(4)",
  (td) => td.map((c) => c.innerText.trim().replace(/\s+/g, " ")));
const todo = async () => {
  await page.click('#nav button[data-route="todo"]');
  await page.waitForTimeout(300);
};

/* --- a task created here records the minute ------------------------------- */
await todo();
await page.click('[data-edit="task:new"]');
await page.waitForSelector("#formDialog .box");
await page.fill("#fd_name", "Timed task");
await page.click('[data-fd="save"]');
await page.waitForSelector("table.tasktable");

const stored = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("tracker.tasks"))[0]);
ok("the task stores a createdAt with a time in it",
   typeof stored.createdAt === "string" && /T\d{2}:\d{2}/.test(stored.createdAt),
   JSON.stringify(stored.createdAt));

const fresh = await dateCells();
ok("the column shows the date and the time", STAMP.test(fresh[0]), fresh[0]);

/* --- the pane says exactly what the column says --------------------------- */
await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(300);
const paneRow = await page.$eval(".taskpane .detailtable tr:nth-child(5) td",
  (td) => td.innerText.trim().replace(/\s+/g, " "));
ok("the pane shows the same stamp as the column", paneRow === fresh[0],
   `pane ${JSON.stringify(paneRow)} vs column ${JSON.stringify(fresh[0])}`);

/* --- editing the task must not rewrite when it was created ---------------- */
const before = stored.createdAt;
await page.click('.taskpane [data-edit^="task:"]');
await page.waitForSelector("#formDialog .box");
await page.fill("#fd_name", "Renamed task");
await page.click('[data-fd="save"]');
await page.waitForTimeout(300);
const after = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("tracker.tasks"))[0].createdAt);
await page.locator("tr.taskrow.open").first().click();
await page.waitForTimeout(300);
ok("editing the task leaves createdAt exactly as it was", after === before,
   `${before} -> ${after}`);

/* --- older tasks get their time back from their id ------------------------
   1757361600000 is 2025-09-08T20:00Z, which in Asia/Manila is 04:00 on the
   9th. A UTC reading would print 20:00, or drop the time for disagreeing
   about the day; both are what this fixture exists to catch. */
await page.evaluate(() => localStorage.setItem("tracker.tasks", JSON.stringify([
  { id: "t-1757361600000", name: "Recovered", given: "2025-09-09",
    status: "To do", attachments: [] },
  { id: "t-legacy", name: "No instant to find", given: "2025-09-09",
    status: "To do", attachments: [] },
  { id: "t-1757361600000", name: "Date moved", given: "2024-01-01",
    status: "To do", attachments: [] },
  { id: "t-1757361600000", name: "No date at all", status: "To do", attachments: [] },
])));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await todo();
const back = await dateCells();
ok("a task saved before createdAt existed gets its time back from its id",
   back[0] === "2025-09-09 04:00", back[0]);
ok("the recovered time is written into the record, not only drawn",
   /T\d{2}:\d{2}/.test(await page.evaluate(() =>
     JSON.parse(localStorage.getItem("tracker.tasks"))[0].createdAt || "")),
   await page.evaluate(() => JSON.parse(localStorage.getItem("tracker.tasks"))[0].createdAt));
ok("an id of another shape gets no time rather than an invented one",
   back[1] === "2025-09-09", back[1]);
ok("a date moved to another day shows the date alone",
   back[2] === "2024-01-01", back[2]);
ok("a task with no create date still shows a dash", back[3] === "—", back[3]);

/* --- the stamp stays on one line -----------------------------------------
   Read off the rendered element rather than the stylesheet: nowrap here is a
   promise the browser is actually keeping, not a rule a later one may have
   overridden. */
const wrapping = await page.$eval("tr.taskrow td:nth-child(4)",
  (td) => getComputedStyle(td).whiteSpace);
ok("the stamp column is set not to wrap", wrapping === "nowrap", wrapping);

/* --- today is the local today, which is what makes the stamp show at all ---
   `given` defaults to today() and the stamp shows when today() agrees with the
   local day of createdAt. A UTC today() disagrees every morning in Manila, and
   the time silently stops appearing for the first eight hours of every day. */
// The clock is pinned to 20:00 UTC, which in Manila is 04:00 the next day. A
// UTC today() prefills the 8th, a local one the 9th; at any other instant the
// two agree and the assertion proves nothing.
await ctx.clock.setFixedTime(new Date("2025-09-08T20:00:00Z"));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await todo();
const localToday = "2025-09-09";
await page.click('[data-edit="task:new"]');
await page.waitForSelector("#formDialog .box");
const prefilled = await page.inputValue("#fd_given");
ok("a new task's create date defaults to the local day, not the UTC one",
   prefilled === localToday, `${prefilled} vs local ${localToday}`);
await page.click('[data-fd="cancel"]');
await page.waitForTimeout(200);

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} create-time check(s) failed`
                   : "\nPASS: the create date carries its time, and never invents one");
process.exit(failed ? 1 : 0);
