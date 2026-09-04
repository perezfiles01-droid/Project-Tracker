#!/usr/bin/env node
/**
 * Guard for the Projects page controls.
 *
 * Three things here are easy to get wrong in a way that looks fine:
 *
 *  - A create button placed beside a pager DISAPPEARS when the list is short
 *    enough to fit one page, because TrackerUI.pager renders nothing at all
 *    for a single page. Both buttons are asserted with a long list AND a
 *    short one.
 *  - The per-tile pencil and bin are gone; the whole tile opens the project.
 *    A tile that still carries a button of its own is a regression.
 *  - Rename and delete now choose their project inside a dialog. Both are
 *    driven end to end and the tiles are read back.
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const url = "file://" + join(root, "Tracker-standalone.html");

/** Start clean, optionally with `n` projects added on top of the workbook's. */
async function seed(n) {
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate((count) => {
    localStorage.clear();
    if (count) {
      const added = [];
      for (let i = 1; i <= count; i++)
        added.push({ key: "seeded-" + i, name: "Seeded project " + i });
      localStorage.setItem("tracker.projects", JSON.stringify({ added, renamed: {}, hidden: [] }));
    }
  }, n);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector(".ptile");
}

const text = () => page.locator(".ptiles").textContent();

/* --- tiles carry no controls of their own --- */
await seed(0);
ok("projects render as tiles", (await page.locator(".ptile").count()) >= 2);
ok("no tile carries a button of its own",
   (await page.locator(".ptile button").count()) === 0,
   `${await page.locator(".ptile button").count()} found`);
ok("no tile carries a rename or delete action",
   (await page.locator('.ptile [data-edit^="project:"], .ptile [data-remove^="project:"]').count()) === 0);
ok("the whole tile is the open target",
   (await page.locator("button.ptile[data-pick]").count()) === (await page.locator(".ptile").count()));

/* --- Create Project is visible whether or not the list pages --- */
const short = await page.locator("[data-newproject]").isVisible();
const shortPager = await page.locator(".ptiles ~ .listfoot .pager, .listfoot .pager").count();
ok("Create Project is visible with a short, unpaged list", short,
   `pager present: ${shortPager > 0}`);
ok("the short list really has no pager", shortPager === 0);
ok("Create Project reads as a button, not an icon",
   /create project/i.test(await page.locator("[data-newproject]").textContent()));

await seed(6);   // workbook 2 + 6 = 8, past the 6-per-page limit
ok("Create Project is still visible with a paged list",
   await page.locator("[data-newproject]").isVisible());
ok("the long list really does page", (await page.locator(".listfoot .pager").count()) > 0);
const order = await page.evaluate(() => {
  const f = document.querySelector(".listfoot");
  const p = f.querySelector(".pager"), b = f.querySelector("[data-newproject]");
  if (!p || !b) return null;
  return { pagerLeft: Math.round(p.getBoundingClientRect().left),
           buttonLeft: Math.round(b.getBoundingClientRect().left) };
});
ok("Create Project sits to the right of the pager",
   order && order.buttonLeft > order.pagerLeft, JSON.stringify(order));

/* --- Create Table, below the tables, visible with or without a pager --- */
await page.locator(".ptile").first().click();
await page.waitForTimeout(500);
const ct = page.locator("[data-newtable]");
ok("Create Table is visible with a project open", await ct.isVisible());
ok("Create Table reads as a button, not an icon",
   /create table/i.test(await ct.textContent()));
const below = await page.evaluate(() => {
  const b = document.querySelector("[data-newtable]");
  const secs = [...document.querySelectorAll("section.linksection")];
  if (!b || !secs.length) return null;
  return Math.round(b.getBoundingClientRect().top -
                    secs[secs.length - 1].getBoundingClientRect().bottom);
});
ok("Create Table sits below the last table", below !== null && below >= 0, `${below}px`);

/* --- a project's description sits under its name and is editable --- */
await page.goto(url, { waitUntil: "load" });
await page.waitForSelector(".ptile");
const subs = await page.locator(".ptile .psub").allTextContents();
ok("workbook projects show a description under the name", subs.length >= 2, String(subs.length));
const under = await page.evaluate(() => {
  const t = document.querySelector(".ptile .t"), s2 = document.querySelector(".ptile .psub");
  if (!t || !s2) return null;
  const a = t.getBoundingClientRect(), b = s2.getBoundingClientRect();
  return { below: b.top >= a.bottom - 1, smaller: parseFloat(getComputedStyle(s2).fontSize)
             < parseFloat(getComputedStyle(t).fontSize) };
});
ok("the description sits below the title", under && under.below, JSON.stringify(under));
ok("the description reads as a subtitle, not a second title",
   under && under.smaller);

// It is edited where item 7 asks for it: inside the project's own edit form.
const target = (await page.locator(".ptile .t").first().textContent()).trim();
await page.click('[data-projectaction="rename"]');
await page.waitForSelector("#fd_project");
await page.selectOption("#fd_project", target);
await page.click('#formDialog [data-fd="save"]');
await page.waitForSelector("#fd_description");
ok("the project form carries a description field", true);
await page.fill("#fd_description", "A description I typed");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(400);
ok("an edited description shows under the tile",
   (await page.locator(".ptiles").textContent()).includes("A description I typed"));
await page.reload({ waitUntil: "load" });
await page.waitForSelector(".ptile");
ok("the description survives a reload",
   (await page.locator(".ptiles").textContent()).includes("A description I typed"));

/* --- rename through the picker --- */
await page.goto(url, { waitUntil: "load" });
await page.waitForSelector(".ptile");
const firstName = (await page.locator(".ptile .t").first().textContent()).trim();
await page.click('[data-projectaction="rename"]');
await page.waitForSelector("#formDialog .box");
await page.selectOption("#fd_project", firstName);
await page.click('#formDialog [data-fd="save"]');
await page.waitForSelector("#fd_name");
await page.fill("#fd_name", "Picked and renamed");
await page.click('#formDialog [data-fd="save"]');
await page.waitForTimeout(400);
ok("a project chosen in the picker is renamed", (await text()).includes("Picked and renamed"));
await page.reload({ waitUntil: "load" });
await page.waitForSelector(".ptile");
ok("the rename survives a reload", (await text()).includes("Picked and renamed"));

/* --- delete through the picker, and it still confirms --- */
await page.click('[data-projectaction="delete"]');
await page.waitForSelector("#formDialog .box");
await page.selectOption("#fd_project", "Picked and renamed");
await page.click('#formDialog [data-fd="save"]');
await page.waitForSelector("#formDialog .box");
ok("deleting through the picker still asks for confirmation",
   (await page.locator('#formDialog [data-fd="choice"]').count()) > 0);
ok("the confirmation asks nothing to be typed",
   (await page.locator("#formDialog input, #formDialog textarea").count()) === 0);
await page.click('#formDialog [data-fd="choice"]');
await page.waitForTimeout(400);
ok("a project chosen in the picker is deleted", !(await text()).includes("Picked and renamed"));

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} project-action check(s) failed`
                   : "\nPASS: the Projects page controls hold");
process.exit(failed ? 1 : 0);
