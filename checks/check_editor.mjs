#!/usr/bin/env node
/**
 * Guard for the Image editor (asked for 17 Nov 2026).
 *
 * Drives it with a real mouse and keyboard, because every fault worth
 * catching here is a gesture that does nothing: a tool that draws nothing,
 * a crop that is never applied, an undo that skips a step, or a picture
 * whose bytes land in localStorage and take the task list with them.
 *
 * Tools are enumerated from the rendered ribbon, so one added later is
 * exercised without this file being edited.
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
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(400);

/* --- placement: under Index, straight after Overview --- */
const navOrder = await page.$$eval("#nav > *", (els) => els.map((e) => e.dataset.route || "#" + e.textContent.trim()));
const iIdx = navOrder.indexOf("#Index"), iEd = navOrder.indexOf("editor");
ok("Image editor sits in the Index group, after Overview",
   iEd === navOrder.indexOf("overview") + 1 && iIdx >= 0 && iEd > iIdx, navOrder.slice(0, 4).join(", "));

await page.click('#nav button[data-route="editor"]');
await page.waitForTimeout(300);
ok("the page mounts a canvas", (await page.locator("#ieCanvas").count()) === 1);
ok("the empty canvas invites a drop", await page.locator("#ieDrop").isVisible());

const doc = () => page.evaluate(() => JSON.parse(JSON.stringify(window.TrackerEditor._doc())));
const box = async () => page.locator("#ieCanvas").boundingBox();
/** Canvas coordinates to screen coordinates. */
const at = async (x, y) => { const b = await box(), d = await doc(); const k = b.width / d.w; return [b.x + x * k, b.y + y * k]; };
const dragOn = async (x1, y1, x2, y2) => {
  await page.mouse.move(...await at(x1, y1)); await page.mouse.down();
  await page.mouse.move(...await at((x1 + x2) / 2, (y1 + y2) / 2), { steps: 3 });
  await page.mouse.move(...await at(x2, y2), { steps: 3 }); await page.mouse.up();
  await page.waitForTimeout(60);
};

/* --- a picture, added the way a paste or drop adds one --- */
await page.evaluate(async () => {
  const c = document.createElement("canvas"); c.width = 400; c.height = 200;
  const g = c.getContext("2d"); g.fillStyle = "#0000ff"; g.fillRect(0, 0, 200, 200); g.fillStyle = "#00ff00"; g.fillRect(200, 0, 200, 200);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  await window.TrackerEditor._addImage(new File([blob], "t.png", { type: "image/png" }));
});
await page.waitForTimeout(200);
let d = await doc();
ok("a picture becomes an image object", d.objects.length === 1 && d.objects[0].type === "image");
ok("the drop hint goes once something is on the canvas", !(await page.locator("#ieDrop").isVisible()));

/* --- every insert / draw tool on the ribbon draws something --- */
const tools = await page.$$eval("[data-ie-tool]", (bs) => bs.map((b) => b.dataset.ieTool).filter((t) => t !== "select" && t !== "text"));
ok("drawing tools were found on the ribbon", tools.length >= 6, tools.join(", "));
let y = 60;
for (const t of tools) {
  const n = (await doc()).objects.length;
  await page.click(`[data-ie-tool="${t}"]`);
  await dragOn(900, y, 1150, y + 50);
  y += 90;
  const after = await doc();
  ok(`"${t}" draws an object`, after.objects.length === n + 1 && after.objects.at(-1).type === t,
     `${n} → ${after.objects.length}`);
}

/* --- text: click, type, click away --- */
await page.click('[data-ie-tool="text"]');
await page.mouse.click(...await at(100, 600));
await page.waitForTimeout(80);
await page.keyboard.type("Hello review");
await page.mouse.click(...await at(1270, 710));
await page.waitForTimeout(80);
d = await doc();
const txt = d.objects.find((o) => o.type === "text");
ok("typed text is kept", txt && txt.text === "Hello review", txt && txt.text);

/* --- undo and redo step exactly once each, and stay out of the app's history --- */
const count = (await doc()).objects.length;
await page.keyboard.press("Control+z");
ok("Ctrl+Z removes the last thing added", (await doc()).objects.length === count - 1);
await page.keyboard.press("Control+y");
ok("Ctrl+Y puts it back", (await doc()).objects.length === count);

