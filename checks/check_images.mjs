#!/usr/bin/env node
/**
 * Guard: pictures in a rich field, stored by reference.
 *
 * The failure this exists to prevent is not a missing image. It is losing the
 * task list. A description lives in localStorage, which holds about 5 MB for
 * the whole origin; this app's own header says two screenshots would exhaust
 * it "taking the pinned links and the task list down with them", and a failed
 * write returns false rather than throwing. So an image embedded as a data:
 * URI would destroy data silently, and the central assertion here is that no
 * data: URI ever reaches storage.
 *
 * Six things fail quietly:
 *   1. Bytes in localStorage instead of IndexedDB.
 *   2. src accepted from content - a javascript: URL, a remote tracking pixel,
 *      an <img onerror>. src is never stored and never read from content; the
 *      only thing that sets it is the app resolving an id it wrote itself.
 *   3. The image landing outside the cell the caret was in, which is the whole
 *      request.
 *   4. The blob store move orphaning attachments saved by the old version.
 *   5. A picture edited out of a description being unrecoverable by undo.
 *   6. A picture edited out never being deleted at all - a leak wearing a
 *      feature.
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
await page.exposeFunction("__fired", () => { errors.push("PAYLOAD EXECUTED"); });
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const clean = (h) => page.evaluate((x) => window.TrackerUI.cleanHtml(x), h);
const blobKeys = () => page.evaluate(() => window.TrackerBlobs.list());

/* --- 4. the shared store reads what the old private one wrote ------------ */
ok("the blob store is shared, not private to one module",
   await page.evaluate(() => typeof window.TrackerBlobs.put === "function" &&
     typeof window.TrackerBlobs.get === "function"));
