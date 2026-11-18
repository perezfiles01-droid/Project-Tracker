#!/usr/bin/env node
/**
 * Guard for the FAQ (asked for 18 Nov 2026).
 *
 * The loop it protects: download the template, Claude answers in the one
 * shape the template fixes, import that answer (file or paste) into a
 * project, find it again by meaning, edit it, delete it.
 *
 * The failures worth catching are all quiet ones: a template whose own
 * example no longer imports, an answer filed under the wrong project, a
 * search that only finds exact words, a duplicate silently doubled, or a
 * delete with no confirmation.
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
const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(400);

/* --- sidebar: FAQ under Index after Image editor; no counts on the three --- */
const nav = await page.$$eval("#nav > *", (els) => els.map((e) => e.dataset.route || "#" + e.textContent.trim()));
ok("FAQ sits in the Index group after Image editor", nav.indexOf("faq") === nav.indexOf("editor") + 1 && nav.indexOf("faq") < nav.indexOf("#Projects"),
   nav.slice(0, 5).join(", "));
const counts = await page.$$eval('#nav [data-route="overview"] .count, #nav [data-route="editor"] .count, #nav [data-route="faq"] .count', (x) => x.length);
ok("Overview, Image editor and FAQ show no number", counts === 0, String(counts));

await page.click('#nav button[data-route="faq"]');
await page.waitForTimeout(200);

/* --- step 1: just the two projects and the template --- */
const cards = await page.$$eval(".faq-card", (cs) => cs.map((c) => c.innerText.trim()));
ok("the first screen shows exactly the two project cards", cards.join("|") === "ADB EDRMS|GRA GLASS", cards.join("|"));
ok("the button reads Download template", (await page.locator('[data-faq="template"]').innerText()).includes("Download template"));
const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-faq="template"]')]);
const tplPath = await dl.path();
const tpl = readFileSync(tplPath, "utf8");
ok("the template downloads as FAQ-template.md", dl.suggestedFilename() === "FAQ-template.md");
ok("the template fixes the format, fields, allowed categories and a checklist",
   tpl.includes('"format": "tracker-faq"') && /title.*category.*summary.*keywords.*sections/s.test(tpl) &&
   tpl.includes("SharePoint, Power BI, PowerShell, AvePoint, Microsoft 365, General") && tpl.includes("Check before you send"));
// The template's own example must import: if it does not, Claude copying it cannot either.
const blocks = [...tpl.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
const example = blocks[blocks.length - 1];
const parsed = await page.evaluate((t) => window.TrackerFAQ.parse(t), example);
ok("the template's own example imports cleanly",
   parsed.length === 1 && parsed[0].sections[0].steps.length === 6 && parsed[0].category === "SharePoint");

/* --- step 2: import by pasting, wrapped the way a chat reply wraps it --- */
await page.click('[data-faq-project="adb"]');
await page.waitForTimeout(150);
ok("choosing a project opens its list and reading pane", (await page.locator(".faq-split").count()) === 1 &&
   (await page.locator("h2.page").innerText()).includes("ADB EDRMS"));
await page.click('[data-faq="importmenu"]');
await page.click('[data-faq="importpaste"]');
await page.fill(".faq-paste", "Here you go:\n\n```json\n" + example + "```\nHope that helps!");
await page.click('.faq-modal [data-v="next"]');
await page.waitForTimeout(100);
ok("the preview names what will be added", (await page.locator(".faq-modal").innerText()).includes("How to change versioning (library level)"));
await page.click('.faq-modal [data-v="go"]');
await page.waitForTimeout(150);
const steps = await page.$$eval(".faq-steps li", (ls) => ls.map((l) => l.innerHTML));
ok("the answer shows its numbered steps", steps.length === 6, String(steps.length));
ok("on-screen names are bold", steps[2].includes("<b>Versioning settings</b>") && !steps[0].includes("<b>"));
ok("the heading and short explanation are shown",
   (await page.locator(".faq-sec h3").innerText()) === "How to change it (library level)" && (await page.locator(".faq-sum").count()) === 1);
ok("the list shows the title only, with no step count or date",
   (await page.locator(".faq-row").first().innerText()).trim() === "How to change versioning (library level)");

/* --- a batch, imported as a file; one of them is already there --- */
const batch = {
  format: "tracker-faq", version: 1, questions: [
    JSON.parse(example).questions[0],
    { title: "How to restore a deleted file", category: "SharePoint", summary: "Get back something deleted in the last 93 days.",
      keywords: ["recycle bin", "undelete"], sections: [{ heading: "From the recycle bin", steps: ["1. Open the site.", "Click **Recycle bin**.", "Select the file, then **Restore**."] }] },
    { title: "How to refresh a dataset", category: "power bi", summary: "", keywords: ["update data"],
      sections: [{ heading: "", steps: ["Open the workspace.", "Click **Refresh now**."] }] },
  ],
};
const dir = mkdtempSync(join(tmpdir(), "faq-"));
const file = join(dir, "answer.faq.json");
writeFileSync(file, JSON.stringify(batch));
await page.click('[data-faq="importmenu"]');
const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-faq="importfile"]')]);
await chooser.setFiles(file);
await page.waitForTimeout(250);
ok("a file with several questions previews them all", (await page.locator(".faq-pr").count()) === 3);
ok("the duplicate is flagged and offers Replace, Keep both, Skip",
   (await page.locator(".faq-pr select option").allInnerTexts()).join("|") === "Replace|Keep both|Skip");
