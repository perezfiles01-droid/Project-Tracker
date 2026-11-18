#!/usr/bin/env node
/**
 * Guard for Project updates (asked for 18 Nov 2026).
 *
 * The rules this protects were stated outright, and each fails silently:
 *   - a day belongs to the date things happened, not the date of import
 *   - a late import of an older day must not overwrite a newer status
 *   - a second import for the same day merges into it
 *   - only the updates are shown: no decision, action or question lists
 *   - everything in "where things stand" can be edited
 *   - ADB work sorts into releases, with Hotfix and General for the rest
 *   - the template's own example imports, so instructions and parser agree
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e).split("\n").slice(0, 3).join(" @ ")));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(400);

const nav = await page.$$eval("#nav > *", (els) => els.map((e) => e.dataset.route || "#" + e.textContent.trim()));
ok("Project updates sits after FAQ under Index", nav.indexOf("updates") === nav.indexOf("faq") + 1 && nav.indexOf("updates") < nav.indexOf("#Projects"));
ok("it shows no number", (await page.locator('#nav [data-route="updates"] .count').count()) === 0);

await page.click('#nav button[data-route="updates"]');
await page.waitForTimeout(150);
ok("the first screen shows the two projects", (await page.$$eval(".faq-card", (c) => c.map((x) => x.innerText.trim()))).join("|") === "ADB EDRMS|GRA GLASS");

const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-pu="template"]')]);
const tpl = readFileSync(await dl.path(), "utf8");
ok("the template downloads", dl.suggestedFilename() === "Project-update-template.md");
ok("it tells Claude to date each update by when it happened",
   /the day the things in it HAPPENED, not today/.test(tpl) && /ask me before answering/.test(tpl));
ok("it makes Claude check with you before sending the file",
   /TWO steps\. Never skip step 1/.test(tpl) && /## Step 1: Check with me first/.test(tpl) && /## Step 2: After I choose A, send the file/.test(tpl));
ok("its questions are multiple choice, best guess first, with an Other option",
   /2 to 4 lettered options/.test(tpl) && /\(my guess\)/.test(tpl) && /"Other \(none of these is right, I will type my answer\)"/.test(tpl));
ok("it shows the summary in plain words and asks Is this right? A / B / C",
   /Part B\. The summary in plain words/.test(tpl) && /> Is this right\?\n> A\. Yes, send me the file\.\n> B\. Change something/.test(tpl) && /Then STOP and wait/.test(tpl));
ok("it asks for clickable choices, with Other to type an answer, and one at a time otherwise",
   /ALWAYS use it for every question in this template/.test(tpl) && /Other \(none of these is right, I will type my answer\)" option\. If I pick it, let me type my own answer/.test(tpl) && /ask ONE question per message/.test(tpl));
ok("every question, including the first and Is this right?, offers Other to type an answer",
   (tpl.match(/> Other \(none of these is right, I will type my answer\)/g) || []).length === 2 && /Never leave it out/.test(tpl));
const q1 = tpl.indexOf("> What do you want to put in this project update?"), qa = tpl.indexOf("**Part A. Questions.**");
ok("the first question is always what to put in the update, asked on its own before the rest",
   q1 > 0 && q1 < qa && /Question 1, always first and always on its own/.test(tpl) && /Ask exactly this first, nothing else, and wait for my answer/.test(tpl) &&
   /> A\. Everything we discussed in this chat \(my guess\)/.test(tpl));
const shape = (tpl.match(/## The JSON shape\n\n```json\n([\s\S]*?)```/) || [])[1] || "";
ok("the template asks for updates only: no decisions, actions or questions fields",
   shape.includes('"summary": [""]') && !/decisions|actions|questions/.test(shape) && !/"decisions"|"actions"|"questions"/.test(tpl.split("## Example")[1] || "x") &&
   /Do NOT add decisions, action items, open questions/.test(tpl) && !/who owns an action/.test(tpl));
ok("it sets rules for simple wording", /How to write so it is simple to understand/.test(tpl) && /Short sentences/.test(tpl));
ok("it lists every ADB release, plus Hotfix and General",
   ["R2026.1 Multiple Records", "R2026.2 Centralized", "R2026.3 Email Records", "R2026.3.1 Email Records Enhancement",
    "R2026.4 Utilization Report", "Hotfix", "General"].every((r) => tpl.includes(r)));
const blocks = [...tpl.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
const example = blocks[blocks.length - 1];
const ex = await page.evaluate((t) => window.TrackerUpdates.parse(t, "adb"), example);
ok("the template's own example imports cleanly",
   ex.project === "adb" && ex.days.length === 1 && ex.days[0].blocks.map((b) => b.release).join("|") === "R2026.3 Email Records|Hotfix");

const canon = await page.evaluate(() => ["2026.4", "R2026.3.1", "utilization report", "hot fix", "R2026.5 Retention Rules", "release 2026.6 - Archive", ""]
  .map((r) => window.TrackerUpdates.canonRelease("adb", r)));
ok("release names written loosely land on the right release", canon.join("|") ===
   "R2026.4 Utilization Report|R2026.3.1 Email Records Enhancement|R2026.4 Utilization Report|Hotfix|R2026.5 Retention Rules|R2026.6 Archive|General",
   canon.join("|"));

/* --- a catch-up file: two past days, imported now --- */
const catchup = {
  format: "tracker-update", version: 1, project: "ADB EDRMS",
  status: "Status as of the 12th.",
  updates: [
    { date: "2026-11-10", headline: "Kick-off for utilization report", releases: [
      { release: "2026.4", summary: ["We met the client about the utilization report.", "They want monthly figures."],
        decisions: ["Monthly figures are required."], actions: [{ task: "Draft the KPI list.", owner: "Me", due: "2026-11-14" }], questions: ["Which departments are in scope?"] } ] },
    { date: "2026-11-12", headline: "Email labels reviewed", releases: [
      { release: "R2026.3 Email Records", summary: ["The labels were reviewed."], decisions: [], actions: [{ task: "Send the label list to Maria.", owner: "Me", due: "" }], questions: [] },
      { release: "Hotfix", summary: ["A permissions error was fixed."], decisions: [], actions: [], questions: [] } ] },
  ],
};
const dir = mkdtempSync(join(tmpdir(), "pu-"));
writeFileSync(join(dir, "update.json"), JSON.stringify(catchup));

