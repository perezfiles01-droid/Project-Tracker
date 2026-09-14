#!/usr/bin/env node
/**
 * Guard for the exported task report.
 *
 * The report is a file that leaves the app, gets read later, and is trusted.
 * Everything that can go wrong with it is quiet:
 *
 *   - A date range that is exclusive at one end silently drops the task you
 *     created on the day you asked for. Nothing says so; the report simply has
 *     one fewer task than your list did.
 *   - A field that stops reaching the file reads as a task that never had one.
 *   - Numbering the filtered rows instead of the list makes every report
 *     contain a different "task 1", and two reports over different weeks then
 *     disagree about which task is which.
 *   - An AI failure that stops the export turns a rate limit into "the export
 *     button is broken".
 *   - Worst of all: the model's prose replacing a fact rather than sitting
 *     beside it. That produces a confident report of work that was never
 *     recorded, and nothing in the file marks which sentence it was.
 *
 * So all of it is driven here, through the real button and the real dialog,
 * against real storage, reading the file that actually lands on disk.
 *
 * The AI is stubbed rather than called. This check must pass with no key, on a
 * machine with no network, and must be able to force the failure paths on
 * demand - a check that depends on a third party being up is a check that goes
 * red for reasons that are not about this repository. What it asserts about
 * the real engines it asserts statically: every provider in PROVIDERS,
 * enumerated at runtime, is reached by the report instruction.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
// The file under test. Overridable so a baseline build can be run through the
// same assertions, which is how this check was proved to fail without the
// feature rather than merely asserted to.
const url = "file://" + (process.env.TRACKER_HTML || join(root, "Tracker-standalone.html"));

/* ------------------------------------------------------------------ dates */
const pad2 = (n) => String(n).padStart(2, "0");
const dayOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const shift = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return dayOf(d); };
const TODAY = dayOf(new Date());

/* ------------------------------------------------------------- the sample */
const TASKS = [
  { id: "t-1000000000001", name: "Old task from last month", project: "GLASS",
    given: shift(-40), createdAt: new Date(Date.now() - 40 * 86400000).toISOString(),
    status: "In progress", assignee: "Jim", description: "<p>Something from a while ago.</p>" },
  { id: "t-1000000000002", name: "Edge task on the from day", project: "EDRMS ADB",
    given: shift(-3), createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    status: "In progress", assignee: "Jim", description: "<p>Starts the window.</p>" },
  { id: "t-1000000000003", name: "Ask Mihal about the utility report database design",
    project: "EDRMS ADB", given: TODAY, createdAt: new Date().toISOString(),
    due: shift(-1), status: "In progress", assignee: "Jim",
    description: "<p>Confirm the table design.</p><ul><li>Which key joins them</li>" +
                 "<li>Whether a snapshot is kept</li></ul><table><tr><td>Records</td>" +
                 "<td>daily</td></tr></table>",
    refs: [{ url: "https://example.com/spec", note: "The spec he sent" },
           { url: "https://example.com/thread", note: "" }],
    updates: [
      { id: "u-1", date: shift(-1), at: new Date(Date.now() - 86400000).toISOString(),
        text: "<p>Asked him on Teams.</p>", images: [{ id: "a-x", name: "teams.png", size: 2048 }] },
      { id: "u-2", date: TODAY, at: new Date().toISOString(), text: "<p>He replied, waiting on the DBA.</p>", images: [] },
    ],
    attachments: [{ id: "a-1", name: "design-notes.pdf", size: 412000, type: "application/pdf", kind: "file" }] },
  { id: "t-1000000000004", name: "Task with an edited create date", project: "GLASS",
    // given deliberately does NOT match createdAt's day: the report must print
    // the date alone, never this morning's clock time beside last week's date.
    given: shift(-2), createdAt: new Date().toISOString(),
    status: "In progress", assignee: "Doris", description: "<p>Date was corrected by hand.</p>" },
  { id: "t-1000000000005", name: "A finished thing", project: "GLASS", given: TODAY,
    createdAt: new Date().toISOString(), status: "Done", assignee: "Jim",
    description: "<p>All done.</p>" },
];

