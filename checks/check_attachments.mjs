#!/usr/bin/env node
/**
 * Guard: attaching images and files, by paste or by picker, capped at five.
 *
 * Three things fail quietly if nobody checks them:
 *   1. Picking files twice. A file input's FileList is read-only, so the
 *      second pick used to replace the first rather than add to it - which is
 *      indistinguishable from "the file did not attach".
 *   2. The ceiling. Refusing silently and refusing loudly look the same to the
 *      code and completely different to the person attaching.
 *   3. Download. An attachment inside IndexedDB is not a file any more unless
 *      something hands it back with its own name.
 *
 * The paste is synthesised, so this proves our handler rather than a
 * clipboard: a tool that puts a path or HTML on the clipboard instead of a
 * file is outside what any check here can cover.
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
await page.evaluate(() => localStorage.setItem("tracker.tasks", "[]"));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);

const openNew = async () => {
  await page.click('[data-edit="task:new"]');
  await page.waitForSelector("#fd_files");
};
const staged = () => page.$$eval(".attstaged .attrow", (r) =>
  r.map((x) => x.querySelector(".attname").innerText.trim()));
const countNote = () => page.locator("[data-attcount]").innerText();

/** A one-pixel PNG, as bytes, so an image is a real image. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Paste files into the dialog exactly as a screenshot would arrive. */
const pasteImages = (n) => page.evaluate(({ b64, n }) => {
  const dt = new DataTransfer();
  for (let i = 0; i < n; i++) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    // "image.png" is what a real clipboard paste is named, which is the case
    // the renaming exists for.
    dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
  }
  document.querySelector("#formDialog").dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, { b64: PNG, n });

/** Choose files through the picker, one call per pick. */
const choose = (names) => page.setInputFiles("#fd_files",
  names.map((name) => ({ name, mimeType: "text/plain", buffer: Buffer.from("x") })));

/* --- pasting a screenshot attaches it, with a usable name ----------------- */
await openNew();
await pasteImages(1);
await page.waitForTimeout(200);
const afterPaste = await staged();
ok("a pasted screenshot attaches", afterPaste.length === 1, afterPaste.join(", "));
ok("a pasted image is renamed to something saveable",
   /^Pasted image \d+\.png$/.test(afterPaste[0] || ""), afterPaste[0] || "none");
ok("a pasted image shows a thumbnail",
   (await page.locator(".attstaged .attthumb").count()) === 1);

/* --- picking twice adds, it does not replace ------------------------------ */
await choose(["one.txt"]);
await page.waitForTimeout(200);
await choose(["two.txt"]);
await page.waitForTimeout(200);
const afterPicks = await staged();
ok("choosing files twice adds to the list rather than replacing it",
   afterPicks.length === 3 && afterPicks.includes("one.txt") && afterPicks.includes("two.txt"),
   afterPicks.join(", "));
ok("the count is shown", /3 of 5/.test(await countNote()), await countNote());

/* --- the sixth is refused, out loud, and the five survive ----------------- */
await choose(["three.txt", "four.txt", "five.txt"]);
await page.waitForTimeout(250);
const atLimit = await staged();
ok("five attach and the sixth is refused", atLimit.length === 5, atLimit.join(", "));
const note = (await page.locator('[data-note="fd_files"]').textContent()).trim();
ok("the refusal says so rather than dropping it silently",
   /not attached/i.test(note) && /5/.test(note), note || "(nothing said)");
ok("the picker is disabled once full",
   await page.$eval("#fd_files", (el) => el.disabled));

/* --- removing a staged file frees the slot -------------------------------- */
await page.click(".attstaged .attdrop");
await page.waitForTimeout(200);
ok("removing a staged file frees a slot", (await staged()).length === 4, await countNote());
ok("the picker is usable again", !(await page.$eval("#fd_files", (el) => el.disabled)));

/* --- saved, and offered as View plus Download ----------------------------- */
await page.fill("#fd_name", "with attachments");
await page.click("#formDialog .actions button.primary");
await page.waitForTimeout(700);
const savedCount = await page.evaluate(() =>
  (JSON.parse(localStorage.getItem("tracker.tasks"))[0].attachments || []).length);
ok("all four are saved with the task", savedCount === 4, String(savedCount));

await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(300);
ok("each attachment offers View", (await page.locator("[data-att]").count()) === 4);
ok("each attachment offers Download", (await page.locator("[data-attdl]").count()) === 4);

/* The download must carry the file's own name, or it saves as "download". */
const dlName = await page.evaluate(async () => {
  const id = document.querySelector("[data-attdl]").dataset.attdl;
  const list = JSON.parse(localStorage.getItem("tracker.tasks"));
  const meta = list.flatMap((t) => t.attachments || []).find((a) => a.id === id);
  return meta ? meta.name : null;
});
ok("the attachment kept its own filename", !!dlName && /\.(png|txt)$/.test(dlName), String(dlName));

const download = await page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
const clicked = page.click("[data-attdl]").then(() => page.waitForEvent("download", { timeout: 5000 }))
  .catch(() => null);
const got = download || await clicked;
ok("clicking Download actually downloads the file, named as it was attached",
   !!got && got.suggestedFilename() === dlName,
   got ? got.suggestedFilename() : "no download fired");

/* --- the old link field is gone, but stored links still render ------------ */
await page.evaluate(() => localStorage.setItem("tracker.tasks", JSON.stringify([{
  id: "t-link", name: "Legacy", status: "To do",
  attachments: [{ id: "l-1", name: "https://example.test/old", url: "https://example.test/old", kind: "link" }],
}])));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
await openNew();
ok("the Attach a link field is gone", (await page.locator("#fd_linkUrl").count()) === 0);
const attLabel = await page.$$eval("#formDialog label", (l) =>
  l.map((x) => x.innerText.trim()).find((t) => /attach/i.test(t)));
ok("the field is named Attach an image/file", /image\/file/i.test(attLabel || ""), attLabel || "none");
await page.click('#formDialog [data-fd="cancel"]');
await page.waitForTimeout(200);
await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(250);
ok("a link attached under the old field still renders",
   (await page.locator('a.tag[href="https://example.test/old"]').count()) === 1);

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} attachment check(s) failed`
                   : "\nPASS: images and files attach, cap at five, and download");
process.exit(failed ? 1 : 0);
