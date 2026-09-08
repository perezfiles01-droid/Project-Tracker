#!/usr/bin/env node
/**
 * Guard: the manual update trail on a task.
 *
 * Six promises, every one of which fails silently if nobody drives it:
 *
 *   1. The pane header carries three named icon buttons, not two. An icon with
 *      no accessible name is a button nobody can identify, and a third one
 *      that never appears reads exactly like a feature that was not built.
 *   2. The trail is the details table. Same class, same wrapper, so it is the
 *      same width and the same formatting by construction rather than by two
 *      stylesheets agreeing with each other today.
 *   3. The time is stamped, never typed - and never printed against a date it
 *      did not happen on. An update back-dated to last week must show the date
 *      alone; printing this afternoon's clock beside it states something that
 *      never happened, which is the fault createStamp already exists to avoid.
 *   4. Five images, and the sixth is refused out loud. This is a property of
 *      every attachments field in the app, so the new one must join that
 *      family rather than quietly opt out of it.
 *   5. Oldest first, with the Add icon below the last entry, and one update
 *      removed takes its own image bytes and nobody else's.
 *   6. A task marked Done leaves the To Do List, and its trail is still
 *      readable from the Daily activity row it became. That is the whole
 *      second half of the request, and it is the half that breaks silently:
 *      the data survives, the way to look at it does not.
 *
 * Everything is driven through the real UI - the real icon, the real dialog,
 * the real confirmation - so a change that keeps the storage shape but breaks
 * the way in is still caught.
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

/** One task, written straight to storage, so the run starts from a known state. */
await page.evaluate(() => {
  localStorage.setItem("tracker.tasks", JSON.stringify([{
    id: "t-1700000000000", name: "Trail task", description: "A task with a history",
    given: "2026-09-01", createdAt: "2026-09-01T09:00:00.000Z",
    status: "In progress", assignee: "Jim", attachments: [], updates: [],
  }]));
  localStorage.setItem("tracker.activity", "[]");
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
await page.click(".taskrow");
await page.waitForTimeout(250);

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

/** Everything IndexedDB is holding, so blob cleanup can be counted rather than assumed. */
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

const storedUpdates = () => page.evaluate(() =>
  (JSON.parse(localStorage.getItem("tracker.tasks") || "[]")[0].updates || []));

/** Write one update through the real dialog. */
async function addUpdate({ date, text, images = 0 }) {
  await page.click("[data-addupdate]");
  await page.waitForSelector("#fd_date");
  if (date) await page.fill("#fd_date", date);
  await page.fill("#fd_text", text);
  if (images) { await pasteImages(images); await page.waitForTimeout(150); }
  await page.click('#formDialog [data-fd="save"]');
  await page.waitForTimeout(400);
}

/* --- 1. the third icon, named, beside edit and remove --------------------- */
const headIcons = await page.$$eval(".taskpane .panehead .btn.icon",
  (bs) => bs.map((b) => b.getAttribute("aria-label")));
ok("the pane header carries three icon buttons", headIcons.length === 3, headIcons.join(" | "));
ok("every header icon has an accessible name", headIcons.every((n) => n && n.trim()),
   headIcons.join(" | "));
ok("the new one is the update button",
   await page.locator(".taskpane .panehead [data-updates]").count() === 1);
ok("edit and remove are still there",
   await page.locator('.taskpane .panehead [data-edit^="task:"]').count() === 1 &&
   await page.locator('.taskpane .panehead [data-remove^="task:"]').count() === 1);

/* --- 2. it swaps the pane to a table of the same class -------------------- */
const detailWidth = await page.locator(".taskpane table.detailtable").evaluate((el) => el.clientWidth);
await page.click(".taskpane [data-updates]");
await page.waitForTimeout(250);
ok("the details rows are gone", await page.locator(".taskpane tr:has(th:text-is('Assignee'))").count() === 0);
const upTable = page.locator(".taskpane table.detailtable.updatetable");
ok("the updates table is the details table", await upTable.count() === 1);
const upWidth = await upTable.evaluate((el) => el.clientWidth);
ok("it is the same width as the details table", upWidth === detailWidth, `${upWidth} vs ${detailWidth}`);
ok("an empty trail says so, and offers the first update",
   (await page.locator(".taskpane").innerText()).includes("No updates yet") &&
   await page.locator("[data-addupdate]").count() === 1);
ok("clicking the icon again goes back to the details",
   await (async () => {
     await page.click(".taskpane [data-updates]");
     await page.waitForTimeout(200);
     const back = await page.locator(".taskpane tr:has(th:text-is('Assignee'))").count() === 1;
     await page.click(".taskpane [data-updates]");
     await page.waitForTimeout(200);
     return back;
   })());

/* --- 3. the date is picked, the time is stamped --------------------------- */
const today = await page.evaluate(() => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
});
ok("the dialog does not ask for a time", await (async () => {
  await page.click("[data-addupdate]");
  await page.waitForSelector("#fd_date");
  const n = await page.locator('#formDialog input[type="time"]').count();
  const help = await page.locator("#formDialog .field:has(#fd_date) small").innerText();
  await page.click('#formDialog [data-fd="cancel"]');
  await page.waitForTimeout(200);
  return n === 0 && /stamped automatically/i.test(help);
})());

await addUpdate({ date: today, text: "first update, written today" });
let saved = await storedUpdates();
ok("the update is stored on the task", saved.length === 1, JSON.stringify(saved[0] || {}).slice(0, 120));
ok("it carries the date that was picked", saved[0].date === today, saved[0].date);
ok("it carries an instant nobody typed", !!saved[0].at && !isNaN(Date.parse(saved[0].at)), saved[0].at);
ok("the text is stored as written", saved[0].text === "First update, written today",
   saved[0].text);   // capitalize:1 raises the first letter, as on every marked field
let when = await page.locator(".updaterow .updatewhen").first().innerText();
ok("today's entry shows the date and the clock time",
   when.includes(today) && /\d{2}:\d{2}/.test(when), when);

await addUpdate({ date: "2026-08-15", text: "back-dated to last month" });
const rowsWhen = await page.$$eval(".updaterow .updatewhen", (e) => e.map((x) => x.innerText.trim()));
const backRow = rowsWhen.find((w) => w.includes("2026-08-15"));
ok("a back-dated entry shows no clock time", backRow && !/\d{2}:\d{2}/.test(backRow), backRow);

/* --- 4. five images, and the sixth refused out loud ----------------------- */
await page.click("[data-addupdate]");
await page.waitForSelector("#fd_images");
await pasteImages(6);
await page.waitForTimeout(300);
const stagedCount = await page.locator(".attstaged .attrow").count();
const note = await page.locator("[data-attcount]").innerText();
const refusal = await page.locator('[data-note="fd_images"]').innerText();
ok("only five images stage", stagedCount === 5, String(stagedCount));
ok("the count says five of five", /5 of 5/.test(note), note);
ok("the sixth is refused in words", /not attached/i.test(refusal), refusal);
await page.fill("#fd_text", "update with pictures");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(600);
saved = await storedUpdates();
const withImgs = saved.find((u) => (u.images || []).length);
ok("five images are stored on that entry", withImgs && withImgs.images.length === 5,
   String(withImgs && withImgs.images.length));
const keysAfterAdd = await blobKeys();
ok("their bytes are in IndexedDB, keyed by the stored ids",
   withImgs.images.every((a) => keysAfterAdd.includes(a.id)), keysAfterAdd.join(", "));
ok("no image bytes leak into localStorage", !/data:image/.test(JSON.stringify(saved)));

/* --- 5. oldest first, add icon last, and a clean removal ------------------ */
const order = await page.$$eval(".updaterow .updatewhen", (e) => e.map((x) => x.innerText.trim()));
ok("the trail reads oldest first", order.length === 3 && order[0].includes("2026-08-15"),
   order.join(" | "));
ok("the add icon sits below the last entry", await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".updatetable tbody tr")];
  return rows.length > 0 && rows[rows.length - 1].classList.contains("updateadd");
}));
ok("each entry can be edited and removed",
   await page.locator("[data-editupdate]").count() === 3 &&
   await page.locator("[data-dropupdate]").count() === 3);

