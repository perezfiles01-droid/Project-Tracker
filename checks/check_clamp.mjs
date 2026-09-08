#!/usr/bin/env node
/**
 * Guard: long prose in a table cell is bounded, and the control that opens it
 * appears only where it is needed.
 *
 * The fault this exists for shipped once already: an update with a long body
 * rendered at full height, ran the whole pane, and pushed every entry after it
 * off the screen. The rule at fault was three lines of CSS with no height
 * bound at all.
 *
 * Five things fail quietly if nobody drives them:
 *
 *   1. The bound itself. Collapsed text must be about three lines tall, not
 *      however tall the text happens to be.
 *   2. The toggle appears on text that overflows. Measured, never counted from
 *      newlines - one unbroken paragraph wraps to eight visual lines with no
 *      newline in it, and that is the exact shape that was reported.
 *   3. The toggle does NOT appear on text that fits. A control that reveals
 *      nothing trains you to ignore it, and false positives get a feature
 *      switched off within a week.
 *   4. Both directions work. "Show more" opening is half a toggle.
 *   5. What is open stays open across a re-render. The pane re-renders on any
 *      status change, and a collapse nobody asked for reads exactly like the
 *      button not working.
 *
 * Every consumer of the helper is enumerated from the running page rather than
 * named here, so a third place that clamps prose is driven by this check
 * without it being edited.
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
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("file://" + join(root, "Tracker-standalone.html"), { waitUntil: "load" });
await page.waitForTimeout(300);

/* One long paragraph with NO newline in it, which is the case a newline count
   gets wrong, and one genuinely short line. */
const LONG = "The breadcrumb trail only displays correctly when navigating step by step. " +
  "When opening a location directly from the favorites or recent locations panel, it fails " +
  "to show the full path, missing the parent path or the tail. The complete breadcrumb trail " +
  "should display properly regardless of how the location is accessed, and the same root " +
  "cause explains the go to parent problem as well.";
const SHORT = "Short one.";

await page.evaluate(({ LONG, SHORT }) => {
  localStorage.setItem("tracker.tasks", JSON.stringify([{
    id: "t-1700000000000", name: "Clamp task", description: LONG,
    given: "2026-09-01", createdAt: "2026-09-01T09:00:00.000Z",
    status: "In progress", assignee: "Jim", attachments: [],
    updates: [
      { id: "u-long", date: "2026-09-01", at: "2026-09-01T10:00:00.000Z", text: LONG, images: [] },
      { id: "u-short", date: "2026-09-02", at: "2026-09-02T10:00:00.000Z", text: SHORT, images: [] },
    ],
  }, {
    id: "t-1700000000001", name: "Short task", description: SHORT,
    given: "2026-09-01", createdAt: "2026-09-01T09:00:00.000Z",
    status: "In progress", assignee: "Jim", attachments: [], updates: [],
  }]));
  localStorage.setItem("tracker.activity", "[]");
}, { LONG, SHORT });
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(300);
await page.click('#nav button[data-route="todo"]');
await page.waitForTimeout(250);

/** The measurements a clamped block reports about itself. */
const measure = (key) => page.evaluate((k) => {
  const box = document.querySelector(`[data-clamp="${k}"]`);
  if (!box) return null;
  const text = box.querySelector(".clamptext");
  const btn = box.querySelector(".clamptoggle");
  const lh = parseFloat(getComputedStyle(text).lineHeight) || 20;
  return {
    open: box.classList.contains("open"),
    height: text.clientHeight,
    full: text.scrollHeight,
    lines: text.clientHeight / lh,
    toggleShown: !!btn && !btn.hidden,
    toggleText: btn ? btn.textContent.trim() : "",
  };
}, key);

/* --- the description clamps, and it is the same helper ------------------- */
await page.click(".taskrow");
await page.waitForTimeout(300);
let d = await measure("d:t-1700000000000");
ok("the long description is a clamped block", !!d);
ok("it is bounded to about three lines", d && d.lines > 2.5 && d.lines < 4,
   d && `${d.lines.toFixed(2)} lines, ${d.height}px of ${d.full}px`);
ok("it is genuinely clipping text", d && d.full > d.height + 10,
   d && `${d.height} shown of ${d.full}`);
ok("it offers Show more", d && d.toggleShown && d.toggleText === "Show more", d && d.toggleText);

/* --- opening and closing both work --------------------------------------- */
await page.click('[data-clamptoggle="d:t-1700000000000"]');
await page.waitForTimeout(200);
d = await measure("d:t-1700000000000");
ok("Show more reveals the whole text", d && d.open && d.height >= d.full - 2,
   d && `${d.height} of ${d.full}`);
