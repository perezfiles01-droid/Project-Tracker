#!/usr/bin/env node
/**
 * Every table in the app pages.
 *
 * Four did not: Artifacts and Timeline on a project page, the To Do List and
 * Daily activity. A table that renders every row grows the page without limit
 * and buries whatever sits below it.
 *
 * Tables are found in the rendered DOM at runtime rather than listed here, so
 * a table added later is covered without anyone remembering to add it.
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

const PER = 10;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });

// Seed more than one page into each collection that is stored in the browser.
await page.evaluate((n) => {
  const tasks = [], acts = [], arts = [], tls = [];
  for (let i = 1; i <= n; i++) {
    tasks.push({ id: "t" + i, no: String(i), name: "Task " + i, description: "d" + i,
                 status: "To do", attachments: [] });
    acts.push({ id: "a" + i, date: "2026-01-0" + ((i % 9) + 1), task: "Activity " + i,
                status: "Completed", origin: "manual", url: "" });
    arts.push({ id: "ar" + i, project: "glass", name: "Artifact " + i, type: "Doc", status: "Not started" });
    tls.push({ id: "tl" + i, project: "glass", name: "Milestone " + i, phase: "P", progress: 0 });
  }
  localStorage.setItem("tracker.tasks", JSON.stringify(tasks));
  localStorage.setItem("tracker.activity", JSON.stringify(acts));
  localStorage.setItem("tracker.artifacts", JSON.stringify(arts));
  localStorage.setItem("tracker.timeline", JSON.stringify(tls));
}, 25);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(400);

/** Walk every route, opening disclosures, and check each table it finds. */
const routes = await page.$$eval("#nav button[data-route]", (bs) => bs.map((b) => b.dataset.route));
let checked = 0;
for (const r of routes) {
  await page.click(`#nav button[data-route="${r}"]`);
  await page.waitForTimeout(250);
  const pick = page.locator("[data-pick]").first();
  if (await pick.count()) { await pick.click(); await page.waitForTimeout(320); }

  const tables = await page.evaluate(() => [...document.querySelectorAll("#view table")]
    .map((t, i) => ({ i, rows: t.querySelectorAll("tbody tr").length,
                      cls: t.className || "(none)" })));
  for (const t of tables) {
    // A detail table (one row per field) and the projects grid are not row
    // listings, so the page-size rule does not apply to them.
    if (t.cls.includes("detailtable") || t.cls.includes("cellgrid")) continue;
    checked++;
    ok(`${r}: table ${t.i} (${t.cls}) shows no more than ${PER} rows`, t.rows <= PER,
       `${t.rows} rows`);
  }
}
ok("tables were actually found to check", checked > 0, `${checked} checked`);

// And paging must reach the rest, not just cap the first page.
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
const first = await page.locator("tr.taskrow").count();
ok(`the task list starts at ${PER} rows`, first === PER, String(first));
let seen = first, guard = 0;
while (!(await page.locator('[data-page="tasks:next"]').isDisabled()) && guard++ < 10) {
  await page.click('[data-page="tasks:next"]');
  await page.waitForTimeout(150);
  seen += await page.locator("tr.taskrow").count();
}
ok("paging reaches all 25 tasks", seen === 25, `counted ${seen}`);

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} paging check(s) failed` : "\nPASS: every table pages");
process.exit(failed ? 1 : 0);