/* --- finished text can be reopened and corrected --- */
await page.mouse.dblclick(...await at(txt.x + 20, txt.y + txt.h / 2));
await page.waitForTimeout(80);
ok("double-clicking finished text opens it for editing", await page.locator("#ieText").isVisible());
await page.keyboard.press("Control+a");
await page.keyboard.type("Hello fixed");
await page.mouse.click(...await at(1270, 710));
await page.waitForTimeout(80);
ok("the correction is kept", (await doc()).objects.find((o) => o.type === "text").text === "Hello fixed");
await page.mouse.click(...await at(txt.x + 20, txt.y + txt.h / 2));
await page.click('[data-ie-act="edittext"]');
await page.waitForTimeout(80);
ok("Edit text in the format bar opens it too", await page.locator("#ieText").isVisible());
await page.keyboard.press("Escape");
await page.waitForTimeout(80);


/* --- select, move with keys, duplicate, delete --- */
const img0 = (await doc()).objects[0];
await page.mouse.click(...await at(img0.x + 20, img0.y + 20));
await page.keyboard.press("Shift+ArrowRight");
ok("arrow keys nudge the selection", (await doc()).objects[0].x === img0.x + 10);
await page.keyboard.press("Control+d");
ok("Ctrl+D duplicates", (await doc()).objects.length === count + 1);
await page.keyboard.press("Delete");
ok("Delete removes the selection", (await doc()).objects.length === count);

/* --- resize from a corner keeps a picture's proportions --- */
await page.mouse.click(...await at(img0.x + 30, img0.y + 30));
let o = (await doc()).objects[0];
await dragOn(o.x + o.w, o.y + o.h, o.x + o.w + 100, o.y + o.h + 10);
let o2 = (await doc()).objects[0];
ok("corner resize grows the picture", o2.w > o.w + 50);
ok("and keeps its proportions", Math.abs(o2.w / o2.h - o.w / o.h) < 0.02, `${(o2.w / o2.h).toFixed(3)} vs ${(o.w / o.h).toFixed(3)}`);

/* --- crop keeps only the left half (the blue square) --- */
await page.click('[data-ie-act="crop"]');
o = (await doc()).objects[0];
await dragOn(o.x + o.w, o.y + o.h / 2, o.x + o.w / 2, o.y + o.h / 2);
await page.click('[data-ie-act="crop-apply"]');
o2 = (await doc()).objects[0];
ok("crop keeps the chosen part of the source", Math.abs(o2.crop.w - 200) < 4 && o2.crop.x === 0, JSON.stringify(o2.crop));
ok("crop shrinks the box to match", Math.abs(o2.w - o.w / 2) < 3);

/* --- Copy with something selected copies only that, at its own resolution --- */
const cp = await page.evaluate(async () => {
  const blob = await window.TrackerEditor._copyBlob();
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d"); g.drawImage(bmp, 0, 0);
  const px = (x, y) => [...g.getImageData(x, y, 1, 1).data];
  return { w: bmp.width, h: bmp.height, mid: px(bmp.width >> 1, bmp.height >> 1), corner: px(1, 1),
    label: document.getElementById("ieCopy").textContent };
});
// The larger of its source size and the size it is drawn at, never smaller.
const want = Math.round(Math.max(o2.crop.w, o2.w));
ok("with a picture selected, Copy copies only that picture", Math.abs(cp.w - want) <= 1 && Math.abs(cp.h - want) <= 1, `${cp.w}×${cp.h}, want ${want}`);
ok("at its source resolution, with none of the rest of the page", cp.mid[2] > 200 && cp.corner[2] > 200 && cp.corner[1] < 60,
   cp.mid.join(",") + " / " + cp.corner.join(","));
ok("the button says what it will copy", cp.label === "Copy selection", cp.label);
await page.keyboard.press("Escape");
const whole = await page.evaluate(async () => {
  const bmp = await createImageBitmap(await window.TrackerEditor._copyBlob());
  return { w: bmp.width, label: document.getElementById("ieCopy").textContent };
});
ok("with nothing selected, Copy copies the whole page", whole.w === 1280 && whole.label === "Copy page", JSON.stringify(whole));
await page.mouse.click(...await at(o2.x + 5, o2.y + 5));

/* --- rotate 90 --- */
await page.click('[data-ie-act="rotate"]');
ok("Rotate turns the picture a quarter", Math.abs((await doc()).objects[0].rot - Math.PI / 2) < 1e-6);
await page.keyboard.press("Control+z");

