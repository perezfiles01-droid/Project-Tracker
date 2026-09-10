#!/usr/bin/env node
/**
 * Guard: a panel closes on Cancel, never on a click beside it.
 *
 * Every dialog in this app lives in a `.modal` host that covers the whole
 * screen, with the visible panel as a `.box` inside it. All three dismissal
 * sites used to read a click that landed on the host — that is, anywhere in
 * the dimmed area — as a cancel. The Edit update panel holds typed text,
 * rich-text and staged attachments, and Settings holds a Client ID and an API
 * key; a misplaced click discarded either.
 *
 * Two halves, both enumerating at runtime rather than from a list here:
 *   1. Source: every assets/*.js, read through the stripper so a comment or a
 *      string cannot produce a hit, must contain no comparison of an event
 *      target against a modal host. A module added later is covered without
 *      this file being touched.
 *   2. Behaviour: each dialog kind in the shipped standalone file is opened,
 *      the backdrop is clicked, and the panel must still be there with what
 *      was typed intact — then Cancel must close it. Escape is deliberate and
 *      stays; it is asserted to still work, so this guard cannot be satisfied
 *      by nailing a dialog shut.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import { executableCode as code } from "./lib/code.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

/* ---------- 1. source: nobody treats the backdrop as a close button ----------
   Three shapes, because the three dialogs were each written by hand:
   `e.target === box` (the two in ui.js), an id comparison against a modal
   element (Settings), and a classList test, which is the shape someone
   reaching for this again would most likely write. */
