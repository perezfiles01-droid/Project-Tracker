#!/usr/bin/env node
/**
 * Guard for the model picker.
 *
 * The Standardize dialog lists every model an account can reach - around forty
 * on a Google AI Studio key - and that list is only useful if it is sorted into
 * what you pay for and what each model is for. Three things are asserted here,
 * all of which fail silently if nobody checks them:
 *
 *   1. Every model name classifies. A name nobody has seen before must still
 *      land somewhere, because a model that classifies to nothing is a model
 *      that cannot be picked.
 *   2. The tier radios are mutually exclusive and never trap you: exactly one
 *      is on at all times, and "Show everything" always lists the lot.
 *   3. The saved model survives. Switching tiers never quietly selects a
 *      different model than the one already chosen.
 *
 * The model list is a fixture, not a live call: no key, no spend, and the
 * assertions do not drift when Google ships next month's names.
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

/** Taken from a real account's list, plus one name that does not exist yet. */
const FIXTURE = [
  "gemini-2.5-flash-lite", "gemini-3.1-flash-lite-image", "gemini-2.5-flash",
  "gemini-2.5-flash-image", "gemini-2.5-flash-preview-tts", "gemini-3-flash-preview",
  "gemini-3.1-flash-tts-preview", "gemini-3.7-flash", "gemini-flash-latest",
  "gemini-2.5-pro", "gemini-2.5-pro-preview-tts", "gemini-3-pro-image",
  "gemini-3.1-pro-preview", "gemini-pro-latest",
  "deep-research-max-preview-04-2026", "deep-research-pro-preview-12-2025",
  "gemini-2.5-computer-use-preview-10-2025", "gemini-3.5-transcribe",
  "gemini-robotics-er-2-preview", "gemma-4-26b-a4b-it",
  "lyria-3-clip-preview", "lyria-3.5", "nano-banana-pro-preview",
  "antigravity-preview-05-2026",
  "some-unheard-of-model-9",
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });

/* ---------------------------------------------------- 1. the classifier */
const exposed = await page.evaluate(() => typeof (window.TrackerAI || {}).classify === "function");
ok("the app exposes a model classifier", exposed);
if (!exposed) {
  await browser.close();
  console.log(`\n${++failed} model check(s) failed`);
  process.exit(1);
}

const groups = await page.evaluate(() => window.TrackerAI.PURPOSE_ORDER);
ok("purposes are ordered with text first", Array.isArray(groups) && groups[0] === "text",
   JSON.stringify(groups));

const seen = await page.evaluate((names) =>
  names.map((n) => ({ n, ...window.TrackerAI.classify(n) })), FIXTURE);
const bad = seen.filter((r) => !r.tier || !groups.includes(r.purpose));
ok("every model name classifies", bad.length === 0,
   bad.map((r) => r.n).join(", ") || `${seen.length} names`);

const by = (n) => seen.find((r) => r.n === n);
ok("an unknown future name falls through to free text, not out of the list",
   by("some-unheard-of-model-9").tier === "free" &&
   by("some-unheard-of-model-9").purpose === "text");
ok("image models read as image",
   ["gemini-2.5-flash-image", "gemini-3-pro-image", "nano-banana-pro-preview"]
     .every((n) => by(n).purpose === "image"));
ok("speech models read as speech",
   ["gemini-2.5-flash-preview-tts", "gemini-3.5-transcribe", "gemini-2.5-pro-preview-tts"]
     .every((n) => by(n).purpose === "speech"));
ok("lyria reads as music", by("lyria-3.5").purpose === "music");
ok("deep research reads as research", by("deep-research-max-preview-04-2026").purpose === "research");
ok("computer use and robotics read as specialised",
   by("gemini-2.5-computer-use-preview-10-2025").purpose === "special" &&
   by("gemini-robotics-er-2-preview").purpose === "special");
ok("the flash family is free",
   ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.7-flash", "gemini-2.5-pro"]
     .every((n) => by(n).tier === "free"));
ok("research, music, robotics and the pro image models are paid",
   ["deep-research-pro-preview-12-2025", "lyria-3-clip-preview", "gemini-3-pro-image",
    "nano-banana-pro-preview", "gemini-2.5-computer-use-preview-10-2025"]
     .every((n) => by(n).tier === "paid"));
