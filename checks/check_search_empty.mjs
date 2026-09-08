#!/usr/bin/env node
/**
 * Guard: a search shows results, not a list of things that did not match.
 *
 * Searching "uat" in a project's artifacts printed MAIN (0) with "Nothing in
 * this table yet" above the two tables that actually matched. The more tables
 * a project has, the more empty headings there are to scroll past to reach
 * the answer, which is the opposite of what a search is for.
 *
 * Four things fail quietly:
 *
 *   1. An empty section stays hidden WHILE SEARCHING.
 *   2. It comes BACK when the box is cleared - an empty table you own is a
 *      real thing you can add to, and hiding it always would leave no way to
 *      reach it.
 *   3. A search that matches nothing anywhere still says so, rather than
 *      leaving a blank page under the box.
 *   4. The sections that DO match are untouched, with their rows intact.
 *
 * Both pages that render sections are driven - the project page and the
 * artifact tables - because the fault belongs to the pattern, not to one of
 * them, and only one of the two was reported.
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
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(400);

/* Two tables in one project: one that will match, one that never will. */
await page.evaluate(() => {
  localStorage.setItem("tracker.projects", JSON.stringify({
    added: [{ id: "p-guard", name: "Guard Project" }], renamed: {}, hidden: [], desc: {},
  }));
  localStorage.setItem("tracker.linkTables", JSON.stringify([
    { id: "tb-1", project: "Guard Project", name: "Matching" },
    { id: "tb-2", project: "Guard Project", name: "Empty One" },
  ]));
  localStorage.setItem("tracker.userLinks", JSON.stringify([
    { id: "u-1", project: "Guard Project", table: "Matching",
      name: "UAT Internal", description: "Internal site for UAT", url: "https://example.com" },
  ]));
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(400);
await page.click('#nav button[data-route="overview"]');
await page.waitForTimeout(300);

/** Open the project so its tables render. A tile carries data-pick. */
const opened = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("[data-pick]")]
    .find((b) => /Guard Project/.test(b.textContent || ""));
  if (!btn) return false;
  btn.click();
  return true;
});
ok("the project tile was found and opened", opened);
await page.waitForTimeout(500);

const sections = () => page.$$eval(".linksection .sec", (e) => e.map((x) => x.textContent.trim()));
const emptyNotes = () => page.$$eval(".linksection .empty", (e) => e.map((x) => x.textContent.trim()));

const before = await sections();
ok("both tables show with the search empty", before.length >= 2, before.join(" | "));
ok("the empty one is visible when not searching",
   before.some((t) => /Empty One/.test(t)), before.join(" | "));

/* --- 1. searching hides the section with no results ---------------------- */
const box = page.locator('input[data-search^="artifacts:"]').first();
ok("the artifact search box is there", await box.count() === 1);
await box.fill("uat");
await page.waitForTimeout(400);
const during = await sections();
ok("the matching table is still shown", during.some((t) => /Matching/.test(t)), during.join(" | "));
ok("the table with no results is hidden", !during.some((t) => /Empty One/.test(t)),
   during.join(" | "));
ok("and no 'nothing in this table yet' is left behind",
   !(await emptyNotes()).some((t) => /Nothing in this table yet/i.test(t)),
   (await emptyNotes()).join(" | "));
ok("the matching rows are intact",
   (await page.locator(".linktable tbody tr").count()) === 1,
   String(await page.locator(".linktable tbody tr").count()));

/* --- 3. a search that matches nothing says so ---------------------------- */
await box.fill("zzzznothingmatchesthis");
await page.waitForTimeout(400);
ok("no section is shown", (await sections()).length === 0, (await sections()).join(" | "));
const all = await page.locator(".opened .empty").allInnerTexts();
ok("but the page says the search matched nothing",
   all.some((t) => /Nothing matches your search/i.test(t)), all.join(" | "));

/* --- 2. clearing the box brings the empty table back --------------------- */
await box.fill("");
await page.waitForTimeout(400);
const after = await sections();
ok("clearing the search restores the empty table",
   after.some((t) => /Empty One/.test(t)), after.join(" | "));
ok("an empty table you own still says it is empty",
   (await emptyNotes()).some((t) => /Nothing in this table yet/i.test(t)));

/* --- the project page follows the same rule ------------------------------ */
const projectRoute = await page.evaluate(() => {
  const p = (window.TrackerState.data.projects || [])[0];
  return p ? "p:" + p.id : null;
});
if (projectRoute) {
  await page.evaluate((r) => { location.hash = r; window.dispatchEvent(new HashChangeEvent("hashchange")); }, projectRoute);
  await page.waitForTimeout(400);
  const pbox = page.locator('input[data-search^="project:"]').first();
  // Only the sections BELOW the Reference search box are its to hide. The
  // Artifacts and Timeline headings above it belong to the project view and
  // are not filtered by that box, so counting every h3 on the page would
  // assert something the search never promised.
  const sectionTitles = await page.evaluate((r) => {
    const p = (window.TrackerState.data.projects || []).find((x) => "p:" + x.id === r);
    return (p ? p.sections : []).map((s) => s.title);
  }, projectRoute);
  const searchedHeads = () => page.$$eval("h3.sec", (e) => e.map((x) => x.textContent.trim()))
    .then((all) => all.filter((t) => sectionTitles.some((s) => t.startsWith(s))));
  const ownBefore = (await searchedHeads()).length;
  if (await pbox.count()) {
    await pbox.fill("zzzznothingmatchesthis");
    await page.waitForTimeout(400);
    const secsAfter = (await searchedHeads()).length;
    ok("a project page hides every section that matched nothing",
       secsAfter === 0 && ownBefore > 0, `${ownBefore} searchable before, ${secsAfter} after`);
    const msg = await page.locator(".empty").allInnerTexts();
    ok("and says the search matched nothing",
       msg.some((t) => /Nothing matches your search/i.test(t)), msg.join(" | "));
    await pbox.fill("");
    await page.waitForTimeout(300);
    ok("clearing it brings every section back",
       (await searchedHeads()).length === ownBefore,
       `${ownBefore} expected`);
  } else {
    ok("the project page has a search box", false, "not found");
  }
} else {
  ok("a workbook project was available to check", false, "none in tracker.json");
}

ok("no page errors along the way", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${failed} search check(s) failed`);
process.exit(failed ? 1 : 0);