/* --- the exported PNG holds what is on the canvas, and no handles --- */
const px = await page.evaluate(async () => {
  const d = window.TrackerEditor._doc(), o = d.objects[0];
  const blob = await window.TrackerEditor._exportBlob();
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d"); g.drawImage(bmp, 0, 0);
  const p = (x, y) => [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data];
  return { w: bmp.width, h: bmp.height, mid: p(o.x + o.w / 2, o.y + o.h / 2), corner: p(o.x + 1, o.y + 1), dw: d.w, dh: d.h };
});
ok("the PNG is the canvas size", px.w === px.dw && px.h === px.dh, `${px.w}×${px.h}`);
ok("the PNG shows the cropped picture (blue)", px.mid[2] > 200 && px.mid[1] < 60, px.mid.join(","));
ok("the PNG carries no selection handles", px.corner[2] > 200 && px.corner[0] < 60, px.corner.join(","));

/* --- drafts: saved, in this browser only, without picture bytes --- */
await page.waitForTimeout(400);
const store = await page.evaluate(() => {
  const all = Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]);
  const ed = all.find(([k]) => k.startsWith("tracker.imageEditor"));
  return { ed: ed && JSON.parse(ed[1]), bytes: all.some(([, v]) => /data:image|base64,/i.test(v || "")),
    local: window.TrackerStore.KEYS.local.includes("tracker.imageEditor"),
    data: window.TrackerStore.KEYS.data.includes("tracker.imageEditor") };
});
ok("the edit is saved as a draft", store.ed && store.ed.length === 1 && store.ed[0].pages[0].objects.length === count);
ok("no picture bytes anywhere in localStorage", !store.bytes);
ok("drafts are browser-local, not in the backup", store.local && !store.data);

await page.reload({ waitUntil: "load" });
await page.waitForTimeout(500);
await page.click('#nav button[data-route="editor"]');
await page.waitForTimeout(400);
ok("the latest draft reopens after a reload", (await doc()).objects.length === count);
await page.click('[data-ie-act="drafts"]');
await page.fill('#view [data-search="editor"]', "zzz-none");
await page.waitForTimeout(150);
ok("draft search filters the list", (await page.locator(".ie-draft").count()) === 0);
await page.fill('#view [data-search="editor"]', "");
await page.waitForTimeout(150);
ok("and clearing it brings the draft back", (await page.locator(".ie-draft").count()) === 1);

/* --- several at once: drag a box, Shift+click, move them together --- */
await page.keyboard.press("Escape");
const before = await doc();
const isLine = (o) => o.type === "line" || o.type === "arrow";
const tops = before.objects.filter((o) => !isLine(o) && o.x > 880).map((o) => o.id);  // the shapes drawn at x 900-1150
await dragOn(870, 30, 1275, 715);
let ids = await page.evaluate(() => window.TrackerEditor._chosen());
const right = before.objects.filter((o) => (isLine(o) ? Math.min(o.x1, o.x2) : o.x) > 880).map((o) => o.id);
ok("dragging on empty space selects everything wholly inside the box",
   right.length >= 5 && right.every((id) => ids.includes(id)) && ids.length === right.length, `${ids.length} of ${right.length}`);
ok("the format bar says how many are selected", /\d+ selected/i.test(await page.locator("#ieFormat").innerText()));
const firstRight = before.objects.find((o) => o.id === right[0]);
const grab = isLine(firstRight) ? [(firstRight.x1 + firstRight.x2) / 2, (firstRight.y1 + firstRight.y2) / 2] : [firstRight.x + firstRight.w / 2, firstRight.y + firstRight.h / 2];
await dragOn(grab[0], grab[1], grab[0] - 100, grab[1] + 5);
let moved = await doc();
const dxOf = (id) => { const a = before.objects.find((o) => o.id === id), b = moved.objects.find((o) => o.id === id);
  return isLine(a) ? b.x1 - a.x1 : b.x - a.x; };
ok("dragging one of them moves them all together", right.every((id) => Math.abs(dxOf(id) + 100) < 2),
   right.map(dxOf).map((n) => n.toFixed(0)).join(","));
