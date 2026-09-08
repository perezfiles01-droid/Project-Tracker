#!/usr/bin/env node
/**
 * Guard: undo and redo, seven deep, and the images a delete takes with it.
 *
 * Seven things fail quietly if nobody drives them:
 *
 *   1. The depth. Eight edits then eight undos must honour exactly seven and
 *      leave the oldest state unreachable, not seven-ish.
 *   2. One action is one undo. editTask writes the task AND the activity log
 *      from a single click; ungrouped, marking a task Done takes two undo
 *      clicks and the first leaves the two disagreeing.
 *   3. Redo re-applies, and a NEW edit clears the redo pile - the only rule
 *      that cannot redo onto a state that no longer exists.
 *   4. Undo and redo do not themselves become undo steps, or the buttons
 *      never turn off.
 *   5. Deleted attachment bytes come back with the record. An undo that
 *      restores a task and loses its screenshots is worse than no undo.
 *   6. Those bytes are eventually deleted for real, once the step that
 *      removed them can no longer be undone - otherwise this is a memory leak
 *      wearing an undo button.
 *   7. The buttons say what they can do: disabled at the ends, named with the
 *      depth so hovering tells you how far back you can go.
 *
 * Every assertion is driven through the real UI - the real dialogs, the real
 * confirmations, the real buttons in the sidebar - so a change that keeps the
 * store's API but breaks the way in is still caught.
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
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);
await page.evaluate(() => {
  localStorage.setItem("tracker.tasks", "[]");
  localStorage.setItem("tracker.activity", "[]");
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);

const DEPTH = await page.evaluate(() => window.TrackerStore.DEPTH);
const depths = () => page.evaluate(() =>
  ({ undo: window.TrackerStore.undoDepth(), redo: window.TrackerStore.redoDepth() }));
const names = () => page.evaluate(() =>
  [...(document.querySelectorAll("#history .btn.icon") || [])].map((b) => b.getAttribute("aria-label")));
const disabled = () => page.evaluate(() => ({
  undo: !!document.querySelector("#doUndo")?.disabled,
  redo: !!document.querySelector("#doRedo")?.disabled,
}));
const taskNames = () => page.evaluate(() =>
  JSON.parse(localStorage.getItem("tracker.tasks") || "[]").map((t) => t.name));
const blobKeys = () => page.evaluate(() => new Promise((resolve) => {
  const r = indexedDB.open("tracker-files", 1);
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains("blobs")) return resolve([]);
    const rq = db.transaction("blobs", "readonly").objectStore("blobs").getAllKeys();
    rq.onsuccess = () => resolve([...rq.result]);
    rq.onerror = () => resolve([]);
  };
  r.onerror = () => resolve([]);
}));

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const pasteImages = (n) => page.evaluate(({ b64, n }) => {
  const dt = new DataTransfer();
  for (let i = 0; i < n; i++) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
  }
  document.querySelector("#formDialog").dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, { b64: PNG, n });

/**
 * Make sure the detail pane is showing, without toggling it shut.
 *
 * The pane remembers the open row by id, so after an undo restores a deleted
 * task its pane comes back on its own. Clicking the row then closes it.
 */
async function openPane() {
  if (await page.locator('.taskpane [data-remove^="task:"]').count() === 0) {
    await page.click(".taskrow");
    await page.waitForSelector('.taskpane [data-remove^="task:"]');
  }
}

/** Create one task through the real dialog. */
async function addTask(name, { images = 0 } = {}) {
  await page.click('[data-edit="task:new"]');
  await page.waitForSelector("#fd_name");
  await page.fill("#fd_name", name);
  if (images) { await pasteImages(images); await page.waitForTimeout(200); }
  await page.click('#formDialog [data-fd="save"]');
  await page.waitForTimeout(400);
}

/* --- 7. the buttons exist, named, and start disabled ---------------------- */
const shown = await names();
ok("the sidebar footer carries two history buttons", shown.length === 2, shown.join(" | "));
ok("both are named", shown.every((n) => n && n.trim()), shown.join(" | "));
let dis = await disabled();
ok("both are disabled on a fresh load", dis.undo && dis.redo, JSON.stringify(dis));
ok("the depth is seven", DEPTH === 7, String(DEPTH));

/* --- 1. eight edits, seven undos ----------------------------------------- */
for (let i = 1; i <= 8; i++) await addTask("Task " + i);
let d = await depths();
ok("eight edits leave exactly seven undo steps", d.undo === 7, JSON.stringify(d));
ok("Undo is enabled and says how deep it goes",
   !(await disabled()).undo && /7 of 7/.test((await names())[0] || ""), (await names())[0]);

ok("eight tasks were created", (await taskNames()).length === 8);
for (let i = 0; i < 7; i++) {
  await page.click("#doUndo");
  await page.waitForTimeout(250);
}
let left = await taskNames();
ok("seven undos remove seven tasks", left.length === 1, left.join(", "));
ok("the oldest is the one that survives", left[0] === "Task 1", left.join(", "));
ok("Undo is disabled at the bottom of the stack", (await disabled()).undo);
d = await depths();
ok("undo did not stack onto itself", d.undo === 0 && d.redo === 7, JSON.stringify(d));