await page.evaluate(async (b64) => {
  // Written straight to the same database and object store the previous
  // version used, so this stands in for an attachment saved before the move.
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await new Promise((resolve, reject) => {
    const r = indexedDB.open("tracker-files", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("blobs");
    r.onsuccess = () => {
      const tx = r.result.transaction("blobs", "readwrite");
      tx.objectStore("blobs").put(new Blob([bytes], { type: "image/png" }), "legacy-att");
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  });
}, PNG);
ok("an attachment written the old way is readable through the shared store",
   await page.evaluate(async () => !!(await window.TrackerBlobs.get("legacy-att"))),
   "the move must not orphan bytes already saved");

/* --- 2. src is never accepted from content ------------------------------ */
for (const [payload, why] of [
  ['<img src="javascript:window.__fired(1)">', "a javascript: url"],
  ['<img src="https://evil.example/pixel.png">', "a remote url"],
  ['<img src="x" onerror="window.__fired(1)">', "an onerror handler"],
  ['<img src="data:image/png;base64,AAAA">', "a data: uri with no adoption"],
]) {
  const out = await clean(payload);
  ok(`stripped: ${why}`, !/src\s*=/i.test(out) && !/on\w+\s*=/i.test(out),
     JSON.stringify(out));
}
ok("an image with no bytes behind it is dropped entirely",
   (await clean('<img alt="nothing">')) === "", JSON.stringify(await clean('<img alt="nothing">')));
ok("but a reference survives, with no src",
   /data-blob="img-1"/.test(await clean('<img data-blob="img-1" alt="a">')) &&
   !/src/i.test(await clean('<img data-blob="img-1" alt="a">')),
   await clean('<img data-blob="img-1" alt="a">'));
ok("a malformed reference is refused",
   (await clean('<img data-blob="../../etc/passwd">')) === "");
ok("nothing executed while sanitizing", !errors.includes("PAYLOAD EXECUTED"));

/* --- the editor: insert into a cell ------------------------------------- */
await page.evaluate(() => {
  localStorage.setItem("tracker.tasks", "[]");
  localStorage.setItem("tracker.activity", "[]");
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
await page.click('[data-edit="task:new"]');
await page.waitForSelector("#fd_description");

ok("the toolbar carries an image button",
   await page.locator("[data-imgpick]").count() === 1);
ok("and it is named", !!(await page.getAttribute("[data-imgpick]", "aria-label")),
   await page.getAttribute("[data-imgpick]", "aria-label"));

// A 2x2 table, caret in the second cell of the second row.
await page.click("[data-tableopen]");
await page.waitForSelector(".tablepicker:not([hidden]) [data-pick]");
await page.click('[data-pick$=":2:2"]');
await page.waitForTimeout(200);
await page.evaluate(() => {
  const t = document.querySelector("#fd_description table");
  const cell = t.rows[1].cells[1];
  cell.innerHTML = "HERE";
  const r = document.createRange();
  r.selectNodeContents(cell);
  r.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges(); sel.addRange(r);
  document.querySelector("#fd_description").focus();
});

/* --- 3. the picture lands in THAT cell ---------------------------------- */
await page.setInputFiles("[data-imginput]",
  { name: "shot.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
await page.waitForTimeout(700);
const where = await page.evaluate(() => {
  const t = document.querySelector("#fd_description table");
  const img = document.querySelector("#fd_description img[data-blob]");
  if (!img) return { found: false };
  const cell = img.closest("td,th");
  return {
    found: true,
    inCell: !!cell,
    row: cell ? [...t.rows].indexOf(cell.parentNode) : -1,
    col: cell ? [...cell.parentNode.cells].indexOf(cell) : -1,
    hasSrc: img.hasAttribute("src"),
    blob: img.getAttribute("data-blob"),
  };
});
ok("the image is inserted", where.found);
ok("INSIDE a table cell", where.inCell, JSON.stringify(where));
ok("in the cell the caret was in", where.row === 1 && where.col === 1,
   `row ${where.row}, col ${where.col}`);
ok("its src is resolved for display", where.hasSrc);
ok("and its bytes are in IndexedDB", (await blobKeys()).includes(where.blob),
   where.blob);

const widths = () => page.evaluate(() => {
  const t = document.querySelector("#fd_description table");
  return [...t.rows].map((tr) => [...tr.cells]
    .reduce((n, c) => n + Math.max(1, c.colSpan || 1), 0));
});
const w = await widths();
ok("the table is still square", w.every((n) => n === w[0]), JSON.stringify(w));

/* --- 1. the central assertion: no bytes in localStorage ----------------- */
await page.fill("#fd_name", "Task with a picture");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(600);
const stored = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("tracker.tasks"))[0].description);
ok("the description refers to the picture", /data-blob=/.test(stored), stored.slice(0, 90));
ok("NO data: uri reaches localStorage", !/data:/i.test(stored),
   "this is what would silently destroy the task list");
ok("and no src is stored either", !/\bsrc\s*=/i.test(stored), stored.slice(0, 120));
const wholeStore = await page.evaluate(() =>
  Object.keys(localStorage).map((k) => localStorage.getItem(k)).join(""));
ok("nothing anywhere in localStorage holds image bytes",
   !/data:image\//i.test(wholeStore),
   `${Math.round(wholeStore.length / 1024)} KB stored in total`);

/* --- it renders in the pane -------------------------------------------- */
await page.click(".taskrow");
await page.waitForTimeout(600);
ok("the pane shows the picture inside the table",
   await page.locator(".taskpane .clamptext.rich td img").count() === 1);
ok("with a real src resolved from IndexedDB",
   await page.evaluate(() => {
     const img = document.querySelector(".taskpane .clamptext.rich img");
     return !!img && /^blob:/.test(img.src);
   }));

/* --- 5 & 6. the lifecycle ---------------------------------------------- */
const theBlob = where.blob;
await page.click('.taskpane [data-edit^="task:"]');
await page.waitForSelector("#fd_description");
await page.evaluate(() => {
  document.querySelector("#fd_description").innerHTML = "<p>Picture removed</p>";
});
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(600);
ok("the description no longer refers to it",
   !/data-blob=/.test(await page.evaluate(() =>
     JSON.parse(localStorage.getItem("tracker.tasks"))[0].description)));
ok("but its bytes are HELD, so the edit can be undone",
   (await blobKeys()).includes(theBlob), (await blobKeys()).join(", "));

await page.click("#doUndo");
await page.waitForTimeout(600);
ok("undo brings the picture back",
   /data-blob=/.test(await page.evaluate(() =>
     JSON.parse(localStorage.getItem("tracker.tasks"))[0].description)));
ok("and its bytes are still readable",
   await page.evaluate(async (id) => !!(await window.TrackerBlobs.get(id)), theBlob));

// Remove it again, then push the step out of the seven-deep history.
await page.click("#doRedo");
await page.waitForTimeout(500);
ok("redo removes the picture again",
   !/data-blob=/.test(await page.evaluate(() =>
     JSON.parse(localStorage.getItem("tracker.tasks"))[0].description)),
   await page.evaluate(() => ({ d: window.TrackerStore.undoDepth(),
                                r: window.TrackerStore.redoDepth() })).then(JSON.stringify));
for (let i = 1; i <= 8; i++) {
  await page.click('[data-edit="task:new"]');
  await page.waitForSelector("#fd_name");
  await page.fill("#fd_name", "Filler " + i);
  await page.click('#formDialog [data-fd="save"]');
  await page.waitForTimeout(250);
}
await page.waitForTimeout(600);
ok("once the edit falls out of the history, the bytes are really gone",
   !(await blobKeys()).includes(theBlob),
   "otherwise every edited-out picture leaks for ever");

ok("no page errors along the way", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${failed} image check(s) failed`);
process.exit(failed ? 1 : 0);
