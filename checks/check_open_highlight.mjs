#!/usr/bin/env node
/**
 * Guard: the open task looks open, and the artifact tables share one search.
 *
 * The highlight existed before this and could not be seen: tr.taskrow.open was
 * var(--panel-2), and the .tasklist panel behind it is var(--panel-2) too. A
 * rule that paints a thing the colour of its own background is not a missing
 * feature, it is an invisible one - so this compares the two RENDERED colours
 * rather than asserting a class is present. A future palette change that makes
 * them collide again fails here.
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);

/* --- the open row is visibly different from the rows around it ------------ */
await page.evaluate(() => localStorage.setItem("tracker.tasks", JSON.stringify([
  { id: "t-1", name: "First", project: "GLASS", status: "To do", attachments: [] },
  { id: "t-2", name: "Second", project: "GLASS", status: "To do", attachments: [] },
])));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(300);
await page.locator("tr.taskrow").first().click();
await page.waitForTimeout(300);

const shades = await page.evaluate(() => {
  const open = document.querySelector("tr.taskrow.open td");
  const other = document.querySelector("tr.taskrow:not(.open) td");
  const panel = document.querySelector(".tasklist");
  const paint = (el) => el ? getComputedStyle(el).backgroundColor : "none";
  return { open: paint(open), other: paint(other), panel: paint(panel),
           bar: open ? getComputedStyle(open).boxShadow : "none" };
});
ok("a row is marked open at all", (await page.locator("tr.taskrow.open").count()) === 1);
ok("the open row is not painted the colour of the panel behind it",
   shades.open !== shades.panel, JSON.stringify(shades));
ok("and not the colour of the rows that are not open",
   shades.open !== shades.other, JSON.stringify(shades));
ok("the open row is actually painted, not left transparent",
   !/^rgba\(0, 0, 0, 0\)$/.test(shades.open), shades.open);
// Colour alone is not an answer on every screen.
ok("the open row carries a marker besides its colour",
   shades.bar && shades.bar !== "none", shades.bar);

/* --- clicking the other row moves the highlight --------------------------- */
await page.locator("tr.taskrow").nth(1).click();
await page.waitForTimeout(300);
const moved = await page.$$eval("tr.taskrow", (r) => r.map((x) => x.classList.contains("open")));
ok("clicking another task moves the highlight to it",
   JSON.stringify(moved) === JSON.stringify([false, true]), JSON.stringify(moved));

/* --- one search for the whole Table of Artifacts -------------------------- */
await page.click('#nav button[data-route="overview"]');
await page.waitForTimeout(400);
const pick = page.locator("[data-pick]").first();
if (await pick.count()) { await pick.click(); await page.waitForTimeout(500); }

const perTable = await page.locator("section.linksection [data-search]").count();
ok("no table carries a search box of its own", perTable === 0, String(perTable));
const shared = await page.locator(".artifactsearch [data-search]").count();
if (await page.locator(".opened").count()) {
  ok("there is exactly one search for all of them", shared === 1, String(shared));
  // Under the heading, not beside it: the arrow in the report pointed here.
  const geom = await page.evaluate(() => {
    const h = document.querySelector(".opened h2.page.sub");
    const s = document.querySelector(".artifactsearch [data-search]");
    const tables = document.querySelector("section.linksection");
    if (!h || !s) return null;
    const hb = h.getBoundingClientRect(), sb = s.getBoundingClientRect();
    const tb = tables ? tables.getBoundingClientRect() : null;
    return { headBottom: Math.round(hb.bottom), searchTop: Math.round(sb.top),
             searchLeft: Math.round(sb.left), headLeft: Math.round(hb.left),
             firstTableTop: tb ? Math.round(tb.top) : null };
  });
  ok("the search sits under the Table of Artifacts heading",
     geom && geom.searchTop >= geom.headBottom - 2, JSON.stringify(geom));
  ok("and above the tables it filters",
     geom && (geom.firstTableTop === null || geom.searchTop <= geom.firstTableTop),
     JSON.stringify(geom));
  ok("it lines up on the left, like every other search",
     geom && Math.abs(geom.searchLeft - geom.headLeft) < 40, JSON.stringify(geom));
} else {
  ok("a project with tables was opened to check the search", false,
     "no .opened section; the fixture has no project with tables");
}

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} highlight/search check(s) failed`
                   : "\nPASS: the open task is visible, and the artifacts share one search");
process.exit(failed ? 1 : 0);