await page.click('[data-pu-project="adb"]');
await page.click('[data-pu="menu"][data-m="imp"]');
const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-pu="importfile"]')]);
await chooser.setFiles(join(dir, "update.json"));
await page.waitForTimeout(200);
ok("the preview lists each day by the date it happened",
   (await page.locator(".faq-modal").innerText()).includes("Tue 10 Nov 2026") && (await page.locator(".faq-pr").count()) === 2);
await page.click('.faq-modal [data-v="go"]');
await page.waitForTimeout(150);
const dates = await page.$$eval(".pu-date", (d) => d.map((x) => x.innerText));
ok("both days land on their own dates, newest first", dates.join("|") === "Thu 12 Nov 2026|Tue 10 Nov 2026", dates.join("|"));
ok("the summary reads as paragraphs", (await page.locator(".pu-block p").count()) >= 4);
ok("Where things stand shows the status and its date", (await page.locator(".pu-stp").innerText()) === "Status as of the 12th." &&
   (await page.locator(".pu-asof").innerText()).includes("12 Nov 2026"));
const pageText = await page.locator(".pu").innerText();
ok("only the updates are shown: no open items, questions, decisions or action lists",
   (await page.locator(".pu-open, .pu-det, .pu-item, .pu-mgrid").count()) === 0 &&
   !/still open|open questions|decisions|action items/i.test(pageText), "");