ok("things outside the box stay put", before.objects.filter((o) => !right.includes(o.id)).every((o) => dxOf(o.id) === 0));
await page.keyboard.press("Shift+ArrowRight");
moved = await doc();
ok("arrow keys nudge the whole selection", right.every((id) => Math.abs(dxOf(id) + 90) < 2));
await page.keyboard.press("Control+z"); await page.keyboard.press("Control+z");
ok("undo takes the group back where it was",
   (await doc()).objects.every((o, i) => JSON.stringify(o) === JSON.stringify(before.objects[i])));
// Shift+click adds one more, and takes it out again.
const txtNow = (await doc()).objects.find((o) => o.type === "text");
await page.keyboard.down("Shift");
await page.mouse.click(...await at(txtNow.x + 10, txtNow.y + txtNow.h / 2));
await page.keyboard.up("Shift");
ids = await page.evaluate(() => window.TrackerEditor._chosen());
ok("Shift+click adds to the selection", ids.includes(txtNow.id) && ids.length === right.length + 1, `${ids.length}`);
// Shift+drag starting on the big picture selects instead of moving it.
const pic = (await doc()).objects.find((o) => o.type === "image");
await page.keyboard.down("Shift");
await dragOn(pic.x + 5, pic.y + 5, 1275, 715);
await page.keyboard.up("Shift");
ok("Shift+drag over a picture draws a selection box instead of moving the picture",
   (await doc()).objects.find((o) => o.id === pic.id).x === pic.x);
await page.keyboard.press("Control+a");
ids = await page.evaluate(() => window.TrackerEditor._chosen());
ok("Ctrl+A selects everything on the page", ids.length === (await doc()).objects.length);
const many = await page.evaluate(async () => (await createImageBitmap(await window.TrackerEditor._copyBlob())).width);
ok("Copy with several selected copies just their area, not the page", many < 1280, String(many));
await page.keyboard.press("Escape");

/* --- pages: a draft holds several, like slides --- */
const book = () => page.evaluate(() => JSON.parse(JSON.stringify(window.TrackerEditor._book())));
const pageCount = async () => (await book()).pages.length;
ok("a draft starts with one page and a strip showing it",
   (await pageCount()) === 1 && (await page.locator("#iePages [data-ie-page]").count()) === 1);
await page.click('[data-ie-act="addmenu"]');
await page.click('[data-ie-act="page-blank"]');
let bk = await book();
ok("Blank page adds an empty page after the current one, and opens it",
   bk.pages.length === 2 && bk.cur === 1 && bk.pages[1].objects.length === 0);
ok("the blank page is the same size", bk.pages[1].w === bk.pages[0].w && bk.pages[1].h === bk.pages[0].h);
ok("the strip shows both pages", (await page.locator("#iePages [data-ie-page]").count()) === 2);
await page.click('[data-ie-tool="rect"]');
await dragOn(100, 100, 300, 200);
ok("drawing lands on the open page only", (await book()).pages[1].objects.length === 1 && (await book()).pages[0].objects.length === count);
await page.keyboard.press("PageUp");
ok("Page Up goes to the previous page", (await book()).cur === 0 && (await doc()).objects.length === count);
await page.click('[data-ie-act="addmenu"]');
await page.click('[data-ie-act="page-dup"]');
bk = await book();
ok("Duplicate this page copies it in after the current one",
   bk.pages.length === 3 && bk.cur === 1 && bk.pages[1].objects.length === count && bk.pages[1].id !== bk.pages[0].id);
ok("the copy's objects are new objects, not shared ones",
   bk.pages[1].objects[0].id !== bk.pages[0].objects[0].id);
await page.click('#iePages [data-ie-page="2"]');
ok("clicking a preview opens that page", (await book()).cur === 2);
await page.waitForTimeout(400);
const thumbsDrawn = await page.$$eval("canvas[data-ie-thumb]", (cs) => cs.every((c) => {
  const g = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < g.length; i += 4) if (g[i]) return true; return false; }));
ok("every preview is drawn", thumbsDrawn);

// Reorder by dragging the last preview onto the first.
const lastId = (await book()).pages[2].id;
await page.locator('#iePages [data-ie-page="2"]').dragTo(page.locator('#iePages [data-ie-page="0"]'));
await page.waitForTimeout(100);
bk = await book();
ok("dragging a preview reorders the pages", bk.pages[0].id === lastId, bk.pages.map((x) => x.id).join(","));
ok("and the open page follows its content", bk.pages[bk.cur].id === lastId);
await page.keyboard.press("Control+z");
ok("undo puts the order back", (await book()).pages[2].id === lastId);

