#!/usr/bin/env node
/**
 * Guard: the first letter capitalises itself, and only where it was asked for.
 *
 * The negative half matters more than the positive one. fieldHtml renders
 * every field in the app, so a blanket rule here would capitalise a URL, a
 * project key and a search box. The behaviour is opt-in per field, and this
 * check asserts both that it happens where marked and that it does not happen
 * where it is not.
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
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);
await page.evaluate(() => localStorage.setItem("tracker.tasks", "[]"));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);
await page.click('[data-edit="task:new"]');
await page.waitForSelector("#fd_name");

/* --- typed, character by character, as a person types --------------------- */
await page.click("#fd_name");
await page.type("#fd_name", "review the draft");
ok("the name capitalises its first letter as you type",
   (await page.inputValue("#fd_name")) === "Review the draft",
   await page.inputValue("#fd_name"));

await page.click("#fd_description");
await page.type("#fd_description", "needs doing before friday");
ok("the description capitalises its first letter as you type",
   (await page.inputValue("#fd_description")) === "Needs doing before friday",
   await page.inputValue("#fd_description"));

/* --- the rest of the text is left exactly alone --------------------------- */
await page.fill("#fd_name", "");
await page.type("#fd_name", "check the iOS build and the URL");
ok("only the first letter is touched, not the rest of the words",
   (await page.inputValue("#fd_name")) === "Check the iOS build and the URL",
   await page.inputValue("#fd_name"));

/* --- a field that did not ask for it is untouched -------------------------
   A capitalised URL is a broken URL, so this is the assertion that stops the
   mechanism leaking into every other field fieldHtml renders. */
await page.fill("#fd_ref", "");
await page.type("#fd_ref", "https://example.test/path");
ok("the reference link is left exactly as typed",
   (await page.inputValue("#fd_ref")) === "https://example.test/path",
   await page.inputValue("#fd_ref"));

/* --- a leading digit or symbol is not mangled ----------------------------- */
await page.fill("#fd_name", "");
await page.type("#fd_name", "2026 plan");
ok("a name starting with a digit is left alone",
   (await page.inputValue("#fd_name")) === "2026 plan", await page.inputValue("#fd_name"));

/* --- pasted text gets the same treatment ---------------------------------- */
await page.fill("#fd_name", "");
await page.evaluate(() => {
  const el = document.querySelector("#fd_name");
  el.focus();
  el.value = "pasted from somewhere";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(100);
ok("pasted text is capitalised too",
   (await page.inputValue("#fd_name")) === "Pasted from somewhere",
   await page.inputValue("#fd_name"));

/* --- and what is saved carries the capital -------------------------------- */
await page.click("#formDialog .actions button.primary");
await page.waitForTimeout(400);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tracker.tasks"))[0]);
ok("the saved task keeps the capital", saved && saved.name === "Pasted from somewhere",
   saved ? saved.name : "no task saved");

/* --- Project is the first field in the dialog ----------------------------- */
await page.click('[data-edit="task:new"]');
await page.waitForSelector("#formDialog .box");
const firstField = await page.$eval("#formDialog .fieldset .field label",
  (l) => l.innerText.trim());
ok("Project is the first field in the dialog", /^project$/i.test(firstField), firstField);

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} capitalisation check(s) failed`
                   : "\nPASS: the first letter capitalises where it was asked for");
process.exit(failed ? 1 : 0);
