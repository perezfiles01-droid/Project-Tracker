#!/usr/bin/env node
/**
 * Backup round trip: write, save, wipe, restore, and get everything back.
 *
 * The failure that matters is a silent one - a restore that comes back short,
 * or a bad file that half-loads and leaves storage in a state no one asked
 * for. Both are asserted here.
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
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);

// A value in every data key, so a missed key cannot hide behind an empty one.
const keys = await page.evaluate(() => window.TrackerStore.KEYS.data);
ok("the store declares its data keys", keys.length > 0, keys.join(", "));
await page.evaluate((ks) => {
  ks.forEach((k, i) => localStorage.setItem(k, JSON.stringify([{ marker: "v" + i }])));
}, keys);

const payload = await page.evaluate(() => JSON.stringify(window.TrackerStore.exportData()));
const saved = JSON.parse(payload);
ok("the backup carries every data key", Object.keys(saved.keys).length === keys.length,
   `${Object.keys(saved.keys).length} of ${keys.length}`);
ok("the backup is labelled so a stray file can be told apart",
   saved.format === "project-tracker-backup" && saved.version === 1);

// Wipe, then restore.
await page.evaluate((ks) => ks.forEach((k) => localStorage.removeItem(k)), keys);
const empty = await page.evaluate((ks) => ks.filter((k) => localStorage.getItem(k) !== null), keys);
ok("storage really was cleared before restoring", empty.length === 0, empty.join(", "));

const n = await page.evaluate((p) => window.TrackerStore.importData(JSON.parse(p)), payload);
ok("restore reports every key", n === keys.length, `${n} of ${keys.length}`);
const back = await page.evaluate((ks) => ks.map((k, i) => {
  const v = localStorage.getItem(k);
  try { return JSON.parse(v)[0].marker === "v" + i; } catch { return false; }
}), keys);
ok("every key came back with its own value", back.every(Boolean),
   `${back.filter(Boolean).length} of ${keys.length}`);

/* A bad file must change nothing. */
for (const [name, bad] of [
  ["a file that is not a backup", '{"hello":"world"}'],
  ["a backup with no data", '{"format":"project-tracker-backup","version":1,"keys":{}}'],
  ["a damaged backup", '{"format":"project-tracker-backup","version":1,"keys":{"tracker.tasks":"{oops"}}'],
]) {
  const res = await page.evaluate(async (b) => {
    const before = JSON.stringify(window.TrackerStore.KEYS.data.map((k) => localStorage.getItem(k)));
    let threw = false;
    try { await window.TrackerStore.importData(JSON.parse(b)); } catch { threw = true; }
    const after = JSON.stringify(window.TrackerStore.KEYS.data.map((k) => localStorage.getItem(k)));
    return { threw, unchanged: before === after };
  }, bad);
  ok(`${name} is refused`, res.threw);
  ok(`${name} leaves storage untouched`, res.unchanged);
}

/* ---------- the pictures ----------
   The reported failure: back up on one computer, restore on another, and the
   text comes back while every picture is blank. "Another computer" is a
   second browser context - its own localStorage and its own IndexedDB, which
   is exactly what a different machine is.

   A picture is put into EVERY place this app can hold one, and the places are
   read from the app rather than listed here, so a field added later is
   carried without this check being edited. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const made = await page.evaluate(async (b64) => {
  // The id out of the markup, with the DOM rather than a regex: the markup is
  // this app's own and the parser cannot disagree with it.
  const idOf = (html) => {
    const d = document.createElement("div"); d.innerHTML = html;
    return d.firstElementChild.getAttribute("data-blob");
  };
  const mk = async (name) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const stored = await window.TrackerUI.storeImage(new File([bytes], name, { type: "image/png" }));
    return stored.html;
  };
  const inDescription = await mk("in-description.png");
  const inLogEntry    = await mk("in-log-entry.png");
  const inUpdateText  = await mk("in-update-text.png");
  const attachmentId  = window.TrackerBlobs.id("att");
  await window.TrackerBlobs.put(attachmentId, new Blob(["a file"], { type: "text/plain" }));
  const updateImageId = window.TrackerBlobs.id("att");
  await window.TrackerBlobs.put(updateImageId, new Blob(["an update image"], { type: "image/png" }));
  const orphanId = window.TrackerBlobs.id("att");
  await window.TrackerBlobs.put(orphanId, new Blob(["referenced by nothing"], { type: "text/plain" }));

  window.TrackerStore.set("tracker.tasks", [{
    id: "t1", name: "Task", status: "Open",
    description: "Screenshot: " + inDescription,
    attachments: [{ id: attachmentId, name: "notes.txt", type: "text/plain" }],
    updates: [{ id: "u1", text: "An update: " + inUpdateText,
                images: [{ id: updateImageId, name: "shot.png", type: "image/png" }] }],
  }]);
  window.TrackerStore.set("tracker.activity", [{ date: "2026-01-01", task: "Logged: " + inLogEntry }]);

  // What the check itself put where, named independently of how the code
  // decides what to carry - this is the list that catches one field being
  // missed, and it is not derived from the rule under test.
  const expected = {
    "a picture in a task description": idOf(inDescription),
    "a picture in the activity log": idOf(inLogEntry),
    "a picture in an update's text": idOf(inUpdateText),
    "a file attached to a task": attachmentId,
    "an image attached to an update": updateImageId,
  };
  // And, separately, every stored id the exported data mentions - the rule the
  // fix rests on, so a future rewrite that walks fields instead is caught.
  const exported = JSON.stringify(window.TrackerStore.exportData().keys);
  const referenced = (await window.TrackerBlobs.list()).filter((id) => exported.indexOf(id) !== -1);
  return { expected, referenced, orphanId, stored: (await window.TrackerBlobs.list()).length };
}, PNG);

const places = Object.entries(made.expected);
ok("a picture was put in every place the app holds one",
   places.length === 5 && places.every(([, id]) => id),
   `${places.length} places, ${made.stored} blobs stored`);
ok("the exported data refers to all of them, and not to the orphan",
   made.referenced.length === places.length && !made.referenced.includes(made.orphanId),
   `${made.referenced.length} referenced`);

const file = await page.evaluate(() => window.TrackerStore.exportFile().then(JSON.stringify));
const parsed = JSON.parse(file);
ok("the backup file now carries bytes, not just references",
   parsed.blobs && Object.keys(parsed.blobs).length > 0,
   `${Object.keys(parsed.blobs || {}).length} in the file`);

/* Named place by place, so a failure says WHICH kind of picture was lost. */
for (const [where, id] of places) {
  ok(`the file carries ${where}`, !!(parsed.blobs && parsed.blobs[id]), id);
}
/* And the rule the fix rests on, which is what catches a field added later:
   every id the exported data refers to has bytes in the file. */
