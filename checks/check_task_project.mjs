#!/usr/bin/env node
/**
 * Guard: the task dialog's Project list is the projects page's list.
 *
 * They came from two different places. The page renders TrackerLinks.groups(),
 * which merges the seeded projects with the ones you create, drops the ones you
 * delete and applies renames. The task dialog called TrackerProjectNames, which
 * read the seeded JSON alone - so a project you created never appeared in the
 * dropdown, a deleted one still did, and a renamed one appeared under its old
 * name. One line, three symptoms, and only the first was ever reported.
 *
 * Set equality, not "contains": a dropdown that offers a project you deleted is
 * as wrong as one missing a project you added.
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
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const url = "file://" + join(root, "Tracker-standalone.html");
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(300);

/** Create a project through the real dialog, exactly as a person would. */
async function createProject(name) {
  // Create Project lives on Overview, beside the project tiles.
  await page.click('#nav button[data-route="overview"]');
  await page.waitForTimeout(250);
  await page.click("[data-newproject]");
  await page.waitForSelector("#fd_name");
  await page.fill("#fd_name", name);
  await page.click("#formDialog .actions button.primary");
  await page.waitForTimeout(300);
}

/** What the app itself says the projects are - the sidebar's own source. */
const onThePage = () => page.evaluate(() =>
  window.TrackerLinks.groups().map((g) => g.name));

/** What the task dialog offers, minus its blank and its "Other" escape hatch. */
async function inTheDialog() {
  await page.click('#nav button[data-route="todo"]');
  await page.waitForTimeout(250);
  await page.click('[data-edit="task:new"]');
  await page.waitForSelector("#fd_project");
  const opts = await page.$$eval("#fd_project option", (o) => o.map((x) => x.value));
  await page.click('#formDialog [data-fd="cancel"]');
  await page.waitForTimeout(200);
  return opts.filter((v) => v && v !== "Other");
}

const same = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

await createProject("Guard Project Alpha");
let page1 = await onThePage(), dlg1 = await inTheDialog();
ok("a project you just created is offered in the task dialog",
   dlg1.includes("Guard Project Alpha"), dlg1.join(", "));
ok("the dialog offers exactly the projects the page lists", same(page1, dlg1),
   `page: ${page1.join(", ")} || dialog: ${dlg1.join(", ")}`);

// A second one, to prove the first was not a coincidence of ordering.
await createProject("Guard Project Beta");
const page2 = await onThePage(), dlg2 = await inTheDialog();
ok("a second created project is offered too", same(page2, dlg2),
   `page: ${page2.join(", ")} || dialog: ${dlg2.join(", ")}`);

// Deleting must remove it from the dropdown, not only from the page. Driven
// through the store rather than the confirm dialog: this check is about the
// two lists agreeing, not about how a delete is confirmed.
await page.evaluate(() => {
  const ps = window.TrackerStore.get("tracker.projects", null) || {};
  ps.hidden = [...(ps.hidden || []), "guard-project-beta"];
  window.TrackerStore.set("tracker.projects", ps);
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
const page3 = await onThePage(), dlg3 = await inTheDialog();
ok("a deleted project is no longer offered", !dlg3.includes("Guard Project Beta"), dlg3.join(", "));
ok("the two lists still agree after a delete", same(page3, dlg3),
   `page: ${page3.join(", ")} || dialog: ${dlg3.join(", ")}`);

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} project-list check(s) failed`
                   : "\nPASS: the task dialog offers the projects the page lists");
process.exit(failed ? 1 : 0);