/* --- releases --- */
const chips = await page.$$eval(".pu-chips .chip", (c) => c.map((x) => x.innerText.replace(/\s+\d+$/, "").trim()));
ok("ADB has a chip for every release, in order, then Hotfix and General",
   chips.join("|") === "All|R2026.1 Multiple Records|R2026.2 Centralized|R2026.3 Email Records|R2026.3.1 Email Records Enhancement|R2026.4 Utilization Report|Hotfix|General",
   chips.join("|"));
await page.click('[data-pu-rel="R2026.4 Utilization Report"]');
ok("a release chip narrows the timeline to that release", (await page.$$eval(".pu-date", (d) => d.length)) === 1);
await page.click('[data-pu-rel="All"]');

/* --- same day again: merges; an older day does not replace a newer status --- */
const later = { format: "tracker-update", version: 1, project: "ADB EDRMS", status: "Old status from the 10th.",
  updates: [{ date: "2026-11-10", headline: "Kick-off for utilization report", releases: [
    { release: "R2026.4 Utilization Report", summary: ["Rewritten paragraph for the 10th."], decisions: ["Monthly figures are required.", "Quarterly roll-up too."],
      actions: [{ task: "Draft the KPI list.", owner: "Me", due: "2026-11-14" }], questions: [] } ] }] };
await page.click('[data-pu="menu"][data-m="imp"]');
await page.click('[data-pu="importpaste"]');
await page.fill(".faq-paste", "Sure:\n```json\n" + JSON.stringify(later) + "\n```");
await page.click('.faq-modal [data-v="next"]');
await page.waitForTimeout(100);
ok("the preview says it adds to the existing day and keeps the newer status",
   (await page.locator(".faq-modal").innerText()).includes("Adds to this day") && (await page.locator(".faq-modal").innerText()).includes("kept as it is"));
await page.click('.faq-modal [data-v="go"]');
await page.waitForTimeout(150);
const data = () => page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("tracker.updates")))));
let d = await data();
const tenth = d.entries.find((e) => e.date === "2026-11-10");
ok("a second import for the day merges into it, not a second day", d.entries.length === 2);
ok("newer paragraphs replace the day's paragraphs", tenth.blocks[0].summary.join() === "Rewritten paragraph for the 10th.");
ok("lists sent by an older template are kept in the saved data, not thrown away", tenth.blocks[0].decisions.length === 2);
ok("an older day imported late does not overwrite the newer status", d.status.adb.text === "Status as of the 12th.");

/* --- where things stand is editable --- */
await page.click('[data-pu="editstatus"]');
await page.fill('[data-pu-f="text"]', "Edited status by hand.");
await page.click('[data-pu="savestatus"]');
ok("the status paragraph can be edited", (await page.locator(".pu-stp").innerText()) === "Edited status by hand.");

/* --- edit a day, including moving it to another date --- */
await page.click('.pu-day:has-text("Thu 12 Nov") [data-pu="edit"]');
await page.fill('[data-pu-f="date"]', "2026-11-11");
const editorBoxes = await page.locator('[data-pu-f^="dec:"], [data-pu-f^="act:"], [data-pu-f^="que:"]').count();
await page.fill('[data-pu-f="sum:0"]', "The labels were reviewed again.\n\nMaria agreed seven years for correspondence.");
await page.click('[data-pu="saveday"]');
await page.waitForTimeout(100);
d = await data();
const moved = d.entries.find((e) => e.date === "2026-11-11");
ok("editing can move a day to the date it really happened", !!moved && !d.entries.some((e) => e.date === "2026-11-12"));
ok("and edits its paragraphs", moved && moved.blocks[0].summary.join("|") === "The labels were reviewed again.|Maria agreed seven years for correspondence.");
ok("the day editor has no decision, action or question boxes", editorBoxes === 0, String(editorBoxes));

