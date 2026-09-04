#!/usr/bin/env node
/**
 * Guard for the Standardize button.
 *
 * Two promises are made to the person typing, and both are the kind that fail
 * silently if nobody checks them:
 *
 *   1. What you typed is never lost. Undo restores it exactly, and every
 *      failure path leaves the field alone.
 *   2. No em dashes come back, whatever the model does. The prompt asks; this
 *      asserts.
 *
 * No API key and no spend: window.fetch is replaced with a stub, so the
 * request shape is captured and every response - success, 401, 429, a
 * refusal, a dead network - is driven deliberately rather than waited for.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

/* --- source level: the key must be a setting, never data --- */
const store = readFileSync(join(root, "assets/store.js"), "utf8");
const dataBlock = store.slice(store.indexOf("data: ["), store.indexOf("settings: ["));
ok("the AI key is not a data key", !dataBlock.includes("tracker.aiKey"));
ok("the AI key is declared as a setting", /settings:\s*\[[^\]]*tracker\.aiKey/s.test(store));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const url = "file://" + join(root, "Tracker-standalone.html");

/** Open a fresh New task dialog, with a key set unless told otherwise. */
async function openTask({ key = "sk-ant-test" } = {}) {
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate((k) => {
    localStorage.clear();
    if (k) localStorage.setItem("tracker.aiKey", k);
  }, key);
  await page.goto(url, { waitUntil: "load" });
  await page.click('#nav button[data-route="todo"]');
  await page.waitForTimeout(350);
  await page.click('[data-edit="task:new"]');
  await page.waitForSelector("#formDialog .box");
}

/** Make the next call to the API answer with whatever we say. */
async function stub(spec) {
  await page.evaluate((s) => {
    window.__calls = [];
    window.fetch = async (u, init) => {
      window.__calls.push({ url: u, init: { ...init, headers: init.headers } });
      if (s.networkError) throw new TypeError("Failed to fetch");
      return {
        ok: s.status === 200,
        status: s.status,
        json: async () => s.body,
      };
    };
  }, spec);
}

const reply = (text, extra = {}) =>
  ({ status: 200, body: { content: [{ type: "text", text }], stop_reason: "end_turn", ...extra } });

/* --- the button is where it was asked for --- */
await openTask();
const on = await page.$$eval("[data-standardize]", (bs) => bs.map((b) => b.dataset.standardize));
ok("both task fields carry the button", on.includes("fd_name") && on.includes("fd_description"),
   on.join(", "));
// Everything below drives that button. Without it the run would throw a
// stack trace thirty lines later, which reads like a broken check rather
// than a missing feature - so it says so and stops here.
if (!on.length) {
  ok("the Standardize button exists at all", false, "nothing to drive; stopping");
  await browser.close();
  console.log(`\n${failed} standardize check(s) failed`);
  process.exit(1);
}

ok("the tooltip reads Standardize text",
   (await page.locator("[data-standardize]").first().getAttribute("title")) === "Standardize text");
ok("a field that did not ask for it has no button",
   !on.includes("fd_no") && !on.includes("fd_assignee"), on.join(", "));

/* --- the request that would be sent --- */
const typed = "the report is not yet done i need to finish it and send to the team";
await stub(reply("The report is not finished. I will complete it and send it to the team."));
await page.fill("#fd_description", typed);
await page.click('[data-standardize="fd_description"]');
await page.waitForTimeout(400);

const call = await page.evaluate(() => window.__calls[0]);
ok("it calls the Messages API", call && call.url === "https://api.anthropic.com/v1/messages",
   call && call.url);
const h = (call && call.init.headers) || {};
ok("it sends the browser access header",
   h["anthropic-dangerous-direct-browser-access"] === "true");
ok("it sends the api version and the key",
   h["anthropic-version"] === "2023-06-01" && h["x-api-key"] === "sk-ant-test");
const sent = JSON.parse((call && call.init.body) || "{}");
ok("it names a current model", /^claude-(opus|haiku|sonnet)-/.test(sent.model || ""), sent.model);
ok("it sends the typed text and nothing else as the message",
   sent.messages && sent.messages.length === 1 && sent.messages[0].content === typed);