// Editing one leaves the other two exactly as they were.
const before = await storedUpdates();
await page.click(".updaterow:first-child [data-editupdate]");
await page.waitForSelector("#fd_text");
await page.fill("#fd_text", "corrected wording");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(500);
const after = await storedUpdates();
ok("editing one update changes only that one", after.length === 3 &&
   after.filter((u) => u.text === "Corrected wording").length === 1 &&
   before.filter((b) => after.some((a) => a.id === b.id && a.text === b.text)).length === 2,
   after.map((u) => u.text).join(" | "));
ok("editing keeps the instant it was first written",
   after.find((u) => u.text === "Corrected wording").at ===
   before.find((u) => u.date === "2026-08-15").at);

// Removing the entry with images drops its bytes, and only its bytes.
const doomed = (await storedUpdates()).find((u) => (u.images || []).length);
const otherKeys = keysAfterAdd.filter((k) => !doomed.images.some((a) => a.id === k));
await page.click(`[data-dropupdate$="|${doomed.id}"]`);
await page.waitForSelector('#formDialog [data-fd="choice"]');
await page.click('#formDialog [data-fd="choice"]');
await page.waitForTimeout(700);
const left = await storedUpdates();
const keysAfterDrop = await blobKeys();
ok("removing an update leaves the rest", left.length === 2 && !left.some((u) => u.id === doomed.id),
   left.map((u) => u.date).join(", "));
