#!/usr/bin/env node
/**
 * The tracker is account-based: what one account stores, another cannot read.
 *
 * Every key this app owns is a logical name that store.js maps to a real
 * localStorage key by appending the signed-in account's id. That mapping is
 * the whole of the isolation, so it is asserted here against the real built
 * page rather than reasoned about.
 *
 * The keys are enumerated at RUNTIME from TrackerStore.ALL. A key added next
 * month is covered by this check without this file being edited - which is
 * the point, because a key that escapes the scoping is a key one account
 * reads out of another's tracker, silently.
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

/* --- the store can be pointed at an account at all --- */
const api = await page.evaluate(() =>
  ["setScope", "getScope"].filter((f) => typeof window.TrackerStore[f] !== "function"));
ok("the store can be pointed at an account", api.length === 0, api.join(", ") || "setScope, getScope");
if (api.length) { console.log("\nFAIL: no account scope"); await browser.close(); process.exit(1); }

const keys = await page.evaluate(() => window.TrackerStore.ALL);
ok("the store declares its keys", keys.length > 0, `${keys.length} keys`);

/* --- write a distinct marker into EVERY key, as account A --- */
const write = (uid, tag) => page.evaluate(({ uid, tag }) => {
  window.TrackerStore.setScope(uid);
  window.TrackerStore.ALL.forEach((k, i) => window.TrackerStore.setText(k, `${tag}-${i}`));
}, { uid, tag });

const readAll = (uid) => page.evaluate((uid) => {
  window.TrackerStore.setScope(uid);
  return window.TrackerStore.ALL.map((k) => window.TrackerStore.getText(k, ""));
}, uid);

await page.evaluate(() => localStorage.clear());
await write("account-A", "alpha");
const asA = await readAll("account-A");
ok("account A can read back everything it wrote",
   asA.every((v, i) => v === `alpha-${i}`), `${asA.filter(Boolean).length} of ${keys.length}`);

/* --- the central assertion: account B sees NOTHING of account A --- */
const asB = await readAll("account-B");
const leaked = asB.map((v, i) => (v === "" ? null : keys[i])).filter(Boolean);
ok("a second account reads none of the first account's keys",
   leaked.length === 0, leaked.length ? "leaked: " + leaked.join(", ") : `${keys.length} keys empty`);

/* --- and writing as B does not touch what A holds --- */
await write("account-B", "beta");
const asBAgain = await readAll("account-B");
ok("account B reads back its own values",
   asBAgain.every((v, i) => v === `beta-${i}`));
const backToA = await readAll("account-A");
ok("account A is unchanged after B wrote every key",
   backToA.every((v, i) => v === `alpha-${i}`),
   backToA.filter((v, i) => v !== `alpha-${i}`).length + " changed");

/* --- signing out leaves the scope empty, not on the last account --- */
const afterOut = await page.evaluate(() => {
  window.TrackerStore.setScope("account-A");
  window.TrackerStore.setScope("");
  return window.TrackerStore.getScope();
});
ok("signing out clears the scope", afterOut === "", `scope is "${afterOut}"`);

/* --- the ids really are separate keys in storage, not one key overwritten --- */
const shape = await page.evaluate(() => {
  const all = Object.keys(localStorage);
  return {
    a: all.filter((k) => k.endsWith("::account-A")).length,
    b: all.filter((k) => k.endsWith("::account-B")).length,
    bare: all.filter((k) => !k.includes("::")).length,
  };
});
ok("each account has its own set of real storage keys",
   shape.a === keys.length && shape.b === keys.length,
   `A ${shape.a}, B ${shape.b}, of ${keys.length}`);
ok("nothing was written to an unscoped key while signed in",
   shape.bare === 0, `${shape.bare} unscoped`);

/* --- undo must not be able to replay one account's bytes into another --- */
const history = await page.evaluate(() => {
  window.TrackerStore.setScope("account-A");
  window.TrackerStore.set("tracker.tasks", [{ name: "A's task" }]);
  return new Promise((resolve) => queueMicrotask(() => {
    const had = window.TrackerStore.canUndo();
    window.TrackerStore.setScope("account-B");
    resolve({ had, after: window.TrackerStore.canUndo(), depth: window.TrackerStore.undoDepth() });
  }));
});
ok("an edit is undoable within an account", history.had);
ok("the undo history is dropped when the account changes",
   history.after === false && history.depth === 0, `depth ${history.depth}`);

/* --- a backup is the signed-in account's data, not the machine's --- */
const exported = await page.evaluate(() => {
  window.TrackerStore.setScope("account-B");
  return window.TrackerStore.exportData().keys["tracker.tasks"] ?? null;
});
ok("a backup carries the signed-in account's data",
   exported !== null && !String(exported).includes("A's task"), String(exported).slice(0, 40));

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} account check(s) failed` : "\nPASS: each account has its own tracker");
process.exit(failed ? 1 : 0);
