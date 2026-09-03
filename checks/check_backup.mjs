#!/usr/bin/env node
/**
 * Backup round trip: write, save, wipe, restore, and get everything back.
 *
 * The failure that matters is a silent one - a restore that comes back short,
 * or a bad file that half-loads and leaves storage in a state no one asked
 * for. Both are asserted here.
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
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);

// A value in every data key, so a missed key cannot hide behind an empty one.
const keys = await page.evaluate(() => window.TrackerStore.KEYS.data);
ok("the store declares its data keys", keys.length > 0, keys.join(", "));
await page.evaluate((ks) => {
  ks.forEach((k, i) => localStorage.setItem(k, JSON.stringify([{ marker: "v" + i }])));
}, keys);

const payload = await page.evaluate(() => JSON.stringify(window.TrackerStore.exportData()));
const saved = JSON.parse(payload);
ok("the backup carries every data key", Object.keys(saved.keys).length === keys.length,
   `${Object.keys(saved.keys).length} of ${keys.length}`);
ok("the backup is labelled so a stray file can be told apart",
   saved.format === "project-tracker-backup" && saved.version === 1);

// Wipe, then restore.
await page.evaluate((ks) => ks.forEach((k) => localStorage.removeItem(k)), keys);
const empty = await page.evaluate((ks) => ks.filter((k) => localStorage.getItem(k) !== null), keys);
ok("storage really was cleared before restoring", empty.length === 0, empty.join(", "));

const n = await page.evaluate((p) => window.TrackerStore.importData(JSON.parse(p)), payload);
ok("restore reports every key", n === keys.length, `${n} of ${keys.length}`);
const back = await page.evaluate((ks) => ks.map((k, i) => {
  const v = localStorage.getItem(k);
  try { return JSON.parse(v)[0].marker === "v" + i; } catch { return false; }
}), keys);
ok("every key came back with its own value", back.every(Boolean),
   `${back.filter(Boolean).length} of ${keys.length}`);

/* A bad file must change nothing. */
for (const [name, bad] of [
  ["a file that is not a backup", '{"hello":"world"}'],
  ["a backup with no data", '{"format":"project-tracker-backup","version":1,"keys":{}}'],
  ["a damaged backup", '{"format":"project-tracker-backup","version":1,"keys":{"tracker.tasks":"{oops"}}'],
]) {
  const res = await page.evaluate((b) => {
    const before = JSON.stringify(window.TrackerStore.KEYS.data.map((k) => localStorage.getItem(k)));
    let threw = false;
    try { window.TrackerStore.importData(JSON.parse(b)); } catch { threw = true; }
    const after = JSON.stringify(window.TrackerStore.KEYS.data.map((k) => localStorage.getItem(k)));
    return { threw, unchanged: before === after };
  }, bad);
  ok(`${name} is refused`, res.threw);
  ok(`${name} leaves storage untouched`, res.unchanged);
}

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} backup check(s) failed` : "\nPASS: backup saves and restores everything");
process.exit(failed ? 1 : 0);
