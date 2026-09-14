#!/usr/bin/env node
/**
 * Guard for the Image Generator.
 *
 * The failures this exists to catch are all quiet ones.
 *
 *   - An engine that cannot draw being offered as though it can. Pollinations
 *     has no run() and cannot rewrite text; Gemini and OpenRouter are text
 *     engines and only one of them draws. A picker built from the wrong list
 *     offers a choice that answers with an error, and nothing but a click
 *     reveals it.
 *   - An image reply read as text. Gemini returns pixels as base64 inlineData
 *     on a part, and the text path's `.map((p) => p.text || "")` drops it and
 *     hands back an empty string - a 200, no error, no picture. That is the
 *     bug this whole capability exists because of.
 *   - A basis image silently ignored. Uploading a reference to an engine that
 *     cannot use one, and getting an unrelated picture back, reads as a bad
 *     model rather than an unsupported option.
 *   - An image byte reaching localStorage, which is the failure that takes the
 *     whole tracker down with it.
 *   - A generation riding into the backup file, which the user explicitly
 *     asked to avoid.
 *
 * The engines are enumerated from TrackerAI.ENGINES at RUNTIME, never as a
 * list of three: a fourth engine added later is checked by this file without
 * this file being edited, and a new engine is exactly the one most likely to
 * declare a capability it has not implemented.
 *
 * No network call is made. Every engine is stubbed, deliberately: this check
 * must pass on a machine with no key and no route to any image host - the
 * build environment is one, its egress proxy refusing everything outside an
 * allowlist - and it must be able to force failure paths on demand. What it
 * asserts about the real services is what can be asserted without them: which
 * list each engine belongs in, what it declares, and that its declarations and
 * its implementation agree.
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
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const url = "file://" + (process.env.TRACKER_HTML || join(root, "Tracker-standalone.html"));
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(300);

/* ================================================== 1. the capability layer */
const api = await page.evaluate(() => {
  const A = window.TrackerAI;
  if (!A) return { missing: "TrackerAI" };
  if (!A.ENGINES) return { missing: "TrackerAI.ENGINES" };
  return {
    engines: A.ENGINES.map((p) => ({
      id: p.id, canText: p.canText !== false, canImage: !!p.canImage,
      canBasis: !!p.canBasis, keyless: p.keyless === true,
      hasRun: typeof p.run === "function",
      hasImage: typeof p.image === "function",
      hasListImageModels: typeof p.listImageModels === "function",
    })),
    text: A.PROVIDERS.map((p) => p.id),
    image: A.imageEngines().map((p) => p.id),
    hasImageFn: typeof A.image === "function",
    hasB64: typeof A.b64ToBlob === "function",
  };
});

if (api.missing) {
  console.log(`\nFAIL: ${api.missing} is not present — this build predates the Image Generator`);
  await browser.close();
  process.exit(1);
}

ok("there is an image entry point", api.hasImageFn);
ok(`engines were discovered at runtime (${api.engines.length}: ${api.engines.map((e) => e.id).join(", ")})`,
   api.engines.length > 0);

// The central pair of assertions, over every engine rather than a sample.
for (const e of api.engines) {
  ok(`${e.id}: declares canImage and implements image()`,
     e.canImage === e.hasImage,
     `canImage=${e.canImage} image()=${e.hasImage}`);
  ok(`${e.id}: appears in the image picker only if it can draw`,
     api.image.includes(e.id) === e.canImage);
  ok(`${e.id}: appears in the text picker only if it can rewrite`,
     api.text.includes(e.id) === e.canText);
  if (e.canText) ok(`${e.id}: a text engine implements run()`, e.hasRun);
  if (e.canImage) ok(`${e.id}: an image engine can list its image models`, e.hasListImageModels);
  // A keyless engine must be usable with nothing saved at all; a keyed one
  // must NOT claim to be ready before its key is pasted in.
  const ready = await page.evaluate((id) =>
    window.TrackerAI.imageReady(window.TrackerAI.ENGINES.find((p) => p.id === id)), e.id);
  ok(`${e.id}: ready without a key is ${e.keyless}`, ready === e.keyless,
     `keyless=${e.keyless} ready=${ready}`);
}

ok("at least one image engine needs no key at all",
   api.engines.some((e) => e.canImage && e.keyless),
   "otherwise the section is unusable until a key is pasted in");

/* ============================== 2. an image reply is read as pixels, not text */
// The exact shape Gemini answers with, snake_case and camelCase alike: the
// REST API uses one and the client libraries the other, and a blank picture
// is what reading only one of them produces.
const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx" +
  "0gAAAABJRU5ErkJggg==";

