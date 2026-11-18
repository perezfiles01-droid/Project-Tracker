/* Project updates — the running record of a project, day by day.

   Asked for 18 Nov 2026. At the end of a day (or later, catching up), the
   template goes to Claude, Claude writes the day's update from the chat in
   one fixed JSON shape, and the file is imported under its project. Each
   import adds to a timeline; the newest "where things stand" paragraph sits
   on top, with every action item and question still open from every day.

   Rules that came with the request:
   - The day an entry belongs to is the day things HAPPENED, written by
     Claude in the file, never the day it was imported. One file may carry
     several days, so a late catch-up lands on the right dates.
   - A second import for a day that already exists merges into it.
   - Everything in "where things stand" is editable: the paragraph, and each
     open item and question (reword, tick, delete).
   - ADB work is grouped by release (R2026.1, R2026.2, ...), with Hotfix and
     General for what belongs to none.

   Stored in tracker.updates, a KEYS.data key: backed up, synced, on undo. */
(() => {
  const KEY = "tracker.updates";
  const PROJECTS = [{ id: "adb", name: "ADB EDRMS" }, { id: "gra", name: "GRA GLASS" }];
  /* ADB's releases, in order. Claude may add a new one in the same pattern. */
  const RELEASES = {
    adb: ["R2026.1 Multiple Records", "R2026.2 Centralized", "R2026.3 Email Records",
      "R2026.3.1 Email Records Enhancement", "R2026.4 Utilization Report", "Hotfix", "General"],
    gra: ["General"],
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const S = () => window.TrackerStore;
  const render = () => window.TrackerRender();
  const uid = (p = "u") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  /* Added 18 Nov 2026: monthly (saved monthly summaries) and, per day,
     images. Both are optional, so data saved before them loads unchanged:
     nothing is migrated or rewritten, a missing field simply reads as empty. */
  const blank = () => ({ entries: [], status: {}, monthly: {} });
  const load = () => {
    const d = S().get(KEY, null);
    return d && Array.isArray(d.entries) ? { ...d, status: d.status || {}, monthly: d.monthly || {} } : blank();
  };
  const save = (d) => S().set(KEY, d);

  /* --------------------------------------------------------------- state */
  let project = null;
  let rel = "All";
  let editing = null;        // a day being edited: deep copy, or { status: true, text }
  let ai = null;
  let notice = "";
  let mode = "daily";          // "daily" | "monthly"
  let month = null;            // "YYYY-MM" on screen; null means the newest month with days
  let writing = null;          // { ym, text } while a monthly summary is being edited
  const projName = (id) => (PROJECTS.find((p) => p.id === id) || {}).name || id;

  /* ------------------------------------------------------------ releases */
  /** Order: the known list first, then anything new Claude introduced, sorted by number. */
  function releasesOf(p, entries) {
    const known = RELEASES[p] || ["General"];
    const seen = [...new Set(entries.filter((e) => e.project === p).flatMap((e) => e.blocks.map((b) => b.release)))];
    const extra = seen.filter((r) => !known.includes(r)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const head = known.filter((r) => r !== "Hotfix" && r !== "General");
    return [...head, ...extra, ...known.filter((r) => r === "Hotfix" || r === "General")];
  }
  /** Match what Claude wrote to a known release: "R2026.4", "2026.4", "utilization report" all land on one. */
  function canonRelease(p, raw) {
    const r = clean(raw);
    if (!r) return "General";
    const list = RELEASES[p] || ["General"];
    const num = (r.match(/\d{4}(?:\.\d+)+/) || [])[0];
    if (num) {
      const hit = list.find((x) => (x.match(/\d{4}(?:\.\d+)+/) || [])[0] === num);
      if (hit) return hit;
      // A release not in the list yet, written in the list's own pattern.
      const name = r.replace(/^.*?\d{4}(?:\.\d+)+\s*[-:–]?\s*/, "").trim();
      return "R" + num + (name ? " " + name : "");
    }
    const byName = list.find((x) => norm(x).includes(norm(r)) || norm(r).includes(norm(x.replace(/^R[\d.]+\s*/, ""))));
    if (byName) return byName;
    if (/hot\s*fix|patch|urgent fix/i.test(r)) return "Hotfix";
    return r.length > 40 ? "General" : r;
  }

  /* ------------------------------------------------------------ template */
  const templateFor = (only = project) => `# Project update template

You are writing my daily project update. Follow every rule below exactly, in every chat, every time. Never change the format, the field names or the order.

This always happens in TWO steps. Never skip step 1, even if everything looks clear.

1. **Check with me first** (below): ask me your questions with options, then show me the summary in plain words and wait for my answer.
2. **Only after I confirm**, send the file.

## The data file that comes with this template

I will usually upload a second file with this one, named like \`ADB EDRMS - project updates data.json\`. It is my tracker's record so far: "where things stand", the monthly summaries, and every day already recorded, by date and release. Read it FIRST, before asking me anything.
- Treat it as what is already recorded. Do not repeat a day already in it unless I ask you to change that day.
- Use it to write better questions (for example, which release something belongs to, or whether something new continues an earlier day) and to keep the monthly summary and "where things stand" complete.
- Never send the data file back. Your reply is only the update, in the shape below.
- If there is no data file, use the "Already recorded" section at the end of this template, if there is one.

## Where the content comes from

- Use everything we discussed in THIS chat about the project: meetings, client requests, requirements, decisions, progress, problems and next steps.
- Do not invent anything that was not discussed. If something is unclear, leave it out.
- **Dates:** every update belongs to the day the things in it HAPPENED, not today. If the chat covers several days, write one update per day. If you cannot tell which day something happened, ask me before answering.

## Step 1: Check with me first

### How to ask: clickable choices

- If you can show me clickable options (a multiple-choice question card, buttons, or any built-in way to ask me questions with choices), ALWAYS use it for every question in this template, including "Is this right?". Every option is something I can click, and every question ends with an "Other (none of these is right, I will type my answer)" option. If I pick it, let me type my own answer and use exactly what I type.
- Only if you cannot show clickable options: ask ONE question per message, with the options lettered A, B, C, D and a last line "Other (none of these is right, I will type my answer)", so I can reply with a single letter or type my own answer.
- Never write the JSON or the file during Step 1.

### Question 1, always first and always on its own

Ask exactly this first, nothing else, and wait for my answer:

> What do you want to put in this project update?
> A. Everything we discussed in this chat (my guess)
> B. Only one meeting or topic from this chat (tell me which)
> C. Something new that I will type or paste now
> D. A catch-up for days I have not recorded yet
> Other (none of these is right, I will type my answer)

My answer decides what goes in the update. Record only that. If I choose B, C, D or Other, wait until I have given you what you need before going on.

### Then the follow-up questions

**Part A. Questions.** After Question 1, ask me about everything you are still not sure of, as multiple-choice questions (clickable if you can; otherwise one at a time). Rules:
- Ask about anything uncertain, in this order: the date something happened; which release it belongs to; who was involved; anything that might be wrong or missing in the "Already recorded" section; and anything I said that could be read two ways.
- Every question has 2 to 4 lettered options (A, B, C, D) written as complete answers, put your best guess first and mark it "(my guess)", and always end with "Other (none of these is right, I will type my answer)". Never leave it out, even when you feel sure.
- One thing per question. At most 8 questions after Question 1. Plain words, no jargon.
- If you are genuinely sure about everything, skip straight to Part B, but you must still do Part B and Part C.

**Part B. The summary in plain words.** Show me what you will record, written so anyone could understand it in one read:
- **Where things stand:** the status paragraph exactly as you will save it.
- **This month:** the monthly summary exactly as you will save it.
- **Each day:** the date, the headline, and for each release 1 to 3 short bullet points of what happened.

**Part C. Confirm.** End with exactly this question (as clickable choices if you can):

> Is this right?
> A. Yes, send me the file.
> B. Change something (tell me what).
> C. Something is missing (tell me what).
> Other (none of these is right, I will type my answer)

Then STOP and wait for my reply. When I answer the questions or ask for changes, apply them, show me Part B again with the changes, and ask Part C again. Repeat until I choose A.

### How to write so it is simple to understand

- Short sentences, about 20 words or fewer. One idea per sentence.
- Everyday words. Say "agreed" not "aligned", "start" not "commence", "problem" not "issue" where it reads naturally. Explain any abbreviation the first time.
- Say who did what: "Maria approved the labels", not "the labels were approved".
- Lead with what matters most: what changed, what was decided, what happens next.
- No filler such as "it is worth noting" or "moving forward". No guessing; leave out anything not confirmed.

## Step 2: After I choose A, send the file

Reply with exactly these two things, in this order, and nothing else (no greeting, no explanation):

1. A downloadable file named \`update.json\` containing the JSON. If you cannot create files, skip this item.
2. The same JSON in a single code block marked \`json\`.

## The JSON shape

\`\`\`json
{
  "format": "tracker-update",
  "version": 1,
  "project": "",
  "status": "",
  "monthly": [
    { "month": "YYYY-MM", "summary": [""] }
  ],
  "updates": [
    {
      "date": "YYYY-MM-DD",
      "headline": "",
      "releases": [
        {
          "release": "",
          "summary": [""]
        }
      ]
    }
  ]
}
\`\`\`

## Rules for every field

- **format** is always \`"tracker-update"\`, **version** is always \`1\`.
- **project**: exactly \`"ADB EDRMS"\` or \`"GRA GLASS"\`.
- **status**: "Where things stand". One paragraph of 2 to 4 sentences, at most 80 words, describing the project's overall position as of the LATEST date in this file: what is done, what is next, the main risk. Plain language.
- **monthly**: the monthly summary, ALWAYS included. One entry per calendar month that any update in this file falls in.
  - **month**: that month as YYYY-MM.
  - **summary**: 2 to 4 paragraphs of plain prose, past tense, covering the WHOLE month so far, not just this file: what happened, what was achieved, what the client asked for or agreed, and what comes next, naming releases and people. If the section "Already recorded" below has a summary for that month, rewrite it to include everything in it plus what is new in this chat; never drop what it says unless this chat corrects it.
- **updates**: one entry per day, oldest first. Never two entries with the same date.
  - **date**: the day it happened, as YYYY-MM-DD.
  - **headline**: what the day was about, at most 10 words, sentence case, no full stop.
  - **releases**: one block per release the day touched. Never two blocks for the same release in one day.
    - **release**: for ADB EDRMS, exactly one of these names:
      R2026.1 Multiple Records, R2026.2 Centralized, R2026.3 Email Records, R2026.3.1 Email Records Enhancement, R2026.4 Utilization Report, Hotfix, General.
      Use **Hotfix** for urgent fixes outside a release, and **General** for anything belonging to no release. If the work is clearly for a NEW release, name it in the same pattern, for example "R2026.5 Short Name".
      For GRA GLASS, use **General** unless the chat names a release.
    - **summary**: 1 to 3 paragraphs, each a string of 2 to 5 full sentences, in plain past tense, readable on its own like meeting minutes: who met or asked, what was discussed, what came of it. Name people as they were named in the chat.
    - Only these two fields per release. Do NOT add decisions, action items, open questions or any other lists: everything goes into the summary paragraphs as plain prose.
- No markdown, no bold, no emoji, no line breaks inside any string.
- Valid JSON only: double quotes, no comments, no trailing commas.

## Example (copy this structure exactly)

\`\`\`json
{
  "format": "tracker-update",
  "version": 1,
  "project": "ADB EDRMS",
  "status": "The retention labels for email records are approved and ready to build. Migration testing of batch 2 is next. The main risk is the AvePoint licence renewal, which is still with IT.",
  "monthly": [
    {
      "month": "2026-11",
      "summary": [
        "November focused on email records. The records team reviewed the proposed retention labels and approved a seven-year label for correspondence and a one-year label for newsletters.",
        "A permissions error on the Finance library was fixed as a hotfix. The final label list goes to Maria next."
      ]
    }
  ],
  "updates": [
    {
      "date": "2026-11-18",
      "headline": "Email retention labels approved by the client",
      "releases": [
        {
          "release": "R2026.3 Email Records",
          "summary": [
            "Maria and the records team reviewed the proposed retention labels for email records. They accepted the seven-year label for correspondence and asked for a shorter one for newsletters."
          ]
        },
        {
          "release": "Hotfix",
          "summary": ["A permissions error on the Finance library was reported in the morning and fixed by resetting the inherited permissions."]
        }
      ]
    }
  ]
}
\`\`\`

## Check before you send the file

- [ ] I asked my questions with options, showed the plain summary, and you chose A.
- [ ] Everything you corrected or added in your answers is in the file.

- [ ] Only the file and one \`json\` code block, nothing else.
- [ ] Every date is the day it happened, as YYYY-MM-DD, oldest first, none repeated.
- [ ] Every release name is from the allowed list or follows the "R2026.x Name" pattern.
- [ ] Every summary paragraph reads on its own as full sentences.
- [ ] status describes the latest date in the file.
- [ ] monthly has one entry for every month in the file, each covering the whole month so far.
- [ ] The JSON is valid.
${alreadyRecorded(only)}`;
  /* What the app already holds, written into the template so a NEW chat can
     still write a whole-month summary: Claude rewrites what is here plus what
     is new, rather than summarising one day as if it were the month. */
  function alreadyRecorded(only) {
    const d = load();
    const parts = PROJECTS.filter((p) => !only || p.id === only).map((p) => {
      const months = Object.keys((d.monthly || {})[p.id] || {}).filter((k) => /^\d{4}-\d{2}$/.test(k)).sort().reverse().slice(0, 2);
      const st = (d.status || {})[p.id];
      if (!months.length && !(st && st.text)) return "";
      return [`### ${p.name}`, st && st.text ? `Where things stand (as of ${st.asOf || "unknown"}): ${st.text}` : "",
        ...months.map((m) => `Monthly summary for ${m}:\n${d.monthly[p.id][m].text}`)].filter(Boolean).join("\n\n");
    }).filter(Boolean);
    return parts.length ? `\n## Already recorded (use this)\n\nThis is what my tracker already holds. Build on it: the monthly summary you write must include it, updated with what is new.\n\n${parts.join("\n\n")}\n` : "";
  }
  /* Two files, asked for 18 Nov 2026: the instructions, and the record so
     far as data, so any new chat can read the project's history before
     asking what to add. Updates only: the paragraphs, never the lists an
     older version kept. */
  function dataFile(only = project) {
    const d = load();
    const projects = PROJECTS.filter((p) => !only || p.id === only).map((p) => ({
      project: p.name,
      status: ((d.status || {})[p.id] || {}).text || "",
      statusAsOf: ((d.status || {})[p.id] || {}).asOf || "",
      monthly: Object.entries((d.monthly || {})[p.id] || {}).filter(([k]) => /^\d{4}-\d{2}$/.test(k)).sort()
        .map(([month, v]) => ({ month, summary: String(v.text || "").split(/\n\s*\n/).filter(Boolean) })),
      updates: d.entries.filter((e) => e.project === p.id).sort((a, b) => a.date.localeCompare(b.date))
        .map((e) => ({ date: e.date, headline: e.headline, releases: e.blocks.filter((b) => b.summary.length).map((b) => ({ release: b.release, summary: b.summary })) })),
    }));
    return { format: "tracker-update-data", version: 1, note: "What my tracker already holds. Read it, do not send it back.",
      exported: new Date().toISOString().slice(0, 10), projects };
  }
  const dataName = (only = project) => (only ? projName(only) : "All projects") + " - project updates data.json";
  function downloadTemplate() {
    window.TrackerUI.saveBlob(new Blob([templateFor()], { type: "text/markdown" }), "Project-update-template.md");
    // A short gap: browsers drop a second download fired in the same instant.
    setTimeout(() => window.TrackerUI.saveBlob(new Blob([JSON.stringify(dataFile(), null, 2)], { type: "application/json" }), dataName()), 400);
  }

  /* --------------------------------------------------------------- parse */
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  function toISO(d) {
    const s = clean(d);
    if (ISO.test(s)) return s;
    const t = Date.parse(s);
    if (isNaN(t)) return "";
    const x = new Date(t);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  }
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const sentence = (s) => clean(s).replace(/^(\d+[.)]|[-*•])\s+/, "").replace(/\*\*/g, "");

  /** Claude's reply to { project, status, days: [{ date, headline, blocks }] }. */
  function parse(text, fallbackProject) {
    let t = String(text || "").replace(/^﻿/, "");
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && /[{[]/.test(fence[1])) t = fence[1];
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("No update was found in that. Paste the whole json block Claude gave you.");
    let data;
    try { data = JSON.parse(t.slice(a, b + 1).replace(/[“”]/g, '"')); }
    catch { throw new Error("That is not complete JSON. Copy the whole code block from Claude, from the first { to the last }."); }
    const named = PROJECTS.find((p) => norm(p.name) === norm(data.project) || norm(data.project).includes(p.id));
    const proj = named ? named.id : fallbackProject;
    const raw = data.updates || data.days || (data.date ? [data] : []);
    const days = list(raw).map((u) => {
      const date = toISO(u.date);
      const blocks = list(u.releases || u.blocks || (u.summary ? [u] : [])).map((r) => ({
        release: canonRelease(proj, r.release),
        summary: list(r.summary).flatMap((p) => String(p).split(/\n\s*\n/)).map(clean).filter(Boolean),
        decisions: list(r.decisions).map(sentence).filter(Boolean),
        actions: list(r.actions).map((x) => (typeof x === "string" ? { task: sentence(x) } : x))
          .map((x) => ({ id: uid("a"), text: sentence(x.task || x.text), owner: clean(x.owner), due: toISO(x.due), done: false }))
          .filter((x) => x.text),
        questions: list(r.questions).map((x) => (typeof x === "string" ? x : x.text))
          .map((x) => ({ id: uid("k"), text: sentence(x), done: false })).filter((x) => x.text),
      })).filter((r) => r.summary.length || r.decisions.length || r.actions.length || r.questions.length);
      return { date, headline: clean(u.headline).replace(/\.$/, ""), blocks: mergeBlocks([], blocks) };
    }).filter((d) => d.blocks.length);
    if (!days.length) throw new Error("No days with any content were found in that.");
    const undated = days.filter((d) => !d.date).length;
    if (undated) throw new Error(`${undated === 1 ? "One day has" : undated + " days have"} no date. Ask Claude to add the date each update happened (YYYY-MM-DD).`);
    const monthly = list(data.monthly).map((m) => ({
      ym: (String(m.month || "").match(/\d{4}-\d{2}/) || [])[0] || "",
      text: list(m.summary).flatMap((x) => String(x).split(/\n\s*\n/)).map(clean).filter(Boolean).join("\n\n"),
    })).filter((m) => m.ym && m.text);
    return { project: proj, named: !!named, status: clean(data.status), monthly, days };
  }

  /* --------------------------------------------------------------- merge */
  const dedupe = (a, b, key) => { const out = [...a]; for (const x of b) if (!out.some((y) => norm(key(y)) === norm(key(x)))) out.push(x); return out; };
  /** Blocks of the same release become one: newer paragraphs win, lists are combined. */
  function mergeBlocks(old, add) {
    const out = old.map((b) => ({ ...b }));
    for (const b of add) {
      const cur = out.find((x) => x.release === b.release);
      if (!cur) { out.push({ ...b }); continue; }
      if (b.summary.length) cur.summary = b.summary;
      cur.decisions = dedupe(cur.decisions, b.decisions, (x) => x);
      cur.actions = dedupe(cur.actions, b.actions, (x) => x.text);
      cur.questions = dedupe(cur.questions, b.questions, (x) => x.text);
    }
    return out;
  }
  function importParsed(p) {
    const d = load();
    let added = 0, merged = 0;
    for (const day of p.days) {
      const cur = d.entries.find((e) => e.project === p.project && e.date === day.date);
      if (cur) { cur.blocks = mergeBlocks(cur.blocks, day.blocks); if (day.headline) cur.headline = day.headline; cur.updated = new Date().toISOString(); merged++; }
      else { d.entries.push({ id: uid("d"), project: p.project, ...day, updated: new Date().toISOString() }); added++; }
    }
    // The status is replaced only by a file at least as recent as the one it came from.
    const latest = p.days.map((x) => x.date).sort().pop();
    const st = d.status[p.project];
    if (p.status && (!st || !st.asOf || latest >= st.asOf)) d.status[p.project] = { text: p.status, asOf: latest };
    d.monthly[p.project] = d.monthly[p.project] || {};
    for (const m of p.monthly || []) {
      const through = p.days.map((x) => x.date).filter((x) => x.startsWith(m.ym)).sort().pop() || m.ym + "-01";
      const cur = d.monthly[p.project][m.ym];
      if (cur && cur.through && through < cur.through) continue;   // a late catch-up never undoes a newer month summary
      d.monthly[p.project][m.ym] = { text: m.text, at: new Date().toISOString(), through };
    }
    save(d);
    return { added, merged, statusKept: !!(p.status && st && st.asOf && latest < st.asOf) };
  }

  /* -------------------------------------------------------------- search */
  /* Reuses the FAQ's meaning-aware ranking by giving each day the same shape. */
  const asDoc = (e) => ({
    id: e.id, title: e.headline, category: e.blocks.map((b) => b.release).join(" "), keywords: [],
    summary: e.blocks.flatMap((b) => b.summary).join(" "),
    sections: e.blocks.map((b) => ({ heading: b.release, steps: [] })),
  });
  const searchDays = (q, entries) => window.TrackerFAQ.search(q, entries.map(asDoc)).map((r) => ({ id: r.q.id, cover: r.cover }));

  async function askAI(query, entries) {
    ai = { q: query, ids: [], busy: true, note: "" };
    render();
    const titles = entries.map((e, i) => `${i + 1}. ${e.date}: ${e.headline}`).join("\n");
    try {
      const reply = await window.TrackerAI.match(`Question: ${query}\n\nTitles:\n${titles}`);
      const nums = [...new Set((String(reply).match(/\d+/g) || []).map(Number))].filter((n) => n >= 1 && n <= entries.length).slice(0, 3);
      ai = { q: query, ids: nums.map((n) => entries[n - 1].id), busy: false, note: nums.length ? "" : "The AI found no day that covers that." };
    } catch (err) { ai = { q: query, ids: [], busy: false, note: String(err && err.message || err) }; }
    render();
  }

  /* -------------------------------------------------------------- months */
  /* One page per calendar month, so a page never holds more than 31 days. */
  const ymOf = (iso) => String(iso || "").slice(0, 7);
  const FULLMONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthName = (ym) => { const [y, m] = ym.split("-").map(Number); return `${FULLMONTHS[m - 1]} ${y}`; };
  /** Months that have days, newest first. */
  const monthsOf = (days) => [...new Set(days.map((e) => ymOf(e.date)))].sort().reverse();

  /* -------------------------------------------------------------- images */
  /* Bytes go to IndexedDB through TrackerUI.storeImage, exactly like task
     attachments; a day keeps only the ids. So they ride in the backup file
     the same way (the backup packs every picture the data refers to). */
  async function storeFiles(files) {
    const out = [], errs = [];
    for (const f of files) {
      if (!/^image\//.test(f.type || "")) continue;
      const r = await window.TrackerUI.storeImage(f);
      if (r && r.error) { errs.push(r.error); continue; }
      const id = r && (r.html.match(/data-blob="([^"]+)"/) || [])[1];
      if (id) out.push({ id, name: f.name || "image" });
    }
    if (errs.length) flash(errs[0], 6000);
    return out;
  }
  async function addImagesTo(dayId, files) {
    const imgs = await storeFiles(files);
    if (!imgs.length) return;
    if (editing && !editing.status && editing.id === dayId) {
      editing.images = [...(editing.images || []), ...imgs];
      return render();
    }
    updateData((d) => { const e = d.entries.find((x) => x.id === dayId); if (e) e.images = [...(e.images || []), ...imgs]; });
    flash(`Added ${imgs.length} image${imgs.length === 1 ? "" : "s"}.`, 2500);
  }
  function pickImages(dayId) {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*"; inp.multiple = true;
    inp.onchange = () => addImagesTo(dayId, [...inp.files]);
    inp.click();
  }
  async function removeImage(dayId, imgId) {
    if (editing && !editing.status && editing.id === dayId) {
      editing.images = (editing.images || []).filter((x) => x.id !== imgId);
      return render();          // the bytes go when the edit is saved
    }
    const yes = await window.TrackerUI.confirmDialog({ title: "Remove this image?", intro: "It will be taken off this day.", confirmLabel: "Remove" });
    if (!yes) return;
    updateData((d) => { const e = d.entries.find((x) => x.id === dayId); if (e) e.images = (e.images || []).filter((x) => x.id !== imgId); });
    window.TrackerStore.holdBlobs([imgId]);   // deleted for real only once undo can no longer bring it back
  }
  async function viewImage(id, name) {
    const blob = await window.TrackerBlobs.get(id);
    if (!blob) return flash("That image is not in this browser.");
    const url = URL.createObjectURL(blob);
    await modal(`<div class="pu-lb"><img src="${url}" alt="${esc(name)}"></div>
      <div class="actions"><button class="btn" data-v="open" data-self="1">Open in new tab</button><button class="btn primary" data-v="cancel">Close</button></div>`,
      (m) => m.querySelector('[data-v="open"]').addEventListener("click", () => window.TrackerUI.openBlob(blob)));
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const imagesHtml = (e, editable) => {
    const imgs = e.images || [];
    if (!imgs.length && !editable) return "";
    return `<div class="pu-imgs">${imgs.map((x) => `<span class="pu-th">
        <button class="pu-thb" data-pu-view="${esc(x.id)}" data-name="${esc(x.name)}" title="${esc(x.name)}"><img data-blob="${esc(x.id)}" alt="${esc(x.name)}"></button>
        <button class="pu-thx" data-pu-imgdel="${esc(x.id)}" data-day="${esc(e.id)}" title="Remove image" aria-label="Remove image">✕</button></span>`).join("")}
      ${editable ? `<button class="pu-thadd" data-pu="addimg" data-id="${esc(e.id)}">+ Add image<small>or drop / paste</small></button>` : ""}</div>`;
  };

  /* ------------------------------------------------------- monthly view */
  /** Everything a month holds, gathered by release. Always current: nothing is stored. */
  function monthData(days) {
    const byRel = {};
    for (const e of days.slice().sort((a, b) => a.date.localeCompare(b.date))) {
      for (const b of e.blocks) {
        if (rel !== "All" && b.release !== rel) continue;
        const r = byRel[b.release] = byRel[b.release] || { days: [], decisions: [], done: [], open: [], questions: [] };
        r.days.push(e);
        b.decisions.forEach((x) => r.decisions.push({ x, e }));
        b.actions.forEach((x) => r[x.done ? "done" : "open"].push({ x, e }));
        b.questions.filter((x) => !x.done).forEach((x) => r.questions.push({ x, e }));
      }
    }
    return byRel;
  }
  /* One summary per month, written by Claude with every import. */
  const sumKey = (ym) => ym;
  function monthlyHtml(ym, days) {
    const d = load();
    const saved = ((d.monthly || {})[project] || {})[sumKey(ym)];
    const lastChange = days.map((e) => e.updated || "").sort().pop() || "";
    const stale = saved && saved.at && lastChange > saved.at;
    const data = monthData(days);
    const rels = releasesOf(project, d.entries).filter((r) => data[r]);
    const when = (e) => `<small class="pu-from">${esc(shortDate(e.date))}</small>`;
    const imgs = days.flatMap((e) => (e.images || []).map((x) => ({ ...x, e })));
    const summary = writing && writing.ym === ym
      ? `<textarea class="pu-sta" data-pu-f="monthtext" rows="7">${esc(writing.text)}</textarea>
         <div class="pu-mact"><button class="btn sm" data-pu="cancelmonth">Cancel</button><button class="btn sm primary" data-pu="savemonth">Save summary</button></div>`
      : saved && saved.text
        ? `${saved.text.split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join("")}
           ${stale ? `<p class="pu-stale">A day was edited by hand after this summary was last updated.</p>` : ""}
           <div class="pu-mact">${saved.through ? `<small class="pu-dim">Updated with the ${esc(shortDate(saved.through))} update</small>` : ""}
             <button class="btn sm" data-pu="editmonth">Edit</button></div>`
        : `<p class="pu-dim">No summary for this month yet. It arrives with your next import.</p>
           <div class="pu-mact"><button class="btn sm" data-pu="editmonth">Edit</button></div>`;
    return `<section class="pu-card pu-month">
      <div class="pu-dh"><span class="pu-date">${esc(monthName(ym))}${rel !== "All" ? " · " + esc(rel) : ""}</span>
        <span class="pu-dim">${days.length} day${days.length === 1 ? "" : "s"} recorded</span></div>
      <h3 class="pu-head">Monthly summary</h3>
      <div class="pu-msum">${summary}</div>
      ${rels.map((r) => { const x = data[r]; return `<div class="pu-block">
        ${project === "adb" || r !== "General" ? relTag(r) : ""}
        <ul class="pu-mdays">${[...new Set(x.days)].map((e) => `<li><button class="pu-dlink" data-pu-day="${e.id}">${esc(shortDate(e.date))}</button> ${esc(e.headline)}</li>`).join("")}</ul>
        </div>`; }).join("")}
      ${imgs.length ? `<div class="pu-block"><h4 class="pu-h4">Images · ${imgs.length}</h4><div class="pu-imgs">${imgs.map((x) => `<span class="pu-th">
        <button class="pu-thb" data-pu-view="${esc(x.id)}" data-name="${esc(x.name)}" title="${esc(shortDate(x.e.date))} · ${esc(x.name)}"><img data-blob="${esc(x.id)}" alt="${esc(x.name)}"></button></span>`).join("")}</div></div>` : ""}
    </section>`;
  }

  /* -------------------------------------------------------------- render */
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function longDate(iso) {
    if (!ISO.test(iso || "")) return iso || "";
    const [y, m, d] = iso.split("-").map(Number), x = new Date(y, m - 1, d);
    return `${DAYS[x.getDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
  }
  const shortDate = (iso) => { if (!ISO.test(iso || "")) return iso || ""; const [, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };
  function hl(text, q) {
    const html = esc(text);
    const ws = (q || "").toLowerCase().match(/[a-z0-9]{3,}/g);
    if (!ws) return html;
    return html.replace(/[A-Za-z0-9]+/g, (w) => (ws.some((t) => w.toLowerCase().startsWith(t.slice(0, Math.max(3, t.length - 2)))) ? `<mark>${w}</mark>` : w));
  }
  const relTag = (r) => `<span class="pu-rel" data-rel="${esc(r)}">${esc(r)}</span>`;

  function cards() {
    const q = window.TrackerLinks.findValue("updates");
    let body;
    if (q) {
      const all = load().entries;
      const hits = searchDays(q, all);
      body = hits.length ? `<div class="faq-all">${hits.map(({ id }) => { const e = all.find((x) => x.id === id);
        return `<button class="faq-row" data-pu-goto="${e.project}"><span class="faq-pj">${esc(projName(e.project))}</span>
          <span class="pu-rd">${esc(longDate(e.date))}</span><b>${hl(e.headline, q)}</b></button>`; }).join("")}</div>`
        : `<div class="empty">No update in either project matches that.</div>`;
    } else body = `<div class="faq-cards">${PROJECTS.map((p) => `<button class="faq-card" data-pu-project="${p.id}"><span>${esc(p.name)}</span></button>`).join("")}</div>`;
    return `<h2 class="page">Project updates</h2>
      <div class="pagetools">${window.TrackerLinks.searchBox("updates", "Search all updates…")}
        <button class="btn" data-pu="template">⤓ Download template</button></div>${body}`;
  }

  function statusCard(entries) {
    const st = load().status[project] || {};
    if (editing && editing.status) return `<section class="pu-stand"><div class="pu-sh"><b>Where things stand</b>
        <span class="faq-acts"><button class="btn sm" data-pu="cancel">Cancel</button><button class="btn sm primary" data-pu="savestatus">Save</button></span></div>
        <label class="faq-l pu-dl">As of<input type="date" data-pu-f="asOf" value="${esc(editing.asOf || "")}"></label>
        <textarea class="pu-sta" data-pu-f="text" rows="4">${esc(editing.text)}</textarea></section>`;
    return `<section class="pu-stand">
      <div class="pu-sh"><b>Where things stand</b>${st.asOf ? `<span class="pu-asof">as of ${esc(longDate(st.asOf))}</span>` : ""}
        <span class="faq-acts"><button class="btn sm" data-pu="editstatus">Edit</button></span></div>
      <p class="pu-stp">${st.text ? esc(st.text) : `<span class="pu-dim">Nothing yet. Import an update from Claude and its status paragraph appears here.</span>`}</p>
      </section>`;
  }

  /* Updates only (18 Nov 2026): a release block is its paragraphs. Lists an
     earlier version recorded stay in the saved data, untouched, but are not shown. */
  function blockHtml(b, q) {
    return `<div class="pu-block">
      ${project === "adb" || b.release !== "General" ? relTag(b.release) : ""}
      ${b.summary.map((p) => `<p>${hl(p, q)}</p>`).join("")}
    </div>`;
  }

  function dayEditor(e) {
    const rels = releasesOf(project, load().entries);
    return `<div class="pu-day pu-editing" data-pu-dropday="${esc(e.id)}"><span class="pu-dot"></span><div class="pu-card faq-ed">
      <div class="faq-meta"><span class="faq-cat">Editing</span><span class="faq-acts">
        <button class="btn sm" data-pu="cancel">Cancel</button><button class="btn sm primary" data-pu="saveday">Save</button></span></div>
      <div class="pu-row2"><label class="faq-l">Date it happened<input type="date" data-pu-f="date" value="${esc(e.date)}"></label>
        <label class="faq-l">Headline<input data-pu-f="headline" value="${esc(e.headline)}"></label></div>
      <datalist id="puRels">${rels.map((r) => `<option value="${esc(r)}">`).join("")}</datalist>
      ${e.blocks.map((b, i) => `<div class="faq-eds">
        <div class="faq-edh"><input data-pu-f="rel:${i}" value="${esc(b.release)}" list="puRels" aria-label="Release">
          <button class="btn sm" data-pu="delblock" data-i="${i}"${e.blocks.length < 2 ? " disabled" : ""}>Remove</button></div>
        <label class="faq-l">Summary <small>a blank line starts a new paragraph</small><textarea data-pu-f="sum:${i}" rows="5">${esc(b.summary.join("\n\n"))}</textarea></label>
      </div>`).join("")}
      <button class="btn sm" data-pu="addblock">+ Add release</button>
      <div class="faq-l pu-imgl">Images <small>drop pictures here, paste with Ctrl+V, or use the button</small></div>
      ${imagesHtml(e, true)}
    </div></div>`;
  }

  function projectView() {
    const q = window.TrackerLinks.findValue("updates");
    const all = load().entries.filter((e) => e.project === project);
    const rels = releasesOf(project, load().entries);
    if (rel !== "All" && !rels.includes(rel)) rel = "All";
    const inRel = (e) => rel === "All" || e.blocks.some((b) => b.release === rel);
    let days = all.filter(inRel).sort((a, b) => b.date.localeCompare(a.date));
    const months = monthsOf(days);
    if (!month || !months.includes(month)) month = months[0] || null;
    let weak = false;
    const aiFor = ai && ai.q === q ? ai : null;
    if (q) {
      const hits = searchDays(q, days);
      weak = !hits.length || hits[0].cover < 0.5;
      const ids = [...(aiFor ? aiFor.ids : []), ...hits.map((h) => h.id)];
      days = days.filter((e) => ids.includes(e.id));
    } else if (month) {
      days = days.filter((e) => ymOf(e.date) === month);   // one month per page
    }
    const edId = editing && !editing.status ? editing.id : null;
    const mi = months.indexOf(month);
    const pager = q ? `<div class="pu-pager"><span class="pu-dim">Showing matches from every month.</span></div>`
      : months.length ? `<div class="pu-pager">
        <span class="seg pu-mode" role="group" aria-label="View">
          <button data-pu-mode="daily" aria-pressed="${mode === "daily"}">Daily</button>
          <button data-pu-mode="monthly" aria-pressed="${mode === "monthly"}">Monthly</button></span>
        <span class="pu-mnav">
          <button class="btn sm" data-pu-month="${esc(months[mi + 1] || "")}"${mi < months.length - 1 ? "" : " disabled"} title="Older month" aria-label="Older month">‹</button>
          <select data-pu-pick aria-label="Month">${months.map((m) => `<option value="${m}"${m === month ? " selected" : ""}>${esc(monthName(m))}</option>`).join("")}</select>
          <button class="btn sm" data-pu-month="${esc(months[mi - 1] || "")}"${mi > 0 ? "" : " disabled"} title="Newer month" aria-label="Newer month">›</button>
        </span></div>` : "";
    const tl = !q && mode === "monthly" && month ? monthlyHtml(month, days) : days.length ? days.map((e) => e.id === edId ? dayEditor(editing) : `<div class="pu-day" id="pu-${e.id}" data-pu-dropday="${esc(e.id)}">
        <span class="pu-dot"></span>
        <div class="pu-card">
          <div class="pu-dh"><span class="pu-date">${esc(longDate(e.date))}</span>
            ${aiFor && aiFor.ids.includes(e.id) ? `<span class="faq-aitag">AI match</span>` : ""}
            <span class="faq-acts"><button class="btn sm" data-pu="copy" data-id="${e.id}">Copy</button>
              <button class="btn sm" data-pu="addimg" data-id="${e.id}">Add image</button>
              <button class="btn sm" data-pu="edit" data-id="${e.id}">Edit</button>
              <button class="btn sm" data-pu="delete" data-id="${e.id}">Delete</button></span></div>
          <h3 class="pu-head">${hl(e.headline, q)}</h3>
          ${e.blocks.filter((b) => rel === "All" || b.release === rel).map((b) => blockHtml(b, q)).join("")}
          ${imagesHtml(e, false)}
        </div></div>`).join("")
      : `<div class="faq-none">${all.length ? (q ? "No day matches that." : "Nothing under this release yet.") : "No updates yet. Download the template, give it to Claude at the end of the day, and import what it sends back."}</div>`;
    const chipCount = (r) => (r === "All" ? all.length : all.filter((e) => e.blocks.some((b) => b.release === r)).length);
    return `<div class="faq pu">
      <div class="faq-head">
        <button class="btn sm" data-pu="back">← Projects</button>
        <h2 class="page">${esc(projName(project))} · Project updates</h2>
        <span class="faq-tools">
          <button class="btn sm" data-pu="template">⤓ Template</button>
          <span class="faq-menuwrap"><button class="btn sm" data-pu="menu" data-m="imp">+ Import ▾</button>
            <span class="faq-menu" data-menu="imp" hidden><button data-pu="importfile">Import file…</button><button data-pu="importpaste">Paste text…</button></span></span>
          <span class="faq-menuwrap"><button class="btn sm" data-pu="menu" data-m="exp">Export ▾</button>
            <span class="faq-menu" data-menu="exp" hidden><button data-pu="exportdoc">Readable document (.doc)</button><button data-pu="exportjson">Data file (.json)</button></span></span>
        </span>
      </div>
      <div class="pagetools faq-search">${window.TrackerLinks.searchBox("updates", "Search updates in your own words…")}</div>
      ${notice ? `<div class="faq-notice">${esc(notice)}</div>` : ""}
      ${q && weak ? `<div class="faq-ai">${aiFor && aiFor.busy ? "Asking the AI…" : aiFor && aiFor.note ? esc(aiFor.note)
        : aiFor ? "The AI's matches are included below." : `No close match. <button class="btn sm" data-pu="ai">Ask AI to find it</button>`}</div>` : ""}
      ${rels.length > 1 ? `<div class="chips pu-chips">${["All", ...rels].map((r) => `<button class="chip" data-pu-rel="${esc(r)}" aria-pressed="${rel === r}">${esc(r)} <span class="pu-n">${chipCount(r)}</span></button>`).join("")}</div>` : ""}
      ${statusCard(all)}
      <h3 class="pu-tlh">Timeline</h3>
      ${pager}
      <div class="pu-tl${!q && mode === "monthly" ? " pu-tlm" : ""}">${tl}</div>
    </div>`;
  }

  const view = () => {
    // Pictures are filled in after the markup lands, as every other view does.
    setTimeout(() => window.TrackerUI.paintImages(document.getElementById("view") || document), 0);
    return project ? projectView() : cards();
  };
  const count = () => load().entries.length;

  /* ------------------------------------------------------------- dialogs */
  function modal(html, wire) {
    return new Promise((resolve) => {
      const m = document.createElement("div");
      m.className = "modal faq-modal"; m.innerHTML = `<div class="box">${html}</div>`;
      document.body.appendChild(m);
      const done = (v) => { obs.disconnect(); m.remove(); resolve(v); };
      const obs = new MutationObserver(() => { if (m.hidden) done(null); });
      obs.observe(m, { attributes: true, attributeFilter: ["hidden"] });
      m.addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b && !b.disabled && !b.dataset.self) done(b.dataset.v === "cancel" ? null : b.dataset.v); });
      if (wire) wire(m, done);
      const f = m.querySelector("textarea,input,select,button.primary"); if (f) f.focus();
    });
  }

  async function confirmImport(p) {
    const d = load();
    const rows = p.days.map((day) => ({ day, exists: d.entries.some((e) => e.project === p.project && e.date === day.date) }));
    const other = p.named && p.project !== project;
    const v = await modal(`<h3>Import into ${esc(projName(p.project))}</h3>
      ${other ? `<p class="faq-err">This file says it is for ${esc(projName(p.project))}, not ${esc(projName(project))}. It will be filed under ${esc(projName(p.project))}.</p>` : ""}
      <p class="lede">${p.days.length === 1 ? "One day" : p.days.length + " days"} found. Each goes on the day it happened.</p>
      <div class="faq-prev">${rows.map(({ day, exists }) => `<div class="faq-pr"><div><b>${esc(longDate(day.date))}</b>
        <small>${esc(day.headline)}</small><small>${day.blocks.map((b) => esc(b.release)).join(" · ")}</small></div>
        <span class="${exists ? "faq-dup" : "faq-new"}">${exists ? "Adds to this day" : "New day"}</span></div>`).join("")}</div>
      ${p.status ? `<p class="lede pu-dl">Where things stand will be ${(() => { const st = d.status[p.project]; const latest = p.days.map((x) => x.date).sort().pop();
          return st && st.asOf && latest < st.asOf ? `kept as it is (it is newer, ${esc(longDate(st.asOf))})` : "updated"; })()}.</p>` : ""}
      ${(p.monthly || []).length ? `<p class="lede pu-dl">Monthly summary updated for ${p.monthly.map((m) => esc(monthName(m.ym))).join(", ")}.</p>`
        : `<p class="faq-err">This file has no monthly summary, so the month's summary is left as it is. Download the template again to get the current one.</p>`}
      <div class="actions"><button class="btn" data-v="cancel">Cancel</button><button class="btn primary" data-v="go">Import</button></div>`);
    if (v !== "go") return;
    const r = importParsed(p);
    project = p.project; rel = "All"; editing = null;
    month = ymOf(p.days.map((x) => x.date).sort().pop());
    flash(`Imported: ${[r.added && `${r.added} new day${r.added === 1 ? "" : "s"}`, r.merged && `${r.merged} added to existing day${r.merged === 1 ? "" : "s"}`].filter(Boolean).join(", ")}.`);
  }

  async function pasteDialog() {
    let parsed = null;
    const v = await modal(`<h3>Paste Claude's update</h3>
      <p class="lede">Paste the json code block from Claude. Extra text around it is ignored.</p>
      <textarea class="faq-paste" rows="12" spellcheck="false" placeholder='{ "format": "tracker-update", … }'></textarea>
      <p class="faq-err" hidden></p>
      <div class="actions"><button class="btn" data-v="cancel">Cancel</button><button class="btn primary" data-v="next" data-self="1">Next</button></div>`,
      (m, done) => m.querySelector('[data-v="next"]').addEventListener("click", () => {
        try { parsed = parse(m.querySelector(".faq-paste").value, project); done("next"); }
        catch (err) { const p = m.querySelector(".faq-err"); p.hidden = false; p.textContent = err.message; }
      }));
    if (v === "next") await confirmImport(parsed);
  }
  function importFile() {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,.txt,.md,application/json,text/plain";
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try { await confirmImport(parse(await f.text(), project)); }
      catch (err) { flash(`${f.name}: ${err.message}`, 8000); }
    };
    inp.click();
  }

  function updateData(fn) { const d = load(); fn(d); save(d); render(); }

  async function deleteDay(id) {
    const e = load().entries.find((x) => x.id === id); if (!e) return;
    const yes = await window.TrackerUI.confirmDialog({ title: `Delete ${longDate(e.date)}?`,
      intro: `"${e.headline}" and everything recorded for that day will be removed.`, confirmLabel: "Delete day" });
    if (!yes) return;
    updateData((d) => { d.entries = d.entries.filter((x) => x.id !== id); });
    if ((e.images || []).length) window.TrackerStore.holdBlobs(e.images.map((x) => x.id));
  }

  /* --------------------------------------------------------- copy, export */
  function dayText(e) {
    return [longDate(e.date) + " — " + e.headline, ...e.blocks.flatMap((b) => [
      "", (project === "adb" || b.release !== "General") ? b.release : "", ...b.summary,
    ].filter((l, i, a) => l !== "" || a[i - 1] !== ""))].join("\n");
  }
  function flash(msg, ms = 4000) { notice = msg; render(); setTimeout(() => { if (notice === msg) { notice = ""; if (project) render(); } }, ms); }
  function copyDay(id) {
    const e = load().entries.find((x) => x.id === id); if (!e) return;
    const done = () => flash("Copied.", 2500);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(dayText(e)).then(done, done);
  }
  const fileStem = () => `${projName(project)} project updates ${new Date().toISOString().slice(0, 10)}`;
  function exportDoc() {
    const d = load(), st = d.status[project] || {};
    const days = d.entries.filter((e) => e.project === project).sort((a, b) => b.date.localeCompare(a.date));
    const body = `<h1>${esc(projName(project))} · Project updates</h1>
      ${st.text ? `<h2>Where things stand${st.asOf ? ", as of " + esc(longDate(st.asOf)) : ""}</h2><p>${esc(st.text)}</p>` : ""}
      ${days.map((e) => `<h2>${esc(longDate(e.date))}: ${esc(e.headline)}</h2>${e.blocks.map((b) => `
        ${project === "adb" || b.release !== "General" ? `<h3>${esc(b.release)}</h3>` : ""}${b.summary.map((p) => `<p>${esc(p)}</p>`).join("")}
`).join("")}`).join("")}`;
    const html = `<html><head><meta charset="utf-8"><title>${esc(fileStem())}</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.45}h1{font-size:20pt}h2{font-size:14pt;margin-top:18pt}h3{font-size:12pt;color:#1F4E79}</style></head><body>${body}</body></html>`;
    window.TrackerUI.saveBlob(new Blob(["﻿" + html], { type: "application/msword" }), fileStem() + ".doc");
  }
  function exportJson() {
    const d = load();
    const out = { format: "tracker-update", version: 1, project: projName(project), status: (d.status[project] || {}).text || "",
      updates: d.entries.filter((e) => e.project === project).sort((a, b) => a.date.localeCompare(b.date)).map((e) => ({
        date: e.date, headline: e.headline, releases: e.blocks.map((b) => ({ release: b.release, summary: b.summary, decisions: b.decisions,
          actions: b.actions.map((x) => ({ task: x.text, owner: x.owner, due: x.due, done: x.done })), questions: b.questions.map((x) => x.text) })) })) };
    window.TrackerUI.saveBlob(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }), fileStem() + ".json");
  }

  /* ------------------------------------------------------------- editing */
  function saveDay() {
    const e = editing;
    const date = toISO(e.date);
    if (!date) return flash("Give the day a date before saving.");
    const blocks = e.blocks.map((b) => ({ ...b, release: canonRelease(project, b.release) }))
      .filter((b) => b.summary.length || b.decisions.length || b.actions.length || b.questions.length);
    if (!blocks.length) return flash("A day needs at least one paragraph or item.");
    const before = (load().entries.find((x) => x.id === e.id) || {}).images || [];
    const gone = before.filter((x) => !(e.images || []).some((y) => y.id === x.id)).map((x) => x.id);
    updateData((d) => {
      const clash = d.entries.find((x) => x.project === project && x.date === date && x.id !== e.id);
      const merged = clash ? mergeBlocks(clash.blocks, blocks) : blocks;
      d.entries = d.entries.filter((x) => x.id !== e.id && x !== clash);
      const images = [...((clash && clash.images) || []), ...(e.images || [])];
      d.entries.push({ id: clash ? clash.id : e.id, project, date, headline: clean(e.headline) || (clash && clash.headline) || "", blocks: merged,
        ...(images.length ? { images } : {}), updated: new Date().toISOString() });
      if (clash) notice = `${longDate(date)} already had an entry, so the two were merged.`;
    });
    if (gone.length) window.TrackerStore.holdBlobs(gone);
    month = ymOf(date);
    editing = null; render();
  }

  /* Action lines keep their ticks and ids when their text is unchanged. */
  function readLines(v) { return String(v).split("\n").map((s) => s.trim()).filter(Boolean); }
  function setBlockField(i, k, v) {
    const b = editing.blocks[i];
    if (k === "rel") b.release = v;
    else if (k === "sum") b.summary = String(v).split(/\n\s*\n/).map(clean).filter(Boolean);
    else if (k === "dec") b.decisions = readLines(v).map(sentence);
    else if (k === "act") b.actions = readLines(v).map((l) => {
      const [text, owner = "", due = ""] = l.split("|").map((s) => s.trim());
      const old = b.actions.find((x) => norm(x.text) === norm(text));
      return { id: old ? old.id : uid("a"), text: sentence(text), owner: clean(owner), due: toISO(due), done: old ? old.done : false };
    });
    else if (k === "que") b.questions = readLines(v).map((t) => {
      const old = b.questions.find((x) => norm(x.text) === norm(t));
      return { id: old ? old.id : uid("k"), text: sentence(t), done: old ? old.done : false };
    });
  }

  /* -------------------------------------------------------------- events */
  document.addEventListener("click", (e) => {
    const pj = e.target.closest("[data-pu-project], [data-pu-goto]");
    if (pj) { project = pj.dataset.puProject || pj.dataset.puGoto; rel = "All"; editing = null; ai = null; return render(); }
    const rc = e.target.closest("[data-pu-rel]");
    if (rc) { rel = rc.dataset.puRel; return render(); }
    const md = e.target.closest("[data-pu-mode]");
    if (md) { mode = md.dataset.puMode; writing = null; return render(); }
    const mn = e.target.closest("[data-pu-month]");
    if (mn && !mn.disabled && mn.dataset.puMonth) { month = mn.dataset.puMonth; writing = null; return render(); }
    const dl = e.target.closest("[data-pu-day]");
    if (dl) {   // from the monthly view, straight to that day
      mode = "daily"; render();
      const el = document.getElementById("pu-" + dl.dataset.puDay);
      if (el) { el.scrollIntoView({ block: "start", behavior: "smooth" }); el.classList.add("pu-flash"); setTimeout(() => el.classList.remove("pu-flash"), 1600); }
      return;
    }
    const iv = e.target.closest("[data-pu-view]");
    if (iv) return viewImage(iv.dataset.puView, iv.dataset.name);
    const ix = e.target.closest("[data-pu-imgdel]");
    if (ix) return removeImage(ix.dataset.day, ix.dataset.puImgdel);
    document.querySelectorAll(".pu .faq-menu").forEach((m) => { if (!m.hidden && !e.target.closest(".faq-menuwrap")) m.hidden = true; });
    const b = e.target.closest("[data-pu]");
    if (!b || b.disabled) return;
    const id = b.dataset.id;
    switch (b.dataset.pu) {
      case "template": return downloadTemplate();
      case "back": project = null; editing = null; ai = null; return render();
      case "menu": { const m = b.parentElement.querySelector(".faq-menu"); const was = m.hidden;
        document.querySelectorAll(".pu .faq-menu").forEach((x) => (x.hidden = true)); m.hidden = !was; return; }
      case "importfile": b.closest(".faq-menu").hidden = true; return importFile();
      case "importpaste": b.closest(".faq-menu").hidden = true; return pasteDialog();
      case "exportdoc": b.closest(".faq-menu").hidden = true; return exportDoc();
      case "exportjson": b.closest(".faq-menu").hidden = true; return exportJson();
      case "ai": return askAI(window.TrackerLinks.findValue("updates"), load().entries.filter((x) => x.project === project));
      case "copy": return copyDay(id);
      case "delete": return deleteDay(id);
      case "edit": { const d = load().entries.find((x) => x.id === id); editing = JSON.parse(JSON.stringify(d)); return render(); }
      case "editstatus": { const st = load().status[project] || {}; editing = { status: true, text: st.text || "", asOf: st.asOf || "" }; return render(); }
      case "savestatus": updateData((d) => { d.status[project] = { text: clean(editing.text), asOf: toISO(editing.asOf) }; }); editing = null; return render();
      case "cancel": editing = null; return render();
      case "saveday": return saveDay();
      case "addimg": return pickImages(id);
      case "editmonth": { const sv = ((load().monthly[project] || {})[sumKey(month)] || {}); writing = { ym: month, text: sv.text || "" }; return render(); }
      case "cancelmonth": writing = null; return render();
      case "savemonth": {
        const ym = writing.ym, text = String(writing.text).trim();
        updateData((d) => { d.monthly[project] = d.monthly[project] || {};
          const cur = d.monthly[project][sumKey(ym)] || {};
          if (text) d.monthly[project][sumKey(ym)] = { ...cur, text, at: new Date().toISOString() }; else delete d.monthly[project][sumKey(ym)]; });
        writing = null; return render();
      }
      case "addblock": editing.blocks.push({ release: rel !== "All" ? rel : "General", summary: [], decisions: [], actions: [], questions: [] }); return render();
      case "delblock": editing.blocks.splice(+b.dataset.i, 1); return render();
    }
  });
  document.addEventListener("change", (e) => {
    const pk = e.target.closest("[data-pu-pick]");
    if (pk) { month = pk.value; writing = null; return render(); }
  });
  document.addEventListener("input", (e) => {
    const f = e.target.closest("[data-pu-f]");
    if (!f) return;
    const k = f.dataset.puF;
    // The monthly summary is written outside a day's edit, so it is read first.
    if (k === "monthtext") { if (writing) writing.text = f.value; return; }
    if (!editing) return;
    const m = k.match(/^(rel|sum|dec|act|que):(\d+)$/);
    if (m) setBlockField(+m[2], m[1], f.value);
    else editing[k] = f.value;
  });

  /* Drop pictures on a day; paste them while editing one. */
  document.addEventListener("dragover", (e) => {
    const day = e.target.closest && e.target.closest("[data-pu-dropday]");
    if (!day || ![...(e.dataTransfer.types || [])].includes("Files")) return;
    e.preventDefault(); day.classList.add("pu-over");
  });
  document.addEventListener("dragleave", (e) => {
    const day = e.target.closest && e.target.closest("[data-pu-dropday]");
    if (day && !day.contains(e.relatedTarget)) day.classList.remove("pu-over");
  });
  document.addEventListener("drop", (e) => {
    const day = e.target.closest && e.target.closest("[data-pu-dropday]");
    if (!day || !e.dataTransfer.files.length) return;
    e.preventDefault(); day.classList.remove("pu-over");
    addImagesTo(day.dataset.puDropday, [...e.dataTransfer.files]);
  });
  document.addEventListener("paste", (e) => {
    if (!editing || editing.status || !document.querySelector(".pu-editing")) return;
    const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    e.preventDefault();
    addImagesTo(editing.id, files);
  });

  window.TrackerUpdates = { view, count, parse, templateFor, dataFile, RELEASES, canonRelease, _state: () => ({ project, rel, mode, month, editing: !!editing }) };
})();
