#!/usr/bin/env node
/**
 * Guard for pinning a site to the top of its table.
 *
 * The case that matters is a row on a LATER page: a pin that only reordered
 * the rows already in front of you would be no use, so the lift has to happen
 * before paging, not after. That is asserted here by pinning a row that is
 * not on page one and then reading page one back.
 *
 * A pin is also per table by design, so the check asserts that pinning in one
 * table leaves a second table's order alone.
 *
 * Page size is read from the source, so the check follows the app.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "assets/links.js"), "utf8");
const m = src.match(/ROWS_PER_PAGE\s*=\s*(\d+)/);
if (!m) throw new Error("could not read ROWS_PER_PAGE from links.js — check has drifted from the app");
const PER_PAGE = Number(m[1]);

let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m2) => m2.type() === "error" && errors.push(m2.text()));
const url = "file://" + join(root, "Tracker-standalone.html");

await page.goto(url, { waitUntil: "load" });
await page.evaluate(() => localStorage.clear());
await page.goto(url, { waitUntil: "load" });
await page.waitForSelector(".ptile");

/** Open the first project whose first table pages, so a later page exists. */
const tiles = await page.locator(".ptile").count();
let opened = false, openedIndex = -1;
const openTile = async (i) => {
  await page.click('#nav button[data-route="overview"]');
  await page.waitForSelector(".ptile");
  await page.locator(".ptile").nth(i).click();
  await page.waitForTimeout(450);
};
for (let i = 0; i < tiles; i++) {
  await openTile(i);
  if (await page.locator("section.linksection").first().locator(".pager").count()) {
    opened = true; openedIndex = i; break;
  }
}
ok("a table long enough to page was found", opened, `${PER_PAGE} rows a page`);

const sec = () => page.locator("section.linksection").first();
const names = async () => sec().locator("tbody .sitename").allTextContents();
const other = () => page.locator("section.linksection").nth(1);

ok("every row offers a pin", (await sec().locator("tbody [data-pin]").count()) === PER_PAGE);
const otherBefore = (await other().count())
  ? await other().locator("tbody .sitename").allTextContents() : null;

// Go to page two and pin a row that page one has never shown.
const page1 = (await names()).map((s) => s.trim());
await sec().locator('[data-page$=":next"]').click();
await page.waitForTimeout(400);
const page2 = (await names()).map((s) => s.trim());
const target = page2[page2.length - 1];
ok("the pinned row starts off page one", target && !page1.includes(target), target);
await sec().locator("tbody [data-pin]").last().click();
await page.waitForTimeout(450);

const after = (await names()).map((s) => s.trim());
ok("a pinned row is first on page one", after[0] === target, `${after[0]} vs ${target}`);
ok("the pinned button says it is pinned",
   (await sec().locator("tbody [data-pin]").first().getAttribute("aria-pressed")) === "true");
ok("the pinned button is highlighted",
   ((await sec().locator("tbody [data-pin]").first().getAttribute("class")) || "").includes("pinned"));
const filled = await page.evaluate(() => {
  const b = document.querySelector("section.linksection tbody [data-pin].pinned svg");
  return b ? getComputedStyle(b).fill : "";
});
ok("the pinned icon is filled, not just outlined",
   filled && filled !== "none", filled);

ok("the rest of the table is still there",
   (await names()).length === PER_PAGE, String((await names()).length));

if (otherBefore) {
  const otherAfter = await other().locator("tbody .sitename").allTextContents();
  ok("a pin in one table leaves another table's order alone",
     JSON.stringify(otherBefore) === JSON.stringify(otherAfter));
}

// It has to survive a reload, which is what makes it a pin and not a sort.
// Which project is open is held in memory, not in the URL, so the reload
// lands back on the project list and the project is opened again by hand.
await page.reload({ waitUntil: "load" });
await page.waitForSelector(".ptile");
await openTile(openedIndex);
await page.waitForSelector("section.linksection tbody");
ok("the pin survives a reload", (await names())[0].trim() === target);

// And come off again.
await sec().locator("tbody [data-pin]").first().click();
await page.waitForTimeout(450);
ok("unpinning puts it back", (await names())[0].trim() !== target,
   (await names())[0].trim());

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} pin check(s) failed` : "\nPASS: a pinned site holds the top of its table");
process.exit(failed ? 1 : 0);
