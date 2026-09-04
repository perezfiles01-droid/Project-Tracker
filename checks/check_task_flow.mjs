#!/usr/bin/env node
/**
 * Guard for where a task lives.
 *
 * One rule holds this together: a task's status decides which of the two pages
 * it is on. In progress is the To Do List; Blocked and Done are Daily activity.
 * A task is on exactly one of them, and moving it moves it both ways.
 *
 * Every part of that is silent when it breaks. A task marked Done that stays
 * on the To Do List looks like a list that was never tidied. A log entry left
 * behind after a task came back looks like an entry someone typed. A prompt
 * that stops asking is invisible until something is marked Done by accident.
 * So all of it is driven here, through the real dialogs, against real storage:
 *
 *   1. Three statuses are offered and "To do" is gone, including for tasks
 *      saved before it was.
 *   2. The To Do List lists the in-progress ones, and the sidebar count agrees
 *      with the rows on screen.
 *   3. Done and Blocked appear in Daily activity; coming back removes the
 *      entry. One entry per task throughout - never two, never an orphan.
 *   4. Both directions ask first, and declining changes nothing at all.
 *   5. A new task is In progress without being asked, and hand-typed log
 *      entries survive every one of the above.
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
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const url = "file://" + join(root, "Tracker-standalone.html");

/* ---------------------------------------------------------------- helpers */
const seed = async (tasks, log = []) => {
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(([t, l]) => {
    localStorage.setItem("tracker.tasks", JSON.stringify(t));
    localStorage.setItem("tracker.activity", JSON.stringify(l));
  }, [tasks, log]);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(300);
};
const todo = async () => {
  await page.click('#nav button[data-route="todo"]');
  await page.waitForTimeout(250);
  return page.$$eval("table.tasktable tbody tr", (tr) => tr.map((r) => r.innerText.trim()));
};
const daily = async () => {
  await page.click('#nav button[data-route="daily"]');
  await page.waitForTimeout(250);
  return page.$$eval("main table tbody tr", (tr) => tr.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
};
const stored = (key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "[]"), key);
const navCount = () => page.$eval('#nav button[data-route="todo"] .count', (e) => Number(e.textContent));
/** Answer the next confirm dialog. The dialog is the app's own, not a native one. */
const answer = async (yes) => {
  await page.waitForSelector("dialog[open] button, .modal:not([hidden]) button", { timeout: 3000 });
  const label = yes ? /mark done|mark blocked|move back/i : /^cancel$/i;
  const buttons = await page.$$("dialog[open] button, .modal:not([hidden]) button");
  for (const b of buttons) {
    const t = ((await b.innerText()) || "").trim();
    if (label.test(t)) { await b.click(); await page.waitForTimeout(250); return t; }
  }
  return null;
};
/**
 * Drive the status dropdown the way a person does: the picker lives in the
 * detail pane, so the task is opened first if it is not already showing.
 */
/**
 * Bring the task's status dropdown on screen, wherever the task currently is.
 *
 * That is the point of the change being checked: an in-progress task carries
 * the picker in the To Do List's detail pane, and a blocked or completed one
 * carries it on its Daily activity row. The check has to be able to reach the
 * task from either side, exactly as a person does.
 */
const showPicker = async (id) => {
  const sel = `select.statuspick[data-status="${id}"]`;
  if (await page.$(sel)) return;
  await page.click('#nav button[data-route="daily"]');
  await page.waitForTimeout(250);
  if (await page.$(sel)) return;
  await page.click('#nav button[data-route="todo"]');
  await page.waitForTimeout(250);
  await openTask(id);
};
const setStatusVia = async (id, status, yes) => {
  await showPicker(id);
  await page.selectOption(`select.statuspick[data-status="${id}"]`, status);
  const clicked = await answer(yes);
  return clicked;
};
const openTask = async (id) => {
  // A clear failure beats a thirty-second wait on a selector: if the row is
  // not there, say which page was showing and what was on it.
  if (!await page.$(`tr[data-open="${id}"]`)) {
    const route = await page.evaluate(() =>
      (document.querySelector('#nav button[aria-current="true"]') || {}).innerText || "?");
    throw new Error(`no row for ${id}; showing "${String(route).trim()}" with ` +
                    `${(await page.$$("select.statuspick")).length} status pickers`);
  }
  await page.click(`tr[data-open="${id}"] td`);
  await page.waitForTimeout(250);
};

