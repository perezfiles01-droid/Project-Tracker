#!/usr/bin/env node
/**
 * Guard for the task table and the dialog that fills it.
 *
 * Two faults this covers, both of which produced "I added a link but it
 * shows no link":
 *   1. A link entered through "Attach a link" rendered only inside the
 *      expanded detail row. The Reference link column showed a dash, so a
 *      link that had been saved correctly read as missing.
 *   2. Enter submitted the whole dialog from any input. On a ten-field form
 *      that saves every field below the caret as blank.
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
const url = "file://" + join(root, "Tracker-standalone.html");
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(300);
// The table only renders once a task exists, so seed one before reading the
// header row; checking an unrendered table asserts nothing.
await page.evaluate(() => localStorage.setItem("tracker.tasks", JSON.stringify(
  [{ id: "t-seed", no: "1", name: "Seed", description: "d", attachments: [], status: "To do" }])));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);

const headers = await page.$$eval("table.tasktable thead th", (th) => th.map((h) => h.innerText.trim()));
ok("the table names the task, not its description",
   headers.some((h) => /name of task/i.test(h)), headers.join(" | "));
ok("the description column is gone from the table",
   !headers.some((h) => /^description/i.test(h)), headers.join(" | "));
ok("there is a Project column", headers.some((h) => /^project$/i.test(h)), headers.join(" | "));

// --- fault 2: Enter must not submit -----------------------------------------
await page.evaluate(() => localStorage.setItem("tracker.tasks", "[]"));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
await page.click('[data-edit="task:new"]');
await page.waitForTimeout(250);
await page.fill("#fd_name", "Guarded task");
await page.press("#fd_name", "Enter");
await page.waitForTimeout(200);
ok("Enter in a field does not submit the dialog",
   await page.locator("#formDialog").isVisible());

// --- fault 1: a link entered ONLY as an attachment must show in the column ---
await page.fill("#fd_linkUrl", "https://example.test/attached-only");
await page.click("#formDialog .actions button.primary");
await page.waitForTimeout(400);

ok("the task was created", (await page.locator("tr.taskrow").count()) === 1);
const refCell = (await page.locator("tr.taskrow td").last().innerText()).trim();
ok("an attached link shows in the Reference link column", /↗/.test(refCell),
   `column reads ${JSON.stringify(refCell)}`);
const nameCell = (await page.locator("tr.taskrow td").nth(1).innerText()).trim();
ok("the name column shows the task name", nameCell === "Guarded task", nameCell);

// --- clicking a task opens its detail ---------------------------------------
await page.click("tr.taskrow");
await page.waitForTimeout(250);
ok("clicking a task opens a detail row", (await page.locator("tr.detail").count()) === 1);
const detail = await page.locator("tr.detail").innerText();
ok("the detail offers add/rename/delete", /Edit/.test(detail) && /Remove/.test(detail), detail.replace(/\s+/g, " ").slice(0, 90));

// --- and it survives a reload ------------------------------------------------
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
ok("the task and its link survive a reload",
   (await page.locator("tr.taskrow").count()) === 1 &&
   /↗/.test((await page.locator("tr.taskrow td").last().innerText())));

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} task check(s) failed` : "\nPASS: task table and dialog behave");
process.exit(failed ? 1 : 0);