ok("the instruction forbids the dashes", /em dash/i.test(sent.system || ""));

ok("the improved text lands in the field",
   (await page.inputValue("#fd_description")).startsWith("The report is not finished"));

/* --- Undo restores exactly what was typed --- */
await page.click('[data-undo="fd_description"]');
await page.waitForTimeout(250);
ok("Undo restores the original byte for byte",
   (await page.inputValue("#fd_description")) === typed);

/* --- the dash rule holds even when the model ignores it --- */
await openTask();
await stub(reply("We shipped it — it works, and the 2024–2025 range is fine."));
await page.fill("#fd_description", "we shipped it and it works");
await page.click('[data-standardize="fd_description"]');
await page.waitForTimeout(400);
const dashed = await page.inputValue("#fd_description");
ok("an em dash from the model never reaches the field", !dashed.includes("—"), dashed);
ok("a numeric range is left alone", dashed.includes("2024-2025"), dashed);

/* --- the dash rule on its own, including what it must NOT touch ---
   A rule this blunt earns its place only if it leaves ordinary punctuation
   alone. A false positive here rewrites correct text. */
const dashes = await page.evaluate(() => {
  const t = window.TrackerUI.tidyDashes;
  return {
    hyphen: t("a well-known case"),
    range: t("the 2024\u20132025 range"),
    minus: t("temperature -5 today"),
    plain: t("nothing to change here"),
    parenthetical: t("We shipped it \u2014 it works."),
    trailing: t("ends with one \u2014"),
  };
});
ok("a hyphenated word is left alone", dashes.hyphen === "a well-known case", dashes.hyphen);
ok("a numeric range becomes a hyphen, not a comma", dashes.range === "the 2024-2025 range", dashes.range);
ok("a minus sign is left alone", dashes.minus === "temperature -5 today", dashes.minus);
ok("text with no dashes is returned unchanged",
   dashes.plain === "nothing to change here", dashes.plain);
ok("a parenthetical dash becomes a comma",
   dashes.parenthetical === "We shipped it, it works.", dashes.parenthetical);
ok("a trailing dash is dropped", dashes.trailing === "ends with one", dashes.trailing);

/* --- every failure leaves what you typed exactly as you typed it --- */
for (const [label, spec] of [
  ["a rejected key", { status: 401, body: { error: { message: "invalid x-api-key" } } }],
  ["a rate limit", { status: 429, body: { error: { message: "slow down" } } }],
  ["a server fault", { status: 500, body: {} }],
  ["a dead network", { networkError: true }],
  ["a refusal", { status: 200, body: { content: [], stop_reason: "refusal" } }],
  ["an empty reply", reply("")],
]) {
  await openTask();
  await stub(spec);
  await page.fill("#fd_description", typed);
  await page.click('[data-standardize="fd_description"]');
  await page.waitForTimeout(400);
  ok(`${label} leaves the text untouched`,
     (await page.inputValue("#fd_description")) === typed);
  const note = (await page.locator('[data-note="fd_description"]').textContent()).trim();
  ok(`${label} says what went wrong`, note.length > 0 && !/undefined|\[object/.test(note), note);
}

/* --- with no key, it says where to put one rather than failing oddly --- */
await openTask({ key: null });
await page.fill("#fd_description", typed);
await page.click('[data-standardize="fd_description"]');
await page.waitForTimeout(300);
const noKey = (await page.locator('[data-note="fd_description"]').textContent()).trim();
ok("with no key it points at Settings", /settings/i.test(noKey), noKey);
ok("with no key nothing was sent",
   (await page.evaluate(() => (window.__calls || []).length)) === 0);

/* --- and the key never travels in a backup --- */
await page.evaluate(() => localStorage.setItem("tracker.aiKey", "sk-ant-secret"));
const backup = await page.evaluate(() => JSON.stringify(window.TrackerStore.exportData()));
ok("a backup file carries no API key",
   !backup.includes("sk-ant-secret") && !backup.includes("tracker.aiKey"));

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} standardize check(s) failed`
                   : "\nPASS: the Standardize button keeps what you typed");
process.exit(failed ? 1 : 0);