ok("its image bytes go with it",
   doomed.images.every((a) => !keysAfterDrop.includes(a.id)), keysAfterDrop.join(", "));
ok("nobody else's bytes go with it",
   otherKeys.every((k) => keysAfterDrop.includes(k)), otherKeys.join(", "));

/* --- 6. the trail survives the move to Daily activity --------------------- */
await page.click(".taskpane [data-updates]");   // back to details, for the status picker
await page.waitForTimeout(200);
await page.selectOption(".taskpane .statuspick", "Done");
await page.waitForSelector('#formDialog [data-fd="choice"]');
await page.click('#formDialog [data-fd="choice"]');
await page.waitForTimeout(500);
ok("the task has left the To Do List", await page.locator(".taskrow").count() === 0);

await page.click('#nav button[data-route="daily"]');
await page.waitForTimeout(300);
const seeBtn = page.locator("[data-seeupdates]");
ok("the logged row offers its updates", await seeBtn.count() === 1);
ok("the button names how many there are",
   /2 updates/.test(await seeBtn.getAttribute("aria-label") || ""),
   await seeBtn.getAttribute("aria-label"));
await seeBtn.click();
await page.waitForTimeout(400);
ok("it opens the same trail table",
   await page.locator("#formDialog table.detailtable.updatetable").count() === 1);
const dialogRows = await page.$$eval("#formDialog .updaterow .updatewhen",
  (e) => e.map((x) => x.innerText.trim()));
ok("both updates are readable from there", dialogRows.length === 2, dialogRows.join(" | "));
ok("it is read-only: no add, edit or remove",
   await page.locator("#formDialog [data-addupdate]").count() === 0 &&
   await page.locator("#formDialog [data-editupdate]").count() === 0 &&
   await page.locator("#formDialog [data-dropupdate]").count() === 0);
await page.click('#formDialog [data-fd="cancel"]');
await page.waitForTimeout(200);

/* A hand-typed log entry has no task behind it, so it offers no trail. */
await page.click('[data-edit="act:new"]');
await page.waitForSelector("#fd_task");
await page.fill("#fd_task", "typed by hand");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(400);
ok("a manual entry offers no updates button",
   await page.locator("[data-seeupdates]").count() === 1,
   String(await page.locator("[data-seeupdates]").count()));

/* --- the trail rides along in the backup --------------------------------- */
const backup = await page.evaluate(() => window.TrackerStore.exportData());
ok("the update text and dates are in the backup",
   /Corrected wording/.test(backup.keys["tracker.tasks"] || ""));

ok("no page errors along the way", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${failed} update check(s) failed`);
process.exit(failed ? 1 : 0);