const missing = made.referenced.filter((id) => !parsed.blobs || !parsed.blobs[id]);
ok("every picture the data refers to has its bytes in the file",
   made.referenced.length > 0 && missing.length === 0,
   missing.join(", ") || `${made.referenced.length} checked`);
ok("a blob nothing refers to is not carried", !parsed.blobs[made.orphanId]);
ok("the file says which version it is", parsed.version === 2, String(parsed.version));

/* --- the other computer --- */
const other = await browser.newContext();
const p2 = await other.newPage();
const errors2 = [];
p2.on("pageerror", (e) => errors2.push(String(e)));
await p2.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await p2.waitForTimeout(300);
ok("the other computer starts with nothing stored",
   (await p2.evaluate(() => window.TrackerBlobs.list())).length === 0);

const restored = await p2.evaluate(async ({ f, refs }) => {
  await window.TrackerStore.importData(JSON.parse(f));
  const got = await Promise.all(refs.map((id) => window.TrackerBlobs.get(id)));
  // and what the page actually shows, which is the thing that was broken
  const task = window.TrackerStore.get("tracker.tasks", [])[0];
  document.querySelector("#view").innerHTML = task.description;
  window.TrackerUI.paintImages(document);
  await new Promise((r) => setTimeout(r, 400));
  const img = document.querySelector("img[data-blob]");
  return { sizes: got.map((b) => (b ? b.size : null)),
           painted: !!(img && (img.getAttribute("src") || "").startsWith("blob:")) };
}, { f: file, refs: places.map(([, id]) => id) });

ok("every picture came back on the other computer",
   restored.sizes.length === places.length && restored.sizes.every((n) => n !== null),
   `${restored.sizes.filter((n) => n !== null).length} of ${places.length}`);
ok("the picture actually paints, rather than leaving an empty <img>", restored.painted);
ok("no page errors on the other computer", errors2.length === 0, errors2.join(" | "));

/* --- an older file must still restore, without pretending it had pictures --- */
const v1 = await p2.evaluate(async () => {
  await window.TrackerStore.importData({
    format: "project-tracker-backup", version: 1, savedAt: "2026-01-01T00:00:00Z",
    keys: { "tracker.tasks": JSON.stringify([{ id: "old", name: "From a version 1 file" }]) },
  });
  return window.TrackerStore.get("tracker.tasks", [])[0].name;
});
ok("a backup saved by the previous version still restores", v1 === "From a version 1 file", v1);

/* --- a damaged picture must lose nothing --- */
const damaged = await p2.evaluate(async () => {
  const before = window.TrackerStore.getText("tracker.tasks", "");
  let threw = false;
  try {
    await window.TrackerStore.importData({
      format: "project-tracker-backup", version: 2, savedAt: "x",
      keys: { "tracker.tasks": JSON.stringify([{ id: "new" }]) },
      blobs: { "img-1": { type: "image/png", data: "!!!not base64!!!" } },
    });
  } catch { threw = true; }
  return { threw, unchanged: before === window.TrackerStore.getText("tracker.tasks", "") };
});
ok("a backup with a damaged picture is refused", damaged.threw);
ok("a damaged picture leaves the text untouched", damaged.unchanged);

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} backup check(s) failed` : "\nPASS: backup saves and restores everything");
process.exit(failed ? 1 : 0);