// Delete through the page's own menu, with its confirmation.
await page.click('#iePages [data-ie-tmenu="0"]');
await page.click('#iePages [data-ie-pdel="0"]');
await page.waitForTimeout(150);
await page.getByRole("button", { name: "Delete page" }).click();
await page.waitForTimeout(150);
ok("Delete removes the page after confirming", (await pageCount()) === 2);
await page.keyboard.press("Control+z");
ok("undo brings a deleted page back", (await pageCount()) === 3);

/* --- export of all pages --- */
const pdf = await page.evaluate(async () => {
  const b = await window.TrackerEditor._pdfBlob();
  const t = new TextDecoder("latin1").decode(new Uint8Array(await b.arrayBuffer()));
  const xref = Number(t.match(/startxref\n(\d+)/)[1]);
  return { head: t.slice(0, 8), count: (t.match(/\/Count (\d+)/) || [])[1], pages: (t.match(/\/Type \/Page /g) || []).length,
    images: (t.match(/\/Subtype \/Image/g) || []).length, xrefOk: t.slice(xref, xref + 4) === "xref", eof: t.trimEnd().endsWith("%%EOF") };
});
ok("the PDF is a PDF with one page per page", pdf.head.startsWith("%PDF-") && pdf.count === "3" && pdf.pages === 3 && pdf.images === 3,
   JSON.stringify(pdf));
ok("the PDF's cross-reference table is where it says", pdf.xrefOk && pdf.eof);
const saved = [];
page.on("download", (dl) => saved.push(dl.suggestedFilename()));
await page.click('[data-ie-act="dlmenu"]');
await page.click('[data-ie-act="dl-all"]');
await page.waitForTimeout(1600);
ok("All pages (PNG) saves one file per page", saved.length === 3 && saved.every((n, i) => n.endsWith(`Page ${i + 1}.png`)),
   saved.join(", "));
await page.click('[data-ie-act="dlmenu"]');
await page.click('[data-ie-act="dl-pdf"]');
await page.waitForTimeout(600);
ok("All pages (PDF) saves one PDF", saved.some((n) => n.endsWith(".pdf")), saved.join(", "));

/* --- the pages survive a reload, and the strip folds away --- */
await page.waitForTimeout(400);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(400);
await page.click('#nav button[data-route="editor"]');
await page.waitForTimeout(300);
ok("all pages reopen after a reload", (await pageCount()) === 3);
const wide = (await box()).width;
await page.click('#iePages [data-ie-act="pages"]');
await page.waitForTimeout(150);
ok("hiding the strip gives the canvas more room", (await box()).width >= wide && (await page.locator("#iePages [data-ie-page]").count()) === 0);
await page.click('#iePages [data-ie-act="pages"]');

/* --- a draft saved before pages existed still opens --- */
await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith("tracker.imageEditor"));
  const list = JSON.parse(localStorage.getItem(k));
  list.push({ id: "dold", name: "Old single", w: 800, h: 600, bg: "#ffffff", updated: "2026-11-01T00:00:00Z",
    objects: [{ id: "r1", type: "rect", x: 10, y: 10, w: 50, h: 50, rot: 0, stroke: "#ef4444", width: 4, fill: null }] });
  localStorage.setItem(k, JSON.stringify(list));
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(400);
await page.click('#nav button[data-route="editor"]');
await page.click('[data-ie-act="drafts"]');
await page.click('[data-ie-open="dold"]');
bk = await book();
ok("an old one-page draft opens as one page", bk.pages.length === 1 && bk.pages[0].w === 800 && bk.pages[0].objects.length === 1);
await page.click('[data-ie-open]:not([data-ie-open="dold"])');

await page.click('[data-ie-act="new"]');
ok("New starts an empty canvas", (await doc()).objects.length === 0);

if (process.env.SHOT) {
  await page.click(`[data-ie-open]:not([data-ie-open="dold"])`);
  await page.waitForTimeout(400);
  const first = (await doc()).objects[0];
  await page.mouse.click(...await at(first.x + 10, first.y + 10));
  await page.screenshot({ path: process.env.SHOT });
}

ok("no page or console errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\nFAIL: ${failed} problem(s) in the image editor` : "\nPASS: the image editor draws, crops, exports, keeps drafts and pages");
process.exit(failed ? 1 : 0);
