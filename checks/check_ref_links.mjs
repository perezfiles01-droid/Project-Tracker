#!/usr/bin/env node
/**
 * Guard: several reference links, each with a note, each with a wand.
 *
 * Three things this is built to catch, all of which look fine on screen:
 *
 *   1. Rows that renumber when one is removed. Every standardize button below
 *      the gap then points at the box above it, and typing into link 3 sends
 *      link 2's text away. So the middle row of three is deliberately removed
 *      and the survivors checked for their own values.
 *   2. A note that saves against the wrong link. Row 2's note is typed and
 *      then read back off row 2's stored link, not merely "a note exists".
 *   3. `ref` quietly dropped. Every activity-log entry the app has written
 *      carries it, so it is asserted to still equal the first link's URL.
 *
 * The wand assertions enumerate the note boxes actually rendered rather than
 * naming two: a fourth row added later must be covered by the check that
 * exists, not by one somebody remembers to update.
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

const rows = () => page.locator("[data-linkrow]").count();
const openTask = async () => {
  await page.click('#nav button[data-route="todo"]');
  await page.waitForTimeout(300);
  await page.click('[data-edit="task:new"]');
  await page.waitForSelector("#formDialog .box");
};

/* --- one row, and a + that adds more -------------------------------------- */
await openTask();
ok("the reference link field renders one row to start", (await rows()) === 1,
   String(await rows()));
ok("there is a button to add another link",
   (await page.locator("[data-linkadd]").count()) === 1);
await page.click("[data-linkadd]");
await page.click("[data-linkadd]");
await page.waitForTimeout(200);
ok("clicking + adds rows", (await rows()) === 3, String(await rows()));

/* --- rows are independent, and removing one does not renumber the rest ---- */
const urlInputs = page.locator('[data-linkrow] input[type="url"]');
await urlInputs.nth(0).fill("https://example.test/one");
await urlInputs.nth(1).fill("https://example.test/two");
await urlInputs.nth(2).fill("https://example.test/three");
await page.locator("[data-linkdrop]").nth(1).click();   // the middle one
await page.waitForTimeout(200);
const left = await page.$$eval('[data-linkrow] input[type="url"]', (i) => i.map((x) => x.value));
ok("removing the middle row leaves the other two untouched",
   JSON.stringify(left) === JSON.stringify(["https://example.test/one",
                                            "https://example.test/three"]),
   left.join(" | "));

/* --- the note is hidden until the icon is clicked ------------------------- */
const noteVisible = () => page.locator("[data-notebox]:not([hidden])").count();
ok("no note box is showing to start", (await noteVisible()) === 0);
ok("every row carries a note toggle",
   (await page.locator("[data-noteopen]").count()) === 2);
await page.locator("[data-noteopen]").nth(1).click();
await page.waitForTimeout(200);
ok("clicking the icon opens exactly one note box", (await noteVisible()) === 1);
ok("the toggle reports itself open",
   (await page.locator("[data-noteopen]").nth(1).getAttribute("aria-expanded")) === "true");
await page.locator("[data-noteopen]").nth(1).click();
await page.waitForTimeout(200);
ok("clicking it again hides the box", (await noteVisible()) === 0);

/* --- every note box carries the same wand as the other text fields -------- */
await page.locator("[data-noteopen]").nth(0).click();
await page.locator("[data-noteopen]").nth(1).click();
await page.waitForTimeout(200);
const wands = await page.$$eval("[data-notebox]", (boxes) => boxes.map((b) => {
  const ta = b.querySelector("textarea");
  const w = b.querySelector("[data-standardize]");
  return { id: ta && ta.id, points: w && w.dataset.standardize,
           title: w && w.getAttribute("title") };
}));
ok("a wand sits on every note box that exists", wands.length === 2 &&
   wands.every((w) => w.points && w.points === w.id), JSON.stringify(wands));
ok("it is the same button as the other fields",
   wands.every((w) => w.title === "Standardize text"), JSON.stringify(wands.map((w) => w.title)));

/* --- and it drives that box, not another one -----------------------------
   The engine and its key are set the way check_standardize does it, and the
   reply is built in the shape that engine actually reads. A stub in the wrong
   shape makes every assertion here meaningless, so an unknown wire fails
   loudly rather than falling through to a default. */
