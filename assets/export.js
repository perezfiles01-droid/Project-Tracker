/* Export the To Do List as a plain-text report.

   One job: turn the tasks you pick into a .txt file you can send to somebody,
   paste into an email, or keep. Three things decide how it is built.

   1. THE FACTS COME FROM STORAGE, NEVER FROM THE MODEL. Every field printed
      below - the number, the name, the project, the dates, the status, the
      description, the update trail - is written out of the task record
      verbatim. The AI writes prose that sits BESIDE those facts and never in
      place of them, so a model that misreads a task, or invents one, cannot
      make the report say something your data does not. That is a property of
      the layout, not a promise about the prompt.

   2. THE AI IS NEVER WHAT DECIDES WHETHER YOU GET A FILE. No key in Settings,
      a dead network, a rate limit, a refusal: the export still saves, with one
      line saying why the summary is missing and every task complete beneath
      it. An export is how you get your own work out, and making that depend on
      a third party being up would be the wrong trade every time.

   3. IT AGREES WITH THE SCREEN. The numbering, the local-day arithmetic and
      the reference links are read from TrackerTasks rather than reimplemented,
      because a report that numbers tasks differently from the table it was
      exported from is worse than no report - it looks authoritative and is
      not.

   Written as its own module rather than inside tasks.js, which is already a
   thousand lines and owns a different job. Daily activity lists the same task
   records through the same pane, so pointing a second button at
   TrackerExport.dialog({ scope: "logged" }) is the whole of giving that page
   an export too. */
