#!/usr/bin/env node
/**
 * Guard: what the Standardize button actually asks the model to do.
 *
 * The prompt used to end its first paragraph with an invitation to fill any
 * perceived gap in the message. That licence is gone: Standardize tidies what
 * you wrote, and a rewriter told to fill gaps will add a sentence you never
 * wrote to a work note that goes out under your name.
 *
 * A prompt is not code and nothing else checks it, so this asserts the text
 * that is actually SENT, captured from a stubbed fetch, per engine, rather
 * than reading the source string. Engines are enumerated from the running app
 * so a third one added later is driven by this without it being edited.
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
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);

/* The forbidden licence, in the shapes it could come back as. Matched against
   the request body, so a rewording that means the same thing is still caught
   by the "gap"/"lacking" terms. */
const BANNED = [/fill that gap/i, /fill any gap/i, /lacking/i, /gap in the message/i];

const engines = await page.evaluate(() =>
  ((window.TrackerAI && window.TrackerAI.PROVIDERS) || []).map((p) => p.id));
ok("the app offers engines to check", engines.length > 0, engines.join(", "));

/** Capture the body every engine would send, without a key or a request. */
const bodies = await page.evaluate(async (ids) => {
  const sent = {};
  const realFetch = window.fetch;
  window.fetch = async (url, opts) => {
    sent[window.__engine] = String((opts && opts.body) || "");
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  for (const id of ids) {
    window.__engine = id;
    try {
      // A key, so the request is actually built. It is never sent: fetch is
      // the stub above, and the value is not a credential.
      const provider = window.TrackerAI.PROVIDERS.find((p) => p.id === id);
      if (provider && provider.keySetting) {
        window.TrackerStore.setText(provider.keySetting, "guard-not-a-real-key");
      }
      window.TrackerStore.setText("tracker.aiEngine", id);
      await window.TrackerAI.standardize("some text to tidy", { kind: "description" });
    } catch { /* a stub reply is not a valid one; the body is what matters */ }
  }
  window.fetch = realFetch;
  return sent;
}, engines);

const seen = Object.keys(bodies);
ok("a request body was captured for at least one engine", seen.length > 0, seen.join(", "));

for (const [id, body] of Object.entries(bodies)) {
  if (!body) { ok(`${id}: a body was sent`, false, "empty"); continue; }
  ok(`${id}: still asks for tone, grammar and clarity`,
     /improve the tone/i.test(body) && /fix the grammar/i.test(body) &&
     /clear and easy to understand/i.test(body));
  const hit = BANNED.find((re) => re.test(body));
  ok(`${id}: does NOT invite the model to fill gaps`, !hit, hit ? String(hit) : "clean");
  ok(`${id}: still forbids inventing specifics`, /do not invent specifics/i.test(body));
  ok(`${id}: still asks for the text and nothing else`,
     /nothing else/i.test(body));
}

/* The source string itself, as a second reading - a prompt assembled from
   pieces could pass the per-engine check and still carry the sentence in a
   branch none of them took. */
const src = await page.evaluate(() => {
  const m = [...document.querySelectorAll("script")].map((s) => s.textContent).join("\n");
  return m;
});
ok("the sentence is not anywhere in the shipped source",
   !/feel free to add and fill that gap/i.test(src) &&
   !/is something lacking or a gap in the message/i.test(src));

await browser.close();
console.log(`\n${failed} prompt check(s) failed`);
process.exit(failed ? 1 : 0);
