#!/usr/bin/env node
/**
 * Guard: task numbers count 1..n and cannot be typed.
 *
 * The number used to be an editable field pre-filled with max+1 and a help
 * line inviting you to change it, so nothing stopped a second "1". A real
 * list read 1, 2, 3, 4, 1.
 *
 * It is now derived from the task's position in creation order, so it is not
 * stored, cannot be edited, cannot collide, and closes up when a task is
 * deleted. These assertions are about all three: no field, no duplicates, and
 * no gaps after a delete.
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
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const url = "file://" + join(root, "Tracker-standalone.html");

const seed = (tasks) => page.evaluate((t) =>
  localStorage.setItem("tracker.tasks", JSON.stringify(t)), tasks);
const openTodo = async () => {
  await page.click('#nav button[data-route="todo"]');
  await page.waitForTimeout(250);
};
/** The Task No. column, read from the table itself. */
const numbers = () => page.$$eval("tr.taskrow td:first-child", (td) =>
  td.map((c) => c.innerText.trim()));

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(300);
await seed([]);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await openTodo();

/* --- the field is gone from the dialog ------------------------------------ */
await page.click('[data-edit="task:new"]');
await page.waitForSelector("#formDialog .box");
ok("the dialog no longer offers a Task No. field",
   (await page.locator("#fd_no").count()) === 0);
const labels = await page.$$eval("#formDialog label", (l) => l.map((x) => x.innerText.trim()));
ok("no field is labelled Task No.", !labels.some((l) => /task no/i.test(l)), labels.join(" | "));
await page.click('#formDialog [data-fd="cancel"]');
await page.waitForTimeout(200);

/* --- three tasks made through the real dialog read 1, 2, 3 ---------------- */
for (const name of ["First", "Second", "Third"]) {
  await page.click('[data-edit="task:new"]');
  await page.waitForSelector("#fd_name");
  await page.fill("#fd_name", name);
  await page.click("#formDialog .actions button.primary");
  await page.waitForTimeout(350);
}
ok("tasks created in order are numbered 1, 2, 3",
   (await numbers()).join(",") === "1,2,3", (await numbers()).join(","));

/* --- stored duplicates still render distinct ------------------------------
   The records that caused the report carry no: "1" twice. The number is no
   longer read from them, so the table must count regardless. */
await seed([
  { id: "t-a", no: "1", name: "Alpha", attachments: [], status: "To do" },
  { id: "t-b", no: "1", name: "Bravo", attachments: [], status: "To do" },
  { id: "t-c", no: "9", name: "Charlie", attachments: [], status: "To do" },
]);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await openTodo();
const dup = await numbers();
ok("records carrying duplicate stored numbers still render 1, 2, 3",
   dup.join(",") === "1,2,3", dup.join(","));
ok("every number on screen is unique", new Set(dup).size === dup.length, dup.join(","));

/* --- deleting closes the gap ---------------------------------------------- */
await page.evaluate(() => {
  const list = JSON.parse(localStorage.getItem("tracker.tasks"));
  localStorage.setItem("tracker.tasks", JSON.stringify(list.filter((t) => t.id !== "t-b")));
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await openTodo();
const after = await numbers();
ok("deleting a task leaves no gap in the numbering",
   after.join(",") === "1,2", after.join(","));

/* --- a new task is assigned to Jim, an edited one keeps its own ----------- */
await page.click('[data-edit="task:new"]');
await page.waitForSelector("#fd_assignee");
ok("a new task is assigned to Jim by default",
   (await page.inputValue("#fd_assignee")) === "Jim",
   await page.inputValue("#fd_assignee"));
await page.click('#formDialog [data-fd="cancel"]');
await page.waitForTimeout(200);

// Editing must not overwrite what is already saved - including an assignee
// deliberately left empty.
await seed([
  { id: "t-e", name: "Empty assignee", assignee: "", attachments: [], status: "To do" },
  { id: "t-f", name: "Someone else", assignee: "Ana", attachments: [], status: "To do" },
]);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await openTodo();
await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(250);
await page.click('[data-edit="task:t-e"]');
await page.waitForSelector("#fd_assignee");
ok("editing a task saved with no assignee does not fill in Jim",
   (await page.inputValue("#fd_assignee")) === "",
   JSON.stringify(await page.inputValue("#fd_assignee")));
await page.click('#formDialog [data-fd="cancel"]');
await page.waitForTimeout(200);
// Edit lives inside the opened task, so the second one is opened before it can
// be edited.
await page.locator("tr.taskrow").nth(1).click();
await page.waitForTimeout(250);
await page.click('[data-edit="task:t-f"]');
await page.waitForSelector("#fd_assignee");
ok("editing a task keeps the assignee it has",
   (await page.inputValue("#fd_assignee")) === "Ana", await page.inputValue("#fd_assignee"));
await page.click('#formDialog [data-fd="cancel"]');
await page.waitForTimeout(200);

/* --- Task Create Date: today by default, never overwriting a saved one ---- */
const todayIs = new Date().toISOString().slice(0, 10);
await page.click('[data-edit="task:new"]');
await page.waitForSelector("#fd_given");
ok("a new task's create date is today", (await page.inputValue("#fd_given")) === todayIs,
   `${await page.inputValue("#fd_given")} vs ${todayIs}`);
const dateLabels = await page.$$eval("#formDialog label", (l) => l.map((x) => x.innerText.trim()));
ok("the field is called Task Create Date",
   dateLabels.some((l) => /task create date/i.test(l)) &&
   !dateLabels.some((l) => /task given date/i.test(l)), dateLabels.join(" | "));
await page.click('#formDialog [data-fd="cancel"]');
await page.waitForTimeout(200);

await seed([
  { id: "t-d", name: "Dated", given: "2020-01-01", attachments: [], status: "To do" },
  { id: "t-n", name: "Undated", given: "", attachments: [], status: "To do" },
]);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await openTodo();
await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(250);
ok("the pane names it Task Create Date",
   (await page.locator(".taskpane").innerText()).includes("Task Create Date"));
await page.click('[data-edit="task:t-d"]');
await page.waitForSelector("#fd_given");
ok("editing keeps the date the task already has",
   (await page.inputValue("#fd_given")) === "2020-01-01", await page.inputValue("#fd_given"));
await page.click('#formDialog [data-fd="cancel"]');
await page.waitForTimeout(200);
await page.locator("tr.taskrow").nth(1).click();
await page.waitForTimeout(250);
await page.click('[data-edit="task:t-n"]');
await page.waitForSelector("#fd_given");
ok("editing a task with no date does not invent one",
   (await page.inputValue("#fd_given")) === "", JSON.stringify(await page.inputValue("#fd_given")));
await page.click('#formDialog [data-fd="cancel"]');
await page.waitForTimeout(200);

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} numbering check(s) failed`
                   : "\nPASS: task numbers count 1..n and cannot be typed");
process.exit(failed ? 1 : 0);
