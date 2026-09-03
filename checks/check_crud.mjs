#!/usr/bin/env node
/**
 * Family guard: everything you author yourself must be add-able, renameable
 * and deletable.
 *
 * Links, pinned links and tasks all had the full set. Tables could only be
 * created, so a typo in a table name could only be escaped by rebuilding it.
 * That gap was invisible until someone hit it.
 *
 * The invariant checked here is structural, not a list of today's types:
 *   for every [data-remove="<kind>:…"] there must exist a [data-edit="<kind>:…"]
 * Kinds are discovered from the rendered DOM at runtime, so a collection type
 * added later is covered without being named here.
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
await page.waitForTimeout(300);
await page.evaluate(() => {
  localStorage.setItem("tracker.tasks", JSON.stringify(
    [{ id: "t-guard", no: "1", description: "Guard task", attachments: [], status: "To do" }]));
  localStorage.setItem("tracker.driveLinks", JSON.stringify(
    [{ id: "p-guard", name: "Guard pin", url: "https://example.test", project: "Google Drive", meta: "manual" }]));
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(400);

/** Walk every route, opening whatever needs opening, and collect the kinds. */
async function sweep() {
  const kinds = {};
  const routes = await page.$$eval("#nav button[data-route]", (bs) => bs.map((b) => b.dataset.route));
  for (const r of routes) {
    await page.click(`#nav button[data-route="${r}"]`);
    await page.waitForTimeout(220);
    const pick = page.locator("[data-pick]").first();
    if (await pick.count()) { await pick.click(); await page.waitForTimeout(320); }
    const row = page.locator("tr.taskrow").first();
    if (await row.count()) { await row.click(); await page.waitForTimeout(220); }
    const found = await page.evaluate(() => {
      const grab = (attr) => [...document.querySelectorAll(`[data-${attr}]`)]
        .map((el) => (el.dataset[attr] || "").split(":")[0]).filter(Boolean);
      return { removes: grab("remove"), edits: grab("edit") };
    });
    for (const k of found.removes) (kinds[k] ||= { remove: 0, edit: 0 }).remove++;
    for (const k of found.edits) (kinds[k] ||= { remove: 0, edit: 0 }).edit++;
  }
  return kinds;
}

const kinds = await sweep();
const names = Object.keys(kinds).sort();
ok("authored collections were discovered", names.length > 0, names.join(", "));

for (const k of names) {
  const { remove, edit } = kinds[k];
  if (remove === 0) continue;   // nothing removable, nothing to pair
  ok(`"${k}" offers rename/edit as well as delete`, edit > 0,
     `${remove} remove control(s), ${edit} edit control(s)`);
}
ok("tables are among the collections found", names.includes("table"), names.join(", "));

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} CRUD check(s) failed` : "\nPASS: every authored collection can be renamed and deleted");
process.exit(failed ? 1 : 0);