const WIRES = {
  gemini: (text) => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  openai: (text) => ({ choices: [{ message: { role: "assistant", content: text } }] }),
};
const engine = await page.evaluate(() => {
  const id = window.TrackerAI.DEFAULT_ENGINE;
  const p = (window.TrackerAI.PROVIDERS || []).find((x) => x.id === id);
  return p ? { id, wire: p.wire, keySetting: p.keySetting } : null;
});
ok("the check knows the default engine's reply shape",
   !!(engine && WIRES[engine.wire]),
   engine ? `wire "${engine.wire}"` : "no default engine");

const REPLY = "The second link is the design spec.";
await page.evaluate(([eng, body]) => {
  localStorage.setItem(eng.keySetting, "test-key");
  window.__calls = [];
  window.fetch = async (u, init) => {
    window.__calls.push({ url: String(u), init });
    return { ok: true, status: 200, json: async () => body };
  };
}, [engine, WIRES[engine.wire](REPLY)]);

const noteBoxes = page.locator("[data-notebox] textarea");
await noteBoxes.nth(0).fill("first note, left alone");
await noteBoxes.nth(1).fill("second note please tidy");
// Read back what the fields actually hold: the note capitalises its own first
// letter as you type, exactly as Name of task and Detailed description do, so
// comparing against the literal would fail on a byte the app changes on purpose.
const kept0 = await noteBoxes.nth(0).inputValue();
const kept1 = await noteBoxes.nth(1).inputValue();
await page.locator("[data-notebox] [data-standardize]").nth(1).click();
await page.waitForTimeout(600);
ok("the wand made a request", (await page.evaluate(() => window.__calls.length)) === 1,
   String(await page.evaluate(() => window.__calls.length)));
const after = await page.$$eval("[data-notebox] textarea", (t) => t.map((x) => x.value));
ok("the wand rewrote the box it belongs to", after[1] === REPLY, after[1]);
ok("and left the other note exactly as typed", after[0] === kept0, after[0]);
const undo = page.locator('[data-notebox] [data-undo]');
ok("it offers an Undo", (await undo.count()) === 1);
await undo.click();
await page.waitForTimeout(200);
ok("Undo puts back what was typed",
   (await page.$$eval("[data-notebox] textarea", (t) => t[1].value)) === kept1,
   await page.$$eval("[data-notebox] textarea", (t) => t[1].value));

/* --- what is saved ------------------------------------------------------- */
await page.fill("#fd_name", "Task with links");
await page.click('[data-fd="save"]');
await page.waitForSelector("table.tasktable");
const saved = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("tracker.tasks")).find((t) => t.name === "Task with links"));
ok("both links are stored", (saved.refs || []).length === 2,
   JSON.stringify(saved.refs));
ok("each note is stored against its own link",
   saved.refs[0].url === "https://example.test/one" &&
   saved.refs[0].note === kept0 &&
   saved.refs[1].url === "https://example.test/three" &&
   saved.refs[1].note === kept1,
   JSON.stringify(saved.refs));
ok("ref still carries the first link, for everything that reads it",
   saved.ref === "https://example.test/one", JSON.stringify(saved.ref));

/* --- the pane shows every link and every note ----------------------------- */
await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(300);
const pane = (await page.locator(".taskpane").innerText()).replace(/\s+/g, " ");
ok("the pane lists both links", pane.includes("example.test/one") &&
   pane.includes("example.test/three"), pane.slice(0, 120));
ok("and the note that says what each is for",
   pane.includes(kept0) && pane.includes(kept1),
   pane.slice(0, 160));

/* --- a task saved the old way still opens -------------------------------- */
await page.evaluate(() => localStorage.setItem("tracker.tasks", JSON.stringify([
  { id: "t-1", name: "Old shape", ref: "https://old.test/link",
    status: "To do", attachments: [] },
])));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(300);
await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(300);
ok("a task with only the old `ref` still shows its link",
   (await page.locator(".taskpane").innerText()).includes("old.test/link"));
await page.click('.taskpane [data-edit^="task:"]');
await page.waitForSelector("#formDialog .box");
ok("and it opens in the dialog as one row carrying that URL",
   (await rows()) === 1 &&
   (await page.inputValue('[data-linkrow] input[type="url"]')) === "https://old.test/link",
   await page.inputValue('[data-linkrow] input[type="url"]'));

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} reference-link check(s) failed`
                   : "\nPASS: many links, each with a note, each with a wand");
process.exit(failed ? 1 : 0);
