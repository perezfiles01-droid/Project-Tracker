#!/usr/bin/env node
/**
 * Guard for per-page search.
 *
 * The single search box in the header used to feed every view through
 * state.query. Removing it is not just deleting an input: any page that
 * relied on it loses search silently, with nothing on screen to show that
 * a capability went missing.
 *
 * Routes are enumerated from the rendered sidebar at runtime, so a page
 * added later is covered without being listed here.
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

// Seed one task so the To Do List renders its list rather than an empty state.
await page.evaluate(() => localStorage.setItem("tracker.tasks", JSON.stringify(
  [{ id: "t-guard", no: "1", description: "Guard task", attachments: [], status: "To do" }])));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(400);

ok("the global header search is gone", (await page.locator("#q").count()) === 0);

const routes = await page.$$eval("#nav button[data-route]", (bs) =>
  bs.map((b) => ({ route: b.dataset.route, label: b.innerText.trim().split("\n")[0] })));
ok("routes were discovered from the live nav", routes.length > 0, `${routes.length} routes`);

for (const { route, label } of routes) {
  await page.click(`#nav button[data-route="${route}"]`);
  await page.waitForTimeout(250);
  const boxes = await page.locator("#view [data-search]").count();
  ok(`"${label}" offers a search control`, boxes > 0, boxes === 0 ? "none rendered" : "");
}

// The search must actually filter, not merely exist.
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
const before = await page.locator("tr.taskrow").count();
await page.fill('#view [data-search]', "zzz-no-such-task");
await page.waitForTimeout(300);
const after = await page.locator("tr.taskrow").count();
ok("a page search actually filters its list", before > 0 && after < before, `${before} → ${after}`);

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} search check(s) failed` : "\nPASS: every page owns a working search");
process.exit(failed ? 1 : 0);