/* --- search, copy, export, delete --- */
await page.fill('#view [data-search="updates"]', "kick off utilisation report");
await page.waitForTimeout(150);
ok("search finds the day by meaning", (await page.$$eval(".pu-date", (x) => x.map((y) => y.innerText))).join() === "Tue 10 Nov 2026");
await page.fill('#view [data-search="updates"]', "");
await page.waitForTimeout(100);
await page.click('[data-pu="menu"][data-m="exp"]');
const [doc] = await Promise.all([page.waitForEvent("download"), page.click('[data-pu="exportdoc"]')]);
const docText = readFileSync(await doc.path(), "utf8");
ok("Export gives a readable document with the status and every day",
   doc.suggestedFilename().endsWith(".doc") && docText.includes("Edited status by hand.") && docText.includes("Tue 10 Nov 2026") && docText.includes("R2026.4 Utilization Report"));
await page.click('.pu-day:has-text("Wed 11 Nov") [data-pu="delete"]');
await page.waitForTimeout(100);
ok("deleting a day asks first", await page.getByRole("button", { name: "Delete day" }).isVisible());
await page.getByRole("button", { name: "Delete day" }).click();
await page.waitForTimeout(100);
ok("and then removes it", (await data()).entries.length === 1);

/* --- projects apart, in the backup --- */
await page.click('[data-pu="back"]');
await page.click('[data-pu-project="gra"]');
ok("GRA GLASS has none of ADB's days", (await page.locator(".pu-day").count()) === 0);
ok("GRA has no release chips (it has no releases yet)", (await page.locator(".pu-chips").count()) === 0);
ok("updates are part of the backup", await page.evaluate(() => window.TrackerStore.KEYS.data.includes("tracker.updates")));

/* --- one month per page --- */
await page.click('[data-pu="back"]');
await page.click('[data-pu-project="adb"]');
const october = { format: "tracker-update", version: 1, project: "ADB EDRMS", status: "",
  monthly: [{ month: "2026-10", summary: ["October started with planning.", "Two decisions were made by the end of the month."] }],
  updates: ["2026-10-05", "2026-10-30"].map((date, i) => ({ date, headline: "October day " + (i + 1), releases: [
    { release: "General", summary: ["Something happened in October."], decisions: ["An October decision."], actions: [{ task: "Do an October thing.", owner: "", due: "" }], questions: [] } ] })) };
await page.click('[data-pu="menu"][data-m="imp"]');
await page.click('[data-pu="importpaste"]');
await page.fill(".faq-paste", JSON.stringify(october));
await page.click('.faq-modal [data-v="next"]');
await page.click('.faq-modal [data-v="go"]');
await page.waitForTimeout(150);
ok("importing older days opens the month they belong to", (await page.$eval("[data-pu-pick]", (s) => s.value)) === "2026-10");
ok("a page holds only that month's days", (await page.$$eval(".pu-date", (d) => d.map((x) => x.innerText))).join("|") === "Fri 30 Oct 2026|Mon 5 Oct 2026");
ok("the month picker lists every month with days, newest first, with no count after it",
   (await page.$$eval("[data-pu-pick] option", (o) => o.map((x) => x.textContent))).join("|") === "November 2026|October 2026");
await page.click('[data-pu-month="2026-11"]');
ok("› goes to the newer month", (await page.$$eval(".pu-date", (d) => d.map((x) => x.innerText))).join("|") === "Tue 10 Nov 2026");
ok("and the newest month has no › further", await page.locator('.pu-mnav button[title="Newer month"]').isDisabled());
await page.selectOption("[data-pu-pick]", "2026-10");
ok("the picker jumps to a month", (await page.$$eval(".pu-date", (d) => d.length)) === 2);
const pageCap = await (async () => {
  // A month never has more than 31 days, so a page can never pass 31 entries.
  const per = {};
  for (const e of (await data()).entries.filter((x) => x.project === "adb")) per[e.date.slice(0, 7)] = (per[e.date.slice(0, 7)] || 0) + 1;
  return Math.max(...Object.values(per));
})();
ok("no month page holds more than 31 days", pageCap <= 31);

