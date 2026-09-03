#!/usr/bin/env node
/**
 * Guard for where a table's search sits.
 *
 * The section header is a flex row with space-between, so anything placed
 * in the tools group drifts to the far right, away from the table it
 * filters. This asserts by measured geometry, not by class name, so a
 * restyle that moves it back is caught.
 *
 * Sections are found at runtime, so a table added later is covered.
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
// Tables sit behind the project card's "Open tables" toggle; open the first
// project that has one, the same way a reader reaches them.
await page.click('#nav button[data-route="overview"]');
await page.waitForTimeout(400);
const pick = page.locator("[data-pick]").first();
if (await pick.count()) { await pick.click(); await page.waitForTimeout(500); }

const measured = await page.evaluate(() => {
  const out = [];
  for (const s of document.querySelectorAll("section.linksection")) {
    const input = s.querySelector("[data-search]");
    const head = s.querySelector(".sectionhead");
    if (!input || !head) continue;
    const i = input.getBoundingClientRect(), h = head.getBoundingClientRect();
    const title = s.querySelector("h3.sec");
    out.push({
      name: title ? title.textContent.trim().slice(0, 30) : "?",
      inputLeft: Math.round(i.left), headLeft: Math.round(h.left),
      headMid: Math.round(h.left + h.width / 2), headRight: Math.round(h.right),
    });
  }
  return out;
});

ok("table sections were found with a search box", measured.length > 0, `${measured.length} sections`);
for (const m of measured) {
  ok(`"${m.name}" search sits left of the section midpoint`,
     m.inputLeft < m.headMid, `input at ${m.inputLeft}, midpoint ${m.headMid}`);
  ok(`"${m.name}" search is in the left half, not the far right`,
     m.inputLeft < m.headLeft + (m.headRight - m.headLeft) * 0.5,
     `input at ${m.inputLeft} of ${m.headLeft}..${m.headRight}`);
}

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} layout check(s) failed` : "\nPASS: table searches sit on the left");
process.exit(failed ? 1 : 0);
