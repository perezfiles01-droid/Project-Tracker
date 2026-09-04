#!/usr/bin/env node
/**
 * Guard: the Project column filters itself, like Email Access does.
 *
 * The filter belongs to its column rather than to a control above the table -
 * a lone "All projects" select gives no clue which column it acts on, which is
 * the reason the Email Access one was moved into its header in the first
 * place. This asserts the behaviour, and then asserts the census: EVERY table
 * rendering a Project column offers the filter, enumerated from the DOM at
 * runtime rather than from a list written here, so a Project column added
 * later is covered rather than forgotten.
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);

await page.evaluate(() => localStorage.setItem("tracker.tasks", JSON.stringify([
  { id: "t-1", name: "Alpha one", project: "GLASS", attachments: [], status: "To do" },
  { id: "t-2", name: "Alpha two", project: "GLASS", attachments: [], status: "To do" },
  { id: "t-3", name: "Beta one", project: "EDRMS ADB", attachments: [], status: "To do" },
  { id: "t-4", name: "No project", project: "", attachments: [], status: "To do" },
])));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(300);

const rows = () => page.locator("tr.taskrow").count();
const pick = (v) => page.selectOption('[data-colfilter="tasks:project"]', v);
// The Settings dialog carries ledes of its own, so this reads the page's.
const lede = () => page.locator("#view p.lede").first().innerText();

ok("the Project header carries a filter",
   (await page.locator('th.filterhead [data-colfilter="tasks:project"]').count()) === 1);
const opts = await page.$$eval('[data-colfilter="tasks:project"] option', (o) => o.map((x) => x.value));
ok("it offers All plus every project a task actually uses",
   opts.length === 3 && opts[0] === "" && opts.includes("GLASS") && opts.includes("EDRMS ADB"),
   opts.join(" | "));
ok("a project no task uses is not offered", !opts.includes("Other"), opts.join(" | "));
ok("all four rows show before filtering", (await rows()) === 4, String(await rows()));

await pick("GLASS");
await page.waitForTimeout(250);
ok("choosing a project leaves only its tasks", (await rows()) === 2, String(await rows()));
const shown = await page.$$eval("tr.taskrow td:nth-child(2)", (td) => td.map((c) => c.innerText.trim()));
ok("and they are the right ones", shown.every((n) => n.startsWith("Alpha")), shown.join(", "));
ok("the count in the lede follows the filter", /2 of 4 tasks/.test(await lede()), await lede());
ok("the filter stays chosen after the re-render",
   (await page.inputValue('[data-colfilter="tasks:project"]')) === "GLASS");

await pick("EDRMS ADB");
await page.waitForTimeout(250);
ok("switching projects switches the rows", (await rows()) === 1, String(await rows()));

await pick("");
await page.waitForTimeout(250);
ok("All brings everything back", (await rows()) === 4, String(await rows()));

// The select sits inside a sortable header; clicking it must not also sort.
const before = await page.$$eval("tr.taskrow td:first-child", (td) => td.map((c) => c.innerText.trim()));
await page.click('[data-colfilter="tasks:project"]');
await page.waitForTimeout(200);
const after = await page.$$eval("tr.taskrow td:first-child", (td) => td.map((c) => c.innerText.trim()));
ok("clicking the filter does not sort the column too", before.join() === after.join(),
   `${before.join()} then ${after.join()}`);

/* --- the census: every Project column, wherever it is rendered ------------ */
const routes = await page.$$eval("#nav button[data-route]", (b) => b.map((x) => x.dataset.route));
const missing = [];
let seen = 0;
for (const route of routes) {
  await page.click(`#nav button[data-route="${route}"]`);
  await page.waitForTimeout(250);
  const found = await page.evaluate(() =>
    [...document.querySelectorAll("table")].map((t, i) => {
      const heads = [...t.querySelectorAll("thead th")];
      // Read the header's own label, not its innerText: a filtering header
      // contains its select's option text too ("Project All GLASS ..."), and
      // innerText applies text-transform, so matching on it found nothing and
      // reported a clean sweep. A census that cannot see its subject reads
      // exactly like a census with nothing to report.
      const name = (h) => {
        const label = h.querySelector(".filterlabel");
        const text = label ? label.textContent : (h.firstChild ? h.firstChild.textContent : "");
        return String(text || "").trim().replace(/[ ↑↓]+$/, "").toLowerCase();
      };
      const col = heads.find((h) => name(h) === "project");
      return col ? { i, filtered: !!col.querySelector("[data-colfilter]") } : null;
    }).filter(Boolean));
  for (const f of found) { seen++; if (!f.filtered) missing.push(`${route}#${f.i}`); }
}
ok("every table with a Project column offers the filter", missing.length === 0,
   `${seen} project column(s) found; unfiltered: ${missing.join(", ") || "none"}`);
ok("the census actually found a Project column to check", seen >= 1, String(seen));

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} project-filter check(s) failed`
                   : "\nPASS: the Project column filters itself");
process.exit(failed ? 1 : 0);
