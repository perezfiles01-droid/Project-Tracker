#!/usr/bin/env node
/**
 * Guard: the sidebar and the Projects page list the same projects.
 *
 * They did not. The nav read state.data.projects — data/tracker.json, which
 * is a build artefact served read-only and holds two projects — while every
 * project you add lives in localStorage and is assembled by
 * TrackerLinks.groups(), which only the Projects page called. Seven on the
 * page, two in the sidebar, and a project renamed or deleted still listed
 * here under its old name.
 *
 * The counts are compared rather than either being hardcoded, so the check
 * holds whatever the workbook ships with.
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
const url = "file://" + join(root, "Tracker-standalone.html");

/** Add `n` projects the way the app does — in this browser, not in the JSON. */
async function seed(n) {
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate((count) => {
    localStorage.clear();
    const added = [];
    for (let i = 1; i <= count; i++) added.push({ key: "seeded-" + i, name: "Seeded " + i });
    localStorage.setItem("tracker.projects",
      JSON.stringify({ added, renamed: {}, hidden: [], desc: {} }));
  }, n);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector(".ptile");
}

/**
 * Every project the sidebar offers, read by walking the nav from its
 * "Projects" heading to the next heading — the way a reader sees the group,
 * and not through the class the scrolling box happens to use, so this
 * reports the real count against any version of the markup.
 */
const navNames = () => page.evaluate(() => {
  const out = [];
  let inGroup = false;
  const walk = (el) => {
    for (const node of el.children) {
      if (node.classList.contains("nav-title")) {
        inGroup = node.textContent.trim().toLowerCase() === "projects";
        continue;
      }
      if (node.tagName === "BUTTON") { if (inGroup) out.push(node.querySelector("span").textContent.trim()); }
      else walk(node);   // the scrolling box wraps its buttons
    }
  };
  walk(document.querySelector("#nav"));
  return out;
});
/** Every project the page knows about, read from the app rather than the DOM,
 *  because the tiles page and only ever show six at a time. */
const pageNames = () => page.evaluate(() => window.TrackerLinks.groups().map((g) => g.name));

await seed(5);
const nav = await navNames(), all = await pageNames();
ok("the sidebar lists every project, not only the workbook's",
   nav.length === all.length, `sidebar ${nav.length}, page ${all.length}`);
ok("they are the same projects, in the same order",
   JSON.stringify(nav) === JSON.stringify(all), `${nav.join(" · ")} vs ${all.join(" · ")}`);

/* --- three at a time, the rest behind a scroll --- */
const box = await page.evaluate(() => {
  const n = document.querySelector(".navscroll");
  const b = n && n.querySelector("button");
  if (!n || !b) return null;
  const row = b.getBoundingClientRect().height + 2;   // + the nav's gap
  return { rows: n.clientHeight / row, scrolls: n.scrollHeight > n.clientHeight + 2,
           overflow: getComputedStyle(n).overflowY };
});
ok("the project list has its own scrolling box", box !== null);
if (box) {
  ok("about three projects are visible at a time",
     box.rows > 2.7 && box.rows < 3.3, box.rows.toFixed(2) + " rows");
  ok("the rest are reached by scrolling", box.scrolls && box.overflow === "auto",
     `${box.overflow}, scrolls: ${box.scrolls}`);
}
const bar = await page.evaluate(() => {
  const n = document.querySelector(".navscroll");
  return { width: getComputedStyle(n).scrollbarWidth,
           color: getComputedStyle(n).scrollbarColor };
});
ok("the scrollbar is a thin, quiet one", bar.width === "thin", JSON.stringify(bar));

/* --- and a project past the third one actually opens --- */
const last = (await navNames()).length - 1;
await page.locator(".navscroll button").nth(last).click();
await page.waitForTimeout(450);
ok("a project reached by scrolling opens",
   (await page.locator(".opened").count()) > 0);
ok("its tile is on screen with it",
   (await page.locator(".ptile.picked").count()) === 1,
   (await page.locator(".ptile.picked .t").textContent().catch(() => "")).trim());

/* --- and a project deleted on the page leaves the sidebar too --- */
const before = (await navNames()).length;
await page.click('#nav button[data-route="overview"]');
await page.waitForSelector(".ptile");
await page.click('[data-projectaction="delete"]');
await page.waitForSelector("#fd_project");
await page.selectOption("#fd_project", "Seeded 1");
await page.click('#formDialog [data-fd="save"]');
await page.waitForSelector('#formDialog [data-fd="choice"]');
await page.click('#formDialog [data-fd="choice"]');
await page.waitForTimeout(450);
const after = await navNames();
ok("a deleted project leaves the sidebar as well as the page",
   after.length === before - 1 && !after.includes("Seeded 1"),
   `${before} → ${after.length}`);

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} sidebar check(s) failed`
                   : "\nPASS: the sidebar and the Projects page agree");
process.exit(failed ? 1 : 0);