const A = { id: "t-a", name: "Alpha", description: "alpha", attachments: [], status: "In progress" };
const B = { id: "t-b", name: "Bravo", description: "bravo", attachments: [], status: "Blocked" };
const C = { id: "t-c", name: "Charlie", description: "charlie", attachments: [], status: "Done" };
const LEGACY = { id: "t-old", name: "Legacy", description: "legacy", attachments: [], status: "To do" };
const HAND = { id: "m-1", origin: "manual", date: "2026-01-01", task: "Typed by hand", status: "Done", url: "" };

/* ------------------------------------------------ 1. the vocabulary */
await seed([A]);
const statuses = await page.evaluate(() => window.TrackerTasks.STATUSES);
ok("three statuses are offered", Array.isArray(statuses) && statuses.length === 3, JSON.stringify(statuses));
ok('"To do" is gone', !statuses.includes("To do"), JSON.stringify(statuses));
ok("the three are in progress, blocked and done",
   ["In progress", "Blocked", "Done"].every((s) => statuses.includes(s)), JSON.stringify(statuses));

await seed([LEGACY]);
const migrated = await stored("tracker.tasks");
ok("a task saved as To do reads back as In progress",
   migrated.length === 1 && migrated[0].status === "In progress",
   JSON.stringify(migrated.map((t) => t.status)));
ok("migrating keeps everything else on the task",
   migrated[0].name === "Legacy" && migrated[0].description === "legacy");

/* ------------------------------------------------ 2. which page lists what */
await seed([A, B, C], [HAND]);
const listed = await todo();
ok("only the in-progress task is on the To Do List",
   listed.length === 1 && /Alpha/.test(listed[0]), listed.join(" / ") || "empty");
ok("the sidebar count matches the rows on screen", await navCount() === 1, String(await navCount()));

const logged = await daily();
ok("blocked and done tasks are in Daily activity, with the hand-typed entry",
   logged.length === 3, logged.join(" / "));
// Read the statuses off the entries, not off the row text: the row now holds
// a dropdown, and every status it offers appears in its innerText. Asserting
// against the rendered words would pass for the wrong reason.
const loggedStatuses = (await stored("tracker.activity")).map((e) => e.status);
ok("nothing in progress is logged as an activity",
   loggedStatuses.every((s) => s === "Done" || s === "Blocked"), loggedStatuses.join(", "));
ok("a done task saved before the rule existed still reaches Daily activity",
   loggedStatuses.filter((s) => s === "Done").length === 2 &&
   loggedStatuses.filter((s) => s === "Blocked").length === 1, loggedStatuses.join(", "));
ok("the logged task carries a status control, so it can come back",
   (await page.$$('select.statuspick')).length === 2,
   String((await page.$$("select.statuspick")).length));

/* ------------------------------------------------ 3. the round trip */
await seed([A], [HAND]);
await todo();
await setStatusVia("t-a", "Done", true);
let log = await stored("tracker.activity");
ok("marking done writes one entry", log.filter((e) => e.taskId === "t-a").length === 1,
   JSON.stringify(log.map((e) => e.status)));
ok("the entry says Done", (log.find((e) => e.taskId === "t-a") || {}).status === "Done");
ok("the task leaves the To Do List", (await todo()).length === 0);
ok("the sidebar count follows it off the list", await navCount() === 0, String(await navCount()));

// Back again: the pane is still open on the task, so the same dropdown is there.
await setStatusVia("t-a", "In progress", true);
log = await stored("tracker.activity");
ok("coming back removes the entry", log.filter((e) => e.taskId === "t-a").length === 0,
   JSON.stringify(log.map((e) => e.task)));
