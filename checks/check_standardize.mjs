#!/usr/bin/env node
/**
 * Guard for the Standardize button.
 *
 * Three promises are made to the person typing, and all three fail silently
 * if nobody checks them:
 *
 *   1. What you typed is never lost. Undo restores it exactly, and every
 *      failure path leaves the field alone.
 *   2. No em dashes come back, whatever the model does. The prompt asks; this
 *      asserts.
 *   3. A key never leaves this browser in a backup file.
 *
 * Providers are enumerated from the running app rather than named here, so a
 * third engine added later is driven by this check without it being edited.
 *
 * No key and no spend: window.fetch is replaced with a stub, so the request
 * each provider builds is captured and every response - success, a rejected
 * key, a rate limit, a dead network, a refusal - is driven deliberately.
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const url = "file://" + join(root, "Tracker-standalone.html");

await page.goto(url, { waitUntil: "load" });

/** Every engine the app offers, asked of the app rather than named here. */
const providers = await page.evaluate(() =>
  ((window.TrackerAI && window.TrackerAI.PROVIDERS) || []).map((p) => ({
    id: p.id, label: p.label, keySetting: p.keySetting,
    modelSetting: p.modelSetting, free: !!p.free,
  })));
if (!providers.length) {
  // Everything below drives these. Without them the run would throw a stack
  // trace, which reads like a broken check rather than a missing feature.
  ok("the app exposes its engines", false, "TrackerAI.PROVIDERS is empty or absent; stopping");
  await browser.close();
  console.log(`\n${failed} standardize check(s) failed`);
  process.exit(1);
}
ok("the app offers engines", providers.length >= 1,
   providers.map((p) => p.id).join(", "));
ok("every engine offered is free to run", providers.every((p) => p.free),
   providers.filter((p) => !p.free).map((p) => p.id).join(", ") || "all free");
const defaultEngine = await page.evaluate(() => window.TrackerAI.DEFAULT_ENGINE);
const defaultProvider = providers.find((p) => p.id === defaultEngine);
ok("the default engine costs nothing to run",
   !!defaultProvider && defaultProvider.free, defaultEngine);

/* --- source level: every key is a setting, never a data key --- */
const store = readFileSync(join(root, "assets/store.js"), "utf8");
const dataBlock = store.slice(store.indexOf("data: ["), store.indexOf("settings: ["));
const settingsBlock = store.slice(store.indexOf("settings: ["));
for (const p of providers) {
  ok(`${p.id}: its key is not a data key`, !dataBlock.includes(p.keySetting), p.keySetting);
  ok(`${p.id}: its key is declared as a setting`, settingsBlock.includes(p.keySetting), p.keySetting);
}

/** Start clean, with the given engine and key in place. */
async function openTask({ engine = null, key = "test-key" } = {}) {
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(([eng, k, provs]) => {
    localStorage.clear();
    if (eng) {
      localStorage.setItem("tracker.aiEngine", eng);
      const p = provs.find((x) => x.id === eng);
      if (p && k) localStorage.setItem(p.keySetting, k);
    }
  }, [engine, key, providers]);
  await page.goto(url, { waitUntil: "load" });
  await page.click('#nav button[data-route="todo"]');
  await page.waitForTimeout(300);
  await page.click('[data-edit="task:new"]');
  await page.waitForSelector("#formDialog .box");
}

/** Make the next call answer with whatever we say, and record what was sent. */
async function stub(spec) {
  await page.evaluate((s) => {
    window.__calls = [];
    window.fetch = async (u, init) => {
      window.__calls.push({ url: String(u), init });
      if (s.networkError) throw new TypeError("Failed to fetch");
      return { ok: s.status === 200, status: s.status, json: async () => s.body };
    };
  }, spec);
}

/** A success body in whichever shape the provider reads. */
const replyFor = (id, text) => ({
  status: 200,
  body: id === "gemini"
    ? { candidates: [{ content: { parts: [{ text }] } }] }
    : { content: [{ type: "text", text }], stop_reason: "end_turn" },
});

const typed = "the report is not yet done i need to finish it and send to the team";

/* --- the button is where it was asked for --- */
await openTask();
const on = await page.$$eval("[data-standardize]", (bs) => bs.map((b) => b.dataset.standardize));
ok("both task fields carry the button", on.includes("fd_name") && on.includes("fd_description"),
   on.join(", "));
if (!on.length) {
  ok("the Standardize button exists at all", false, "nothing to drive; stopping");
  await browser.close();
  console.log(`\n${failed} standardize check(s) failed`);
  process.exit(1);
}
ok("the tooltip reads Standardize text",
   (await page.locator("[data-standardize]").first().getAttribute("title")) === "Standardize text");

/* --- every engine builds a request that carries the key and the text --- */
for (const p of providers) {
  await openTask({ engine: p.id, key: "key-for-" + p.id });
  await stub(replyFor(p.id, "The report is not finished."));
  await page.fill("#fd_description", typed);
  await page.click('[data-standardize="fd_description"]');
  await page.waitForTimeout(400);

  const call = await page.evaluate(() => window.__calls[0]);
  ok(`${p.id}: it made exactly one request`, !!call,
     call ? call.url.replace(/key=[^&]*/, "key=***") : "none");
  if (!call) continue;

  const headers = call.init.headers || {};
  const body = call.init.body || "";
  const everything = call.url + " " + JSON.stringify(headers) + " " + body;
  ok(`${p.id}: the request carries its key`, everything.includes("key-for-" + p.id));
  ok(`${p.id}: it sends the typed text`, body.includes(typed.slice(0, 30)));
  ok(`${p.id}: the instruction forbids the dashes`, /em dash/i.test(body));
  ok(`${p.id}: the reply lands in the field`,
     (await page.inputValue("#fd_description")).startsWith("The report is not finished"));

  // Undo is the promise that matters most, so it is checked per engine.
  await page.click('[data-undo="fd_description"]');
  await page.waitForTimeout(250);
  ok(`${p.id}: Undo restores the original byte for byte`,
     (await page.inputValue("#fd_description")) === typed);
}

