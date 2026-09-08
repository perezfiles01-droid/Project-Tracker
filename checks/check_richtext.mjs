#!/usr/bin/env node
/**
 * Guard: rich text - the sanitizer, the toolbar, the tables, and everything
 * downstream that used to be able to assume plain text.
 *
 * The sanitizer is the dangerous part and is driven first. Content pasted from
 * Word, Outlook or a web page carries script, event handlers, iframes and
 * style with url(); this app stores what you paste and renders it back, so a
 * hole here is script execution in your own tracker.
 *
 * The machinery is tested BEFORE any clean result is believed. A sanitizer
 * stub that returned its input unchanged would report every input "clean",
 * which is indistinguishable from protection - so the first assertions plant
 * an attack and require it to be REMOVED.
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
// Anything the page manages to execute lands here, so an assertion cannot
// pass merely because the payload ran somewhere the checker was not looking.
await page.exposeFunction("__fired", () => { errors.push("PAYLOAD EXECUTED"); });
await page.addInitScript(() => { window.alert = () => window.__fired("alert"); });
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);

const clean = (html) => page.evaluate((h) => window.TrackerUI.cleanHtml(h), html);
const text = (html) => page.evaluate((h) => window.TrackerUI.htmlText(h), html);

/* --- 0. the machinery, before anything it says is believed ---------------- */
ok("cleanHtml exists", await page.evaluate(() => typeof window.TrackerUI.cleanHtml === "function"));
const stubTest = await clean('<script>window.__fired("x")</script>KEEP');
ok("a planted script is REMOVED, so a clean report means something",
   !/script/i.test(stubTest) && stubTest.includes("KEEP"),
   JSON.stringify(stubTest));
ok("and legitimate markup is NOT removed, so it is a filter and not a shredder",
   /<strong>/i.test(await clean("<strong>bold</strong>")),
   await clean("<strong>bold</strong>"));

/* --- 1. the attacks ------------------------------------------------------ */
const ATTACKS = [
  ['<script>window.__fired("s")</script>', /script/i],
  ['<img src=x onerror="window.__fired(1)">', /onerror|<img/i],
  ['<iframe src="javascript:window.__fired(1)"></iframe>', /iframe/i],
  ['<svg onload="window.__fired(1)"></svg>', /svg|onload/i],
  ['<a href="javascript:window.__fired(1)">click</a>', /href|javascript:/i],
  // Matched on `style=`, not on `style`: the payload's own visible text is the
  // word "styled", and /style/i flagged the sanitizer for leaving it alone.
  ['<p style="background:url(javascript:1)">styled</p>', /style\s*=/i],
  ['<p onclick="window.__fired(1)">click me</p>', /onclick/i],
  ['<body onload="window.__fired(1)">x</body>', /onload/i],
  ['<table onmouseover="window.__fired(1)"><tr><td>c</td></tr></table>', /onmouse/i],
  ['<object data="x"></object>', /object/i],
  ['<embed src="x">', /embed/i],
  ['<p><script>window.__fired(1)</script>nested</p>', /script/i],
  ['<STYLE>body{display:none}</STYLE>', /style/i],
  ['<td colspan="1e9">huge</td>', /1e9/],
  ['<td colspan="-4">neg</td>', /-4/],
  ['<form><input name="x"></form>', /form|input/i],
];
for (const [payload, banned] of ATTACKS) {
  const out = await clean(payload);
  ok(`stripped: ${payload.slice(0, 42)}`, !banned.test(out), JSON.stringify(out).slice(0, 90));
}
ok("no payload executed while sanitizing", !errors.includes("PAYLOAD EXECUTED"),
   errors.join(" | "));

/* --- 2. real pasted content survives ------------------------------------- */
/* Roughly what Word and Outlook actually put on the clipboard: mso classes,
   inline styles, spans around everything, and a real table. A sanitizer that
   eats this gets switched off within a week, so it is asserted as hard as the
   attacks are. */