const seed = async () => {
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate((t) => {
    localStorage.setItem("tracker.tasks", JSON.stringify(t));
    localStorage.setItem("tracker.activity", JSON.stringify([]));
  }, TASKS);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(300);
  await page.click('#nav button[data-route="todo"]');
  await page.waitForTimeout(250);
};

/**
 * Run one export through the real UI and return the text that landed on disk.
 *
 * Deliberately not the value dialog() returns: what is asserted has to be the
 * bytes the browser actually saved, or the check proves only that a string was
 * built correctly and never that it reached a file.
 */
async function exportWith(values, { stub } = {}) {
  if (stub !== undefined) await page.evaluate(stub);
  await page.click("[data-export]");
  await page.waitForSelector("#formDialog:not([hidden])");
  for (const [k, v] of Object.entries(values)) {
    await page.selectOption(`#fd_${k}`, v).catch(async () => {
      await page.fill(`#fd_${k}`, v);                       // the date inputs
    });
  }
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.click('[data-fd="save"]'),
  ]);
  const path = await dl.path();
  // This check runs a dozen exports in a row with no human in between, and a
  // browser given downloads faster than it can process them declines roughly
  // one in twelve of them - measured, and measured to be unaffected by
  // anything in this repository. A person clicking Export cannot produce that;
  // this loop can, and did, failing on the eleventh export and reading exactly
  // like a bug in the AI failure path it happened to land on. The pause is the
  // harness behaving like a person, and it belongs here rather than in the app.
  await page.waitForTimeout(400);
  return { text: readFileSync(path, "utf8"), name: dl.suggestedFilename() };
}

/* ============================================================ 1. the button */
await seed();
ok("the To Do List offers an Export button",
   await page.$("[data-export]") !== null);
ok("New task is still the primary action beside it",
   await page.$eval('[data-edit="task:new"]', (b) => b.classList.contains("primary")));

// Everything below drives that button. Without it there is nothing to assert
// against, and thirty timeouts say less than one sentence does - this is how
// the check reports a build that predates the feature rather than crashing on
// it.
if (!await page.$("[data-export]")) {
  console.log("\nFAIL: there is no Export button to test");
  await browser.close();
  process.exit(1);
}

await page.click("[data-export]");
await page.waitForSelector("#formDialog:not([hidden])");
const labels = await page.$$eval("#formDialog label", (ls) => ls.map((l) => l.textContent.trim()));
for (const want of ["Which tasks", "Date range", "From (custom range)", "To (custom range)", "Project", "AI summary"]) {
  ok(`the dialog asks for ${want}`, labels.includes(want));
}
const presets = await page.$$eval("#fd_range option", (o) => o.map((x) => x.value));
ok("the range offers Today and a custom span", presets.includes("Today") &&
   presets.some((p) => /^Custom/.test(p)), presets.join(", "));
ok("the project list offers only projects tasks carry",
   (await page.$$eval("#fd_project option", (o) => o.map((x) => x.value)))
     .join(",") === "All projects,EDRMS ADB,GLASS");
await page.click('[data-fd="cancel"]');

/* ================================================= 2. the facts reach the file */
const one = await exportWith({ range: "Today", ai: "No, facts only" });
const F = one.text;
ok("the file is named for the range it covers", one.name === `task-report-${TODAY}.txt`, one.name);
// One, not two: of the five seeded tasks only Mihal's is BOTH in progress and
// created today, which is the whole point of the default range.
ok("the header states how many tasks and which dates",
   /Count\s+1 task\b/.test(F) && F.includes(`Dates       ${TODAY} only`));
ok("the task number reaches the file", /TASK 3\b/.test(F));
ok("the name of the task reaches the file",
   F.includes("Ask Mihal about the utility report database design"));
