#!/usr/bin/env node
/**
 * Guard for Project updates (asked for 18 Nov 2026).
 *
 * The rules this protects were stated outright, and each fails silently:
 *   - a day belongs to the date things happened, not the date of import
 *   - a late import of an older day must not overwrite a newer status
 *   - a second import for the same day merges, keeping ticks
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
ok("open action items from every day are gathered at the top", (await page.locator(".pu-open > div:first-child .pu-item").count()) === 2);
ok("open questions are gathered too", (await page.locator(".pu-open > div:last-child .pu-item").count()) === 1);

/* --- releases --- */
const chips = await page.$$eval(".pu-chips .chip", (c) => c.map((x) => x.innerText.replace(/\s+\d+$/, "").trim()));
ok("ADB has a chip for every release, in order, then Hotfix and General",
   chips.join("|") === "All|R2026.1 Multiple Records|R2026.2 Centralized|R2026.3 Email Records|R2026.3.1 Email Records Enhancement|R2026.4 Utilization Report|Hotfix|General",
   chips.join("|"));
await page.click('[data-pu-rel="R2026.4 Utilization Report"]');
ok("a release chip narrows the timeline and the open items to that release",
   (await page.$$eval(".pu-date", (d) => d.length)) === 1 && (await page.locator(".pu-open > div:first-child .pu-item").count()) === 1);
await page.click('[data-pu-rel="All"]');

/* --- tick carries everywhere --- */
await page.locator(".pu-open .pu-item", { hasText: "Draft the KPI list." }).locator("input").click();
await page.waitForTimeout(100);
ok("ticking an item done removes it from Still open", (await page.locator(".pu-open > div:first-child .pu-item").count()) === 1);
await page.locator('.pu-day:has-text("Tue 10 Nov") summary:has-text("Action items")').click();
ok("and it shows done on its own day", await page.locator('.pu-day:has-text("Tue 10 Nov") .pu-det input:checked').count() === 1);

/* --- same day again: merges, keeps ticks; an older day does not replace a newer status --- */
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
ok("newer paragraphs replace, lists combine without duplicates",
   tenth.blocks[0].summary.join() === "Rewritten paragraph for the 10th." && tenth.blocks[0].decisions.length === 2 && tenth.blocks[0].actions.length === 1);
ok("a ticked item stays ticked after the merge", tenth.blocks[0].actions[0].done === true);
ok("an older day imported late does not overwrite the newer status", d.status.adb.text === "Status as of the 12th.");

/* --- where things stand is editable --- */
await page.click('[data-pu="editstatus"]');
await page.fill('[data-pu-f="text"]', "Edited status by hand.");
await page.click('[data-pu="savestatus"]');
ok("the status paragraph can be edited", (await page.locator(".pu-stp").innerText()) === "Edited status by hand.");
await page.locator(".pu-open .pu-item").first().hover();
await page.locator(".pu-open .pu-item").first().locator("[data-pu-ied]").click();
await page.fill('.faq-modal [data-k="text"]', "Send the final label list to Maria");
await page.fill('.faq-modal [data-k="due"]', "2026-11-21");
await page.click('.faq-modal [data-v="save"]');
await page.waitForTimeout(100);
const firstOpen = await page.locator(".pu-open .pu-item").first().innerText();
ok("an open item can be reworded and given a date",
   (await page.locator(".pu-open .pu-item").first().innerText()).includes("Send the final label list to Maria") &&
   (await page.locator(".pu-open .pu-item").first().innerText()).includes("21 Nov"), firstOpen.replace(/\s+/g, " "));
await page.locator(".pu-open > div:last-child .pu-item").first().hover();
await page.locator(".pu-open > div:last-child [data-pu-idel]").first().click();
await page.click('#formDialog [data-value="confirm"]');
await page.waitForTimeout(100);
ok("an open question can be deleted, after confirming", (await page.locator(".pu-open > div:last-child .pu-item").count()) === 0);

/* --- edit a day, including moving it to another date --- */
await page.click('.pu-day:has-text("Thu 12 Nov") [data-pu="edit"]');
await page.fill('[data-pu-f="date"]', "2026-11-11");
await page.fill('[data-pu-f="dec:0"]', "Seven years for correspondence.");
await page.click('[data-pu="saveday"]');
await page.waitForTimeout(100);
d = await data();
const moved = d.entries.find((e) => e.date === "2026-11-11");
ok("editing can move a day to the date it really happened", !!moved && !d.entries.some((e) => e.date === "2026-11-12"));
ok("and edits its lists", moved && moved.blocks[0].decisions[0] === "Seven years for correspondence.");

/* --- search, copy, export, delete --- */
await page.fill('#view [data-search="updates"]', "monthly kpi figures");
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
