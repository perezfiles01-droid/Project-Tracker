#!/usr/bin/env node
/**
 * The visible contract of this round: no Export JSON, a Backup button in the
 * right place, icon actions that still carry a name, project tiles you can
 * add/rename/delete, the account filter inside its own column, the renamed
 * heading, and real space between a search box and its table.
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
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(400);

/* --- Export JSON is gone; Backup sits between Google Drive and Settings --- */
ok("no Export JSON button", (await page.locator("#exportBtn").count()) === 0);
ok("no \"Export JSON\" text", !(await page.locator("body").textContent()).includes("Export JSON"));
const foot = await page.$$eval(".side-foot button", (bs) => bs.map((b) => b.textContent.trim()));
ok("Backup sits between Google Drive and Settings",
   foot.indexOf("Backup") === foot.indexOf("Google Drive") + 1 &&
   foot.indexOf("Settings") === foot.indexOf("Backup") + 1, foot.join(" · "));
ok("the title subtext is untouched",
   (await page.locator("#brandSub").textContent()).trim() === "BA master index");

/* --- Row actions are icons, and still have names --- */
// Page-level controls are deliberately text now ("Create Project",
// "Create Table", "Rename project", "Delete project"): they are the page's
// main actions and an icon made them guessable. The per-row actions inside a
// table stay icons, and every icon still has to carry a name.
await page.click('#nav button[data-route="overview"]');
await page.waitForSelector(".ptile");
await page.locator(".ptile").first().click();
await page.waitForSelector("section.linksection");
const textActions = await page.evaluate(() => [...document.querySelectorAll("tbody button")]
  .map((b) => b.textContent.trim())
  .filter((t) => ["Edit", "Remove", "Delete", "Rename", "Pin"].includes(t)));
ok("no row action spells out its label", textActions.length === 0, textActions.join(", "));
const unnamed = await page.evaluate(() => [...document.querySelectorAll("button.icon")]
  .filter((b) => !(b.getAttribute("aria-label") || "").trim()).length);
const icons = await page.locator("button.icon").count();
ok("icon buttons exist", icons > 0, String(icons));
ok("every icon button has an accessible name", unnamed === 0, `${unnamed} without one`);

/* --- Project tiles: independent, three across --- */
// Rename, delete and create are driven end to end by
// check_project_actions.mjs, which owns the picker flow.
await page.click('#nav button[data-route="overview"]');
await page.waitForSelector(".ptile");
const before = await page.locator(".ptile").count();
ok("projects render as independent tiles", before >= 2, String(before));
const cols = await page.evaluate(() =>
  getComputedStyle(document.querySelector(".ptiles")).gridTemplateColumns.split(" ").length);
ok("tiles are three across", cols === 3, String(cols));

/* --- Email Access filter lives in its column; heading renamed; spacing --- */
// EDRMS ADB on purpose: GLASS's links carry no email addresses at all, so a
// filter correctly does not render there and testing it would fail on
// behaviour that is right.
// The tile IS the open target now, so it is clicked directly.
await page.locator(".ptile").filter({ hasText: "EDRMS ADB" }).first().click();
await page.waitForSelector("table.linktable");
ok("the opened heading reads Table of Artifacts",
   (await page.locator("h2.page.sub").textContent()).trim() === "Table of Artifacts");
ok("no standalone account select above the table",
   (await page.locator(".sectiontools .accountpick").count()) === 0);
const inHeader = await page.locator("th.emailhead .accountpick").count();
ok("the account filter sits in the Email Access header", inHeader > 0, String(inHeader));
const offered = await page.locator("th.emailhead .accountpick option").allTextContents();
ok("the filter offers the accounts present, and an All option",
   offered.length > 1 && offered[0] === "All", offered.join(" · "));

const gap = await page.evaluate(() => {
  const s = document.querySelector("section.linksection");
  const box = s && s.querySelector(".search.sectionsearch");
  const tbl = s && s.querySelector(".tablewrap");
  if (!box || !tbl) return -1;
  return Math.round(tbl.getBoundingClientRect().top - box.getBoundingClientRect().bottom);
});
ok("there is real space between a search box and its table", gap >= 10, `${gap}px`);

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} UI check(s) failed` : "\nPASS: the visible contract holds");
process.exit(failed ? 1 : 0);