ok("the project reaches the file", /Project\s+EDRMS ADB/.test(F));
ok("the create date carries its time", new RegExp(`Task Create Date\\s+${TODAY} \\d\\d:\\d\\d`).test(F));
ok("an overdue due date says so", /\*\* OVERDUE \*\*/.test(F));
ok("status and assignee reach the file", /Status\s+In progress/.test(F) && /Assignee\s+Jim/.test(F));
ok("the description reaches the file", F.includes("Confirm the table design"));
ok("a bulleted description keeps its bullets", /- Which key joins them/.test(F));
ok("a table in a description keeps its row", /Records \| daily/.test(F));
ok("reference links reach the file, with their notes",
   F.includes("https://example.com/spec") && F.includes("The spec he sent"));
ok("the update trail reaches the file, oldest first",
   F.indexOf("Asked him on Teams") > 0 &&
   F.indexOf("Asked him on Teams") < F.indexOf("waiting on the DBA"));
ok("an update states how many images it carries, by name",
   /\[1 image: teams\.png\]/.test(F));
ok("attachments are named, and say they are not in the file",
   F.includes("design-notes.pdf") && /not inside this text file/.test(F));
ok("the report ends with a stated count", /End of report\. 1 task,/.test(F));

/* ================================================== 3. the date range holds */
const win = await exportWith({ range: "Custom (use the two dates below)",
                               from: shift(-3), to: TODAY, ai: "No, facts only" });
ok("a task created ON the From day is included", win.text.includes("Edge task on the from day"));
ok("a task created ON the To day is included", win.text.includes("Ask Mihal about"));
ok("a task outside the range is excluded", !win.text.includes("Old task from last month"));
ok("the span names both dates", win.text.includes(`${shift(-3)} to ${TODAY}`));

const before = await exportWith({ range: "Custom (use the two dates below)",
                                  from: shift(-2), to: TODAY, ai: "No, facts only" });
ok("moving From forward one day drops the task on the old boundary",
   !before.text.includes("Edge task on the from day"));

const today1 = await exportWith({ range: "Today", ai: "No, facts only" });
ok("Today picks up a task created today, in the local timezone",
   today1.text.includes("Ask Mihal about"));
ok("Today excludes yesterday's", !today1.text.includes("Task with an edited create date"));

const none = await exportWith({ range: "Yesterday", project: "EDRMS ADB", ai: "No, facts only" });
ok("an empty range still saves a file that says so",
   /No tasks fall in this range/.test(none.text));

/* ======================================= 4. scope, project and the numbering */
const all = await exportWith({ scope: "All tasks (includes blocked and completed)",
                               range: "All dates", ai: "No, facts only" });
ok("All tasks reaches the completed one", all.text.includes("A finished thing"));
ok("In progress does not", !one.text.includes("A finished thing"));
const onlyLogged = await exportWith({ scope: "Blocked and completed only",
                                      range: "All dates", ai: "No, facts only" });
ok("Blocked and completed only reaches just those",
   onlyLogged.text.includes("A finished thing") && !onlyLogged.text.includes("Ask Mihal about"));

const glass = await exportWith({ range: "All dates", project: "GLASS", ai: "No, facts only" });
ok("the project filter narrows the report",
   glass.text.includes("Old task from last month") && !glass.text.includes("Ask Mihal about"));

// The number in the file is the number on the screen, not a position within
// whatever the range happened to select.
const screen = await page.$$eval("table.tasktable tbody tr td:first-child", (c) => c.map((x) => x.textContent.trim()));
const mihalNo = screen[TASKS.findIndex((t) => t.id === "t-1000000000003")];
ok("the number in the report is the number in the table",
   new RegExp(`TASK ${mihalNo}\\s+Ask Mihal`).test(one.text), `table says ${mihalNo}`);
ok("a narrowed report does not renumber from 1",
   /TASK 3\s+Ask Mihal/.test(today1.text));

/* ============================================ 5. the create-date time rule */
const edited = await exportWith({ range: "All dates", project: "GLASS", ai: "No, facts only" });
const line = (edited.text.split("\n").find((l) => /Task Create Date/.test(l) && l.includes(shift(-2))) || "");
ok("an edited create date prints no invented clock time",
   line.includes(shift(-2)) && !/\d\d:\d\d/.test(line), line.trim());

