#!/usr/bin/env node
/**
 * Guard for the rich text field: what it keeps, and stepping back through it.
 *
 * Two faults, both of which reached a user.
 *
 * THE TEXT WAS BEING MANGLED. A contenteditable writes <div> when you press
 * Enter, DIV was not in cleanHtml's ALLOWED set, and the unwrap spliced the
 * children in and deleted the tag WITH NOTHING IN ITS PLACE. So
 *     Monday⏎Ada to check the record
 * saved as "MondayAda to check the record" - the break deleted, the words
 * welded. A blank line, <div><br></div>, collapsed the same way, which is why
 * paragraph spacing "did not save". And once the last tag was gone the value
 * no longer looked like HTML to isHtml, so it took the plain-text branch on
 * the way back into the field, esc() escaped the ampersand of the &nbsp; that
 * Chromium uses to hold a trailing space, and the literal characters
 * "&nbsp;" appeared in the update. Once per save, compounding, which is
 * exactly how it was reported.
 *
 * UNDO HAD NOWHERE TO LIVE. The sidebar's undo/redo are behind the dialog
 * (.modal is position:fixed inset:0 z-index:50) and could not be clicked
 * while editing, and they could not have helped anyway: record() gates on
 * KEYS.data, so nothing typed in an open dialog is in that history at all.
 * The field keeps its own snapshots instead. Not the browser's undo, which
 * was measured clearing the WHOLE field in one click because typing
 * coalesces into a single transaction.
 *
 * Fields are enumerated at RUNTIME from the rendered dialog, so a rich field
 * added later is covered without this file being edited.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { executableCode as code } from "./lib/code.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

/* ============ 1. every rich field is served by the ONE shared toolbar ====
   The source half of the family sweep: the buttons reach all seven rich
   fields precisely because there is one renderer. A module that hand-rolled
   its own toolbar would silently miss them. */
