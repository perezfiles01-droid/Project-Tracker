#!/usr/bin/env node
/**
 * Guard for the Email Access / Account used column.
 *
 * Two separate faults live here, and they look identical on screen:
 *   1. The DATA is masked (ji…@avepoint.com) by build_data.py --redact-emails.
 *      No amount of CSS reveals an address the file does not contain.
 *   2. The CELL is too narrow, so a real address breaks mid-word.
 *
 * This checks both: the published data carries no mask character, and a long
 * address neither overflows its cell nor is broken mid-word when rendered.
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

// --- 1. the data itself ------------------------------------------------------
const data = JSON.parse(readFileSync(join(root, "data/tracker.json"), "utf8"));
const accounts = [];
for (const p of data.projects || []) {
  for (const s of p.sections || []) {
    for (const i of s.items || []) if (i && i.account) accounts.push(i.account);
  }
}
ok("the data carries account addresses at all", accounts.length > 0, `found ${accounts.length}`);
const masked = accounts.filter((a) => a.includes("…"));
ok("no account address is masked", masked.length === 0,
   masked.length ? `${masked.length} masked, e.g. ${masked[0]}` : "");
const bare = accounts.filter((a) => a.includes("@") && !/^[\w.+-]+@[\w.-]+\.\w+$/.test(a));
ok("every address is a complete, well-formed address", bare.length === 0,
   bare.length ? `e.g. ${bare[0]}` : "");

// --- 2. how it renders -------------------------------------------------------
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(400);
await page.click('button[data-route="p:edrms"]');
await page.waitForTimeout(400);

const cells = page.locator("table td.acct, table .acctcell");
const n = await cells.count();
ok("account cells are rendered and identifiable", n > 0, `found ${n}`);

if (n > 0) {
  const worst = await page.evaluate(() => {
    const out = { overflow: 0, sample: "", lines: 1, text: "" };
    for (const c of document.querySelectorAll("table td.acct, table .acctcell")) {
      if (c.scrollWidth > c.clientWidth + 1) { out.overflow++; out.sample = c.textContent.trim(); }
      const cs = getComputedStyle(c);
      const lines = Math.round(c.scrollHeight / (parseFloat(cs.lineHeight) || 20));
      if (lines > out.lines) { out.lines = lines; out.text = c.textContent.trim(); }
    }
    return out;
  });
  ok("no account cell overflows its width", worst.overflow === 0,
     worst.sample ? `e.g. ${worst.sample}` : "");
  ok("no address is wrapped onto multiple lines", worst.lines <= 1,
     worst.text ? `${worst.lines} lines: ${worst.text}` : "");

  const first = (await cells.first().innerText()).trim();
  ok("a rendered address is complete", !first.includes("…"), first);
}

ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} email check(s) failed` : "\nPASS: addresses are complete and readable");
process.exit(failed ? 1 : 0);