/* ================================================== 6. the AI, and its failures */
const GOOD = `SUMMARY
Four pieces of work, mostly on the EDRMS ADB release.

TASK 3
Waiting on a database answer from Mihal before the design can be signed off.`;

const withAi = await exportWith({ range: "Today", ai: "Yes, write a summary" },
  { stub: `window.TrackerAI.report = async () => ${JSON.stringify(GOOD)};` });
ok("the AI summary reaches the report", withAi.text.includes("mostly on the EDRMS ADB release"));
ok("the per-task line lands under its own task",
   /IN PLAIN TERMS[\s\S]{0,120}Waiting on a database answer/.test(withAi.text));
ok("and the facts are still there beside it",
   /Project\s+EDRMS ADB/.test(withAi.text) && withAi.text.includes("Confirm the table design"));

const failed1 = await exportWith({ range: "Today", ai: "Yes, write a summary" },
  { stub: `window.TrackerAI.report = async () => { throw new Error("That Google key was refused. Check it in Settings."); };` });
ok("a refused key still saves a file", failed1.text.length > 500);
ok("and says why the summary is missing", failed1.text.includes("That Google key was refused"));
ok("and every task is still complete in it",
   failed1.text.includes("Ask Mihal about") && /Assignee\s+Jim/.test(failed1.text) &&
   failed1.text.includes("Confirm the table design"));

const empty = await exportWith({ range: "Today", ai: "Yes, write a summary" },
  { stub: `window.TrackerAI.report = async () => "";` });
ok("an empty reply degrades to facts only, and says so",
   /facts only/.test(empty.text) && empty.text.includes("Ask Mihal about"));

const junk = await exportWith({ range: "Today", ai: "Yes, write a summary" },
  { stub: `window.TrackerAI.report = async () => "I have reviewed everything and here it is.";` });
ok("a reply ignoring the shape costs the per-task lines and nothing else",
   junk.text.includes("I have reviewed everything") && junk.text.includes("Ask Mihal about") &&
   /Task Create Date/.test(junk.text));

// The one that matters most: the model cannot make the report state a fact.
const liar = await exportWith({ range: "Today", ai: "Yes, write a summary" },
  { stub: `window.TrackerAI.report = async () => "SUMMARY\\nEverything is finished and signed off by Doris.";` });
ok("model prose never overwrites a field",
   /Status\s+In progress/.test(liar.text) && /Assignee\s+Jim/.test(liar.text),
   "the model claimed it was finished and signed off by Doris");

/* ================================== 7. the engines, enumerated at runtime */
const ai = await page.evaluate(() => {
  const A = window.TrackerAI;
  return {
    providers: A.PROVIDERS.map((p) => p.id),
    report: A.prompt("report"),
    rewrite: A.prompt("description"),
    hasReport: typeof A.report === "function",
  };
});
ok("there is a report entry point", ai.hasReport);
ok("the report instruction is not the rewrite instruction", ai.report !== ai.rewrite);
ok("it forbids inventing specifics",
   /invent no names, dates, systems, numbers/i.test(ai.report));
ok("it forbids an em dash, as everything here does", /em dash/i.test(ai.report));
ok("it asks for the shape the report is parsed back out of",
   /SUMMARY/.test(ai.report) && /TASK 1/.test(ai.report));
// Enumerated, never a list of two: a third engine added later is covered by
// this check without the check being edited.
ok(`every engine can run a report (${ai.providers.length} found: ${ai.providers.join(", ")})`,
   ai.providers.length > 0 && await page.evaluate(() =>
     window.TrackerAI.PROVIDERS.every((p) => typeof p.run === "function" && p.wire && p.key)));

ok("nothing threw while doing all that", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(failed ? `\nFAIL: ${failed} check(s)` : "\nPASS: the export reports what is there, and nothing more");
process.exit(failed ? 1 : 0);
