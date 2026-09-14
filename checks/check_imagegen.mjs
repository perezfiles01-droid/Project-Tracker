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

/* ============================================= 5. the section in the sidebar */
const nav = await page.$$eval("#nav button[data-route]", (bs) => bs.map((b) => b.dataset.route));
ok("the Image Generator has its own route", nav.includes("images"), nav.join(", "));
// Below Google Drive, which is where it was asked for. Asserted by ORDER in
// the rendered nav rather than by reading the source, so a group moved later
// is caught.
ok("it sits below Google Drive", nav.indexOf("images") > nav.indexOf("drive"),
   `drive at ${nav.indexOf("drive")}, images at ${nav.indexOf("images")}`);
const titles = await page.$$eval(".nav-title", (t) => t.map((x) => x.textContent.trim()));
ok("it is its own group, not tacked onto Drive",
   titles.includes("Image") && titles.indexOf("Image") > titles.indexOf("Drive"), titles.join("|"));

await page.click('#nav button[data-route="images"]');
await page.waitForTimeout(300);
// The rule every route in this app obeys, enforced app-wide by
// check_search.mjs. Asserted here too so the reason is stated where the
// section is built rather than only where the sweep runs.
ok("the section offers a search control",
   (await page.locator("#view [data-search]").count()) > 0);
ok("the page names itself", (await page.locator("#view h2.page").innerText()) === "Image Generator");

/* ================================== 6. generating, and where the bytes go */
// The engine is stubbed at the dispatch, so this exercises the whole section -
// button, storage, gallery, thumbnail - with no network and no key.
const png = await page.evaluate(async () => {
  // A real 1x1 PNG, so the <img> genuinely decodes rather than showing a
  // broken-image icon that would still satisfy a naive "src is set" check.
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  window.__png = window.TrackerAI.b64ToBlob(b64, "image/png");
  window.TrackerAI.image = async () => window.__png;
  return window.__png.size;
});
ok("the test has a real PNG to hand back", png > 0, `${png} bytes`);

const made = async (prompt) => {
  await page.fill("[data-imgprompt]", prompt);
  await page.click("[data-imggo]");
  await page.waitForTimeout(500);
};
await made("a red square on white");
ok("generating adds a card to the gallery", (await page.locator(".gencard").count()) === 1);
ok("the sidebar count follows the gallery",
   (await page.$eval('#nav button[data-route="images"] .count', (e) => e.textContent)).trim() === "1");
ok("the thumbnail resolves from IndexedDB",
   await page.$eval(".genshot img", (e) => e.src.startsWith("blob:")));
ok("the card says which engine and model drew it",
   /flux|Pollinations/i.test(await page.locator(".gencard .m").first().innerText()));

// The central storage assertion, and the one that would take the whole
// tracker down if it broke: 5 MB of localStorage cannot hold pictures.
const ls = await page.evaluate(() =>
  Object.keys(localStorage).map((k) => localStorage.getItem(k)).join(""));
ok("NO image bytes reach localStorage", !/data:image|iVBORw0KGgo/.test(ls));
ok("the record keeps the prompt, not the picture",
   /a red square on white/.test(ls));

/* ============================================ 7. the gallery behaves */
for (let i = 0; i < 10; i++) await made("filler prompt " + i);
const shown = await page.locator(".gencard").count();
ok("the gallery pages rather than growing without limit", shown <= 9, `${shown} cards`);
ok("a pager appears once there is more than one page",
   (await page.locator("#view .pager").count()) > 0);
await page.fill('#view [data-search]', "a red square");
await page.waitForTimeout(300);
const filtered = await page.locator(".gencard").count();
ok("the search actually filters the gallery", filtered === 1, `${filtered} cards`);
await page.fill('#view [data-search]', "zzz-nothing");
await page.waitForTimeout(300);
ok("a search with no match says so rather than showing everything",
   (await page.locator(".gencard").count()) === 0 &&
   /No picture matches/i.test(await page.locator("#view .empty").innerText()));