ok("the control now says Show less", d && d.toggleText === "Show less", d && d.toggleText);
await page.click('[data-clamptoggle="d:t-1700000000000"]');
await page.waitForTimeout(200);
d = await measure("d:t-1700000000000");
ok("Show less puts it back to three lines", d && !d.open && d.lines < 4,
   d && `${d.lines.toFixed(2)} lines`);

/* --- text that fits gets no control at all ------------------------------- */
await page.click(".taskrow:nth-child(2)");
await page.waitForTimeout(300);
const short = await measure("d:t-1700000000001");
ok("a short description is still a clamped block", !!short);
ok("a short description offers no control", short && !short.toggleShown,
   short && `toggle shown: ${short.toggleShown}`);
ok("and is not clipped", short && short.full <= short.height + 1,
   short && `${short.height} of ${short.full}`);

/* --- the update trail, long and short side by side ----------------------- */
await page.click(".taskrow:nth-child(1)");
await page.waitForTimeout(250);
await page.click(".taskpane [data-updates]");
await page.waitForTimeout(300);
const uLong = await measure("u:u-long");
const uShort = await measure("u:u-short");
ok("a long update clamps to three lines", uLong && uLong.lines > 2.5 && uLong.lines < 4,
   uLong && `${uLong.lines.toFixed(2)} lines`);
ok("a long update offers Show more", uLong && uLong.toggleShown);
ok("a short update in the same trail offers nothing", uShort && !uShort.toggleShown,
   uShort && `toggle shown: ${uShort.toggleShown}`);

/* --- expanding one leaves its neighbours alone --------------------------- */
await page.click('[data-clamptoggle="u:u-long"]');
await page.waitForTimeout(200);
ok("expanding one update opens only that one",
   (await measure("u:u-long")).open === true && (await measure("u:u-short")).open === false);

/* --- and survives a re-render -------------------------------------------- */
await page.evaluate(() => window.TrackerRender());
await page.waitForTimeout(300);
ok("an expanded update is still expanded after a re-render",
   (await measure("u:u-long")).open === true,
   "a collapse nobody asked for reads as a broken button");

/* --- the trail clamps on the Daily activity page too --------------------- */
/* It used to be reached there through a read-only modal; a logged task's row
   opens the same pane the To Do List opens now, so the clamp has to hold on
   that page for the same reason - it is the same renderer. */
await page.click(".taskpane [data-updates]");   // back to details for the picker
await page.waitForTimeout(200);
await page.selectOption(".taskpane .statuspick", "Done");
await page.waitForSelector('#formDialog [data-fd="choice"]');
await page.click('#formDialog [data-fd="choice"]');
await page.waitForTimeout(400);
await page.click('#nav button[data-route="daily"]');
await page.waitForTimeout(400);
if (await page.locator(".taskpane .taskdetail").count() === 0) {
  await page.click("tr.taskrow[data-open]");
  await page.waitForSelector(".taskpane .taskdetail");
}
await page.click(".taskpane [data-updates]");
await page.waitForTimeout(400);
const onDaily = await page.evaluate(() => {
  const box = document.querySelector('.taskpane [data-clamp="u:u-long"]');
  if (!box) return null;
  const text = box.querySelector(".clamptext");
  const btn = box.querySelector(".clamptoggle");
  return { clipped: text.scrollHeight > text.clientHeight + 1 || box.classList.contains("open"),
           toggleShown: !!btn && !btn.hidden };
});
ok("the trail opened from Daily activity clamps too", !!onDaily && onDaily.toggleShown,
   JSON.stringify(onDaily));

/* --- every consumer, enumerated from the page, obeys the same rules ------ */
const all = await page.evaluate(() => [...document.querySelectorAll("[data-clamp]")].map((b) => {
  const text = b.querySelector(".clamptext");
  const btn = b.querySelector(".clamptoggle");
  return {
    key: b.dataset.clamp,
    open: b.classList.contains("open"),
    clipped: text.scrollHeight > text.clientHeight + 1,
    toggleShown: !!btn && !btn.hidden,
    bounded: getComputedStyle(text).overflow !== "visible" || b.classList.contains("open"),
  };
}));
ok("clamped blocks were found to check", all.length > 0, `${all.length} on this page`);
ok("every collapsed block is bounded", all.every((b) => b.bounded),
   all.filter((b) => !b.bounded).map((b) => b.key).join(", ") || "all bounded");
ok("no block offers a control it does not need",
   all.every((b) => b.toggleShown === (b.clipped || b.open)),
   all.filter((b) => b.toggleShown !== (b.clipped || b.open)).map((b) => b.key).join(", ") || "none");

ok("no page errors along the way", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${failed} clamp check(s) failed`);
process.exit(failed ? 1 : 0);