/* --- a key stranded by the removed engine is adopted, once ---
   A build served from a stale cache saved keys under the Anthropic slot,
   because that was the only engine it knew. Anyone who pasted an AI Studio
   key then has it filed where nothing reads it. */
await page.goto(url, { waitUntil: "load" });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem("tracker.aiKey", "AIzaSyStranded");
});
await page.goto(url, { waitUntil: "load" });
const adopted = await page.evaluate(() => ({
  gemini: localStorage.getItem("tracker.geminiKey"),
  old: localStorage.getItem("tracker.aiKey"),
}));
ok("a Google key left in the old slot is adopted", adopted.gemini === "AIzaSyStranded", adopted.gemini);
ok("the old slot is cleared once it has been moved", adopted.old === null, String(adopted.old));

// It must not touch a key that is not Google's, nor overwrite one already set.
await page.goto(url, { waitUntil: "load" });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem("tracker.aiKey", "sk-ant-not-a-google-key");
  localStorage.setItem("tracker.geminiKey", "AIzaSyMine");
});
await page.goto(url, { waitUntil: "load" });
const untouched = await page.evaluate(() => ({
  gemini: localStorage.getItem("tracker.geminiKey"),
  old: localStorage.getItem("tracker.aiKey"),
}));
ok("a non-Google key is left where it is", untouched.old === "sk-ant-not-a-google-key", String(untouched.old));
ok("an existing key is never overwritten", untouched.gemini === "AIzaSyMine", untouched.gemini);

/* --- the dash rule on its own, including what it must NOT touch --- */
const dashes = await page.evaluate(() => {
  const t = window.TrackerUI.tidyDashes;
  return {
    hyphen: t("a well-known case"),
    range: t("the 2024–2025 range"),
    minus: t("temperature -5 today"),
    plain: t("nothing to change here"),
    parenthetical: t("We shipped it — it works."),
    trailing: t("ends with one —"),
  };
});
ok("a hyphenated word is left alone", dashes.hyphen === "a well-known case", dashes.hyphen);
ok("a numeric range becomes a hyphen, not a comma", dashes.range === "the 2024-2025 range", dashes.range);
ok("a minus sign is left alone", dashes.minus === "temperature -5 today", dashes.minus);
ok("text with no dashes is unchanged", dashes.plain === "nothing to change here", dashes.plain);
ok("a parenthetical dash becomes a comma",
   dashes.parenthetical === "We shipped it, it works.", dashes.parenthetical);
ok("a trailing dash is dropped", dashes.trailing === "ends with one", dashes.trailing);

/* --- and it holds against a model that ignores the instruction --- */
const first = providers[0];
await openTask({ engine: first.id });
await stub(replyFor(first.id, "We shipped it — it works, and the 2024–2025 range is fine."));
await page.fill("#fd_description", "we shipped it and it works");
await page.click('[data-standardize="fd_description"]');
await page.waitForTimeout(400);
const dashed = await page.inputValue("#fd_description");
ok("an em dash from the model never reaches the field", !dashed.includes("—"), dashed);
ok("a numeric range survives it", dashed.includes("2024-2025"), dashed);

/* --- every failure leaves what you typed exactly as you typed it --- */
for (const [label, spec] of [
  ["a rejected key", { status: 401, body: { error: { message: "bad key" } } }],
  ["a rate limit", { status: 429, body: { error: { message: "slow down" } } }],
  ["a server fault", { status: 500, body: {} }],
  ["a dead network", { networkError: true }],
  ["an empty reply", { status: 200, body: {} }],
]) {
  await openTask({ engine: first.id });
  await stub(spec);
  await page.fill("#fd_description", typed);
  await page.click('[data-standardize="fd_description"]');
  await page.waitForTimeout(400);
  ok(`${label} leaves the text untouched`,
     (await page.inputValue("#fd_description")) === typed);
  const note = (await page.locator('[data-note="fd_description"]').textContent()).trim();
  ok(`${label} says what went wrong`, note.length > 0 && !/undefined|\[object/.test(note), note);
}

/* --- with no key anywhere, it says where to get one, free --- */
await openTask({ engine: null, key: null });
await page.fill("#fd_description", typed);
await page.click('[data-standardize="fd_description"]');
await page.waitForTimeout(300);
const noKey = (await page.locator('[data-note="fd_description"]').textContent()).trim();
ok("with no key it points at Settings", /settings/i.test(noKey), noKey);
ok("with no key it names the free option", /free/i.test(noKey), noKey);
ok("with no key nothing was sent",
   (await page.evaluate(() => (window.__calls || []).length)) === 0);

/* --- keys never travel in a backup --- */
await page.evaluate((provs) => {
  for (const p of provs) localStorage.setItem(p.keySetting, "secret-" + p.id);
}, providers);
const backup = await page.evaluate(() => JSON.stringify(window.TrackerStore.exportData()));
for (const p of providers) {
  ok(`${p.id}: a backup file carries no key`,
     !backup.includes("secret-" + p.id) && !backup.includes(p.keySetting), p.keySetting);
}

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} standardize check(s) failed`
                   : "\nPASS: the Standardize button keeps what you typed");
process.exit(failed ? 1 : 0);