await page.selectOption(".faq-pr select", "both");
await page.click('.faq-modal [data-v="go"]');
await page.waitForTimeout(150);
const adb = () => page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("tracker.faq")))).filter((q) => q.project === "adb"));
let list = await adb();
ok("Keep both keeps both copies", list.filter((q) => q.title.startsWith("How to change versioning")).length === 2, String(list.length));
ok("a step number the model added anyway is dropped", list.find((q) => q.title.startsWith("How to restore")).sections[0].steps[0] === "Open the site.");
ok("a category in the wrong case is corrected", list.find((q) => q.title.startsWith("How to refresh")).category === "Power BI");
await page.click('[data-faq-cat="Power BI"]');
ok("a category chip narrows the list to that category", (await page.$$eval(".faq-row", (r) => r.length)) === 1);
await page.click('[data-faq-cat="All"]');
ok("the list is grouped by category", (await page.$$eval(".faq-group", (g) => g.map((x) => x.innerText.trim().toLowerCase()))).join("|") === "sharepoint|power bi");

// Replace: import the example once more and replace.
await page.click('[data-faq="importmenu"]');
await page.click('[data-faq="importpaste"]');
await page.fill(".faq-paste", example);
await page.click('.faq-modal [data-v="next"]');
await page.click('.faq-modal [data-v="go"]');
await page.waitForTimeout(150);
ok("Replace (the default) does not add another copy", (await adb()).length === 4, String((await adb()).length));

/* --- search by meaning --- */
const searchFor = async (q) => {
  await page.fill('#view [data-search="faq"]', q);
  await page.waitForTimeout(150);
  return page.$$eval(".faq-row", (rs) => rs.map((r) => r.innerText.trim()));
};
let r = await searchFor("turn on drafts in a library");
ok("\"turn on drafts in a library\" finds the versioning answer first", r[0] && r[0].startsWith("How to change versioning"), r.join(" / "));
r = await searchFor("recover removed document");
ok("\"recover removed document\" finds the restore answer first", r[0] && r[0].startsWith("How to restore a deleted file"), r.join(" / "));
ok("matching words are highlighted", (await page.locator(".faq-row mark").count()) > 0);

// The AI fallback: only offered when nothing matches well; sent titles, never steps.
r = await searchFor("quarterly budget forecast");
ok("with no close match, Ask AI to find it is offered", (await page.locator('[data-faq="ai"]').count()) === 1);
const sent = await page.evaluate(() => {
  window.__sent = null;
  window.TrackerAI.match = async (t) => { window.__sent = t; return "4"; };
  return true;
});
await page.click('[data-faq="ai"]');
await page.waitForTimeout(200);
const sentText = await page.evaluate(() => window.__sent);
ok("the AI is sent the question and the titles", sentText.includes("quarterly budget forecast") && sentText.includes("How to refresh a dataset"));
ok("but never the steps", !sentText.includes("Refresh now") && !sentText.includes("Versioning settings"));
ok("the AI's pick is shown and labelled", (await page.locator(".faq-row .faq-aitag").count()) === 1);
await searchFor("");

/* --- full edit --- */
await page.click('.faq-row:has-text("How to refresh a dataset")');
await page.click('[data-faq="edit"]');
await page.fill('[data-faq-f="title"]', "How to refresh a Power BI dataset");
await page.click('[data-faq="addstep"]');
await page.fill('[data-faq-f="s:0:2"]', "Wait for the **Refreshed** time to change.");
await page.click('[data-faq="up"][data-i="0:2"]');
await page.click('[data-faq="save"]');
await page.waitForTimeout(100);
let edited = (await adb()).find((q) => q.title === "How to refresh a Power BI dataset");
ok("edits to the title and steps are saved, in the new order",
   edited && edited.sections[0].steps.join("|") === "Open the workspace.|Wait for the **Refreshed** time to change.|Click **Refresh now**.",
   edited && edited.sections[0].steps.join("|"));

/* --- delete asks first --- */
await page.click('[data-faq="delete"]');
await page.waitForTimeout(100);
ok("Delete asks for confirmation", await page.getByRole("button", { name: "Delete question" }).isVisible());
await page.getByRole("button", { name: "Cancel" }).click();
ok("Cancel keeps the question", (await adb()).length === 4);
await page.click('[data-faq="delete"]');
await page.getByRole("button", { name: "Delete question" }).click();
await page.waitForTimeout(100);
ok("confirming deletes it", (await adb()).length === 3);

/* --- projects stay apart; data is in the backup --- */
await page.click('[data-faq="back"]');
await page.click('[data-faq-project="gra"]');
ok("GRA GLASS has none of ADB's answers", (await page.locator(".faq-row").count()) === 0);
await page.click('[data-faq="back"]');
await page.fill('#view [data-search="faq"]', "restore deleted");
await page.waitForTimeout(150);
ok("searching from the project cards looks in both projects and names the project",
   (await page.locator(".faq-all .faq-row").first().innerText()).includes("ADB EDRMS"));
ok("answers are part of the backup", await page.evaluate(() => window.TrackerStore.KEYS.data.includes("tracker.faq")));

if (process.env.SHOT) {
  await page.fill('#view [data-search="faq"]', "");
  await page.click('[data-faq-project="adb"]');
  await page.click('.faq-row:has-text("How to change versioning")');
  await page.waitForTimeout(150);
  await page.screenshot({ path: process.env.SHOT });
}

ok("no page or console errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\nFAIL: ${failed} problem(s) in the FAQ` : "\nPASS: the FAQ imports, finds, edits and deletes answers per project");
process.exit(failed ? 1 : 0);
