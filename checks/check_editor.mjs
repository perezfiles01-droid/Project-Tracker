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
ok("the edit is saved as a draft", store.ed && store.ed.length === 1 && store.ed[0].objects.length === count);
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

await page.click('[data-ie-act="new"]');
ok("New starts an empty canvas", (await doc()).objects.length === 0);

if (process.env.SHOT) {
  await page.click(`[data-ie-open]`);
  await page.waitForTimeout(400);
  const first = (await doc()).objects[0];
  await page.mouse.click(...await at(first.x + 10, first.y + 10));
  await page.screenshot({ path: process.env.SHOT });
}

ok("no page or console errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\nFAIL: ${failed} problem(s) in the image editor` : "\nPASS: the image editor draws, crops, exports and keeps drafts");
process.exit(failed ? 1 : 0);