ok("both tiers are actually populated by a real account's list",
   seen.some((r) => r.tier === "free") && seen.some((r) => r.tier === "paid"));

/* --------------------------------------------- 2. the dialog and radios */
// listModels is stubbed on the live provider, so the real render path runs
// with no key and no request.
await page.evaluate((names) => {
  const p = window.TrackerAI.PROVIDERS[0];
  p.listModels = async () => names.slice();
  window.TrackerStore.setText(p.keySetting, "stub-key");
  window.TrackerStore.setText(p.modelSetting, "gemini-2.5-flash");
}, FIXTURE);
await page.click("#openSettings");
await page.waitForFunction(() => document.querySelectorAll("#aiModel option").length > 1);

ok("the settings dialog is open", await page.isVisible("#aiModel"));
const radios = await page.$$eval('#aiTier input[name="aiTier"]', (r) => r.map((i) => i.value));
ok("three tier radios are offered", radios.length === 3 && radios.includes("all"),
   radios.join(", "));

const checkedCount = () => page.$$eval('#aiTier input[name="aiTier"]:checked', (r) => r.length);
ok("exactly one tier is chosen", await checkedCount() === 1);

const shown = () => page.$$eval("#aiModel option", (o) => o.map((x) => x.value));
const grouped = () => page.$$eval("#aiModel option",
  (o) => o.every((x) => x.parentElement && x.parentElement.tagName === "OPTGROUP"));
const groupLabels = () => page.$$eval("#aiModel optgroup", (g) => g.map((x) => x.label));

const free = await shown();
ok("the free tier is listed by default", free.length > 0 && free.length < FIXTURE.length,
   `${free.length} of ${FIXTURE.length}`);
ok("no paid model is listed under the free tier",
   free.every((m) => by(m) && by(m).tier === "free"),
   free.filter((m) => by(m) && by(m).tier === "paid").join(", ") || "none");
ok("every option sits inside a purpose group", await grouped());
const labels = await groupLabels();
ok("no purpose group is empty",
   await page.$$eval("#aiModel optgroup", (g) => g.every((x) => x.children.length > 0)),
   labels.join(" | "));
ok("text generation is the first group", labels[0] === "Text generation", labels.join(" | "));

await page.check('#aiTier input[value="paid"]');
const paid = await shown();
ok("exactly one tier is chosen after switching", await checkedCount() === 1);
ok("the paid tier lists a different set", paid.length > 0 && paid.join() !== free.join(),
   `${paid.length} paid`);
ok("no free model is listed under the paid tier",
   paid.every((m) => by(m) && by(m).tier === "paid"));
ok("paid options are grouped too", await grouped());

await page.check('#aiTier input[value="all"]');
const all = await shown();
ok("show everything lists every model, so nothing is out of reach",
   all.length === FIXTURE.length, `${all.length} of ${FIXTURE.length}`);

/* --------------------------------------------- 3. the saved model holds */
await page.selectOption("#aiModel", "gemini-3-pro-image");
await page.click("#settingsSave");
await page.click("#openSettings");
await page.waitForFunction(() => document.querySelectorAll("#aiModel option").length > 1);
ok("a saved paid model is still selected when the dialog reopens",
   await page.inputValue("#aiModel") === "gemini-3-pro-image",
   await page.inputValue("#aiModel"));
ok("the radio followed the saved model to its own tier",
   await page.$eval('#aiTier input[value="paid"]', (i) => i.checked));

await page.check('#aiTier input[value="all"]');
ok("switching tiers keeps the chosen model when it is still on screen",
   await page.inputValue("#aiModel") === "gemini-3-pro-image",
   await page.inputValue("#aiModel"));
await page.check('#aiTier input[value="free"]');
const nowFree = await page.inputValue("#aiModel");
ok("a tier that cannot show the chosen model falls to one it can",
   nowFree !== "gemini-3-pro-image" && by(nowFree) && by(nowFree).tier === "free", nowFree);

ok("nothing threw while doing all that", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(failed ? `\n${failed} model check(s) failed` : "\nAll model checks passed");
process.exit(failed ? 1 : 0);