/* --- monthly view --- */
await page.click('[data-pu-mode="monthly"]');
ok("Monthly shows one summary for the month", (await page.locator(".pu-month").count()) === 1 && (await page.locator(".pu-day").count()) === 0);
const mtext = await page.locator(".pu-month").innerText();
ok("it lists the month's days", mtext.includes("October day 1") && mtext.includes("October day 2"));
ok("and no decisions, done, still open or open questions", !mtext.includes("An October decision.") && !/still open|open questions|decisions &|done ·/i.test(mtext));
ok("the monthly summary arrives with the import, as paragraphs",
   (await page.locator(".pu-msum p").allInnerTexts()).join("|") === "October started with planning.|Two decisions were made by the end of the month.");
ok("there is no AI or write-it-yourself button, only Edit",
   (await page.locator('[data-pu="aimonth"]').count()) === 0 && !(await page.locator(".pu-month").innerText()).includes("Write it myself") &&
   (await page.locator('.pu-msum [data-pu="editmonth"]').count()) === 1);
ok("it says which update it was last written with", (await page.locator(".pu-msum").innerText()).includes("Updated with the 30 Oct update"));
await page.click('[data-pu="editmonth"]');
await page.fill('[data-pu-f="monthtext"]', "October was quiet.\n\nTwo small decisions were made.");
await page.click('[data-pu="savemonth"]');
const handP = (await page.locator(".pu-msum p").allInnerTexts()).join("|");
ok("the summary can be edited, and is kept as paragraphs", handP === "October was quiet.|Two small decisions were made.", handP);
// The template carries what is already recorded, so a new chat can write the whole month.
const [tdl] = await Promise.all([page.waitForEvent("download"), page.click('.pu [data-pu="template"]')]);
const tpl2 = readFileSync(await tdl.path(), "utf8");
/* Two files: the instructions and the record so far, as data. */
const both = [];
const listen = (dl) => both.push(dl);
page.on("download", listen);
await page.click('.pu [data-pu="template"]');
await page.waitForTimeout(1200);
page.off("download", listen);
const names = both.map((x) => x.suggestedFilename());
ok("Download template saves two files: the template and the data file",
   names.includes("Project-update-template.md") && names.includes("ADB EDRMS - project updates data.json"), names.join(", "));
const dataJson = JSON.parse(readFileSync(await both.find((x) => x.suggestedFilename().endsWith(".json")).path(), "utf8"));
const adbData = dataJson.projects[0];
ok("the data file holds this project's status, monthly summaries and every day",
   dataJson.format === "tracker-update-data" && dataJson.projects.length === 1 && adbData.project === "ADB EDRMS" &&
   adbData.monthly.some((m) => m.month === "2026-10") && adbData.updates.some((u) => u.date === "2026-10-30") && adbData.updates.every((u, i, a) => !i || a[i - 1].date <= u.date));
