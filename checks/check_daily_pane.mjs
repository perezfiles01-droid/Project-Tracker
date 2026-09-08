#!/usr/bin/env node
/**
 * Guard: a completed task is the same task, on whichever page it is listed.
 *
 * Two pages list tasks - the To Do List holds the ones in progress, Daily
 * activity holds the ones that are Done or Blocked - and moving between them
 * is supposed to change only where the task lives and what its status says.
 * It used to change a great deal more: the log was a flat table of inert rows,
 * and the only way into a finished task was a small modal showing its update
 * trail and nothing else. No description, no project, no due date, no
 * attachments, no links.
 *
 * Seven things fail quietly if nobody drives them:
 *
 *   1. A logged task's row opens the pane at all.
 *   2. The pane is the SAME pane - asserted by comparing the markup the two
 *      pages produce for one task, not by spot-checking a field, because two
 *      renderers agreeing today is exactly how they come to disagree.
 *   3. Everything is in it: description, project, due date, assignee,
 *      attachments, links. "All details remain the same" is the request.
 *   4. The update trail is reachable from that pane.
 *   5. An entry typed by hand stays inert. It has no task behind it, and a
 *      row that looks clickable and does nothing is worse than one that
 *      plainly is not.
 *   6. Deleting a logged task takes its log entry with it, in one undo step -
 *      the orphan used to be swept on the next page load, which hid it only
 *      while you could not delete from this page.
 *   7. The row reads the task's current name, unless you typed over it.
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
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);

/* One rich task, in progress, plus one entry typed by hand. */
await page.evaluate(() => {
  localStorage.setItem("tracker.tasks", JSON.stringify([{
    id: "t-rich", name: "R2026.3.1 - QA Testing",
    description: "Bugs found during internal QA testing and logged in Jira.",
    project: "EDRMS ADB", given: "2026-09-01", due: "2026-12-31",
    createdAt: "2026-09-01T09:00:00.000Z", status: "In progress", assignee: "Jim",
    refs: [{ url: "https://example.com/jira", note: "the Jira version page" }],
    ref: "https://example.com/jira", attachments: [], updates: [
      { id: "u-a", date: "2026-09-02", at: "2026-09-02T10:00:00.000Z",
        text: "First look at the failures.", images: [] },
      { id: "u-b", date: "2026-09-03", at: "2026-09-03T10:00:00.000Z",
        text: "Second pass, three left.", images: [] },
    ],
  }]));
  localStorage.setItem("tracker.activity", JSON.stringify([
    { id: "m-hand", origin: "manual", date: "2026-09-04",
      task: "Typed by hand, no task behind it", status: "Done", url: "" },
  ]));
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);

const paneMarkup = () => page.evaluate(() => {
  const el = document.querySelector(".taskpane");
  return el ? el.outerHTML : "";
});
const paneText = () => page.evaluate(() => {
  const el = document.querySelector(".taskpane");
  return el ? el.innerText : "";
});
const logRows = () => page.$$eval("table[data-route='daily'] tbody tr", (rs) => rs.map((r) => ({
  cls: r.className, open: r.getAttribute("data-open"), text: r.innerText.replace(/\s+/g, " ").trim(),
})));
const tasks = () => page.evaluate(() => JSON.parse(localStorage.getItem("tracker.tasks") || "[]"));
const log = () => page.evaluate(() => JSON.parse(localStorage.getItem("tracker.activity") || "[]"));

/* --- capture the To Do List's pane for this task, to compare against ------ */
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
await page.click(".taskrow");
await page.waitForTimeout(350);
const todoPane = await paneMarkup();
ok("the To Do List shows a pane for the task", todoPane.length > 0);
const todoText = await paneText();

/* --- mark it Done, which moves it to Daily activity ----------------------- */
await page.selectOption(".taskpane .statuspick", "Done");
await page.waitForSelector('#formDialog [data-fd="choice"]');
await page.click('#formDialog [data-fd="choice"]');
await page.waitForTimeout(500);
ok("the task has left the To Do List", await page.locator(".taskrow").count() === 0);

await page.click('#nav button[data-route="daily"]');
await page.waitForTimeout(350);

/* --- 1 & 5. which rows are clickable ------------------------------------- */
let rows = await logRows();
ok("the log lists both entries", rows.length === 2, rows.map((r) => r.text).join(" | "));
const taskRow = rows.find((r) => r.open === "t-rich");
const handRow = rows.find((r) => /Typed by hand/.test(r.text));
ok("the logged task's row is clickable", !!taskRow && /taskrow/.test(taskRow.cls),
   taskRow && taskRow.cls);
ok("the hand-typed row is not", !!handRow && !/taskrow/.test(handRow.cls) && !handRow.open,
   handRow && `${handRow.cls} / ${handRow.open}`);

/* --- 7. the row reads the task's live name ------------------------------- */
ok("the row reads the task's name, not a stale snapshot",
   taskRow && /R2026\.3\.1 - QA Testing/.test(taskRow.text), taskRow && taskRow.text);

/* --- 1, 2, 3. clicking opens the SAME pane ------------------------------- */
/* Marking the task Done moved it here with its pane still open - the pane
   follows the task, by design. So the row is opened only when it is not
   already showing; clicking it blindly would close the thing being asserted. */
async function ensureOpen() {
  if (await page.locator(".taskpane .taskdetail").count() === 0) {
    await page.click('tr[data-open="t-rich"]');
    await page.waitForSelector(".taskpane .taskdetail");
    await page.waitForTimeout(250);
  }
}
await ensureOpen();
const dailyPane = await paneMarkup();
ok("clicking a logged task opens a pane", dailyPane.length > 0);
const dailyText = await paneText();

// The status differs by design - it is Done now, it was In progress then - so
// the comparison is of everything else. Any other difference is two renderers
// drifting, which is the thing this assertion exists to catch.
const strip = (h) => h.replace(/<select[\s\S]*?<\/select>/g, "[status]");
ok("it is the SAME pane the To Do List produced, field for field",
   strip(dailyPane) === strip(todoPane),
   strip(dailyPane) === strip(todoPane) ? "identical"
     : `differs by ${Math.abs(strip(dailyPane).length - strip(todoPane).length)} chars`);

for (const [what, needle] of [
  ["the description", "Bugs found during internal QA testing"],
  ["the project", "EDRMS ADB"],
  ["the due date", "2026-12-31"],
  ["the assignee", "Jim"],
  ["the reference link", "the Jira version page"],
  ["the create date", "2026-09-01"],
]) {
  ok(`the pane still carries ${what}`, dailyText.includes(needle));
}
ok("and the To Do List pane carried the same things",
   ["Bugs found during internal QA testing", "EDRMS ADB", "Jim"].every((n) => todoText.includes(n)));

/* --- 4. the trail is reachable from that pane ---------------------------- */
ok("the pane offers the update trail", await page.locator(".taskpane [data-updates]").count() === 1);
await page.click(".taskpane [data-updates]");
await page.waitForTimeout(300);
const trail = await page.$$eval(".taskpane .updaterow .updatewhen",
  (e) => e.map((x) => x.innerText.trim()));
ok("both updates are there", trail.length === 2, trail.join(" | "));
ok("and it is the editable trail, not a read-only copy",
   await page.locator(".taskpane [data-addupdate]").count() === 1);
await page.click(".taskpane [data-updates]");
await page.waitForTimeout(250);

/* --- clicking the open row again closes it ------------------------------- */
await page.click('tr[data-open="t-rich"]');
await page.waitForTimeout(300);
ok("clicking the open row closes the pane",
   await page.locator(".taskpane.empty-pane").count() === 1);
await ensureOpen();

/* --- 7b. renaming follows, hand-edited wording does not ------------------ */
await page.click('.taskpane [data-edit^="task:"]');
await page.waitForSelector("#fd_name");
await page.fill("#fd_name", "Renamed after logging");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(500);
rows = await logRows();
ok("renaming the task updates its logged row",
   rows.some((r) => /Renamed after logging/.test(r.text)), rows.map((r) => r.text).join(" | "));

// Now type over the entry by hand, and rename again. The pane has to be shut
// first: open, the log shows only Date and Activity, exactly as the To Do List
// drops its own columns, so the entry's own Edit button is not on screen.
async function ensureClosed() {
  if (await page.locator(".taskpane .taskdetail").count() > 0) {
    await page.click('tr[data-open="t-rich"]');
    await page.waitForTimeout(300);
  }
}
await ensureClosed();
const entryId = (await log()).find((e) => e.origin === "task").id;
await page.waitForSelector(`[data-edit="act:${entryId}"]`);
await page.click(`[data-edit="act:${entryId}"]`);
await page.waitForSelector("#fd_task");
await page.fill("#fd_task", "My own wording");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(450);
ok("an entry typed over keeps what you wrote",
   (await logRows()).some((r) => /My own wording/.test(r.text)));
ok("and is stamped as edited", ((await log()).find((e) => e.origin === "task") || {}).edited === true);
await ensureOpen();
await page.click('.taskpane [data-edit^="task:"]');
await page.waitForSelector("#fd_name");
await page.fill("#fd_name", "Renamed a second time");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(500);
ok("a later rename does not overwrite your wording",
   (await logRows()).some((r) => /My own wording/.test(r.text)) &&
   !(await logRows()).some((r) => /Renamed a second time/.test(r.text)),
   (await logRows()).map((r) => r.text).join(" | "));

/* --- 6. deleting a logged task takes its entry with it ------------------- */
await ensureOpen();
await page.click('.taskpane [data-remove^="task:"]');
await page.waitForSelector('#formDialog [data-fd="choice"]');
await page.click('#formDialog [data-fd="choice"]');
await page.waitForTimeout(600);
ok("the task is gone", (await tasks()).length === 0);
ok("and its log entry went with it, with no refresh",
   (await log()).filter((e) => e.origin === "task").length === 0,
   JSON.stringify(await log()).slice(0, 120));
ok("the hand-typed entry is untouched",
   (await log()).some((e) => e.origin === "manual"));
rows = await logRows();
ok("no orphan row is left on the page", rows.length === 1, rows.map((r) => r.text).join(" | "));

ok("deleting both was ONE undo step", await (async () => {
  await page.click("#doUndo");
  await page.waitForTimeout(500);
  return (await tasks()).length === 1 &&
         (await log()).filter((e) => e.origin === "task").length === 1;
})(), "the task and its entry must come back together");

/* --- a task open on one page does not reach into the other --------------- */
await page.evaluate(() => {
  localStorage.setItem("tracker.tasks", JSON.stringify([
    { id: "t-todo", name: "Still going", given: "2026-09-01", status: "In progress",
      assignee: "Jim", attachments: [], updates: [] },
    { id: "t-done", name: "All finished", given: "2026-09-01", status: "Done",
      assignee: "Jim", attachments: [], updates: [] },
  ]));
  localStorage.setItem("tracker.activity", JSON.stringify([
    { id: "a-done", taskId: "t-done", origin: "task", date: "2026-09-05",
      task: "All finished", status: "Done", url: "" },
  ]));
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(300);
await page.click('tr[data-open="t-todo"]');
await page.waitForTimeout(350);
const todoCols = await page.$$eval(".tasktable thead th", (e) => e.length);
ok("opening a task narrows its own table", todoCols === 2, String(todoCols));
await page.click('#nav button[data-route="daily"]');
await page.waitForTimeout(350);
const dailyCols = await page.$$eval("table[data-route='daily'] thead th", (e) => e.length);
ok("a task open on the To Do List does not narrow the log", dailyCols > 2, String(dailyCols));
ok("nor fill the log's pane with a task the log is not listing",
   await page.locator(".taskpane .taskdetail").count() === 0);
const headCells = dailyCols;
const bodyCells = await page.$$eval("table[data-route='daily'] tbody tr:first-child td", (e) => e.length);
ok("the log's head and body agree on how many columns there are",
   headCells === bodyCells, `${headCells} head, ${bodyCells} body`);

await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(300);
const th = await page.$$eval(".tasktable thead th", (e) => e.length);
const td = await page.$$eval(".tasktable tbody tr:first-child td", (e) => e.length);
ok("and so do the To Do List's", th === td, `${th} head, ${td} body`);

ok("no page errors along the way", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${failed} daily-pane check(s) failed`);
process.exit(failed ? 1 : 0);
