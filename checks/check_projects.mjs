#!/usr/bin/env node
/**
 * Guard for the project Artifacts and Timeline sections.
 *
 * Both are authored data: add, edit and delete must survive a reload, and the
 * project roll-up must agree with the milestones it summarises — a headline
 * percentage that disagrees with its rows is worse than none, because it looks
 * authoritative.
 *
 * Projects are read from the live sidebar, so a project added later is covered.
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
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const url = "file://" + join(root, "Tracker-standalone.html");
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(400);

const projects = await page.$$eval('#nav button[data-route^="p:"]',
  (bs) => bs.map((b) => ({ route: b.dataset.route, label: b.innerText.trim().split("\n")[0] })));
ok("projects were discovered from the live nav", projects.length > 0,
   projects.map((p) => p.label).join(", "));

for (const { route, label } of projects) {
  await page.click(`#nav button[data-route="${route}"]`);
  await page.waitForTimeout(400);
  const heads = await page.$$eval("section.linksection h3.sec", (hs) => hs.map((h) => h.innerText.trim()));
  ok(`"${label}" shows an Artifacts section`, heads.some((h) => /^ARTIFACTS/i.test(h)), heads.join(" | "));
  ok(`"${label}" shows a Timeline section`, heads.some((h) => /^TIMELINE/i.test(h)), heads.join(" | "));
}

// --- add / edit / delete round-trip, on the first project --------------------
await page.click(`#nav button[data-route="${projects[0].route}"]`);
await page.waitForTimeout(300);

const artCount = () => page.locator('[data-remove^="art:"]').count();
const before = await artCount();
await page.click('[data-edit^="art:"][data-edit$="|new"]');
await page.waitForTimeout(300);
await page.fill("#fd_name", "Guard artifact");
await page.fill("#fd_owner", "Jim");
await page.click("#formDialog .actions button.primary");
await page.waitForTimeout(400);
ok("an artifact can be added", (await artCount()) === before + 1, `${before} → ${await artCount()}`);

await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click(`#nav button[data-route="${projects[0].route}"]`);
await page.waitForTimeout(400);
ok("the added artifact survives a reload",
   (await page.locator("text=Guard artifact").count()) > 0);

// edit it
const mine = page.locator('tr:has-text("Guard artifact") [data-edit^="art:"]').first();
await mine.click();
await page.waitForTimeout(300);
await page.fill("#fd_name", "Guard artifact renamed");
await page.click("#formDialog .actions button.primary");
await page.waitForTimeout(400);
ok("an artifact can be renamed",
   (await page.locator("text=Guard artifact renamed").count()) > 0);

// delete it
await page.locator('tr:has-text("Guard artifact renamed") [data-remove^="art:"]').first().click();
await page.waitForTimeout(400);
ok("an artifact can be deleted",
   (await page.locator("text=Guard artifact renamed").count()) === 0);

// --- the roll-up must agree with its milestones -----------------------------
// Assert this on a project that actually HAS milestones, found at runtime:
// not every project's workbook section carries phases.
const withMilestones = await page.evaluate((routes) => {
  for (const r of routes) {
    const id = r.replace(/^p:/, "");
    if (window.TrackerProjects.timelineOf(id).length) return r;
  }
  return null;
}, projects.map((p) => p.route));
ok("a project with milestones was found to test the roll-up", !!withMilestones, String(withMilestones));
if (withMilestones) {
  await page.click(`#nav button[data-route="${withMilestones}"]`);
  await page.waitForTimeout(400);
}

const agree = await page.evaluate(() => {
  const id = location.hash.slice(1).replace(/^p:/, "");
  const rows = window.TrackerProjects.timelineOf(id);
  const shown = window.TrackerProjects.rollup(id);
  if (!rows.length) return { skip: true };
  const mean = Math.round(rows.reduce((n, r) => n + (Number(r.progress) || 0), 0) / rows.length);
  return { shown, mean, ok: shown === mean, n: rows.length };
});
if (agree.skip) ok("roll-up check had milestones to work with", false, "no milestones seeded");
else ok("the project roll-up equals the mean of its milestones", agree.ok,
        `shown ${agree.shown}, mean of ${agree.n} milestones ${agree.mean}`);

// A roll-up of 0 against milestones that are all 0 would pass even if the
// figure were hardcoded. Move real values and assert it follows.
const moved = await page.evaluate(() => {
  const id = location.hash.slice(1).replace(/^p:/, "");
  const key = "tracker.timeline";
  const all = JSON.parse(localStorage.getItem(key) || "[]");
  const mine = all.filter((r) => r.project === id);
  mine.forEach((r, i) => { r.progress = i < 2 ? 100 : (i < 4 ? 50 : 0); });
  localStorage.setItem(key, JSON.stringify(all));
  const expect = Math.round(mine.reduce((n, r) => n + r.progress, 0) / mine.length);
  return { expect, n: mine.length };
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click(`#nav button[data-route="${withMilestones}"]`);
await page.waitForTimeout(400);
const followed = await page.evaluate(() =>
  window.TrackerProjects.rollup(location.hash.slice(1).replace(/^p:/, "")));
ok("the roll-up follows real, differing milestone values",
   followed === moved.expect && followed > 0,
   `shown ${followed}, expected ${moved.expect} across ${moved.n} milestones`);

// And it must be visible on the page, not merely computed.
const shownText = await page.locator(".rollup").first().innerText();
ok("the roll-up is rendered on the page", shownText.includes(String(followed)), shownText.trim());

// --- a progress value outside 0-100 must not corrupt the roll-up ------------
await page.click('[data-edit^="tl:"][data-edit$="|new"]');
await page.waitForTimeout(300);
await page.fill("#fd_name", "Guard milestone");
await page.fill("#fd_progress", "5000");
await page.click("#formDialog .actions button.primary");
await page.waitForTimeout(400);
const clamped = await page.evaluate(() => {
  const id = location.hash.slice(1).replace(/^p:/, "");
  const r = window.TrackerProjects.timelineOf(id).find((x) => x.name === "Guard milestone");
  return r ? r.progress : null;
});
ok("a progress percentage is clamped to 0-100", clamped === 100, `stored ${clamped}`);

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} project check(s) failed` : "\nPASS: artifacts and timeline behave");
process.exit(failed ? 1 : 0);