ok("and only updates, never the old lists", !/"decisions"|"actions"|"questions"/.test(JSON.stringify(dataJson)));
ok("the template tells Claude to read the data file first and never send it back",
   /## The data file that comes with this template/.test(tpl2) && /Read it FIRST, before asking me anything/.test(tpl2) && /Never send the data file back/.test(tpl2));
ok("the template asks for the monthly summary every time", /\*\*monthly\*\*: the monthly summary, ALWAYS included/.test(tpl2) && tpl2.includes('"monthly": ['));
ok("and carries the month's current summary for Claude to build on",
   tpl2.includes("## Already recorded (use this)") && tpl2.includes("Monthly summary for 2026-10:\nOctober was quiet.") && !tpl2.includes("GRA GLASS\n"));
// A newer update for the month replaces the summary; an older catch-up does not.
const importJson = async (obj) => {
  await page.click('[data-pu="menu"][data-m="imp"]');
  await page.click('[data-pu="importpaste"]');
  await page.fill(".faq-paste", JSON.stringify(obj));
  await page.click('.faq-modal [data-v="next"]');
  const txt = await page.locator(".faq-modal").innerText();
  await page.click('.faq-modal [data-v="go"]');
  await page.waitForTimeout(150);
  return txt;
};
const day = (date, h) => ({ date, headline: h, releases: [{ release: "General", summary: ["Text for " + h + "."], decisions: [], actions: [], questions: [] }] });
let pv = await importJson({ format: "tracker-update", version: 1, project: "ADB EDRMS", status: "",
  monthly: [{ month: "2026-10", summary: ["Rewritten for the whole of October, through the 31st."] }], updates: [day("2026-10-31", "Last day of October")] });
ok("the import preview says the monthly summary will be updated", pv.includes("Monthly summary updated for October 2026"));
ok("each new update rewrites the month's summary", (await data()).monthly.adb["2026-10"].text === "Rewritten for the whole of October, through the 31st.");
await importJson({ format: "tracker-update", version: 1, project: "ADB EDRMS", status: "",
  monthly: [{ month: "2026-10", summary: ["Only about the 6th."] }], updates: [day("2026-10-06", "A late catch-up")] });
ok("a late catch-up for an earlier day does not overwrite a newer month summary",
   (await data()).monthly.adb["2026-10"].text === "Rewritten for the whole of October, through the 31st.");
pv = await importJson({ format: "tracker-update", version: 1, project: "ADB EDRMS", status: "", updates: [day("2026-10-31", "No monthly in this file")] });
ok("a file with no monthly summary says so, and leaves the summary alone",
   pv.includes("no monthly summary") && (await data()).monthly.adb["2026-10"].text === "Rewritten for the whole of October, through the 31st.");
await page.selectOption("[data-pu-pick]", "2026-10");
await page.click('[data-pu-mode="monthly"]');
await page.click('.pu-dlink:has-text("30 Oct")');
await page.waitForTimeout(100);
ok("clicking a day in the summary opens it in Daily", (await page.locator(".pu-day").count()) === 4 && (await page.$eval('[data-pu-mode="daily"]', (b) => b.getAttribute("aria-pressed"))) === "true");

/* --- images --- */
const png = join(dir, "shot.png");
writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEIGBmgDBgAAO8GBvy0tC0yAAAAAElFTkSuQmCC", "base64"));
const day30 = '.pu-day:has-text("Fri 30 Oct")';
const [ch] = await Promise.all([page.waitForEvent("filechooser"), page.click(`${day30} [data-pu="addimg"]`)]);
await ch.setFiles(png);
await page.waitForTimeout(300);
let oct30 = (await data()).entries.find((e) => e.date === "2026-10-30");
ok("Add image puts a picture on the day", (oct30.images || []).length === 1);
ok("its thumbnail is drawn", await page.$eval(`${day30} .pu-thb img`, (i) => i.src.startsWith("blob:")));
ok("no image bytes reach localStorage", await page.evaluate(() => !Object.values(localStorage).some((v) => /data:image|base64,/.test(v))));
await page.click(`${day30} .pu-thb`);
await page.waitForTimeout(100);
ok("clicking a thumbnail opens it full size", (await page.locator(".pu-lb img").count()) === 1);
await page.click('.faq-modal [data-v="cancel"]');
// Drop a picture onto a day.
await page.evaluate(async (sel) => {
  const blob = await (await fetch("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEIGBmgDBgAAO8GBvy0tC0yAAAAAElFTkSuQmCC")).blob();
  const dt = new DataTransfer(); dt.items.add(new File([blob], "dropped.png", { type: "image/png" }));
  const card = document.querySelector(sel + " .pu-card") || [...document.querySelectorAll(".pu-day")].find((d) => d.innerText.includes("Fri 30 Oct")).querySelector(".pu-card");
  card.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
}, "#none");
await page.waitForTimeout(300);
oct30 = (await data()).entries.find((e) => e.date === "2026-10-30");
ok("dropping a picture on a day adds it", oct30.images.length === 2 && oct30.images[1].name === "dropped.png");
// Paste while editing; remove one in the editor; save.
await page.click(`${day30} [data-pu="edit"]`);
await page.evaluate(async () => {
  const blob = await (await fetch("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEIGBmgDBgAAO8GBvy0tC0yAAAAAElFTkSuQmCC")).blob();
  const dt = new DataTransfer(); dt.items.add(new File([blob], "pasted.png", { type: "image/png" }));
  document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(300);
ok("pasting while editing adds the picture to the day being edited", (await page.locator(".pu-editing .pu-th").count()) === 3);
await page.locator(".pu-editing .pu-th").first().hover();
await page.locator(".pu-editing .pu-thx").first().click();
await page.click('[data-pu="saveday"]');
await page.waitForTimeout(150);
oct30 = (await data()).entries.find((e) => e.date === "2026-10-30");
ok("removing one in the editor and saving keeps the rest", oct30.images.map((x) => x.name).join("|") === "dropped.png|pasted.png");
await page.click('[data-pu-mode="monthly"]');
ok("the month's images are gathered in the monthly view", (await page.locator(".pu-month .pu-th").count()) === 2);
await page.click('[data-pu-mode="daily"]');

/* --- data saved before this change still opens, and is not rewritten by viewing it --- */
const legacy = { entries: [{ id: "dlegacy", project: "gra", date: "2026-09-14", headline: "Saved by the earlier version",
  blocks: [{ release: "General", summary: ["An older paragraph."], decisions: ["Old decision."], actions: [{ id: "alegacy", text: "Old action.", owner: "", due: "", done: false }], questions: [] }],
  updated: "2026-09-14T10:00:00.000Z" }], status: { gra: { text: "Older status.", asOf: "2026-09-14" } } };
const legacyKey = await page.evaluate((v) => {
  const k = Object.keys(localStorage).find((x) => x.startsWith("tracker.updates")) || "tracker.updates";
  localStorage.setItem(k, JSON.stringify(v)); return k;
}, legacy);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(400);
await page.click('#nav button[data-route="updates"]');
await page.click('[data-pu-project="gra"]');
await page.waitForTimeout(150);
ok("data saved by the earlier version still shows its day and status",
   (await page.locator(".pu-head").first().innerText()) === "Saved by the earlier version" && (await page.locator(".pu-stp").innerText()) === "Older status.");
await page.click('[data-pu-mode="monthly"]');
ok("and opens in the monthly view too, without its old lists",
   (await page.locator(".pu-month").innerText()).includes("Saved by the earlier version") && !(await page.locator(".pu-month").innerText()).includes("Old decision."));
ok("viewing it changes nothing that was saved", await page.evaluate((k) => localStorage.getItem(k), legacyKey) === JSON.stringify(legacy));
await page.click('[data-pu-mode="daily"]');

if (process.env.SHOT) {
  await page.click('[data-pu="back"]');
  await page.click('[data-pu-project="adb"]');
  writeFileSync(join(dir, "u2.json"), JSON.stringify(catchup));
  await page.click('[data-pu="menu"][data-m="imp"]');
  const [c2] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-pu="importfile"]')]);
  await c2.setFiles(join(dir, "u2.json"));
  await page.waitForTimeout(150);
  await page.click('.faq-modal [data-v="go"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: process.env.SHOT, fullPage: true });
}

ok("no page or console errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\nFAIL: ${failed} problem(s) in Project updates` : "\nPASS: Project updates dates, merges, sorts by release and stays editable");
process.exit(failed ? 1 : 0);
