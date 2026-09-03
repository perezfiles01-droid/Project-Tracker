#!/usr/bin/env node
/**
 * Behavioural guard for the paged tables on the Drive page.
 *
 * Balanced markup is not enough: a table can be well formed and still show
 * the wrong number of rows, lose its buttons after paging, or strand the
 * reader on an empty page when a search shrinks the list. This drives the
 * real page in a real browser and asserts the invariants.
 *
 * Page sizes are read from the source rather than hardcoded here, so the
 * check follows the app if the sizes change.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "assets/drive.js"), "utf8");
const num = (name) => {
  const m = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`could not read ${name} from drive.js — check has drifted from the app`);
  return Number(m[1]);
};
const COLS = num("PINNED_COLS"), ROWS = num("PINNED_ROWS"), FILES = num("FILES_PER_PAGE");
const PINNED = COLS * ROWS;

let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const url = "file://" + join(root, "Tracker-standalone.html");

// Seed more pinned links than fit on one page, then drive the pager.
await page.goto(url, { waitUntil: "load" });
await page.evaluate((n) => {
  const links = [];
  for (let i = 1; i <= n; i++) {
    links.push({ id: "p" + i, name: "Pinned link " + i, url: "https://example.test/" + i,
                 project: "Google Drive", meta: "manual", verified: true });
  }
  localStorage.setItem("tracker.driveLinks", JSON.stringify(links));
}, PINNED + 1);
await page.goto(url, { waitUntil: "load" });
await page.click('button[data-route="drive"]');
await page.waitForSelector("table.cellgrid");

const shape = async () => page.evaluate(() => {
  const t = document.querySelector("table.cellgrid");
  const rows = [...t.querySelectorAll("tbody tr")];
  return {
    rows: rows.length,
    cols: Math.max(...rows.map((r) => r.children.length)),
    filled: rows.reduce((n, r) => n + [...r.children].filter((c) => !c.classList.contains("pad")).length, 0),
  };
});

let s = await shape();
ok(`pinned page 1 has ${ROWS} rows`, s.rows === ROWS, `saw ${s.rows}`);
ok(`pinned page 1 has ${COLS} columns`, s.cols === COLS, `saw ${s.cols}`);
ok(`pinned page 1 holds ${PINNED} links`, s.filled === PINNED, `saw ${s.filled}`);
ok("Prev is disabled on the first page",
   await page.locator('[data-page="pinned:prev"]').isDisabled());

await page.click('[data-page="pinned:next"]');
await page.waitForTimeout(150);
s = await shape();
ok("pinned page 2 holds the remaining 1 link", s.filled === 1, `saw ${s.filled}`);
ok("pinned page 2 never exceeds the page size", s.filled <= PINNED);
ok("Next is disabled on the last page",
   await page.locator('[data-page="pinned:next"]').isDisabled());
ok("Remove button survives paging",
   (await page.locator("table.cellgrid [data-unpin]").count()) === 1);

// A search that shrinks the list must not strand the reader on an empty page.
await page.fill("#q", "Pinned link 1");
await page.waitForTimeout(200);
const stranded = await page.evaluate(() =>
  !!document.querySelector("table.cellgrid") &&
  document.querySelectorAll("table.cellgrid tbody td:not(.pad)").length === 0);
ok("a shrinking search never leaves an empty page", !stranded);
await page.fill("#q", "");
await page.waitForTimeout(150);

// Files table: seed through the app's own render path.
await page.evaluate((n) => {
  const files = [];
  for (let i = 1; i <= n; i++) {
    files.push({ id: "f" + i, name: "File " + i, mimeType: "application/vnd.google-apps.document",
                 webViewLink: "https://example.test/f" + i, modifiedTime: "2026-08-0" + ((i % 9) + 1) + "T00:00:00Z" });
  }
  window.TrackerDrive._seed(files);
}, 50);
await page.waitForSelector("table.filetable");

const fileRows = async () => page.locator("table.filetable tbody tr").count();
ok(`files page 1 shows ${FILES} rows`, (await fileRows()) === FILES, `saw ${await fileRows()}`);

let seen = await fileRows();
for (let i = 0; i < 4; i++) {
  await page.click('[data-page="files:next"]');
  await page.waitForTimeout(120);
  const n = await fileRows();
  ok(`files page ${i + 2} shows no more than ${FILES} rows`, n <= FILES, `saw ${n}`);
  seen += n;
}
ok("paging reaches every one of the 50 files", seen === 50, `counted ${seen}`);
ok("Next is disabled on the final files page",
   await page.locator('[data-page="files:next"]').isDisabled());
ok("Pin buttons survive paging",
   (await page.locator("table.filetable [data-pin]").count()) > 0);

ok("no console or page errors", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(failed ? `\n${failed} render check(s) failed` : "\nPASS: paged tables behave");
process.exit(failed ? 1 : 0);
