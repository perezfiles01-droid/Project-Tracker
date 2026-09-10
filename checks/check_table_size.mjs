#!/usr/bin/env node
/**
 * Guard: a table column can be widened, a table can be zoomed, and text can
 * be coloured — and none of it opens the sanitizer.
 *
 * Three parts, because three different things can silently stop working:
 *
 *   1. The sanitizer. A width and a colour now survive cleanHtml, which is the
 *      one place in this app where a mistake is a security bug rather than a
 *      cosmetic one. Both are carried as values this file can enumerate — an
 *      integer in a fixed range, and a name from a fixed list — and `style`
 *      stays banned outright. This part plants the shapes that must NOT get
 *      through, so a passing run means something.
 *   2. Behaviour, in the file that actually ships: drag a column edge, save,
 *      reopen, and the width is still there; zoom moves the rendered size and
 *      reset returns it; a coloured word keeps its colour into the read-only
 *      view.
 *   3. The family, enumerated at runtime: every field declaring type "rich"
 *      must be built by the shared field builder, so a rich field added later
 *      cannot quietly miss these controls.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import { executableCode as code } from "./lib/code.mjs";

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
const url = "file://" + join(root, "Tracker-standalone.html");
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(400);

/* ---------- 1. the sanitizer ---------- */
const clean = (html) => page.evaluate((h) => window.TrackerUI.cleanHtml(h), html);

/* Kept: exactly the two carriers, in their exact shapes. */
ok("a column width survives",
   (await clean('<table><tr><td data-w="120">a</td></tr></table>')).includes('data-w="120"'));
ok("a palette colour survives",
   (await clean('<p><span data-colour="amber">a</span></p>')).includes('data-colour="amber"'));

/* Stripped: everything else. Each of these is a way the sanitizer could be
   widened by accident, and each would be invisible until it was exploited. */
for (const [why, html, banned] of [
  ["a style attribute is still refused", '<td style="width:120px">a</td>', "style"],
  ["a style on a coloured span is refused", '<span data-colour="red" style="color:red">a</span>', "style"],
  ["an event handler is refused", '<td data-w="120" onmouseover="alert(1)">a</td>', "onmouseover"],
  ["a width out of range is refused", '<td data-w="99999">a</td>', "data-w"],
  ["a width below the floor is refused", '<td data-w="10">a</td>', "data-w"],
  ["a non-numeric width is refused", '<td data-w="120px">a</td>', "data-w"],
  ["a width on a non-cell is refused", '<p data-w="120">a</p>', "data-w"],
  ["an unknown colour name is refused", '<span data-colour="chartreuse">a</span>', "data-colour"],
  ["a colour carrying CSS is refused", '<span data-colour="red;background:url(x)">a</span>', "data-colour"],
  ["a colour carrying an expression is refused", '<span data-colour="expression(alert(1))">a</span>', "data-colour"],
  ["a colour on a cell is refused", '<td data-colour="red">a</td>', "data-colour"],
]) {
  ok(why, !(await clean(html)).includes(banned), await clean(html));
}
/* And a span that lost its colour must not survive as an empty wrapper. */
ok("a stripped colour span is unwrapped, not left behind",
   !(await clean('<p><span data-colour="nope">kept text</span></p>')).includes("<span"),
   await clean('<p><span data-colour="nope">kept text</span></p>'));
ok("...and its text is kept",
   (await clean('<p><span data-colour="nope">kept text</span></p>')).includes("kept text"));

/* ---------- 2. behaviour, in the shipped file ---------- */
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(300);
await page.click('[data-edit="task:new"]');
await page.waitForTimeout(300);
ok("the task dialog opened", await page.locator("#formDialog").isVisible());

/** Put a known table in the rich field, the way the toolbar would. */
async function seedTable() {
  await page.evaluate(() => {
    const box = document.querySelector("#fd_description") ||
                document.querySelector(".richbox");
    box.innerHTML = "<table><thead><tr><th>One</th><th>Two</th></tr></thead>" +
                    "<tbody><tr><td>a</td><td>b</td></tr></tbody></table><p><br></p>";
    if (window.TrackerUI.paintTables) window.TrackerUI.paintTables(box);
  });
  await page.waitForTimeout(150);
}
await seedTable();
const firstCell = ".richbox table th";
const widthOf = async () => (await page.locator(firstCell).first().boundingBox()).width;
const before = await widthOf();