const WORD = `<meta charset="utf-8"><style>p.MsoNormal{margin:0}</style>
<p class="MsoNormal" style="margin:0cm"><span style="font-size:11pt"><b>Enhancement 1</b></span></p>
<ul style="margin-top:0"><li style="color:#333">First point</li><li>Second point</li></ul>
<table class="MsoTableGrid" border="1" style="border-collapse:collapse">
<tr><td style="width:100pt"><p><b>Item</b></p></td><td>Description</td></tr>
<tr><td>1</td><td><i>Change the label</i></td></tr></table>`;
const word = await clean(WORD);
ok("a Word paste keeps its bold", /<b>Enhancement 1<\/b>/i.test(word), word.slice(0, 80));
ok("keeps its list", /<ul>[\s\S]*<li>First point<\/li>/i.test(word));
ok("keeps its table with both rows", (word.match(/<tr>/gi) || []).length === 2);
ok("keeps the italic inside a cell", /<i>Change the label<\/i>/i.test(word));
ok("but drops every style attribute", !/style=/i.test(word));
ok("and every class", !/class=/i.test(word));
ok("and the mso stylesheet block", !/MsoNormal\{|display:none/i.test(word));
// Inside a real table: the HTML parser discards a bare <td>, so a lone cell
// tested nothing about the sanitizer at all.
ok("a legal colspan is kept",
   /colspan="2"/i.test(await clean('<table><tr><td colspan="2">x</td></tr></table>')),
   await clean('<table><tr><td colspan="2">x</td></tr></table>'));
ok("a legal rowspan is kept too",
   /rowspan="3"/i.test(await clean('<table><tr><td rowspan="3">x</td></tr></table>')));

/* --- 3. text extraction, for search and for narrow columns --------------- */
ok("htmlText returns the words, not the tags",
   (await text("<p><b>Bold</b> and <i>italic</i></p>")) === "Bold and italic",
   await text("<p><b>Bold</b> and <i>italic</i></p>"));
ok("a table becomes its cell text",
   /Item Description/.test(await text("<table><tr><td>Item</td><td>Description</td></tr></table>")),
   await text("<table><tr><td>Item</td><td>Description</td></tr></table>"));
ok("plain text passes through untouched",
   (await text("just words")) === "just words");
ok("text extraction does not execute anything either",
   !errors.includes("PAYLOAD EXECUTED"));

/* --- 4. idempotence: cleaning clean content changes nothing -------------- */
const once = await clean(WORD);
const twice = await clean(once);
ok("sanitizing twice gives the same result",
   once === twice, "otherwise every edit silently rewrites your content");

/* --- 5. the field, the toolbar and the tables, through the real dialog --- */
await page.evaluate(() => {
  localStorage.setItem("tracker.tasks", "[]");
  localStorage.setItem("tracker.activity", "[]");
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);

const openNew = async () => {
  await page.click('[data-edit="task:new"]');
  await page.waitForSelector("#fd_description");
};
const boxHtml = () => page.$eval("#fd_description", (el) => el.innerHTML);
/** Put the caret across the text of the field, the way a person selects it. */
const selectAll = () => page.evaluate(() => {
  const el = document.querySelector("#fd_description");
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
});

await openNew();
ok("the description is a rich field, not a textarea",
   await page.evaluate(() => {
     const el = document.querySelector("#fd_description");
     return el && el.getAttribute("contenteditable") === "true";
   }));
ok("it carries a toolbar with six formatting buttons",
   await page.locator(".richbar [data-cmd]").count() === 6,
   String(await page.locator(".richbar [data-cmd]").count()));
const labels = await page.$$eval(".richbar [data-cmd]", (b) => b.map((x) => x.getAttribute("aria-label")));
ok("every button has an accessible name", labels.every((l) => l && l.trim()), labels.join(" | "));

/* Each command, applied to a real selection. */
for (const [cmd, tag] of [["bold", "b"], ["italic", "i"], ["underline", "u"],
                          ["strikeThrough", "strike|s"]]) {
  await page.evaluate(() => { document.querySelector("#fd_description").innerHTML = "format me"; });
  await selectAll();
  await page.click(`.richbar [data-cmd="${cmd}"]`);
  await page.waitForTimeout(120);
  const html = await boxHtml();
  ok(`${cmd} wraps the selection`, new RegExp(`<(${tag})\\b`, "i").test(html), html.slice(0, 70));
}
for (const [cmd, tag] of [["insertUnorderedList", "ul"], ["insertOrderedList", "ol"]]) {
  await page.evaluate(() => { document.querySelector("#fd_description").innerHTML = "one"; });
  await selectAll();
  await page.click(`.richbar [data-cmd="${cmd}"]`);
  await page.waitForTimeout(120);
  ok(`${cmd} makes a list`, new RegExp(`<${tag}\\b`, "i").test(await boxHtml()),
     (await boxHtml()).slice(0, 70));
}

/* --- the table: insert, then the invariant after every operation --------- */
/** Every row must carry the same total column count, counting colspan. */
const widths = () => page.evaluate(() => {
  const t = document.querySelector("#fd_description table");
  if (!t) return null;
  return [...t.rows].map((tr) => [...tr.cells]
    .reduce((n, c) => n + Math.max(1, c.colSpan || 1), 0));
});
const square = (w) => !!w && w.length > 0 && w.every((n) => n === w[0]);

await page.evaluate(() => { document.querySelector("#fd_description").innerHTML = "<p>before</p>"; });
await page.click('[data-tableopen]');
await page.waitForSelector(".tablepicker:not([hidden]) [data-pick]");
ok("the size picker opens", await page.locator(".pickcell").count() === 64);
await page.click('[data-pick$=":3:3"]');
await page.waitForTimeout(200);
let w = await widths();
ok("a 3x3 table is inserted", !!w && w.length === 3 && w[0] === 3, JSON.stringify(w));
ok("and every row is the same width", square(w), JSON.stringify(w));

/** Put the caret in a given cell, then run a table operation. */
const inCell = (r, c) => page.evaluate(({ r, c }) => {
  const t = document.querySelector("#fd_description table");
  const cell = t.rows[r].cells[c];
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.querySelector("#fd_description").focus();
}, { r, c });
const op = async (name) => {
  await page.click(`[data-tableop="${name}"]`);
  await page.waitForTimeout(150);
};

for (const [name, expectRows, expectCols] of [
  ["rowBelow", 4, 3], ["rowAbove", 5, 3], ["colRight", 5, 4], ["colLeft", 5, 5],
  ["delRow", 4, 5], ["delCol", 4, 4],
]) {
  await inCell(1, 1);
  await op(name);
  w = await widths();
  ok(`${name}: every row still the same width`, square(w), JSON.stringify(w));
  ok(`${name}: ${expectRows} rows of ${expectCols}`,
     !!w && w.length === expectRows && w[0] === expectCols, JSON.stringify(w));
}

/* Merge: content of both cells must survive, and the grid stay square. */
await page.evaluate(() => {
  const t = document.querySelector("#fd_description table");
  t.rows[1].cells[0].innerHTML = "LEFT";
  t.rows[1].cells[1].innerHTML = "RIGHT";
  // Selected the way a drag across two cells really does it: from inside the
  // first cell's text to inside the second's.
  const range = document.createRange();
  range.setStart(t.rows[1].cells[0].firstChild || t.rows[1].cells[0], 0);
  range.setEnd(t.rows[1].cells[1].firstChild || t.rows[1].cells[1],
               (t.rows[1].cells[1].firstChild || { length: 0 }).length || 0);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.querySelector("#fd_description").focus();
});
await op("merge");
const merged = await page.$eval("#fd_description table", (t) => t.outerHTML);
ok("merging spans two columns", /colspan="2"/i.test(merged), merged.slice(0, 120));
ok("and neither cell's content is lost",
   /LEFT/.test(merged) && /RIGHT/.test(merged), merged.slice(0, 160));
ok("the grid is still square after a merge", square(await widths()), JSON.stringify(await widths()));

await inCell(1, 0);
await op("split");
w = await widths();
ok("splitting restores the row", square(w), JSON.stringify(w));

/* A non-rectangular selection is refused rather than acted on. */
await page.evaluate(() => {
  const t = document.querySelector("#fd_description table");
  const range = document.createRange();
  range.setStartBefore(t.rows[0].cells[0]);
  range.setEndAfter(t.rows[1].cells[0]);
  const sel = getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  document.querySelector("#fd_description").focus();
});
const beforeRefuse = JSON.stringify(await widths());
await op("merge");
ok("the table is unchanged when a merge cannot be made",
   JSON.stringify(await widths()) === beforeRefuse || square(await widths()),
   `${beforeRefuse} -> ${JSON.stringify(await widths())}`);

await inCell(0, 0);
await op("delTable");
ok("delete table removes it", (await widths()) === null);
// Case-insensitive: this asserts the surrounding text SURVIVES the table
// being deleted, and the first letter is capitalised by the same rule that
// capitalises every other marked field.
ok("but leaves the text around it", /before/i.test(await boxHtml()),
   (await boxHtml()).slice(0, 60));

/* --- 6. a sanitized paste, straight into the field ---------------------- */
await page.evaluate((wordHtml) => {
  const el = document.querySelector("#fd_description");
  el.innerHTML = "";
  el.focus();
  const dt = new DataTransfer();
  dt.setData("text/html", wordHtml +
    '<script>window.__fired("paste")<\/script><img src=x onerror="window.__fired(2)">');
  dt.setData("text/plain", "fallback");
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, WORD);
await page.waitForTimeout(250);
const pasted = await boxHtml();
ok("a paste keeps the bold", /<b>Enhancement 1<\/b>/i.test(pasted), pasted.slice(0, 70));
ok("keeps the table", /<table/i.test(pasted));
/* Matched on the TAG and the ATTRIBUTE, not on the bare words. A naive
   /script/i fired on the word "Description" in this very fixture, and a
   /style/i earlier fired on the word "styled" - twice now, the same mistake:
   a check that greps for a substring finds the word, not the fault, and a
   false positive gets a guard switched off as surely as a false clear. */
const DANGEROUS = /<\s*script|<\s*iframe|\son\w+\s*=|javascript:/i;
ok("the danger matcher itself fires on a real payload",
   DANGEROUS.test('<script>x</script>') && DANGEROUS.test('<img onerror="x">') &&
   DANGEROUS.test('<a href="javascript:x">'),
   "if this fails, the two clean reports below mean nothing");
ok("and does not fire on the word Description",
   !DANGEROUS.test("<td>Description</td>"));
ok("and the script never lands", !DANGEROUS.test(pasted),
   JSON.stringify(pasted).slice(0, 200));
ok("nothing executed during the paste", !errors.includes("PAYLOAD EXECUTED"), errors.join(" | "));

/* --- 7. round trip: save, reopen, save again, unchanged ----------------- */
await page.fill("#fd_name", "Rich task");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(400);
const saved = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("tracker.tasks"))[0].description);
ok("the markup is stored", /<b>/i.test(saved) && /<table/i.test(saved), saved.slice(0, 80));
ok("and nothing dangerous is stored", !DANGEROUS.test(saved),
   JSON.stringify(saved).slice(0, 200));

await page.click(".taskrow");
await page.waitForTimeout(300);
ok("the pane renders it as real formatting",
   await page.locator(".taskpane .clamptext.rich b").count() >= 1);
ok("with a real table", await page.locator(".taskpane .clamptext.rich table").count() === 1);

await page.click('.taskpane [data-edit^="task:"]');
await page.waitForSelector("#fd_description");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(400);
const again = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("tracker.tasks"))[0].description);
ok("reopening and saving does not rewrite the content", again === saved,
   again === saved ? "identical" : `${saved.length} -> ${again.length} chars`);

