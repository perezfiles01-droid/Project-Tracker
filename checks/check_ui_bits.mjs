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

/* --- Actions are icons, and still have names --- */
const textActions = await page.evaluate(() => [...document.querySelectorAll("button")]
  .map((b) => b.textContent.trim())
  .filter((t) => ["Edit", "Remove", "Delete", "Rename", "Add link", "Add project",
                  "Add artifact", "Add milestone", "New table", "Mark done"].includes(t)));
ok("no action button spells out its label", textActions.length === 0, textActions.join(", "));
const unnamed = await page.evaluate(() => [...document.querySelectorAll("button.icon")]
  .filter((b) => !(b.getAttribute("aria-label") || "").trim()).length);
const icons = await page.locator("button.icon").count();
ok("icon buttons exist", icons > 0, String(icons));
ok("every icon button has an accessible name", unnamed === 0, `${unnamed} without one`);

/* --- Project tiles: independent, no subtext, add / rename / delete --- */
await page.click('#nav button[data-route="overview"]');
await page.waitForSelector(".ptile");
const before = await page.locator(".ptile").count();
ok("projects render as independent tiles", before >= 2, String(before));
ok("the tile subtext is gone",
   !(await page.locator(".ptiles").textContent()).includes("without a description"));
const cols = await page.evaluate(() =>
  getComputedStyle(document.querySelector(".ptiles")).gridTemplateColumns.split(" ").length);
ok("tiles are three across", cols === 3, String(cols));

await page.click("[data-newproject]");
await page.waitForSelector("#formDialog .box");
await page.fill("#fd_name", "A project I added");
await page.click('[data-fd="save"]');
await page.waitForTimeout(300);
ok("a new project appears", (await page.locator(".ptile").count()) === before + 1);
await page.reload({ waitUntil: "load" });
await page.waitForSelector(".ptile");
ok("the new project survives a reload",
   (await page.locator(".ptiles").textContent()).includes("A project I added"));

const tile = page.locator(".ptile").filter({ hasText: "A project I added" }).first();
await tile.locator('[data-edit^="project:"]').click();
await page.waitForSelector("#formDialog .box");
await page.fill("#fd_name", "Renamed project");
await page.click('[data-fd="save"]');
await page.waitForTimeout(300);
await page.reload({ waitUntil: "load" });
await page.waitForSelector(".ptile");
ok("a renamed project keeps its new name",
   (await page.locator(".ptiles").textContent()).includes("Renamed project"));

const renamed = page.locator(".ptile").filter({ hasText: "Renamed project" }).first();
await renamed.locator('[data-remove^="project:"]').click();
await page.waitForSelector("#formDialog .box");
await page.click('#formDialog [data-fd="choice"]');
await page.waitForTimeout(300);
ok("a deleted project goes",
   !(await page.locator(".ptiles").textContent()).includes("Renamed project"));

/* --- Email Access filter lives in its column; heading renamed; spacing --- */
// EDRMS ADB on purpose: GLASS's links carry no email addresses at all, so a
// filter correctly does not render there and testing it would fail on
// behaviour that is right.
await page.locator(".ptile").filter({ hasText: "EDRMS ADB" }).first()
  .locator("[data-pick]").click();
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
