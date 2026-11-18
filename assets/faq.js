/* FAQ — a book of answers, one per project.

   Asked for 18 Nov 2026. The loop it serves:
     1. Download the template (a fixed instruction file for Claude).
     2. Upload it to any Claude chat with a question.
     3. Claude answers in one fixed JSON shape, as a .faq.json file and as a
        code block, so the result is identical whichever chat produced it.
     4. Import the file, or paste the block, into the project it belongs to.

   Answers live in tracker.faq, a KEYS.data key: backed up, synced, and on
   the sidebar's undo, like every other thing you author here.

   Search ranks by meaning, offline: word stems, a small synonym table, and
   the keywords Claude writes into every answer. When nothing matches well,
   "Ask AI to find it" sends the question and the TITLES ONLY (never the
   steps) to the engine chosen in Settings. */
(() => {
  const KEY = "tracker.faq";
  const PROJECTS = [{ id: "adb", name: "ADB EDRMS" }, { id: "gra", name: "GRA GLASS" }];
  const CATEGORIES = ["SharePoint", "Power BI", "PowerShell", "AvePoint", "Microsoft 365", "General"];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const S = () => window.TrackerStore;
  const render = () => window.TrackerRender();
  const uid = () => "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const load = () => S().get(KEY, []);
  const save = (list) => S().set(KEY, list);
  const count = () => load().length;

  /* --------------------------------------------------------------- state */
  let project = null;      // "adb" | "gra" | null for the project cards
  let openId = null;
  let cat = "All";
  let draft = null;        // the answer being edited, a deep copy
  let ai = null;           // { q, ids, busy, note } for the AI fallback
  let notice = "";

  /* ------------------------------------------------------------ template */
  /* The whole point of this text is that two different chats return the
     same structure. So it states the shape once, names every field's rule,
     shows a full example, and ends with a checklist the model runs before
     answering. Changing the shape here means changing parse() with it. */
  const TEMPLATE = `# FAQ answer template

You are writing answers for my FAQ book. Follow every rule below exactly, in every chat, every time. Never change the format, the field names or the order, even if I ask the question casually.

## What to send back

Reply with exactly these two things, in this order, and nothing else (no greeting, no explanation before or after):

1. A downloadable file named \`answer.faq.json\` containing the JSON. If you cannot create files, skip this item.
2. The same JSON in a single code block marked \`json\`.

## The JSON shape

\`\`\`json
{
  "format": "tracker-faq",
  "version": 1,
  "questions": [
    {
      "title": "",
      "category": "",
      "summary": "",
      "keywords": [],
      "sections": [
        { "heading": "", "steps": [] }
      ]
    }
  ]
}
\`\`\`

## Rules for every field

- **format** is always \`"tracker-faq"\` and **version** is always \`1\`.
- **questions** has one entry per question I asked. One question means one entry.
- **title**: the question as a short task. Start with "How to" for a task, or "What is" for an explanation. Sentence case, under 70 characters, no full stop at the end. A scope in brackets is allowed, for example "How to change versioning (library level)".
- **category**: exactly one of these, spelled exactly like this: SharePoint, Power BI, PowerShell, AvePoint, Microsoft 365, General. Use General when none fits. Never invent another.
- **summary**: one or two plain sentences, at most 40 words, saying what this does and why someone would do it. No steps in the summary.
- **keywords**: 6 to 12 lowercase words or short phrases someone might type when looking for this answer. Include synonyms and other ways of saying the same thing (for example "drafts", "version history", "minor versions"). No duplicates.
- **sections**: 1 to 4 sections. Use more than one only when there are genuinely different paths (for example "library level" and "site level").
  - **heading**: short, in the style "How to change it (library level)". No colon at the end.
  - **steps**: 3 to 12 steps per section, in order. Each step is ONE action, starts with a verb, ends with a full stop, and is at most 30 words. Do not number the steps; the app numbers them.
- **Bold**: wrap the exact on-screen name of every button, menu, tab, setting, field and option in double asterisks, for example \`Click **Versioning settings**.\` Bold nothing else.
- When several clicks follow one path, put them in one step joined by "then", for example \`Click the **gear icon** (top right), then **Library settings**, then **More library settings**.\`
- No other formatting: no headings inside steps, no links, no emoji, no nested lists, no line breaks inside a step.
- Write for someone non-technical: plain words, no jargon unless it is the name on screen.
- Valid JSON only: double quotes, no comments, no trailing commas. Write a quote inside text as \\".

## Example (copy this structure exactly)

\`\`\`json
{
  "format": "tracker-faq",
  "version": 1,
  "questions": [
    {
      "title": "How to change versioning (library level)",
      "category": "SharePoint",
      "summary": "Versioning lets a document library keep drafts that only editors can see until they are published.",
      "keywords": ["versioning", "version history", "drafts", "minor versions", "major versions", "library settings", "content approval"],
      "sections": [
        {
          "heading": "How to change it (library level)",
          "steps": [
            "Open the library.",
            "Click the **gear icon** (top right), then **Library settings**, then **More library settings**.",
            "Click **Versioning settings**.",
            "Under **Document Version History**, choose **Create major and minor (draft) versions**.",
            "Set **Require content approval** to **No**.",
            "Click **OK**."
          ]
        }
      ]
    }
  ]
}
\`\`\`

## Check before you send

- [ ] Only the file and one \`json\` code block, nothing else.
- [ ] "format" is "tracker-faq" and "version" is 1.
- [ ] Every question has title, category, summary, keywords and sections, in that order.
- [ ] The category is one of the six allowed names.
- [ ] Every step is one action, starts with a verb, ends with a full stop, and has no number in front.
- [ ] Every on-screen name is in **bold**, and nothing else is.
- [ ] The JSON is valid.

## My question

(Ask your question in the chat after uploading this file.)
`;

  function downloadTemplate() {
    window.TrackerUI.saveBlob(new Blob([TEMPLATE], { type: "text/markdown" }), "FAQ-template.md");
  }

  /* --------------------------------------------------------------- parse */
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  /**
   * Read Claude's reply: the .faq.json file, or the pasted code block with
   * or without the fence and any text around it. Lenient about wrapping,
   * strict about content: what comes out always has the one shape.
   */
  function parse(text) {
    let t = String(text || "").replace(/^﻿/, "");
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && /[{[]/.test(fence[1])) t = fence[1];
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("No answer was found in that. Paste the whole json block Claude gave you.");
    t = t.slice(a, b + 1).replace(/[“”]/g, '"');
    let data;
    try { data = JSON.parse(t); }
    catch { throw new Error("That is not complete JSON. Copy the whole code block from Claude, from the first { to the last }."); }
    const list = Array.isArray(data.questions) ? data.questions : (data.title ? [data] : []);
    const out = list.map(normalise).filter((q) => q.title && q.sections.some((s) => s.steps.length));
    if (!out.length) throw new Error("No questions with steps were found in that.");
    return out;
  }
  function normalise(q) {
    const cat0 = clean(q.category);
    const known = CATEGORIES.find((c) => c.toLowerCase() === cat0.toLowerCase());
    const sections = (Array.isArray(q.sections) ? q.sections : (q.steps ? [{ heading: "", steps: q.steps }] : []))
      .map((s) => ({
        heading: clean(s.heading).replace(/:$/, ""),
        // The app numbers steps; a "1." the model added anyway is dropped.
        steps: (Array.isArray(s.steps) ? s.steps : []).map((x) => clean(x).replace(/^(\d+[.)]|[-*•])\s+/, "")).filter(Boolean),
      }))
      .filter((s) => s.steps.length || s.heading);
    return {
      title: clean(q.title).replace(/[.?]$/, "") || "",
      category: known || cat0 || "General",
      summary: clean(q.summary),
      keywords: [...new Set((Array.isArray(q.keywords) ? q.keywords : String(q.keywords || "").split(","))
        .map((k) => clean(k).toLowerCase()).filter(Boolean))],
      sections,
    };
  }

  /* -------------------------------------------------------------- search */
  const STOP = new Set("a an the to of in on for and or is are be do does i my me how what why when where can could should would it this that with from at by as into your you we our use using get".split(" "));
  /** A light stemmer: enough that versions, versioning and versioned meet. */
  function stem(w) {
    for (const suf of ["ational", "ations", "ation", "ments", "ment", "ings", "ing", "ions", "ion", "ers", "er", "ies", "ied", "es", "ed", "ly", "s"]) {
      if (w.length - suf.length >= 3 && w.endsWith(suf)) return suf === "ies" || suf === "ied" ? w.slice(0, -3) + "y" : w.slice(0, -suf.length);
    }
    return w;
  }
  const words = (s) => String(s || "").toLowerCase().replace(/\*\*/g, "").match(/[a-z0-9]+/g) || [];
  const terms = (s) => words(s).filter((w) => !STOP.has(w)).map(stem);
  /* Different words for the same thought. Each group is matched as one. */
  const SYN = [
    ["delete", "remove", "erase", "clear", "drop"], ["restore", "recover", "undelete", "retrieve", "bring back"],
    ["enable", "turn on", "activate", "switch on", "allow"], ["disable", "turn off", "deactivate", "switch off", "block"],
    ["create", "add", "new", "make", "set up", "setup"], ["change", "modify", "edit", "update", "set", "adjust", "configure"],
    ["find", "search", "locate", "look up", "lookup"], ["permission", "access", "rights", "share", "sharing"],
    ["file", "document", "doc"], ["version", "draft", "history", "minor", "major"], ["approve", "approval", "publish"],
    ["move", "transfer", "migrate"], ["copy", "duplicate"], ["refresh", "reload", "sync"], ["error", "problem", "issue", "fail", "broken"],
    ["label", "tag", "retention"], ["folder", "library", "list"], ["user", "member", "person", "people"],
  ].map((g) => g.map(stem));
  const synonyms = (t) => { const g = SYN.find((x) => x.includes(t)); return g ? g.filter((x) => x !== t) : []; };

  function fieldsOf(q) {
    return [
      [terms(q.title), 4], [q.keywords.flatMap(terms), 3], [terms(q.category), 2],
      [q.sections.flatMap((s) => terms(s.heading)), 2], [terms(q.summary), 1.5],
      [q.sections.flatMap((s) => s.steps.flatMap(terms)), 1],
    ];
  }
  /** Score every answer against the query; returns [{ q, score, cover }] best first. */
  function search(query, list) {
    const qt = [...new Set(terms(query))];
    if (!qt.length) return list.map((q) => ({ q, score: 0, cover: 1 }));
    return list.map((q) => {
      const fs = fieldsOf(q);
      let score = 0, hit = 0;
      for (const t of qt) {
        let best = 0;
        for (const [ws, w] of fs) {
          for (const x of ws) {
            if (x === t) best = Math.max(best, w);
            else if (t.length >= 3 && x.length >= 3 && (x.startsWith(t) || t.startsWith(x))) best = Math.max(best, w * 0.6);
            else if (synonyms(t).includes(x)) best = Math.max(best, w * 0.7);
          }
        }
        if (best) { score += best; hit++; }
      }
      const cover = hit / qt.length;
      return { q, score: score * (0.4 + cover), cover };
    }).filter((r) => r.cover > 0).sort((a, b) => b.score - a.score);
  }
  /** Highlight the words of the query that appear in a piece of text. */
  function mark(text, query) {
    const qt = terms(query);
    const html = esc(text);
    if (!qt.length) return html;
    return html.replace(/[A-Za-z0-9]+/g, (w) => {
      const s = stem(w.toLowerCase());
      // A word found through a synonym is marked too: it is why the answer matched.
      return qt.some((t) => s === t || synonyms(t).includes(s) || (t.length >= 3 && s.length >= 3 && (s.startsWith(t) || t.startsWith(s)))) ? `<mark>${w}</mark>` : w;
    });
  }

  async function askAI(query, list) {
    ai = { q: query, ids: [], busy: true, note: "" };
    render();
    const titles = list.map((q, i) => `${i + 1}. ${q.title}`).join("\n");
    try {
      const reply = await window.TrackerAI.match(`Question: ${query}\n\nTitles:\n${titles}`);
      const nums = [...new Set((String(reply).match(/\d+/g) || []).map(Number))].filter((n) => n >= 1 && n <= list.length).slice(0, 3);
      ai = { q: query, ids: nums.map((n) => list[n - 1].id), busy: false,
        note: nums.length ? "" : "The AI found nothing in this project that answers that." };
    } catch (err) {
      ai = { q: query, ids: [], busy: false, note: String(err && err.message || err) };
    }
    render();
  }

  /* -------------------------------------------------------------- render */
  const bold = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  const inProject = () => load().filter((q) => q.project === project);
  const projName = (id) => (PROJECTS.find((p) => p.id === id) || {}).name || id;

  function answerHtml(q) {
    return `<article class="faq-a">
      <div class="faq-meta"><span class="faq-cat">${esc(q.category)}</span>
        <span class="faq-acts">
          <button class="btn sm" data-faq="copy">Copy steps</button>
          <button class="btn sm" data-faq="edit">Edit</button>
          <button class="btn sm" data-faq="delete">Delete</button>
        </span></div>
      <h2 class="faq-title">${esc(q.title)}</h2>
      ${q.summary ? `<p class="faq-sum">${esc(q.summary)}</p>` : ""}
      ${q.sections.map((s) => `<section class="faq-sec">
        ${s.heading ? `<h3>${esc(s.heading)}</h3>` : ""}
        <ol class="faq-steps">${s.steps.map((x) => `<li>${bold(x)}</li>`).join("")}</ol>
      </section>`).join("")}
    </article>`;
  }

  function editorHtml(d) {
    const catOpts = [...new Set([...CATEGORIES, ...load().map((q) => q.category)])];
    return `<article class="faq-a faq-ed">
      <div class="faq-meta"><span class="faq-cat">Editing</span>
        <span class="faq-acts"><button class="btn sm" data-faq="cancel">Cancel</button>
        <button class="btn sm primary" data-faq="save">Save</button></span></div>
      <label class="faq-l">Question<input data-faq-f="title" value="${esc(d.title)}" placeholder="How to …"></label>
      <label class="faq-l">Category<input data-faq-f="category" value="${esc(d.category)}" list="faqCats">
        <datalist id="faqCats">${catOpts.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>
      <label class="faq-l">Short explanation<textarea data-faq-f="summary" rows="2">${esc(d.summary)}</textarea></label>
      <label class="faq-l">Search keywords <small>comma separated</small><input data-faq-f="keywords" value="${esc(d.keywords.join(", "))}"></label>
      ${d.sections.map((s, si) => `<div class="faq-eds">
        <div class="faq-edh"><input data-faq-f="h:${si}" value="${esc(s.heading)}" placeholder="Section heading, e.g. How to change it (library level)">
          <button class="btn sm" data-faq="delsec" data-i="${si}"${d.sections.length < 2 ? " disabled" : ""}>Remove section</button></div>
        <ol class="faq-edl">${s.steps.map((x, i) => `<li>
          <textarea data-faq-f="s:${si}:${i}" rows="2">${esc(x)}</textarea>
          <span class="faq-stb">
            <button data-faq="up" data-i="${si}:${i}" title="Move up"${i ? "" : " disabled"}>↑</button>
            <button data-faq="down" data-i="${si}:${i}" title="Move down"${i < s.steps.length - 1 ? "" : " disabled"}>↓</button>
            <button data-faq="delstep" data-i="${si}:${i}" title="Delete step">✕</button></span></li>`).join("")}</ol>
        <button class="btn sm" data-faq="addstep" data-i="${si}">+ Add step</button>
      </div>`).join("")}
      <button class="btn sm" data-faq="addsec">+ Add section</button>
      <p class="faq-tip">Wrap a button or setting name in **double asterisks** to make it bold.</p>
    </article>`;
  }

  function cards() {
    return `<h2 class="page">FAQ</h2>
      <div class="pagetools">${window.TrackerLinks.searchBox("faq", "Search all answers…")}
        <button class="btn" data-faq="template">⤓ Download template</button></div>
      ${window.TrackerLinks.findValue("faq") ? allResults() : `<div class="faq-cards">
        ${PROJECTS.map((p) => `<button class="faq-card" data-faq-project="${p.id}"><span>${esc(p.name)}</span></button>`).join("")}
      </div>`}`;
  }
  /* Searching from the project cards looks in both projects. */
  function allResults() {
    const q = window.TrackerLinks.findValue("faq");
    const hits = search(q, load());
    if (!hits.length) return `<div class="empty">Nothing in either project matches that yet.</div>`;
    return `<div class="faq-all">${hits.map(({ q: a }) => `<button class="faq-row" data-faq-goto="${a.project}:${a.id}">
        <span class="faq-pj">${esc(projName(a.project))}</span><b>${mark(a.title, q)}</b></button>`).join("")}</div>`;
  }

  function projectView() {
    const query = window.TrackerLinks.findValue("faq");
    const all = inProject();
    const cats = [...new Set(all.map((q) => q.category))].sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b) || a.localeCompare(b));
    if (cat !== "All" && !cats.includes(cat)) cat = "All";
    const pool = all.filter((q) => cat === "All" || q.category === cat);
    const hits = search(query, pool);
    const weak = query && (!hits.length || hits[0].cover < 0.5);
    const aiFor = ai && ai.q === query ? ai : null;
    let shown = hits.map((h) => h.q);
    if (aiFor && aiFor.ids.length) shown = [...aiFor.ids.map((id) => all.find((q) => q.id === id)).filter(Boolean), ...shown.filter((q) => !aiFor.ids.includes(q.id))];
    if (!draft && (!openId || !shown.some((q) => q.id === openId))) openId = shown[0] ? shown[0].id : null;
    const open = all.find((q) => q.id === openId);

    // Grouped by category, unless a search is ranking them.
    let listHtml;
    if (!shown.length) listHtml = `<div class="faq-none">${all.length ? "No answer matches that." : "No answers yet. Import one from Claude, or add one with + New."}</div>`;
    else if (query) listHtml = shown.map((q) => row(q, query, aiFor && aiFor.ids.includes(q.id))).join("");
    else listHtml = cats.filter((c) => cat === "All" || c === cat).map((c) =>
      `<div class="faq-group">${esc(c)}</div>` + shown.filter((q) => q.category === c).map((q) => row(q, "")).join("")).join("");

    return `<div class="faq">
      <div class="faq-head">
        <button class="btn sm" data-faq="back">← Projects</button>
        <h2 class="page">${esc(projName(project))} · FAQ</h2>
        <span class="faq-tools">
          <button class="btn sm" data-faq="template">⤓ Template</button>
          <span class="faq-menuwrap"><button class="btn sm" data-faq="importmenu">+ Import ▾</button>
            <span class="faq-menu" hidden>
              <button data-faq="importfile">Import file…</button>
              <button data-faq="importpaste">Paste text…</button></span></span>
          <button class="btn sm primary" data-faq="new">+ New</button>
        </span>
      </div>
      <div class="pagetools faq-search">${window.TrackerLinks.searchBox("faq", "Ask in your own words… e.g. \"turn on drafts in a library\"")}</div>
      ${notice ? `<div class="faq-notice">${esc(notice)}</div>` : ""}
      ${weak ? `<div class="faq-ai">${aiFor && aiFor.busy ? "Asking the AI…"
        : aiFor && aiFor.note ? esc(aiFor.note)
        : aiFor ? "The AI's best matches are at the top of the list."
        : `No close match. <button class="btn sm" data-faq="ai">Ask AI to find it</button>`}</div>` : ""}
      <div class="chips" data-faq-cats>
        ${["All", ...cats].map((c) => `<button class="chip" data-faq-cat="${esc(c)}" aria-pressed="${cat === c}">${esc(c)} ${c === "All" ? all.length : all.filter((q) => q.category === c).length}</button>`).join("")}
      </div>
      <div class="faq-split">
        <nav class="faq-list" aria-label="Questions">${listHtml}</nav>
        <div class="faq-pane">${draft ? editorHtml(draft) : open ? answerHtml(open) : `<div class="faq-none">Pick a question on the left.</div>`}</div>
      </div>
    </div>`;
  }
  const row = (q, query, byAi) => `<button class="faq-row${q.id === openId ? " cur" : ""}" data-faq-open="${q.id}">
      <b>${query ? mark(q.title, query) : esc(q.title)}</b>${byAi ? `<span class="faq-aitag">AI match</span>` : ""}</button>`;

  function view() { return project ? projectView() : cards(); }

  /* ------------------------------------------------------------- dialogs */
  /** A plain modal built on the app's own .modal styling. Resolves with the button's value. */
  function modal(html, wire) {
    return new Promise((resolve) => {
      const m = document.createElement("div");
      m.className = "modal faq-modal"; m.innerHTML = `<div class="box">${html}</div>`;
      document.body.appendChild(m);
      const done = (v) => { obs.disconnect(); m.remove(); resolve(v); };
      // The app's Escape handler hides every .modal; treat that as Cancel.
      const obs = new MutationObserver(() => { if (m.hidden) done(null); });
      obs.observe(m, { attributes: true, attributeFilter: ["hidden"] });
      m.addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b && !b.disabled) done(b.dataset.v === "cancel" ? null : b.dataset.v); });
      if (wire) wire(m, done);
      const f = m.querySelector("textarea,input,select,button.primary"); if (f) f.focus();
    });
  }

  async function pasteDialog() {
    let text = null;
    const v = await modal(`<h3>Paste Claude's answer</h3>
      <p class="lede">Paste the json code block from Claude. Everything from the first { to the last } is enough; extra text around it is ignored.</p>
      <textarea class="faq-paste" rows="12" spellcheck="false" placeholder='{ "format": "tracker-faq", … }'></textarea>
      <p class="faq-err" hidden></p>
      <div class="actions"><button class="btn" data-v="cancel">Cancel</button><button class="btn primary" data-v="next">Next</button></div>`,
      (m, done) => {
        m.querySelector('[data-v="next"]').addEventListener("click", (e) => {
          e.stopPropagation();
          text = m.querySelector(".faq-paste").value;
          try { parse(text); done("next"); }
          catch (err) { const p = m.querySelector(".faq-err"); p.hidden = false; p.textContent = err.message; }
        });
      });
    if (v === "next") await preview(parse(text));
  }

  function importFile() {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,.txt,.md,application/json,text/plain";
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try { await preview(parse(await f.text())); }
      catch (err) { notice = `${f.name}: ${err.message}`; render(); }
    };
    inp.click();
  }

  /** Show what will be added; a question already in the project asks Replace, Keep both or Skip. */
  async function preview(items) {
    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const existing = inProject();
    const rows = items.map((q, i) => {
      const dup = existing.find((x) => norm(x.title) === norm(q.title));
      return { q, dup, i };
    });
    const v = await modal(`<h3>Import into ${esc(projName(project))}</h3>
      <p class="lede">${items.length === 1 ? "One answer" : items.length + " answers"} found.</p>
      <div class="faq-prev">${rows.map(({ q, dup, i }) => `<div class="faq-pr">
        <div><b>${esc(q.title)}</b><small>${esc(q.category)} · ${q.sections.reduce((n, s) => n + s.steps.length, 0)} steps</small>
          ${dup ? `<small class="faq-dup">Already in this project.</small>` : ""}</div>
        ${dup ? `<select data-dup="${i}"><option value="replace">Replace</option><option value="both">Keep both</option><option value="skip">Skip</option></select>` : `<span class="faq-new">New</span>`}
      </div>`).join("")}</div>
      <div class="actions"><button class="btn" data-v="cancel">Cancel</button><button class="btn primary" data-v="go">Import</button></div>`,
      (m) => { m.addEventListener("change", (e) => { const s = e.target.closest("[data-dup]"); if (s) rows[s.dataset.dup].choice = s.value; }); });
    if (v !== "go") return;
    let list = load();
    const now = new Date().toISOString();
    let firstId = null, n = 0;
    for (const r of rows) {
      const choice = r.dup ? (r.choice || "replace") : "new";
      if (choice === "skip") continue;
      if (choice === "replace") {
        list = list.map((x) => (x.id === r.dup.id ? { ...x, ...r.q, updated: now } : x));
        firstId = firstId || r.dup.id;
      } else {
        const id = uid();
        list.push({ id, project, ...r.q, added: now, updated: now });
        firstId = firstId || id;
      }
      n++;
    }
    save(list);
    openId = firstId; cat = "All"; draft = null;
    notice = n ? `Imported ${n} answer${n === 1 ? "" : "s"}.` : "Nothing was imported.";
    render();
    setTimeout(() => { notice = ""; if (project) render(); }, 4000);
  }

  async function remove(id) {
    const q = load().find((x) => x.id === id);
    if (!q) return;
    const yes = await window.TrackerUI.confirmDialog({
      title: `Delete "${q.title}"?`,
      intro: "This removes the question and its steps from the FAQ.",
      confirmLabel: "Delete question",
    });
    if (!yes) return;
    save(load().filter((x) => x.id !== id));
    openId = null;
    render();
  }

  function copySteps(q) {
    const plain = (s) => s.replace(/\*\*/g, "");
    const text = [q.title, q.summary, ...q.sections.flatMap((s) => [
      "", ...(s.heading ? [s.heading] : []), ...s.steps.map((x, i) => `${i + 1}. ${plain(x)}`)])].filter((x) => x !== undefined).join("\n");
    const done = () => { notice = "Steps copied."; render(); setTimeout(() => { notice = ""; if (project) render(); }, 2500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
  }

  /* -------------------------------------------------------------- events */
  const D = () => draft;

  document.addEventListener("click", (e) => {
    const pj = e.target.closest("[data-faq-project]");
    if (pj) { project = pj.dataset.faqProject; openId = null; cat = "All"; draft = null; ai = null; return render(); }
    const go = e.target.closest("[data-faq-goto]");
    if (go) { const [p, id] = go.dataset.faqGoto.split(":"); project = p; openId = id; cat = "All"; draft = null; return render(); }
    const op = e.target.closest("[data-faq-open]");
    if (op) {
      if (draft) return;   // finish or cancel the edit first
      openId = op.dataset.faqOpen; return render();
    }
    const c = e.target.closest("[data-faq-cat]");
    if (c) { cat = c.dataset.faqCat; return render(); }
    // The import menu closes on any click outside it.
    const menu = document.querySelector(".faq-menu");
    if (menu && !menu.hidden && !e.target.closest(".faq-menuwrap")) menu.hidden = true;
    const b = e.target.closest("[data-faq]");
    if (!b || b.disabled) return;
    const act = b.dataset.faq, open = () => load().find((x) => x.id === openId);
    const at = () => b.dataset.i.split(":").map(Number);
    switch (act) {
      case "template": return downloadTemplate();
      case "back": project = null; draft = null; ai = null; return render();
      case "importmenu": { const m = b.parentElement.querySelector(".faq-menu"); m.hidden = !m.hidden; return; }
      case "importfile": b.closest(".faq-menu").hidden = true; return importFile();
      case "importpaste": b.closest(".faq-menu").hidden = true; return pasteDialog();
      case "ai": return askAI(window.TrackerLinks.findValue("faq"), inProject());
      case "copy": return open() && copySteps(open());
      case "delete": return open() && remove(openId);
      case "edit": if (open()) { draft = JSON.parse(JSON.stringify(open())); render(); } return;
      case "new":
        draft = { id: null, project, title: "", category: cat !== "All" ? cat : "General", summary: "", keywords: [], sections: [{ heading: "", steps: [""] }] };
        return render();
      case "cancel": draft = null; return render();
      case "save": return saveDraft();
      case "addstep": D().sections[+b.dataset.i].steps.push(""); return render();
      case "addsec": D().sections.push({ heading: "", steps: [""] }); return render();
      case "delsec": D().sections.splice(+b.dataset.i, 1); return render();
      case "delstep": { const [si, i] = at(); D().sections[si].steps.splice(i, 1); return render(); }
      case "up": case "down": {
        const [si, i] = at(), st = D().sections[si].steps, j = act === "up" ? i - 1 : i + 1;
        [st[i], st[j]] = [st[j], st[i]]; return render();
      }
    }
  });

  document.addEventListener("input", (e) => {
    const f = e.target.closest("[data-faq-f]");
    if (!f || !draft) return;
    const k = f.dataset.faqF, v = f.value;
    if (k === "keywords") draft.keywords = v.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    else if (k.startsWith("h:")) draft.sections[+k.slice(2)].heading = v;
    else if (k.startsWith("s:")) { const [, si, i] = k.split(":").map(Number); draft.sections[si].steps[i] = v; }
    else draft[k] = v;
  });

  function saveDraft() {
    const d = normalise(draft);
    if (!d.title) { notice = "Give the question a title before saving."; return render(); }
    if (!d.sections.some((s) => s.steps.length)) { notice = "Add at least one step before saving."; return render(); }
    const now = new Date().toISOString();
    let list = load();
    if (draft.id) list = list.map((x) => (x.id === draft.id ? { ...x, ...d, updated: now } : x));
    else { const id = uid(); list.push({ id, project, ...d, added: now, updated: now }); openId = id; }
    if (draft.id) openId = draft.id;
    save(list);
    draft = null; notice = "";
    render();
  }

  window.TrackerFAQ = { view, count, parse, search, TEMPLATE, PROJECTS, _state: () => ({ project, openId, cat, editing: !!draft }) };
})();
