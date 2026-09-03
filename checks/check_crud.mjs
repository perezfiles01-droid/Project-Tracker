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

/* ---------------------------------------------------------------------------
   Structural pairing is not enough: a Remove button can exist and do nothing.

   drive.js sliced "drive:<id>" by seven characters where the prefix is six,
   so Remove passed a truncated id, matched no record and silently changed
   nothing - while the check above, which only counts controls, stayed green.

   So every removable kind found in the DOM is now actually clicked, and the
   control must disappear. Kinds are discovered at runtime, so a collection
   added later is exercised without being named here.
--------------------------------------------------------------------------- */
/** Quote an attribute value for a CSS selector. */
const cssQuote = (v) => String(v).replace(/["\\]/g, "\\$&");

async function removalWorks(kind) {
  // Reload first: the picked project and the open task row are module state,
  // so a second visit would TOGGLE them shut and hide the very controls this
  // is looking for - which reads as "no Remove button" rather than a guard bug.
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(300);

  const sel = `[data-remove^="${kind}:"]`;
  const routes = await page.$$eval("#nav button[data-route]", (bs) => bs.map((b) => b.dataset.route));
  for (const r of routes) {
    await page.click(`#nav button[data-route="${r}"]`);
    await page.waitForTimeout(220);
    if (!(await page.locator(sel).count())) {
      const pick = page.locator("[data-pick]").first();
      if (await pick.count()) { await pick.click(); await page.waitForTimeout(320); }
    }
    if (!(await page.locator(sel).count())) {
      const row = page.locator("tr.taskrow").first();
      if (await row.count()) { await row.click(); await page.waitForTimeout(220); }
    }

    const before = await page.locator(sel).count();
    if (!before) continue;

    // The attribute carries the identity, which a confirm dialog may ask for.
    const spec = await page.locator(sel).first().getAttribute("data-remove");
    page.once("dialog", (d) => d.accept());          // a native confirm, if any
    await page.locator(sel).first().click();
    await page.waitForTimeout(300);

    // Deleting a table asks through the app's own dialog and requires the
    // table name typed back; it then covers the page until it is answered.
    const box = page.locator("#formDialog .box");
    if (await box.count() && await box.isVisible()) {
      const confirm = page.locator("#fd_confirm");
      if (await confirm.count()) {
        const name = spec.slice(spec.indexOf(":") + 1);
        await confirm.fill(name.slice(name.lastIndexOf("|") + 1));
      }
      await page.locator('#formDialog [data-fd="save"]').click();
      await page.waitForTimeout(350);
    }
    // Counted by the EXACT item, not by how many controls of this kind are
    // left: deleting a project's last table leaves an empty fallback table
    // behind it, so the count can hold at 1 while the delete worked fine.
    const after = await page.locator(`[data-remove="${cssQuote(spec)}"]`).count();
    return { before: 1, after, spec };
  }
  return null;
}

for (const k of names) {
  if (!kinds[k].remove) continue;
  const res = await removalWorks(k);
  if (!res) { ok(`"${k}": a Remove control was reachable to click`, false, "none found on any route"); continue; }
  ok(`"${k}": clicking Remove actually removes it`, res.after === 0,
     res.after ? `${res.spec} is still on the page` : res.spec);
}

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} CRUD check(s) failed` : "\nPASS: every authored collection can be renamed and deleted");
process.exit(failed ? 1 : 0);
