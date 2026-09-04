#!/usr/bin/env node
/**
 * Guard: one status vocabulary, set from the pane.
 *
 * The tick could only ever say "Done", and the two pages spoke different
 * languages: the activity log used Completed / In Progress / Pending, and a
 * finished task was logged as "Completed" for a status the task itself called
 * "Done".
 *
 * The vocabulary is three words now - In progress, Blocked, Done - and the
 * status decides which page a task is on, so changing one asks first. This
 * check keeps its original subject (one vocabulary, set from the pane, and
 * one log entry per task) and answers the prompt where the app now shows one.
 * Which page a task lands on is check_task_flow's subject, not this one.
 *
 * Unifying them has a trap this asserts explicitly: statusTag colours by
 * substring, so "Done" matched none of its cases and every completed activity
 * would have rendered as a colourless tag - the lists would agree and the
 * colour would quietly stop meaning anything.
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

const seed = (tasks, log = []) => page.evaluate(([t, l]) => {
  localStorage.setItem("tracker.tasks", JSON.stringify(t));
  localStorage.setItem("tracker.activity", JSON.stringify(l));
}, [tasks, log]);
const openTodo = async () => {
  await page.click('#nav button[data-route="todo"]');
  await page.waitForTimeout(300);
};
/** Confirm the move the app now asks about. Returns false if nothing asked. */
const confirmMove = async () => {
  await page.waitForTimeout(250);
  const btn = page.locator('#formDialog:not([hidden]) [data-fd="choice"]');
  if (!await btn.count()) return false;
  await btn.first().click();
  await page.waitForTimeout(300);
  return true;
};
/** Set the status wherever the picker currently is: the pane, or the log row. */
const setStatus = async (value) => {
  if (!await page.locator("[data-status]").count()) {
    await page.click('#nav button[data-route="daily"]');
    await page.waitForTimeout(300);
  }
  await page.selectOption("[data-status]", value);
  await confirmMove();
};

await seed([{ id: "t-1", name: "Alpha", attachments: [], status: "In progress" }]);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await openTodo();
await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(300);

/* --- the pane sets the status, and the tick is gone ----------------------- */
ok("the pane offers a Status dropdown",
   (await page.locator(".taskpane [data-status]").count()) === 1);
ok("the Mark done tick is gone",
   (await page.locator('.taskpane [aria-label="Mark done"]').count()) === 0);

const taskOpts = await page.$$eval(".taskpane [data-status] option", (o) => o.map((x) => x.value));
ok("it offers every status a task can be in",
   taskOpts.join("|") === "In progress|Blocked|Done", taskOpts.join("|"));

ok("nothing is logged while the task is in progress",
   (await page.evaluate(() => JSON.parse(localStorage.getItem("tracker.activity") || "[]").length)) === 0);

await page.selectOption(".taskpane [data-status]", "Done");
ok("moving a task to Done asks before it moves", await confirmMove());
ok("choosing a status saves it",
   (await page.evaluate(() => JSON.parse(localStorage.getItem("tracker.tasks"))[0].status)) === "Done");
const logged = await page.evaluate(() => JSON.parse(localStorage.getItem("tracker.activity") || "[]"));
ok("choosing Done writes one activity entry", logged.length === 1, String(logged.length));
ok("the entry is logged as Done, not Completed",
   logged[0] && logged[0].status === "Done", logged[0] && logged[0].status);

/* Moving out of Done and back must not log a second time. */
await setStatus("Blocked");
await setStatus("Done");
ok("going out of Done and back does not log twice",
   (await page.evaluate(() => JSON.parse(localStorage.getItem("tracker.activity")).length)) === 1);

/* --- both pages offer the same list, compared rather than named ----------- */
const dialogStatuses = async (route, opener) => {
  await page.click(`#nav button[data-route="${route}"]`);
  await page.waitForTimeout(250);
  await page.click(opener);
  await page.waitForSelector("#fd_status");
  const opts = await page.$$eval("#fd_status option", (o) => o.map((x) => x.value));
  await page.click('#formDialog [data-fd="cancel"]');
  await page.waitForTimeout(200);
  return opts;
};
// The new-task dialog no longer asks for a status, so the task side of this
// comparison is read from the app's own list rather than from that dialog.
// The point still stands: the log speaks the task vocabulary, not a second one.
const inTask = await page.evaluate(() => window.TrackerTasks.STATUSES);
const inDaily = await dialogStatuses("daily", '[data-edit="act:new"]');
ok("the Daily activity dialog speaks the task vocabulary",
   inDaily.every((s) => inTask.includes(s)), `${inTask.join("|")} vs ${inDaily.join("|")}`);
ok("and it offers only the two statuses that belong in a log",
   inDaily.join("|") === "Done|Blocked", inDaily.join("|"));

/* --- a status saved under the old words is kept, not rewritten ------------ */
await seed([{ id: "t-9", name: "Legacy", attachments: [], status: "Pending" }],
           [{ id: "a-1", date: "2026-01-01", task: "Old entry", status: "Completed", origin: "manual" }]);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await openTodo();
await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(300);
ok("a task saved with an unknown status still shows it",
   (await page.inputValue(".taskpane [data-status]")) === "Pending",
   await page.inputValue(".taskpane [data-status]"));
ok("and that status is offered rather than replaced",
   (await page.$$eval(".taskpane [data-status] option", (o) => o.map((x) => x.value)))
     .includes("Pending"));

await page.click('#nav button[data-route="daily"]');
await page.waitForTimeout(300);
ok("an activity saved as Completed still reads Completed",
   (await page.locator("#view").innerText()).includes("Completed"));

/* --- and every status still gets a colour -------------------------------- */
/* Put every status through statusTag itself, rather than inferring a colour
   from whatever happens to be on screen. The statuses come from the app's own
   list plus the old words, so a status added later is covered here. */
const colours = await page.evaluate(() => {
  const names = [...window.TrackerTasks.STATUSES, "Completed", "Pending", "In Progress"];
  const out = {};
  for (const s of names) {
    const el = document.createElement("div");
    el.innerHTML = window.TrackerApp.statusTag(s);
    const tag = el.querySelector(".tag");
    out[s] = tag ? tag.className.replace(/\btag\b/, "").trim() : null;
  }
  return out;
});
ok("every status renders with a colour, Done included",
   Object.values(colours).every((c) => c), JSON.stringify(colours));
ok("Done reads as finished, the same as Completed",
   colours["Done"] === "ok" && colours["Completed"] === "ok", JSON.stringify(colours));

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} status check(s) failed`
                   : "\nPASS: one status vocabulary, set from the pane");
process.exit(failed ? 1 : 0);
