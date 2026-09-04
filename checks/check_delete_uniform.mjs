#!/usr/bin/env node
/**
 * Guard: every destructive action in the app asks the same question.
 *
 * Deleting used to mean two different things. A project or a table made you
 * retype its name; a link, an artifact, a milestone, a task, a log entry and
 * a pinned Drive file went instantly, with nothing asked — six of the eight
 * could be lost to a misplaced click.
 *
 * Delete buttons are found at runtime by their data-remove attribute, across
 * every route the nav offers, so a ninth one added later is checked without
 * this file being touched. For each one it asserts:
 *   1. a dialog opens at all
 *   2. the dialog has no "type the name" field
 *   3. Cancel leaves the item exactly where it was
 *   4. Confirm removes it
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

/* --- source-level: nobody re-invents a type-the-name confirmation --- */
for (const f of readdirSync(join(root, "assets")).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(join(root, "assets", f), "utf8");
  ok(`${f} declares no "confirm" text field`,
     !/name:\s*["']confirm["']/.test(src));
}

const cssQuote = (s) => s.replace(/(["\\])/g, "\\$1");

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const url = "file://" + join(root, "Tracker-standalone.html");
await page.goto(url, { waitUntil: "load" });

/** A known starting state: a pinned Drive link and a task to delete. */
async function reset() {
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("tracker.driveLinks", JSON.stringify(
      [{ id: "d1", name: "A pinned file", url: "https://example.test/d1",
         project: "Google Drive", meta: "document", verified: true }]));
    localStorage.setItem("tracker.tasks", JSON.stringify(
      [{ id: "t1", no: 1, name: "A task", description: "", status: "Pending",
         attachments: [] }]));
  });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(350);
}

/** Reveal whatever a route hides behind a click, then list its delete buttons. */
async function specsOn(route) {
  await page.click(`#nav button[data-route="${route}"]`);
  await page.waitForTimeout(300);
  const pick = page.locator("[data-pick]").first();
  if (await pick.count()) { await pick.click(); await page.waitForTimeout(400); }
  const row = page.locator("tr.taskrow").first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(250); }
  return page.$$eval("[data-remove]", (bs) => bs.map((b) => b.dataset.remove));
}

const routes = async () =>
  page.$$eval("#nav button[data-route]", (bs) => bs.map((b) => b.dataset.route));

// Every KIND of delete the app renders ("link:", "task:", …), found by walking
// the nav rather than from a list here, so a kind added later is covered.
await reset();
const kinds = new Map();
for (const r of await routes()) {
  for (const spec of await specsOn(r)) {
    const kind = spec.slice(0, spec.indexOf(":") + 1);
    if (!kinds.has(kind)) kinds.set(kind, { route: r, spec });
  }
}
ok("delete buttons were found to check", kinds.size > 0,
   `${kinds.size} kinds: ${[...kinds.keys()].join(" ")}`);

for (const [kind, { route, spec }] of kinds) {
  // Each kind starts from the same clean state: deleting a project otherwise
  // takes the tables and links inside it, and the next kind finds nothing.
  await reset();
  await specsOn(route);
  const sel = `[data-remove="${cssQuote(spec)}"]`;
  if (!(await page.locator(sel).count())) {
    ok(`${kind} button was still there to click`, false, spec);
    continue;
  }

  await page.locator(sel).first().click();
  await page.waitForTimeout(300);
  const box = page.locator("#formDialog .box");
  const asked = (await box.count()) > 0 && (await box.isVisible());
  ok(`${kind} asks before deleting`, asked, spec);
  if (!asked) continue;

  ok(`${kind} asks by confirmation, not by typing a name`,
     (await page.locator("#formDialog input, #formDialog textarea").count()) === 0);
  const buttons = await page.locator("#formDialog .actions button").allTextContents();
  ok(`${kind} offers a Cancel`, buttons.some((b) => /cancel/i.test(b)), buttons.join(" · "));

  // Cancel keeps it.
  await page.locator('#formDialog [data-fd="cancel"]').click();
  await page.waitForTimeout(300);
  ok(`${kind} survives Cancel`, (await page.locator(sel).count()) > 0, spec);

  // Confirm takes it. A dialog with no confirm button of its own is a
  // failure to report, not an exception to crash the run.
  await page.locator(sel).first().click();
  await page.waitForTimeout(300);
  const confirmBtn = page.locator('#formDialog [data-fd="choice"]').first();
  if (!(await confirmBtn.count())) {
    ok(`${kind} offers a single Confirm button`, false, "none found");
    await page.locator('#formDialog [data-fd="cancel"]').click().catch(() => {});
    await page.waitForTimeout(200);
    continue;
  }
  await confirmBtn.click();
  await page.waitForTimeout(400);
  ok(`${kind} goes on Confirm`, (await page.locator(sel).count()) === 0, spec);
}

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} delete check(s) failed` : "\nPASS: every delete asks the same question");
process.exit(failed ? 1 : 0);