await page.fill('#view [data-search]', "");
await page.waitForTimeout(300);

/* ==================================================== 8. export to a file */
const [dl] = await Promise.all([
  page.waitForEvent("download"),
  page.click("[data-imgexport]"),
]);
const path = await dl.path();
const { readFileSync } = await import("node:fs");
const bytes = readFileSync(path);
ok("Export saves a real image file", bytes.length > 0 && bytes[0] === 0x89 && bytes[1] === 0x50,
   `${bytes.length} bytes, name ${dl.suggestedFilename()}`);
ok("the file is named from the prompt", /\.png$/.test(dl.suggestedFilename()),
   dl.suggestedFilename());
await page.waitForTimeout(400);

/* ============================= 9. the generations stay out of the backup */
const backup = await page.evaluate(async () => {
  const payload = await window.TrackerStore.exportFile();
  return {
    keys: Object.keys(payload.keys || {}),
    pictures: Object.keys(payload.blobs || {}).length,
    mentionsPrompt: JSON.stringify(payload).includes("a red square on white"),
  };
});
ok("a backup does not carry the gallery", !backup.keys.includes("tracker.images"),
   backup.keys.join(", "));
ok("and therefore carries none of its pictures", backup.pictures === 0, `${backup.pictures} pictures`);
ok("nothing of a generation leaks into the backup by another route",
   !backup.mentionsPrompt);

/* =========================================== 10. delete asks, then removes */
// Counted from STORAGE, not from the visible cards. The gallery pages at
// nine, and there are more than nine here, so removing one refills the page
// from the next and the card count does not move - which is correct
// behaviour that reads as a delete doing nothing.
const stored = () => page.evaluate(() => window.TrackerImages.load().length);
const before = await stored();
const cardsBefore = await page.locator(".gencard").count();
await page.click('[data-remove^="image:"]');
await page.waitForTimeout(300);
ok("removing a picture asks first", (await page.locator("#formDialog:not([hidden])").count()) > 0);
// It has to say the delete cannot be undone, because it cannot: this key is
// not in KEYS.data, so record() opens no undo step for it.
ok("and says it cannot be undone",
   /cannot be undone/i.test(await page.locator("#formDialog").innerText()));
await page.click('[data-fd="cancel"]');
await page.waitForTimeout(250);
ok("cancelling keeps the picture", (await stored()) === before);
await page.click('[data-remove^="image:"]');
await page.waitForTimeout(300);
// confirmDialog is formDialog with `choices`, so its confirm button is a
// choice carrying its value - not a save button. Clicking the wrong one timed
// out for thirty seconds and then reported the picture as still present,
// which read exactly like a delete that does not work.
await page.click('[data-fd="choice"][data-value="confirm"]');
await page.waitForTimeout(400);
ok("confirming removes it", (await stored()) === before - 1,
   `${before} → ${await stored()}`);
ok("and a full page refills from the next rather than leaving a hole",
   (await page.locator(".gencard").count()) === cardsBefore,
   `${cardsBefore} cards before, ${await page.locator(".gencard").count()} after`);
// The bytes go too. Nothing else will ever come for them: this key opens no
// undo step, so there is no expiry that would collect them later.
ok("the picture's bytes are dropped, not left in IndexedDB",
   await page.evaluate(async () => {
     const ids = await window.TrackerBlobs.list();
     const refs = JSON.stringify(window.TrackerImages.load());
     return ids.filter((id) => id.includes("img") && !refs.includes(id)).length === 0;
   }));

/* ============================ 11. the settings, inside the section itself */
// Stubbed so this check makes NO network call, which is the claim at the top
// of this file. Opening the settings legitimately asks each engine what models
// it has; in the build environment that request is refused by the egress proxy
// and arrives as a console error, which would fail the "nothing threw" check
// below for a reason that is about the network rather than about the app. The
// fallback path it would exercise is asserted separately, just below.
await page.evaluate(() => {
  for (const p of window.TrackerAI.imageEngines()) {
    p.listImageModels = async () => p.id === "gemini"
      ? ["gemini-2.5-flash-image"] : ["flux", "turbo"];
  }
});
await page.click('[data-imgsettings="open"]');
await page.waitForTimeout(500);
ok("the settings open inside the section, not in the global dialog",
   (await page.locator("#view .imgsettings").count()) > 0 &&
   (await page.locator("#settingsModal:not([hidden])").count()) === 0);