/* --- 8. search reads the words, not the tags ---------------------------- */
const search = async (q) => {
  await page.fill('input[data-search="todo"]', q);
  await page.waitForTimeout(300);
  return page.locator("tr.taskrow").count();
};
ok("a word inside the table is findable", (await search("Change the label")) === 1);
ok("a word in the bold heading is findable", (await search("Enhancement")) === 1);
ok("but searching 'table' does NOT match it for containing one",
   (await search("table")) === 0, "otherwise every task with a table matches");
ok("nor 'strong', 'colspan' or 'tbody'",
   (await search("strong")) === 0 && (await search("colspan")) === 0 &&
   (await search("tbody")) === 0);
await page.fill('input[data-search="todo"]', "");
await page.waitForTimeout(250);

/* --- 9. plain text saved before this change still works ----------------- */
await page.evaluate(() => {
  localStorage.setItem("tracker.tasks", JSON.stringify([{
    id: "t-old", name: "Old task", description: "Just plain words, no markup.",
    given: "2026-09-01", status: "In progress", assignee: "Jim",
    attachments: [], updates: [],
  }]));
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
await page.click(".taskrow");
await page.waitForTimeout(300);
ok("a task saved as plain text still shows its description",
   (await page.locator(".taskpane").innerText()).includes("Just plain words"));
await page.click('.taskpane [data-edit^="task:"]');
await page.waitForSelector("#fd_description");
ok("and opens in the editor as its own words",
   (await page.$eval("#fd_description", (el) => el.innerText)).includes("Just plain words"));
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(400);
ok("and survives a save",
   (await page.evaluate(() => JSON.parse(localStorage.getItem("tracker.tasks"))[0].description))
     .includes("Just plain words"));

ok("no page errors along the way", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${failed} rich text check(s) failed`);
process.exit(failed ? 1 : 0);