/* --- the drag --- */
const box0 = await page.locator(firstCell).first().boundingBox();
await page.mouse.move(box0.x + box0.width - 2, box0.y + box0.height / 2);
await page.mouse.down();
await page.mouse.move(box0.x + box0.width + 120, box0.y + box0.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const after = await widthOf();
ok("dragging the column edge widens the column", after > before + 60, `${before} → ${after}`);
ok("the width is recorded as a plain integer",
   /^\d+$/.test(await page.locator(firstCell).first().getAttribute("data-w") || ""),
   String(await page.locator(firstCell).first().getAttribute("data-w")));

/* --- it survives the round trip through storage --- */
await page.fill("#fd_name", "Table sizing");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(400);
await page.click('table.tasktable tbody tr');
await page.waitForTimeout(300);
const readOnly = await page.locator(".clamptext.rich table th").first();
ok("the width is applied in the read-only view",
   (await readOnly.count()) > 0 && (await readOnly.boundingBox()).width > before + 40,
   (await readOnly.count()) ? String((await readOnly.boundingBox()).width) : "no table rendered");

/* --- zoom --- */
const zoomIn = '[data-zoom="in"]';
const zoomOut = '[data-zoom="out"]';
const zoomReset = '[data-zoom="reset"]';
ok("the reading view offers zoom", (await page.locator(zoomIn).count()) > 0);
// A cell, not the table: the read-only table is display:block/max-width:100%,
// so its outer box is bound by the container and would report the same number
// at every zoom level — a measurement that cannot move is not a check.
const cellW = async () => (await page.locator(".clamptext.rich table th").first().boundingBox()).width;
const base = await cellW();
await page.click(zoomIn); await page.waitForTimeout(200);
const bigger = await cellW();
ok("zoom in makes the table bigger", bigger > base + 5, `${base} → ${bigger}`);
await page.click(zoomOut); await page.click(zoomOut); await page.waitForTimeout(200);
const smaller = await cellW();
ok("zoom out makes it smaller", smaller < base - 1, `${base} → ${smaller}`);
await page.click(zoomReset); await page.waitForTimeout(200);
const reset = await cellW();
ok("reset returns to the base size", Math.abs(reset - base) < 2, `${base} → ${reset}`);

/* --- the zoom level is a per-viewer preference, not part of the update --- */
await page.click(zoomIn); await page.waitForTimeout(200);
const held = await cellW();
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(500);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(300);
await page.click('table.tasktable tbody tr');
await page.waitForTimeout(300);
const afterReload = await cellW();
ok("the zoom level is remembered across a reload",
   Math.abs(afterReload - held) < 3, `${held} → ${afterReload}`);
const stored = await page.evaluate(() =>
  JSON.stringify(window.TrackerStore.get("tracker.tasks", [])));
ok("no zoom value is written into the saved update",
   !/zoom/i.test(stored), "saved text mentions zoom");

/* ---------- text colour, end to end ---------- */
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(300);
await page.click('[data-edit="task:new"]');
await page.waitForTimeout(300);
await page.evaluate(() => {
  const box = document.querySelector("#fd_description");
  box.innerHTML = "<p>colour me</p>";
  const r = document.createRange();
  r.selectNodeContents(box.querySelector("p"));
  const sel = document.getSelection();
  sel.removeAllRanges(); sel.addRange(r);
});
await page.click('[data-colouropen="fd_description"]');
await page.waitForTimeout(150);
ok("the palette opens", await page.locator('[data-colours="fd_description"]').isVisible());
const swatches = await page.locator('[data-colours="fd_description"] .swatch').count();
ok("the palette offers the fixed set plus a clear", swatches === 9, `${swatches} swatches`);
await page.click('[data-colour-set="blue"][data-for="fd_description"]');
await page.waitForTimeout(200);
const coloured = await page.locator('#fd_description span[data-colour="blue"]').count();
ok("the selection is wrapped in a palette colour", coloured === 1);
ok("the colour is actually painted",
   (await page.locator('#fd_description span[data-colour="blue"]').first()
      .evaluate((e) => getComputedStyle(e).color)) !== "rgb(0, 0, 0)");
await page.fill("#fd_name", "Coloured text");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(400);
const savedColour = await page.evaluate(() =>
  JSON.stringify(window.TrackerStore.get("tracker.tasks", [])));
ok("the colour is stored as a name, not a CSS value",
   savedColour.includes('data-colour=\\"blue\\"') || savedColour.includes('data-colour="blue"'),
   "not found in saved text");
ok("no CSS value reached storage", !/style=|#[0-9a-f]{6}/i.test(savedColour));

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();

/* ---------- 3. the family, enumerated at runtime ---------- */
const files = readdirSync(join(root, "assets")).filter((f) => f.endsWith(".js"));
let richFields = 0;
for (const f of files) {
  const src = code(readFileSync(join(root, "assets", f), "utf8"), true);
  richFields += (src.match(/type:\s*["']rich["']/g) || []).length;
  // Nobody hand-rolls a rich box: the class is emitted in exactly one place,
  // the shared builder in ui.js. A module that wrote its own would get neither
  // the resize handles nor the zoom.
  if (f !== "ui.js") {
    ok(`${f} does not build its own rich box`, !/class=["'][^"']*\brichbox\b/.test(src));
    ok(`${f} does not build its own rich toolbar`, !/\brichbar\b/.test(src));
  }
}
ok("rich fields were found to protect", richFields > 0, `${richFields} across ${files.length} modules`);

console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