/* --- 3. redo re-applies -------------------------------------------------- */
ok("Redo is enabled after undoing", !(await disabled()).redo);
for (let i = 0; i < 7; i++) {
  await page.click("#doRedo");
  await page.waitForTimeout(250);
}
ok("seven redos put all eight back", (await taskNames()).length === 8);
ok("Redo is disabled at the top", (await disabled()).redo);

/* --- 3b. a new edit clears the redo pile --------------------------------- */
await page.click("#doUndo");
await page.waitForTimeout(250);
ok("there is something to redo", (await depths()).redo === 1);
await addTask("After the undo");
d = await depths();
ok("a new edit clears the redo pile", d.redo === 0, JSON.stringify(d));
ok("and Redo is disabled again", (await disabled()).redo);

/* --- 2. one action is one undo, across two keys -------------------------- */
await page.evaluate(() => {
  localStorage.setItem("tracker.tasks", JSON.stringify([{
    id: "t-9", name: "Move me", given: "2026-09-01", status: "In progress",
    assignee: "Jim", attachments: [], updates: [],
  }]));
  localStorage.setItem("tracker.activity", "[]");
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
await page.click(".taskrow");
await page.waitForTimeout(250);
await page.selectOption(".taskpane .statuspick", "Done");
await page.waitForSelector('#formDialog [data-fd="choice"]');
await page.click('#formDialog [data-fd="choice"]');
await page.waitForTimeout(500);
const moved = await page.evaluate(() => ({
  status: JSON.parse(localStorage.getItem("tracker.tasks"))[0].status,
  log: JSON.parse(localStorage.getItem("tracker.activity")).length,
}));
ok("marking Done writes the task and the log", moved.status === "Done" && moved.log === 1,
   JSON.stringify(moved));
ok("but it is only ONE undo step", (await depths()).undo === 1,
   `${(await depths()).undo} steps for one click`);
await page.click("#doUndo");
await page.waitForTimeout(400);
const back = await page.evaluate(() => ({
  status: JSON.parse(localStorage.getItem("tracker.tasks"))[0].status,
  log: JSON.parse(localStorage.getItem("tracker.activity")).length,
}));
ok("one undo puts BOTH back", back.status === "In progress" && back.log === 0,
   JSON.stringify(back));

/* --- 5 & 6. deleted images come back, then are really gone --------------- */
await page.evaluate(() => { localStorage.setItem("tracker.tasks", "[]"); });
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
await addTask("Has pictures", { images: 2 });
const withImgs = await page.evaluate(() =>
  (JSON.parse(localStorage.getItem("tracker.tasks"))[0].attachments || []).map((a) => a.id));
ok("the task carries two attachments", withImgs.length === 2, withImgs.join(", "));
const before = await blobKeys();
ok("their bytes are in IndexedDB", withImgs.every((id) => before.includes(id)));

await openPane();
await page.click('.taskpane [data-remove^="task:"]');
await page.waitForSelector('#formDialog [data-fd="choice"]');
await page.click('#formDialog [data-fd="choice"]');
await page.waitForTimeout(600);
ok("the task is deleted", (await taskNames()).length === 0);
const held = await blobKeys();
ok("its bytes are HELD, not dropped, while the delete can be undone",
   withImgs.every((id) => held.includes(id)), held.join(", "));

await page.click("#doUndo");
await page.waitForTimeout(500);
const restored = await page.evaluate(() =>
  (JSON.parse(localStorage.getItem("tracker.tasks"))[0]?.attachments || []).map((a) => a.id));
ok("undo brings the task back", (await taskNames()).length === 1);
ok("with the same attachments", restored.length === 2 &&
   restored.every((id) => withImgs.includes(id)), restored.join(", "));
ok("whose bytes are still readable",
   (await blobKeys()).filter((k) => withImgs.includes(k)).length === 2);

// Delete it again, then push the step off the end of the stack.
// Undo reopened the pane on the restored task, because the pane remembers
// which row was open by id and that row is back. Clicking the row again would
// close it, so it is only clicked when the pane is not already showing.
await openPane();
await page.click('.taskpane [data-remove^="task:"]');
await page.waitForSelector('#formDialog [data-fd="choice"]');
await page.click('#formDialog [data-fd="choice"]');
await page.waitForTimeout(500);
for (let i = 1; i <= DEPTH; i++) await addTask("Filler " + i);
await page.waitForTimeout(600);
const purged = await blobKeys();
ok("once the delete falls out of the history, the bytes are really gone",
   withImgs.every((id) => !purged.includes(id)), purged.join(", ") || "none left");

/* --- a restore is not one undo ------------------------------------------- */
await page.evaluate(() => {
  const payload = window.TrackerStore.exportData();
  window.TrackerStore.importData(payload);
});
await page.waitForTimeout(300);
ok("restoring a backup clears the history rather than becoming one step",
   (await depths()).undo === 0 && (await depths()).redo === 0,
   JSON.stringify(await depths()));

ok("no page errors along the way", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${failed} undo check(s) failed`);
process.exit(failed ? 1 : 0);