const BACKDROP = [
  [/\.target\s*===\s*(box|host|modal|overlay|scrim)\b/, "compares the event target to the dialog host"],
  [/\.target\.id\s*===\s*["'][A-Za-z0-9_]*[Mm]odal["']/, "compares the event target id to a modal element"],
  [/\.target\.classList\.contains\(\s*["']modal["']\s*\)/, "tests the event target for the modal class"],
];
/* Strings are KEPT here. The default stripper blanks them, which turns
   `e.target.id === "settingsModal"` into `e.target.id === ""` — indistinguishable
   from a legitimate comparison against a button id, so the middle rule above
   could never fire and the Settings fault would have been reported clean. Only
   comments are removed, which is all that is needed: a comment cannot execute. */
const scan = (src) => code(src, true);
const files = readdirSync(join(root, "assets")).filter((f) => f.endsWith(".js"));
ok("assets/*.js were found to scan", files.length > 0, `${files.length} modules`);
for (const f of files) {
  const src = scan(readFileSync(join(root, "assets", f), "utf8"));
  for (const [re, why] of BACKDROP) {
    ok(`${f} ${why.replace(/^/, "never ")}`, !re.test(src));
  }
}

/* The stripper is what the whole source half rests on: if it swallows code,
   every assertion above passes and reports nothing, which reads exactly like
   a clean sweep. Assert the real files survive it. */
for (const f of files) {
  const src = readFileSync(join(root, "assets", f), "utf8");
  const stripped = scan(src);
  ok(`${f} survives the stripper`,
     stripped.length > src.length * 0.2 && /\bfunction\b|=>/.test(stripped),
     `${stripped.length} of ${src.length} chars`);
  // Not just "something survived": the declarations must still be there, and
  // the braces must still balance. A stripper that desynchronises on a regex
  // literal eats the rest of the file and every rule above then passes.
  const braces = [...stripped].reduce((n, c) => n + (c === "{") - (c === "}"), 0);
  ok(`${f} keeps its braces balanced through the stripper`, braces === 0, `${braces}`);
  // And the string contents are actually there — the whole point of this
  // mode. A blanked-strings pass would be shorter and would report clean.
  ok(`${f} keeps its string contents`,
     stripped.length > code(src).length, `${stripped.length} vs ${code(src).length}`);
}

/* A near-miss the guard must NOT flag: closing on a Cancel button is exactly
   what these dialogs are supposed to do. */
const nearMiss = `const onClick = (e) => { if (e.target.closest('[data-fd="cancel"]')) close(null); };`;
ok("a Cancel-button close is not flagged",
   !BACKDROP.some(([re]) => re.test(scan(nearMiss))));
ok("a comparison against a button id is not flagged",
   !BACKDROP.some(([re]) => re.test(scan(`if (e.target.id === "settingsCancel") close();`))));
/* And a planted fault the guard must catch, so a passing run means something. */
for (const planted of [`if (e.target === box) close();`,
                       `if (e.target.id === "settingsModal") hide();`,
                       `if (e.target.classList.contains("modal")) hide();`]) {
  ok(`a planted backdrop close IS flagged: ${planted.slice(4, 40)}`,
     BACKDROP.some(([re]) => re.test(scan(planted))));
}
ok("the fault is not seen when it sits in a comment",
   !BACKDROP.some(([re]) => re.test(scan(`// if (e.target === box) close();`))));

/* ---------- 2. behaviour, in the file that actually ships ---------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const url = "file://" + join(root, "Tracker-standalone.html");
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(400);

/** The dimmed area, never the panel: top-left of the host, well clear of the box. */
async function clickBackdrop(sel) {
  const b = await page.locator(sel).boundingBox().catch(() => null);
  if (!b) return;
  await page.mouse.click(b.x + 6, b.y + 6);
  await page.waitForTimeout(200);
}
const visible = (sel) => page.locator(sel).isVisible();
/* Read a field without throwing. When the fault is present the panel is
   already gone by this point, and a check that dies on the first finding
   hides the rest of them. */
const valueOf = async (sel) => {
  try { return await page.inputValue(sel, { timeout: 1500 }); } catch { return null; }
};
/* Same reason: clicking a button that is no longer there must be a finding,
   not a crash. */
const clickIfThere = async (sel) => {
  try { await page.click(sel, { timeout: 1500 }); } catch { /* reported by the assertion */ }
  await page.waitForTimeout(250);
};

/* --- the form dialog: New task, reached the way a person reaches it --- */
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(300);
await clickIfThere('[data-edit="task:new"]');
ok("New task opens a panel", await visible("#formDialog"));
const nameField = "#fd_name";
await page.fill(nameField, "typed and not to be lost", { timeout: 5000 });
await clickBackdrop("#formDialog");
ok("form panel survives a click on the backdrop", await visible("#formDialog"));
// Compared case-insensitively on the first letter: this field carries
// data-capitalize, so the app raises it as you type. What matters is that
// the text is still there, not its casing.
ok("what was typed survives it too",
   (await valueOf(nameField) || "").toLowerCase() === "typed and not to be lost");
await clickIfThere('#formDialog [data-fd="cancel"]');
ok("form panel closes on Cancel", !(await visible("#formDialog")));

/* --- the read-only viewer --- */
// Not returned: htmlDialog resolves only when the dialog closes, and
// page.evaluate awaits whatever it is handed — returning it hangs forever.
await page.evaluate(() => { window.TrackerUI.htmlDialog({ title: "A trail", html: "<p>rows</p>" }); });
await page.waitForTimeout(250);
ok("the read-only viewer opens", await visible("#formDialog"));
await clickBackdrop("#formDialog");
ok("viewer survives a click on the backdrop", await visible("#formDialog"));
await clickIfThere('#formDialog [data-fd="cancel"]');
ok("viewer closes on its button", !(await visible("#formDialog")));

/* --- Settings --- */
await clickIfThere("#openSettings");
ok("Settings opens", await visible("#settingsModal"));
await page.fill("#clientId", "kept-through-a-stray-click", { timeout: 5000 });
await clickBackdrop("#settingsModal");
ok("Settings survives a click on the backdrop", await visible("#settingsModal"));
ok("the credential survives it too",
   (await valueOf("#clientId")) === "kept-through-a-stray-click");
await clickIfThere("#settingsCancel");
ok("Settings closes on Cancel", !(await visible("#settingsModal")));

/* --- Escape is deliberate and still works: a dialog nailed shut is not the
       fix that was asked for. --- */
await clickIfThere('[data-edit="task:new"]');
ok("a panel is open again", await visible("#formDialog"));
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
ok("Escape still closes a panel", !(await visible("#formDialog")));

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
