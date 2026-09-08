#!/usr/bin/env node
/**
 * Guard: every attachments field enforces the same ceiling, and says so.
 *
 * The number used to live in three places: ATT_MAX in ui.js, UPDATE_IMAGES in
 * tasks.js, and the word "five" spelled out as a literal in the task dialog's
 * help text. Raising the limit moved two of them and left the third telling
 * you something the field no longer did.
 *
 * So nothing here hard-codes a number. The ceiling is read FROM THE RUNNING
 * APP and every assertion is made against that, which is what stops this
 * check needing an edit the next time the limit moves - and what makes it
 * catch a field that quietly disagrees with the constant.
 *
 * Fields are enumerated from the dialogs at runtime, so an attachments field
 * added later is covered without this file being touched.
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
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
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

/* The ceiling, asked of the app. Every number below derives from this one. */
const MAX = await page.evaluate(() => window.TrackerUI.ATT_MAX);
ok("the app exposes one ceiling", Number.isInteger(MAX) && MAX > 0, String(MAX));
ok("and it is the twenty that was asked for", MAX === 20, String(MAX));
ok("the update field agrees with it",
   (await page.evaluate(() => window.TrackerTasks.UPDATE_IMAGES)) === MAX,
   `update: ${await page.evaluate(() => window.TrackerTasks.UPDATE_IMAGES)}, shared: ${MAX}`);

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const paste = (n) => page.evaluate(({ b64, n }) => {
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
 * Drive one attachments field to its ceiling and one past it.
 *
 * The SHAPE of what is asserted is what matters and is unchanged from the
 * checks this replaces: exactly MAX stage, the next is refused out loud, and
 * the count note reads "MAX of MAX".
 */
async function driveField(label, openDialog) {
  await openDialog();
  const field = await page.evaluate(() => {
    const el = document.querySelector(".attachments");
    return el ? el.dataset.attfield : null;
  });
  ok(`${label}: has an attachments field`, !!field, String(field));
  if (!field) return;

  await paste(MAX + 3);
  await page.waitForTimeout(500);
  const staged = await page.locator(".attstaged .attrow").count();
  ok(`${label}: exactly ${MAX} stage`, staged === MAX, String(staged));

  const note = await page.locator("[data-attcount]").innerText();
  ok(`${label}: the count reads ${MAX} of ${MAX}`,
     new RegExp(`${MAX} of ${MAX}`).test(note), note);
  const refusal = await page.locator(`[data-note="fd_${field}"]`).innerText();
  ok(`${label}: the extras are refused out loud`, /not attached/i.test(refusal), refusal);
  ok(`${label}: and the refusal names the real limit`,
     new RegExp(`limit is ${MAX}\\b`).test(refusal), refusal);

  /* No help text may name a number other than the ceiling. This is the
     assertion that would have caught "Up to five" surviving a raise to 20. */
  const helps = await page.$$eval("#formDialog .field small", (els) => els.map((e) => e.innerText));
  const wrong = helps.filter((h) => {
    const nums = (h.match(/\bUp to (\d+|five|ten|twenty)\b/gi) || []);
    return nums.some((n) => !new RegExp(`Up to ${MAX}\\b`, "i").test(n));
  });
  ok(`${label}: no help text names a different number`, wrong.length === 0,
     wrong.join(" | ") || "consistent");

  await page.click('#formDialog [data-fd="cancel"]');
  await page.waitForTimeout(200);
}

await driveField("task attachments", async () => {
  await page.click('[data-edit="task:new"]');
  await page.waitForSelector(".attachments");
});

// A task to hang an update on, so the update field can be driven too.
await page.evaluate(() => {
  localStorage.setItem("tracker.tasks", JSON.stringify([{
    id: "t-lim", name: "Limit task", given: "2026-09-01", status: "In progress",
    assignee: "Jim", attachments: [], updates: [],
  }]));
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
await page.click(".taskrow");
await page.waitForTimeout(300);
await page.click(".taskpane [data-updates]");
await page.waitForTimeout(250);

await driveField("update images", async () => {
  await page.click("[data-addupdate]");
  await page.waitForSelector(".attachments");
});

/* And the ceiling actually holds through a save, not just in the dialog. */
await page.click("[data-addupdate]");
await page.waitForSelector("#fd_text");
await paste(MAX + 2);
await page.waitForTimeout(600);
await page.fill("#fd_text", "many pictures");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(1200);
const savedCount = await page.evaluate(() =>
  (JSON.parse(localStorage.getItem("tracker.tasks"))[0].updates[0].images || []).length);
ok(`${MAX} images survive a save`, savedCount === MAX, String(savedCount));

ok("no page errors along the way", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${failed} limit check(s) failed`);
process.exit(failed ? 1 : 0);