const assets = join(root, "assets");
let richDecls = 0, ownBars = [];
for (const f of readdirSync(assets).filter((n) => n.endsWith(".js"))) {
  const exec = code(join(assets, f) && readFileSync(join(assets, f), "utf8"), true);
  richDecls += (exec.match(/type:\s*["']rich["']/g) || []).length;
  // Only ui.js may produce a rich toolbar.
  if (f !== "ui.js" && /data-richbar\s*=/.test(exec)) ownBars.push(f);
}
ok(`every rich field in the app is declared, and there are several (${richDecls})`,
   richDecls >= 5, `${richDecls} declarations`);
ok("no module builds its own rich toolbar", ownBars.length === 0, ownBars.join(", "));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const url = "file://" + (process.env.TRACKER_HTML || join(root, "Tracker-standalone.html"));
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(300);

/* ---------- helpers ---------- */
const openDialog = async (fields) => {
  await page.evaluate((fs) => {
    window.__d = window.TrackerUI.formDialog({ title: "guard", fields: fs });
  }, fields);
  await page.waitForSelector("#formDialog:not([hidden])");
  await page.waitForTimeout(120);
};
const close = async (save) => {
  await page.click(save ? '[data-fd="save"]' : '[data-fd="cancel"]');
  return page.evaluate(() => window.__d);
};
const sel = (id) => `#${id}`;
const seen = (id) => page.$eval(sel(id), (e) => e.innerText.replace(/\s+$/, ""));

/* ==================== 2. a line break survives being saved ============== */
await openDialog([{ name: "text", label: "Update", type: "rich", rows: 4 }]);
await page.click("[data-rich]");
await page.type("[data-rich]", "Monday ", { delay: 5 });
await page.keyboard.press("Enter");
await page.type("[data-rich]", "Ada to check on the record.", { delay: 5 });
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.type("[data-rich]", "Second paragraph.", { delay: 5 });
const v1 = (await close(true)).text;

ok("the words either side of a line break are NOT welded together",
   !/MondayAda/.test(v1), v1.slice(0, 60));
ok("the line break is saved as markup that carries it",
   /Monday(&nbsp;|\s)*<br>/i.test(v1), v1.slice(0, 60));
ok("a blank line between paragraphs survives as a double break",
   /<br>\s*<br>/i.test(v1), v1);

// What it looks like coming BACK into the field is the thing people see.
await openDialog([{ name: "text", label: "Update", type: "rich", rows: 4, value: v1 }]);
const back1 = await seen("fd_text");
ok("no literal entity is displayed as text",
   !/&nbsp;|&amp;/i.test(back1), JSON.stringify(back1.slice(0, 70)));
ok("the lines come back on separate lines",
   /Monday\s*\n\s*Ada to check/.test(back1), JSON.stringify(back1.slice(0, 70)));
ok("and the blank line is still there",
   /record\.\n\s*\nSecond paragraph\./.test(back1), JSON.stringify(back1));

/* ============ 3. saving repeatedly does not accumulate anything ========= */
// The reported symptom was "additional text every time I save", so the round
// trip has to be idempotent, not merely correct once.
let v = (await close(true)).text;
const trips = [v];
for (let i = 0; i < 3; i++) {
  await openDialog([{ name: "text", label: "Update", type: "rich", rows: 4, value: v }]);
  v = (await close(true)).text;
  trips.push(v);
}
ok("three more saves change nothing at all", trips.every((t) => t === trips[0]),
   trips.map((t) => t.length).join(" -> "));

/* ================= 4. isHtml does not mistake markup for plain text ===== */
const ih = await page.evaluate(() => {
  const f = window.TrackerUI.isHtml;
  return {
    entityOnly: f("Monday&nbsp;Ada"),        // the value that produced the bug
    ampOnly: f("Tom &amp; Jerry"),
    tag: f("a<br>b"),
    plain: f("just plain words"),
    mathNotTag: f("if a < b and c > d"),     // must NOT be treated as markup
  };
});
ok("a value whose only markup is an entity counts as HTML", ih.entityOnly);
ok("an escaped ampersand counts as HTML", ih.ampOnly);
ok("a tag still counts as HTML", ih.tag);
ok("genuinely plain text does not", ih.plain === false);
ok("a less-than used as arithmetic is not mistaken for a tag", ih.mathNotTag === false);

/* ============= 5. the buttons: one pair per field, at runtime =========== */
await openDialog([
  { name: "a", label: "First", type: "rich", rows: 3 },
  { name: "b", label: "Second", type: "rich", rows: 3 },
]);
const bars = await page.$$eval("[data-richbar]", (bs) => bs.map((b) => b.dataset.richbar));
ok(`every rich field renders its own toolbar (${bars.length} found)`, bars.length === 2, bars.join(", "));
for (const id of bars) {
  const pair = await page.evaluate((barId) => {
    const bar = document.querySelector(`[data-richbar="${barId}"]`);
    const u = bar.querySelector("[data-richundo]"), r = bar.querySelector("[data-richredo]");
    return { u: !!u, r: !!r, uDis: u && u.disabled, rDis: r && r.disabled,
             uFor: u && u.dataset.for, uLabel: u && u.getAttribute("aria-label") };
  }, id);
  ok(`${id}: has its own undo and redo button`, pair.u && pair.r);
  ok(`${id}: both start disabled, with nothing to undo`, pair.uDis && pair.rDis);
  ok(`${id}: the buttons point at their own field`, pair.uFor === id);
  ok(`${id}: says so in words, like the sidebar pair`, /Nothing to undo/i.test(pair.uLabel || ""),
     pair.uLabel);
}

/* ====== 6. undo steps back ONE edit, and never clears the whole field === */
const A = bars[0];
await page.click(sel(A));
for (const s of ["Asked him on Teams. ", "Waiting on the DBA. ", "Will chase tomorrow."]) {
  await page.type(sel(A), s, { delay: 5 });
  await page.waitForTimeout(620);
}
const full = await seen(A);
ok("three bursts of typing are in the field", /Will chase tomorrow/.test(full));
// The depth in the label must be the store's, so the two histories cannot
// drift apart. (This assertion was itself wrong first time round: it built a
// regex with ${...} inside a REGEX literal, where nothing interpolates.)
const depth = await page.evaluate(() => window.TrackerStore.DEPTH);
const undoLabel = await page.$eval(`[data-richbar="${A}"] [data-richundo]`,
  (e) => e.getAttribute("aria-label"));
ok("the label carries the depth, read from the store rather than declared twice",
   undoLabel === `Undo (3 of ${depth})`, `${undoLabel} (store depth ${depth})`);

const clickUndo = async () => {
  await page.click(`[data-richbar="${A}"] [data-richundo]`);
  await page.waitForTimeout(110);
  return seen(A);
};
const u1 = await clickUndo();
ok("one undo does NOT clear the field", u1.length > 0, JSON.stringify(u1));
ok("one undo steps back exactly one burst",
   u1 === "Asked him on Teams. Waiting on the DBA." , JSON.stringify(u1));
const u2 = await clickUndo();
ok("a second undo steps back another", u2 === "Asked him on Teams.", JSON.stringify(u2));
await page.click(`[data-richbar="${A}"] [data-richredo]`);
await page.waitForTimeout(110);
ok("redo returns the step", (await seen(A)) === "Asked him on Teams. Waiting on the DBA.",
   JSON.stringify(await seen(A)));

/* ================== 7. the keyboard drives the SAME history ============= */
await page.click(sel(A));
await page.keyboard.press("Control+z");
await page.waitForTimeout(110);
ok("Ctrl+Z does what the undo button does", (await seen(A)) === "Asked him on Teams.",
   JSON.stringify(await seen(A)));
await page.keyboard.press("Control+Shift+z");
await page.waitForTimeout(110);
ok("Ctrl+Shift+Z does what the redo button does",
   (await seen(A)) === "Asked him on Teams. Waiting on the DBA.", JSON.stringify(await seen(A)));

/* ============ 8. each field's history is its own, not a shared one ====== */
const B = bars[1];
await page.click(sel(B));
await page.type(sel(B), "a different field", { delay: 5 });
await page.waitForTimeout(620);
const aBefore = await seen(A);
await page.click(`[data-richbar="${B}"] [data-richundo]`);
await page.waitForTimeout(110);
ok("undoing in one field leaves the other alone", (await seen(A)) === aBefore,
   `${JSON.stringify(aBefore)} -> ${JSON.stringify(await seen(A))}`);

/* ================= 9. a toolbar command is its own step ================= */
// Driven with the bulleted-list button rather than bold, deliberately: bold
// needs a SELECTION, and pressing a toolbar button moves focus around, so the
// selection this test set up was gone by the time execCommand ran and the
// assertion failed for a reason that was about the test. A list applies to the
// block the caret is in, which survives the click.
await page.click(sel(B));
await page.keyboard.press("End");
await page.type(sel(B), " plain", { delay: 5 });
await page.waitForTimeout(620);
const beforeList = await page.$eval(sel(B), (e) => e.innerHTML);
await page.click(`[data-richbar="${B}"] [data-cmd="insertUnorderedList"]`);
await page.waitForTimeout(300);
const listed = await page.$eval(sel(B), (e) => e.innerHTML);
ok("a toolbar command actually applied", /<ul\b/i.test(listed), listed.slice(0, 70));
await page.click(`[data-richbar="${B}"] [data-richundo]`);
await page.waitForTimeout(300);
const afterUndoList = await page.$eval(sel(B), (e) => e.innerHTML);
ok("undo steps over exactly that command, keeping the text",
   afterUndoList === beforeList, `${afterUndoList.slice(0, 50)} | wanted ${beforeList.slice(0, 50)}`);

/* ===== 10. a dialog's listeners do not survive it and pile up ========== */
// The fault this catches was PRE-EXISTING and silent: wireRich added its
// listeners to the singleton dialog host and never removed them, so they
// accumulated one set per dialog opened. Measured on the unmodified build at
// five dialogs: ONE click on a toolbar button ran execCommand five times, so
// a toggle like bold applied an odd or even number of times depending on how
// many dialogs you had opened. Bold appearing to do nothing is what that
// looks like from a chair.
await close(false);
const accumulation = await page.evaluate(async () => {
  const open = async () => {
    const d = window.TrackerUI.formDialog({ title: "acc",
      fields: [{ name: "t", label: "T", type: "rich", rows: 3 }] });
    await new Promise((r) => setTimeout(r, 90));
    return d;
  };
  for (let i = 0; i < 5; i++) {
    const d = open();
    await new Promise((r) => setTimeout(r, 90));
    document.querySelector('[data-fd="cancel"]').click();
    await d;
  }
  const d = open();
  await new Promise((r) => setTimeout(r, 120));
  const el = document.querySelector("#fd_t");
  el.focus();
  el.textContent = "hello";
  let n = 0;
  const orig = document.execCommand.bind(document);
  document.execCommand = (...a) => { n++; return orig(...a); };
  document.querySelector('[data-richbar="fd_t"] [data-cmd="insertUnorderedList"]').click();
  document.execCommand = orig;
  document.querySelector('[data-fd="cancel"]').click();
  await d;
  return n;
});
ok("one toolbar click runs its command exactly once, after six dialogs",
   accumulation === 1, `${accumulation} execCommand calls`);

/* ====== 11. a standardize is one step, and both paths agree on it ======= */
// The fault: standardize assigns innerHTML, and a programmatic assignment
// fires no `input` event, so the snapshot listening for it never ran. Measured
// before the fix: the undo count did not move across a standardize, the
// standardized text was never a state you could reach or redo back to, and the
// history's account of the past was false - it claimed the field held your
// original just before your next keystroke when it actually held the
// standardized text.
const ORIGINAL = "Need to review the failed record that was forwarded by Willie via email yesterday.";
const STD = "Review the failed record forwarded by Willie";

const freshStd = async () => {
  await page.evaluate((std) => {
    // Stubbed, so this tests the WIRING and runs with no key and no network.
    window.TrackerAI.standardize = async () => std;
  }, STD);
  await openDialog([{ name: "text", label: "Update", type: "rich", rows: 4, standardize: true }]);
  await page.click("[data-rich]");
  await page.type("[data-rich]", ORIGINAL, { delay: 3 });
  await page.waitForTimeout(620);
  const before = await page.$eval("[data-richundo]", (e) => e.getAttribute("aria-label"));
  await page.click("[data-standardize]");
  await page.waitForTimeout(420);
  const after = await page.$eval("[data-richundo]", (e) => e.getAttribute("aria-label"));
  return { before, after };
};
const richText = () => page.$eval("[data-rich]", (e) => e.innerText.trim());

const counts = await freshStd();
ok("standardizing replaces the text", (await richText()) === STD, await richText());
ok("and records a step of its own in the history",
   counts.before !== counts.after, `${counts.before} -> ${counts.after}`);
await page.click("[data-richundo]");
await page.waitForTimeout(200);
ok("undo gives your own words back", (await richText()) === ORIGINAL, await richText());
await page.click("[data-richredo]");
await page.waitForTimeout(200);
ok("redo returns the standardized version", (await richText()) === STD, await richText());

// The one the request was actually about: going back LATER, after working on.
await page.click("[data-rich]");
await page.keyboard.press("End");
await page.type("[data-rich]", " Also chase Ada.", { delay: 3 });
await page.waitForTimeout(620);
await page.click("[data-richundo]");
await page.waitForTimeout(180);
ok("after typing on, one undo reaches the standardized text",
   (await richText()) === STD, await richText());
await page.click("[data-richundo]");
await page.waitForTimeout(180);
ok("and a second undo still reaches the original, at any time",
   (await richText()) === ORIGINAL, await richText());

// The inline offer must mean what it says, and agree with the toolbar.
await close(false);
const viaLink = await (async () => {
  await freshStd();
  ok("the inline Standardized/Undo offer is shown",
     (await page.locator("[data-undo]").count()) === 1);
  await page.click("[data-undo]");
  await page.waitForTimeout(200);
  const t = await richText();
  await close(false);
  return t;
})();
const viaButton = await (async () => {
  await freshStd();
  await page.click("[data-richundo]");
  await page.waitForTimeout(200);
  const t = await richText();
  await close(false);
  return t;
})();
ok("the inline link and the toolbar button leave the field identical",
   viaLink === viaButton, `link ${JSON.stringify(viaLink)} vs button ${JSON.stringify(viaButton)}`);
ok("and both of them give back the original", viaLink === ORIGINAL, viaLink);

// Once you edit again, one step back is no longer the standardize, so the
// offer must not still be claiming it is.
await freshStd();
await page.click("[data-rich]");
await page.keyboard.press("End");
await page.type("[data-rich]", " Also chase Ada.", { delay: 3 });
await page.waitForTimeout(300);
ok("the offer expires once you edit again, rather than lying about what it does",
   (await page.locator("[data-undo]").count()) === 0);
await close(false);

ok("nothing threw while doing all that", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\nFAIL: ${failed} check(s)` : "\nPASS: the field keeps what you typed, and steps back one edit at a time");
process.exit(failed ? 1 : 0);