ok("and the hand-typed entry is untouched by all of it",
   log.some((e) => e.id === "m-1" && e.task === "Typed by hand"));
ok("the task is back on the To Do List", (await todo()).length === 1);

await setStatusVia("t-a", "Blocked", true);
log = await stored("tracker.activity");
ok("blocked logs the task too", log.filter((e) => e.taskId === "t-a").length === 1);
ok("and logs it as Blocked", (log.find((e) => e.taskId === "t-a") || {}).status === "Blocked");
ok("blocked leaves the To Do List as well", (await todo()).length === 0);

// Blocked straight to Done must update the entry it has, not add a second.
await setStatusVia("t-a", "Done", true);
log = await stored("tracker.activity");
ok("blocked to done keeps one entry, not two",
   log.filter((e) => e.taskId === "t-a").length === 1,
   JSON.stringify(log.filter((e) => e.taskId === "t-a").map((e) => e.status)));
ok("the entry now says Done", (log.find((e) => e.taskId === "t-a") || {}).status === "Done");

/* ------------------------------------------------ 4. the prompts */
await seed([A]);
await todo();
await setStatusVia("t-a", "Done", false);
let tasks = await stored("tracker.tasks");
ok("declining leaves the status alone", tasks[0].status === "In progress", tasks[0].status);
ok("declining writes no activity entry", (await stored("tracker.activity")).length === 0);
ok("declining leaves the task on the list", (await todo()).length === 1);
ok("the dropdown snaps back to the saved status",
   await page.$eval('select.statuspick[data-status="t-a"]', (s) => s.value) === "In progress");

await seed([C]);
await page.click('#nav button[data-route="daily"]');
await page.waitForTimeout(200);
ok("moving back off Done asks before deleting the entry",
   await page.evaluate(async () => {
     // Drive it through the app's own path, with the dialog left unanswered.
     window.TrackerTasks.setStatus("t-c", "In progress");
     await new Promise((r) => setTimeout(r, 300));
     return !!document.querySelector("dialog[open], .modal:not([hidden])");
   }));
await answer(false);

/* ------------------------------------------------ 5. creating a task */
await seed([]);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(200);
await page.click('[data-edit="task:new"]');
await page.waitForTimeout(300);
const labels = await page.$$eval(".modal:not([hidden]) label", (l) => l.map((x) => x.innerText.trim()));
ok("the new-task dialog does not ask for a status",
   !labels.some((l) => /^status$/i.test(l)), labels.join(" | "));
// Fields are addressed by the id the dialog gives them, "fd_<name>".
await page.fill("#fd_name", "Fresh");
await page.click('.modal:not([hidden]) [data-fd="save"]');
await page.waitForTimeout(400);
tasks = await stored("tracker.tasks");
ok("a new task is saved as In progress",
   tasks.length === 1 && tasks[0].status === "In progress",
   JSON.stringify(tasks.map((t) => t.status)));
ok("and it appears on the To Do List", (await todo()).length === 1);
ok("creating a task logs nothing", (await stored("tracker.activity")).length === 0);

/* ------------------------------------------------ the editing dialog */
await seed([A]);
await todo();
// The Edit button lives in the detail pane, so the task is opened first.
await openTask("t-a");
await page.click('[data-edit="task:t-a"]');
await page.waitForTimeout(300);
const editLabels = await page.$$eval(".modal:not([hidden]) label", (l) => l.map((x) => x.innerText.trim()));
ok("editing an existing task still offers the status",
   editLabels.some((l) => /^status$/i.test(l)), editLabels.join(" | "));
const editOptions = await page.$$eval("#fd_status option", (o) => o.map((x) => x.value));
ok("the edit dialog offers the three statuses and no more",
   editOptions.length === 3 && !editOptions.includes("To do"), editOptions.join(", "));

ok("nothing threw while doing all that", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(failed ? `\n${failed} task-flow check(s) failed` : "\nPASS: a task lives on exactly one page");
process.exit(failed ? 1 : 0);