for (const shape of ["inlineData", "inline_data"]) {
  const got = await page.evaluate(async ([shape, b64]) => {
    const g = window.TrackerAI.ENGINES.find((p) => p.id === "gemini");
    const realFetch = window.fetch;
    window.TrackerStore.setText("tracker.geminiKey", "AIzaTEST");
    window.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [
        { text: "Here is your picture." },
        { [shape]: { mimeType: "image/png", data: b64 } },
      ] } }] }),
    });
    try {
      const blob = await g.image("a red square");
      return { type: blob.type, size: blob.size, isBlob: blob instanceof Blob };
    } catch (err) { return { error: String(err && err.message) }; }
    finally { window.fetch = realFetch; }
  }, [shape, tinyPng]);
  ok(`a reply carrying ${shape} becomes a real image Blob`,
     got.isBlob && got.type === "image/png" && got.size > 0,
     got.error || `${got.size} bytes, ${got.type}`);
}

// The regression itself: a model that answers in prose must not read as success.
const prose = await page.evaluate(async () => {
  const g = window.TrackerAI.ENGINES.find((p) => p.id === "gemini");
  const realFetch = window.fetch;
  window.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [
      { text: "I would draw a red square with soft edges." },
    ] } }] }),
  });
  try { await g.image("a red square"); return { ok: true }; }
  catch (err) { return { error: String(err && err.message) }; }
  finally { window.fetch = realFetch; }
});
ok("a text-only reply is a failure, not an empty picture",
   !!prose.error && /text rather than a picture/i.test(prose.error), prose.error || "it succeeded");

// And the failures a person has to be able to act on.
const refused = await page.evaluate(async () => {
  const g = window.TrackerAI.ENGINES.find((p) => p.id === "gemini");
  const realFetch = window.fetch;
  window.fetch = async () => ({ ok: false, status: 403,
    json: async () => ({ error: { message: "API key not valid" } }) });
  try { await g.image("x"); return { ok: true }; }
  catch (err) { return { error: String(err && err.message) }; }
  finally { window.fetch = realFetch; }
});
ok("a refused key says to check the key, in a sentence",
   !!refused.error && /key was refused|Settings|settings/i.test(refused.error), refused.error);

const noKey = await page.evaluate(async () => {
  window.TrackerStore.remove("tracker.geminiKey");
  try { await window.TrackerAI.image("x", { engineId: "gemini" }); return { ok: true }; }
  catch (err) { return { error: String(err && err.message) }; }
});
ok("a keyed engine with no key asks for one rather than throwing raw",
   !!noKey.error && /key/i.test(noKey.error), noKey.error);

/* ============================================ 3. a basis is never ignored */
const basisRefused = await page.evaluate(async () => {
  const off = window.TrackerAI.imageEngines().find((p) => !p.canBasis);
  if (!off) return { skip: true };
  try {
    await window.TrackerAI.image("x", { engineId: off.id, basis: { base64: "AAAA", type: "image/png" } });
    return { ok: true, id: off.id };
  } catch (err) { return { error: String(err && err.message), id: off.id }; }
});
ok("an engine that cannot take a basis says so rather than dropping it",
   basisRefused.skip || (!!basisRefused.error && /cannot work from an uploaded picture/i.test(basisRefused.error)),
   basisRefused.error || `${basisRefused.id} accepted it silently`);

const basisSent = await page.evaluate(async ([b64]) => {
  const g = window.TrackerAI.ENGINES.find((p) => p.id === "gemini");
  window.TrackerStore.setText("tracker.geminiKey", "AIzaTEST");
  const realFetch = window.fetch;
  let sent = null;
  window.fetch = async (u, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [
        { inlineData: { mimeType: "image/png", data: b64 } }] } }] }) };
  };
  try {
    await g.image("make it blue", { basis: { base64: b64, type: "image/png" } });
    const parts = sent.contents[0].parts;
    return { parts: parts.length, carried: parts.some((p) => p.inline_data || p.inlineData) };
  } catch (err) { return { error: String(err && err.message) }; }
  finally { window.fetch = realFetch; window.TrackerStore.remove("tracker.geminiKey"); }
}, [tinyPng]);
ok("a basis image actually reaches the engine, beside the prompt",
   basisSent.carried === true && basisSent.parts === 2,
   basisSent.error || `${basisSent.parts} parts, carried=${basisSent.carried}`);

/* ================================ 4. the storage contract for generations */
const storage = await page.evaluate(() => {
  const S = window.TrackerStore;
  return {
    inAll: S.ALL.includes("tracker.images"),
    inData: S.KEYS.data.includes("tracker.images"),
    local: (S.KEYS.local || []).includes("tracker.images"),
    settings: ["tracker.imageEngine", "tracker.geminiImageModel", "tracker.pollinationsModel"]
      .every((k) => S.KEYS.settings.includes(k)),
  };
});
ok("generations are scoped per account (in ALL)", storage.inAll);
ok("generations stay out of the backup (not in KEYS.data)", !storage.inData);
ok("generations are declared browser-local", storage.local);
ok("the image settings are settings, so they never enter a backup", storage.settings);

ok("nothing threw while doing all that", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\nFAIL: ${failed} check(s)` : "\nPASS: every engine draws what it says it can");
process.exit(failed ? 1 : 0);