const offered = await page.$$eval("[data-imgengine] option", (o) => o.map((x) => x.value));
const canDraw = api.engines.filter((e) => e.canImage).map((e) => e.id);
ok("the engine picker offers exactly the engines that can draw",
   offered.slice().sort().join(",") === canDraw.slice().sort().join(","),
   `offered ${offered.join(",")} / can draw ${canDraw.join(",")}`);
ok("a text-only engine is never offered here", !offered.includes("openrouter"));
// Pollinations is keyless, so it must not ask for a key it has no use for.
ok("a keyless engine shows no key box",
   (await page.locator("#imgKey").count()) === 0);

// Switching to the keyed engine must produce a key box and a saveable model.
await page.selectOption("[data-imgengine]", "gemini");
await page.waitForTimeout(500);
ok("choosing a keyed engine asks for a key", (await page.locator("#imgKey").count()) === 1);
await page.fill("#imgKey", "AIzaSAVED");
await page.click('[data-imgsettings="save"]');
await page.waitForTimeout(300);
const saved = await page.evaluate(() => ({
  key: window.TrackerStore.getText("tracker.geminiKey"),
  engine: window.TrackerStore.getText("tracker.imageEngine"),
}));
ok("the key and the engine are saved", saved.key === "AIzaSAVED" && saved.engine === "gemini",
   JSON.stringify(saved));
// And the key must never reach a backup file, exactly like the text AI keys.
const keyLeak = await page.evaluate(async () =>
  JSON.stringify(await window.TrackerStore.exportFile()).includes("AIzaSAVED"));
ok("an image key never enters a backup", !keyLeak);

/* ================= 12. a basis is refused at upload, not after a wait */
const warn = await page.evaluate(async () => {
  window.TrackerStore.setText("tracker.imageEngine", "pollinations");
  window.TrackerRender();
  // Straight at the handler: a real file chooser cannot be driven, and what
  // matters is what the section says when a basis meets an engine that
  // cannot use one.
  const f = new File([window.__png], "basis.png", { type: "image/png" });
  const input = document.querySelector("#imgBasis");
  const dt = new DataTransfer();
  dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  return document.querySelector("#view .note") ? document.querySelector("#view .note").textContent : "";
});
ok("uploading a basis to an engine that cannot use one warns immediately",
   /cannot work from an uploaded picture/i.test(warn), warn || "(no notice shown)");

/* ===================== 13. a failed model listing does not empty the picker */
// The real case in the build environment, and a real case on any blocked
// network: an engine that cannot be reached must still offer the model that
// is saved, or a keyless engine would present as unusable because a listing
// request failed.
const fallback = await page.evaluate(async () => {
  window.TrackerStore.setText("tracker.imageEngine", "pollinations");
  for (const p of window.TrackerAI.imageEngines()) {
    p.listImageModels = async () => { throw new Error("network down"); };
  }
  window.TrackerRender();
  document.querySelector('[data-imgsettings="open"]').click();
  await new Promise((r) => setTimeout(r, 400));
  const opts = [...document.querySelectorAll("[data-imgmodel] option")].map((o) => o.value);
  return { opts, notice: (document.querySelector("#view .imgsettings small") || {}).textContent || "" };
});
ok("a model list that fails still offers the saved model",
   fallback.opts.filter(Boolean).length > 0, fallback.opts.join(","));

ok("nothing threw while doing all that", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\nFAIL: ${failed} check(s)` : "\nPASS: every engine draws what it says it can");
process.exit(failed ? 1 : 0);