(() => {
  const T = () => window.TrackerTasks;
  const UI = () => window.TrackerUI;

  /** How wide the prose wraps. Narrow enough to stay readable pasted into mail. */
  const WIDTH = 76;
  const RULE = "=".repeat(WIDTH);
  const THIN = "-".repeat(WIDTH);

  /* ------------------------------------------------------------ rich text */
  /**
   * Rich text flattened to lines, keeping the shape it was written in.
   *
   * NOT TrackerUI.htmlText, deliberately, and the difference is the whole
   * reason this exists: htmlText collapses every run of whitespace into one
   * space and returns a single line, which is exactly right for a table cell
   * and for the search index it was written for. A description typed as four
   * bullet points would arrive in the report as one long sentence with the
   * bullets rubbed out. A report is read, so the paragraphs, the list items
   * and the table rows have to survive.
   *
   * Falls back to htmlText if DOMParser is unavailable or throws, so the worst
   * case is the old flat line rather than an empty field.
   */
  function flatten(html) {
    const src = String(html ?? "");
    if (!src) return "";
    if (!/[<&]/.test(src)) return src.trim();
    try {
      const doc = new DOMParser().parseFromString("<body>" + src + "</body>", "text/html");
      const out = [];
      const walk = (node) => {
        for (const el of node.childNodes) {
          if (el.nodeType === 3) {                       // a run of text
            const t = el.textContent.replace(/\s+/g, " ");
            if (t.trim()) out[out.length - 1] = (out[out.length - 1] || "") + t;
            continue;
          }
          if (el.nodeType !== 1) continue;
          const tag = el.tagName.toLowerCase();
          if (tag === "br") { out.push(""); continue; }
          if (tag === "img") {
            // Bytes cannot go in a .txt, so a picture is named rather than
            // silently dropped: a reader who cannot see it should at least
            // know the task carries one.
            out.push("[image]");
            continue;
          }
          if (tag === "li") {
            out.push("  - ");
            walk(el);
            continue;
          }
          if (tag === "tr") {
            out.push("  ");
            const cells = [...el.children].map((c) => (c.textContent || "").replace(/\s+/g, " ").trim());
            out[out.length - 1] += cells.join(" | ");
            continue;
          }
          if (/^(p|div|ul|ol|table|thead|tbody|h[1-6]|blockquote)$/.test(tag)) {
            if ((out[out.length - 1] || "").trim()) out.push("");
            walk(el);
            if ((out[out.length - 1] || "").trim()) out.push("");
            continue;
          }
          walk(el);                                       // b, i, span, a, td…
        }
      };
      out.push("");
      walk(doc.body);
      return out.map((l) => l.replace(/\s+$/, ""))
                .join("\n").replace(/\n{3,}/g, "\n\n").trim();
    } catch {
      return UI().htmlText(src);
    }
  }

  /** Wrap one paragraph to WIDTH, indented, without breaking a long word. */
  function wrap(text, indent = "") {
    const room = Math.max(20, WIDTH - indent.length);
    const out = [];
    for (const para of String(text || "").split("\n")) {
      if (!para.trim()) { out.push(""); continue; }
      // An indent the line already carries (a bullet, a table row) is kept and
      // its continuation lines are lined up under it.
      const own = (para.match(/^\s*(- )?/) || [""])[0];
      const body = para.slice(own.length);
      const hang = indent + " ".repeat(own.length);
      let line = indent + own;
      let first = true;
      for (const word of body.split(/\s+/).filter(Boolean)) {
        const start = first ? line : hang;
        if (line.length + (first ? 0 : 1) + word.length > room + indent.length && !first) {
          out.push(line);
          line = hang + word;
        } else {
          line = (first ? start : line + " ") + word;
          first = false;
        }
      }
      out.push(line);
    }
    return out;
  }

  /* ----------------------------------------------------------- the ranges */
  /**
   * The presets, each answering with [from, to] as local calendar days.
   *
   * Computed on open rather than at load: a tab left open overnight would
   * otherwise export yesterday when you asked for today. "All dates" answers
   * with empty bounds, which is what makes the range optional throughout.
   */
  const shift = (days) => {
    const d = new Date(T().today() + "T00:00:00");
    d.setDate(d.getDate() + days);
    return T().dayOf(d);
  };
  const PRESETS = {
    "Today": () => [T().today(), T().today()],
    "Yesterday": () => [shift(-1), shift(-1)],
    "Last 7 days": () => [shift(-6), T().today()],
    "Last 30 days": () => [shift(-29), T().today()],
    "This month": () => [T().today().slice(0, 8) + "01", T().today()],
    "All dates": () => ["", ""],
    "Custom (use the two dates below)": () => null,
  };
  const PRESET_NAMES = Object.keys(PRESETS);

  /**
   * The day a task is filed under for the purpose of a date range.
   *
   * `given` is the Task Create Date column - the date you see, and the one you
   * are free to edit - so it leads. createdAt is the true instant and is used
   * only when `given` was deliberately cleared, so a task with no visible date
   * is still placed somewhere rather than vanishing from every range.
   */
  function dayOfTask(t) {
    if (t.given) return t.given;
    if (t.createdAt) {
      const d = new Date(t.createdAt);
      if (!isNaN(d.getTime())) return T().dayOf(d);
    }
    return "";
  }

  /**
   * Is this task inside the range? Both ends INCLUSIVE.
   *
   * Inclusive because of what the dialog says: picking the 1st and the 14th
   * means the fortnight including both, which is what anybody reading "from"
   * and "to" expects. Compared as YYYY-MM-DD strings, which sort correctly as
   * text and avoid building Date objects whose timezone would reintroduce the
   * off-by-one this app already fixed once.
   *
   * A task with no date at all is in range only when no bounds were given. It
   * cannot honestly be called "created today", and quietly including it in
   * every range would put undated tasks in reports that exclude them.
   */
  function inRange(t, from, to) {
    const day = dayOfTask(t);
    if (!from && !to) return true;
    if (!day) return false;
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  }

  /* --------------------------------------------------------- the selection */
  const SCOPES = {
    "In progress (what the To Do List shows)": "active",
    "All tasks (includes blocked and completed)": "all",
    "Blocked and completed only": "logged",
  };

  function select({ scope, from, to, project }) {
    const all = T().load();
    const by = scope === "all" ? all
             : scope === "logged" ? all.filter((t) => T().LOGGED(t.status))
             : all.filter((t) => !T().LOGGED(t.status));
    // Numbered BEFORE the date range is applied, through the list's own
    // function, so a task is number 3 in the report because it is number 3 on
    // the screen. Numbering the filtered rows instead would renumber them 1..n
    // per export, and two reports over different weeks would both contain a
    // different "task 1".
    const numbered = T().numbered(by);
    return numbered
      .filter((t) => inRange(t, from, to))
      .filter((t) => !project || t.project === project);
  }

  /* ------------------------------------------------------------ the digest */
  /**
   * What the model is shown: the tasks, as text, with their numbers.
   *
   * Deliberately not JSON. A field dump invites a model to describe the
   * structure it was handed; this reads as notes about work, which is what it
   * is being asked to summarise. Attachment bytes and image ids are left out -
   * they carry nothing to summarise and would spend the budget.
   */
  function digest(tasks) {
    return tasks.map((t) => {
      const parts = [`TASK ${t.no}: ${t.name || "(no name)"}`];
      if (t.project) parts.push(`Project: ${t.project}`);
      parts.push(`Status: ${t.status || "In progress"}`);
      if (t.given) parts.push(`Created: ${t.given}`);
      if (t.due) parts.push(`Due: ${t.due}${T().overdue(t) ? " (OVERDUE)" : ""}`);
      if (t.assignee) parts.push(`Assignee: ${t.assignee}`);
      const d = flatten(t.description);
      if (d) parts.push(`Description: ${d}`);
      const ups = T().updatesOf(t);
      if (ups.length) {
        parts.push("Updates:");
        for (const u of ups) parts.push(`  ${u.date || "(undated)"}: ${flatten(u.text) || "(no text)"}`);
      }
      return parts.join("\n");
    }).join("\n\n");
  }

  /**
   * Split the model's reply into the summary and one line per task.
   *
   * Tolerant on purpose. A reply that ignores the shape asked for costs the
   * per-task lines and nothing else: whatever came back is kept whole as the
   * summary, and every task still reaches the file with all of its facts. The
   * report degrades; it never breaks.
   */
  function parseReport(text) {
    const src = String(text || "").trim();
    if (!src) return { summary: "", perTask: {} };
    const lines = src.split("\n");
    const perTask = {};
    let bucket = "summary";
    const buf = { summary: [] };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (/^\s*SUMMARY\s*:?\s*$/i.test(line)) { bucket = "summary"; continue; }
      const m = line.match(/^\s*TASK\s+(\d+)\s*:?\s*$/i);
      if (m) { bucket = m[1]; buf[bucket] = buf[bucket] || []; continue; }
      (buf[bucket] = buf[bucket] || []).push(line);
    }
    for (const k of Object.keys(buf)) {
      const v = buf[k].join("\n").trim();
      if (k === "summary") continue;
      if (v) perTask[k] = v;
    }
    return { summary: (buf.summary || []).join("\n").trim(), perTask };
  }

  /* ------------------------------------------------------------- the file */
  const pad2 = (n) => String(n).padStart(2, "0");

  /** The create date with its time, under the same rule the table applies. */
  function stamp(t) {
    if (!t.given) return "";
    const at = t.createdAt ? new Date(t.createdAt) : null;
    // The time is printed only when createdAt falls on the day `given` names.
    // They differ once the date has been edited, and printing this morning's
    // clock time beside a date moved to last week states something that never
    // happened. Same rule as createStamp in tasks.js, and the guard asserts
    // the two agree.
    if (!at || isNaN(at.getTime()) || T().dayOf(at) !== t.given) return t.given;
    return `${t.given} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  }

  const size = (n) => (!n && n !== 0 ? "" : n < 1024 ? n + " B"
                    : n < 1048576 ? (n / 1024).toFixed(0) + " KB"
                    : (n / 1048576).toFixed(1) + " MB");

  function rangeLabel(from, to) {
    if (!from && !to) return "All dates";
    if (from && to && from === to) return `${from} only`;
    if (from && to) return `${from} to ${to}`;
    return from ? `${from} onwards` : `up to ${to}`;
  }

  /**
   * The whole report, as one string.
   *
   * Exported and pure, so the guard can assert what a given set of tasks
   * produces without a download, a clock or a network.
   */
  function buildText(tasks, opts = {}) {
    const { from = "", to = "", project = "", scopeLabel = "", summary = "",
            perTask = {}, aiNote = "", at = new Date() } = opts;
    const L = [];
    const when = `${T().dayOf(at)} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;

    L.push(RULE, "PROJECT TRACKER - TASK REPORT", RULE, "");
    L.push(`Generated   ${when}`);
    L.push(`Tasks       ${scopeLabel || "In progress"}`);
    L.push(`Dates       ${rangeLabel(from, to)}`);
    L.push(`Project     ${project || "All projects"}`);
    L.push(`Count       ${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
    L.push("");

    L.push(THIN, "REPORT SUMMARY", THIN, "");
    if (summary) L.push(...wrap(summary));
    else L.push(...wrap(aiNote || "No summary was generated."));
    L.push("");

    if (!tasks.length) {
      L.push(THIN, "No tasks fall in this range.", THIN, "");
      return L.join("\n");
    }

    for (const t of tasks) {
      L.push(RULE);
      L.push(`TASK ${t.no}  ${t.name || "(no name)"}`.slice(0, WIDTH));
      L.push(RULE, "");
      const field = (k, v) => L.push(`  ${(k + "                ").slice(0, 18)}${v || "-"}`);
      field("Task No.", t.no);
      field("Name of task", t.name);
      field("Project", t.project);
      field("Task Create Date", stamp(t));
      field("Due Date", t.due ? t.due + (T().overdue(t) ? "   ** OVERDUE **" : "") : "");
      field("Status", t.status || "In progress");
      field("Assignee", t.assignee);
      L.push("");

      if (perTask[t.no]) {
        L.push("  IN PLAIN TERMS");
        L.push(...wrap(perTask[t.no], "    "));
        L.push("");
      }

      L.push("  DESCRIPTION");
      const d = flatten(t.description);
      L.push(...(d ? wrap(d, "    ") : ["    (none)"]));
      L.push("");

      const refs = T().refsOf(t);
      if (refs.length) {
        L.push("  REFERENCE LINKS");
        refs.forEach((r, i) => {
          L.push(`    ${i + 1}. ${r.url}`);
          if (r.note) L.push(...wrap(r.note, "       "));
        });
        L.push("");
      }

      const ups = T().updatesOf(t);
      L.push(`  UPDATE TRAIL  (${ups.length} update${ups.length === 1 ? "" : "s"})`);
      if (!ups.length) L.push("    (no updates yet)", "");
      for (const u of ups) {
        const atU = u.at ? new Date(u.at) : null;
        const sameDay = atU && !isNaN(atU.getTime()) && T().dayOf(atU) === u.date;
        L.push(`    ${u.date || "(undated)"}${sameDay ? ` ${pad2(atU.getHours())}:${pad2(atU.getMinutes())}` : ""}`);
        const txt = flatten(u.text);
        L.push(...(txt ? wrap(txt, "        ") : ["        (no text)"]));
        if ((u.images || []).length) {
          L.push(`        [${u.images.length} image${u.images.length === 1 ? "" : "s"}: ` +
                 u.images.map((a) => a.name).join(", ") + "]");
        }
        L.push("");
      }

      const atts = t.attachments || [];
      if (atts.length) {
        L.push("  ATTACHMENTS");
        for (const a of atts) {
          L.push(a.kind === "link"
            ? `    ${a.name || "link"}  ${a.url || ""}`
            : `    ${a.name}${a.size ? "  (" + size(a.size) + ")" : ""}`);
        }
        L.push("    (held in this browser, not inside this text file, but named");
        L.push("     here so you know the task carries them)");
        L.push("");
      }
    }

    L.push(RULE);
    L.push(`End of report. ${tasks.length} task${tasks.length === 1 ? "" : "s"}, ${rangeLabel(from, to)}.`);
    L.push(RULE, "");
    return L.join("\n");
  }

  /* ---------------------------------------------------------- the download */
  function fileName(from, to) {
    const base = !from && !to ? "all-dates"
               : from && to && from === to ? from
               : `${from || "start"}_to_${to || T().today()}`;
    return `task-report-${base}.txt`;
  }

  /**
   * Hand the text to the browser as a file.
   *
   * Through TrackerUI.saveBlob, which every save in this app now goes through:
   * a hand-rolled anchor here would be a fifth copy of the race it exists to
   * close. charset is stated because a report carries whatever you typed, and
   * a description with an accent in it opens as mojibake without it.
   */
  function saveText(text, name) {
    UI().saveBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), name);
  }

  /* ------------------------------------------------------------ the dialog */
  /**
   * Ask what to export, build it, save it.
   *
   * The AI step is wrapped so that every way it can fail - no key, refused
   * key, rate limit, dead network, a reply that is empty - lands in the file
   * as one readable line instead of stopping the export. That is the whole
   * shape of this function: the only thing that ends it without a file is
   * cancelling the dialog.
   */
  async function dialog({ scope = "active" } = {}) {
    const all = T().load();
    const projects = [...new Set(all.map((t) => t.project).filter(Boolean))].sort();
    const scopeNames = Object.keys(SCOPES);
    const startScope = scopeNames.find((k) => SCOPES[k] === scope) || scopeNames[0];

    const v = await UI().formDialog({
      title: "Export tasks as a report",
      intro: "Saves a .txt report of the tasks you pick. The facts come from " +
             "your tasks; AI writes the summary that explains them.",
      submitLabel: "Export .txt",
      fields: [
        { name: "scope", label: "Which tasks", type: "select",
          options: scopeNames, value: startScope },
        { name: "range", label: "Date range", type: "select",
          options: PRESET_NAMES, value: "Today",
          help: "Filters on Task Create Date. Both dates are included." },
        { name: "from", label: "From (custom range)", type: "date", value: T().today() },
        { name: "to", label: "To (custom range)", type: "date", value: T().today() },
        { name: "project", label: "Project", type: "select",
          options: ["All projects", ...projects], value: "All projects" },
        { name: "ai", label: "AI summary", type: "select",
          options: ["Yes, write a summary", "No, facts only"],
          value: window.TrackerAI && window.TrackerAI.hasKey()
            ? "Yes, write a summary" : "No, facts only",
          help: window.TrackerAI && window.TrackerAI.hasKey()
            ? "Uses the engine set in Settings."
            : "No AI key is set, so the report will be facts only. Add one in Settings." },
      ],
    });
    if (!v) return;

    const preset = PRESETS[v.range] ? PRESETS[v.range]() : null;
    const [from, to] = preset || [v.from || "", v.to || ""];
    const project = v.project === "All projects" ? "" : v.project;
    const picked = select({ scope: SCOPES[v.scope] || "active", from, to, project });

    let summary = "", perTask = {}, aiNote = "";
    if (v.ai !== "No, facts only" && picked.length) {
      try {
        const reply = await window.TrackerAI.report(digest(picked));
        const parsed = parseReport(reply);
        summary = parsed.summary;
        perTask = parsed.perTask;
        if (!summary && !Object.keys(perTask).length) {
          aiNote = "The AI returned nothing, so this report is facts only.";
        }
      } catch (err) {
        // Named, not swallowed. "No summary" with no reason is a report you
        // cannot act on; knowing the key was refused is what tells you to go
        // to Settings.
        aiNote = "No AI summary: " + (err && err.message ? err.message : "the request failed.") +
                 " Every task below is complete.";
      }
    } else if (!picked.length) {
      aiNote = "There is nothing in this range to summarise.";
    } else {
      aiNote = "AI summary was turned off for this export.";
    }

    const text = buildText(picked, {
      from, to, project, scopeLabel: v.scope, summary, perTask, aiNote,
    });
    saveText(text, fileName(from, to));
    return { count: picked.length, name: fileName(from, to), text };
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-export]");
    if (b) dialog({ scope: b.dataset.export || "active" });
  });

  window.TrackerExport = { dialog, buildText, select, inRange, flatten, wrap,
                           digest, parseReport, fileName, saveText,
                           PRESETS, PRESET_NAMES, SCOPES, dayOfTask };
})();
