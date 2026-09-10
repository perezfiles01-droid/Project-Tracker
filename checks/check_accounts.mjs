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
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
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
    bare: all.filter((k) => !k.includes("::") && k !== "tracker.session"),
  };
});
ok("each account has its own set of real storage keys",
   shape.a === keys.length && shape.b === keys.length,
   `A ${shape.a}, B ${shape.b}, of ${keys.length}`);
// tracker.session is the ONE deliberately unscoped key: it is the pointer that
// selects the scope, so it cannot itself be behind the scope. Anything else
// unscoped is a key that escaped the mapper.
ok("nothing but the session pointer was written to an unscoped key",
   shape.bare.length === 0, shape.bare.join(", ") || "0 unscoped");

const session = await page.evaluate(() => {
  window.TrackerStore.setSession({ id: "u1", name: "N", email: "e@x", kind: "hosted",
                                   password: "hunter2", token: "secret-token" });
  return localStorage.getItem("tracker.session");
});
ok("the session pointer carries no credential",
   !/hunter2|secret-token|password|token/i.test(session || ""), session);

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

/* ---------- the gate ----------
   Served over http, because the offline file has no origin a sign-in could
   work against and deliberately runs as one device account. The assertion
   that matters is that the tracker is not merely hidden while signed out -
   it was never rendered, so there is nothing in the page to read. */
const server = createServer((req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = join(root, rel === "/" ? "index.html" : rel.replace(/^\/+/, ""));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const type = file.endsWith(".js") ? "text/javascript"
      : file.endsWith(".css") ? "text/css"
      : file.endsWith(".json") ? "application/json"
      : file.endsWith(".svg") ? "image/svg+xml" : "text/html";
    res.writeHead(200, { "content-type": type }).end(readFileSync(file));
  } catch { res.writeHead(404).end("no"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const site = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const siteErrors = [];
site.on("pageerror", (e) => siteErrors.push(String(e)));
await site.goto(origin + "/index.html", { waitUntil: "load" });
await site.waitForTimeout(600);

const SECRET = /SECRETTASK|SECRETLINK/;

ok("the hosted page shows a sign-in screen, not the tracker",
   await site.evaluate(() => !!document.querySelector(".acct-gate")));
ok("the sidebar navigation is empty while signed out",
   await site.evaluate(() => document.querySelector("#nav").innerHTML.trim() === ""));
ok("the page marks itself signed out, so its chrome can be hidden",
   await site.evaluate(() => document.body.dataset.signedIn === "no"));

/* --- sign in, and put real content on the screen ---
   Seeded into the account that is actually signed in and then RENDERED, so
   the absence assertion after the sign-out has something to be the absence
   OF. Seeding an account nobody is signed into would make it pass whatever
   the gate did, which is a check that cannot fail. */
await site.click("#acctDevice");
await site.waitForTimeout(400);
ok("signing in draws the tracker",
   await site.evaluate(() => !document.querySelector(".acct-gate")
     && document.body.dataset.signedIn === "yes"));
ok("the sidebar says who is signed in, and offers a way out",
   await site.evaluate(() => !!document.querySelector("#acctOut")
     && document.querySelector("#acct").textContent.trim().length > 0));

await site.evaluate(() => {
  window.TrackerStore.set("tracker.tasks",
    [{ id: "t1", name: "SECRETTASK", status: "Open", created: new Date().toISOString() }]);
  window.TrackerStore.set("tracker.userLinks",
    [{ name: "SECRETLINK", url: "https://example.com", project: "Ad hoc" }]);
  window.TrackerGo("todo");
});
await site.waitForTimeout(300);
const bodyIn = await site.evaluate(() => document.body.innerHTML);
ok("the signed-in account's own content really is on the screen",
   SECRET.test(bodyIn), "so its absence below means something");

/* --- and signing out takes it away --- */
await site.click("#acctOut");
await site.waitForTimeout(400);
const bodyAfter = await site.evaluate(() => document.body.innerHTML);
ok("signing out returns to the screen and empties the view",
   await site.evaluate(() => !!document.querySelector(".acct-gate")));
ok("nothing of the signed-out account survives in the page",
   !SECRET.test(bodyAfter));

ok("the store is pointed at no account after signing out",
   await site.evaluate(() => window.TrackerStore.getScope() === ""));

/* --- and the next account in sees none of it --- */
await site.evaluate(() => {
  window.TrackerStore.setSession(null);
  window.TrackerAccount.init();
});
await site.click("#acctDevice");
await site.waitForTimeout(300);
await site.evaluate(() => { window.TrackerStore.setScope("a-different-person"); window.TrackerRender(); });
await site.waitForTimeout(300);
ok("a different account signing in sees none of the first account's content",
   !SECRET.test(await site.evaluate(() => document.body.innerHTML)));
/* --- a hosted account must never be restorable from the pointer alone --- */
const forged = await site.evaluate(async () => {
  window.TrackerStore.setSession({ id: "someone-else", name: "Someone", kind: "hosted" });
  await window.TrackerAccount.init();
  return { user: window.TrackerAccount.current(), scope: window.TrackerStore.getScope() };
});
ok("editing the session pointer cannot sign you in as a hosted account",
   forged.user === null && forged.scope === "", JSON.stringify(forged));

ok("no page errors on the hosted page", siteErrors.length === 0, siteErrors.join(" | "));
server.close();

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} account check(s) failed` : "\nPASS: each account has its own tracker");
process.exit(failed ? 1 : 0);
