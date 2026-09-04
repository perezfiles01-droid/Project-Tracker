/* To Do List — task cards you create, edit and delete.

   Storage is split on purpose. Task metadata is small and is read on every
   render, so it lives in localStorage. Attachment bytes do not: localStorage
   holds roughly 5 MB for the whole origin and two screenshots would exhaust
   it, taking the pinned links and the task list down with them. Bytes go to
   IndexedDB, which is sized for blobs; the task record keeps only a
   reference. */
(() => {
  const KEY = "tracker.tasks";
  const DB = "tracker-files", STORE = "blobs";
  /* One vocabulary, used by the task pane, the task dialog and the Daily
     activity dialog. They were three separate lists, and the log wrote
     "Completed" for a status the task list called "Done".

     Three, not four. "To do" and "In progress" were the same thing said twice:
     a task on the list is a task to do, and the status that mattered was which
     of them had been picked up. The status now decides which page the task is
     on - In progress is the To Do List, Blocked and Done are Daily activity -
     so a fourth word for "not finished" would put a task in two places. */
  const STATUSES = ["In progress", "Blocked", "Done"];
  const ACTIVE = "In progress";
  const BLOCKED = "Blocked";
  const DONE = "Done";
  /** The two statuses that belong in the log rather than the task list. */
  const LOGGED = (s) => s === DONE || s === BLOCKED;
  const DEFAULT_ASSIGNEE = "Jim";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const LOG = "tracker.activity";
  const load = () => window.TrackerStore.get(KEY, []);
  const logRead = () => window.TrackerStore.get(LOG, []);
  const logWrite = (a) => window.TrackerStore.set(LOG, a);
  const save = (list) => window.TrackerStore.set(KEY, list);
  window.TrackerTasks = { load };

  /**
   * Bring what is already saved onto the three-status rule, once.
   *
   * Two things are reconciled, and only if something actually needs it - a
   * browser with nothing to change writes nothing at all:
   *
   *   1. A task saved as "To do", or with no status, becomes In progress.
   *      Dropping the word without this leaves tasks carrying a value no
   *      picker offers, which reads as an empty status box.
   *   2. A log entry the app wrote itself (origin "task") is a record derived
   *      from a status, so one whose task is no longer Done or Blocked is
   *      removed - that is the rule applied to data saved before the rule
   *      existed. Entries typed by hand are left exactly as they are: they are
   *      not derived from anything, and an upgrade that deletes what someone
   *      wrote is a bug however tidy the result looks.
   */
  function migrate() {
    const tasks = window.TrackerStore.get(KEY, []);
    let touched = false;
    for (const t of tasks) {
      if (!t.status || t.status === "To do") { t.status = ACTIVE; touched = true; }
    }
    if (touched) window.TrackerStore.set(KEY, tasks);

    const log = window.TrackerStore.get(LOG, []);
    const alive = log.filter((e) => {
      if (e.origin !== "task") return true;
      const t = tasks.find((x) => x.id === e.taskId);
      return !!t && LOGGED(t.status);
    });
    // And the other direction, which matters more: a task saved as Done or
    // Blocked before this rule existed, with no entry of its own, would be on
    // neither page - off the To Do List by its status and absent from the log
    // for want of a record. Reconciling only one way loses tasks quietly.
    let added = false;
    for (const t of tasks) {
      if (!LOGGED(t.status)) continue;
      if (alive.some((e) => e.origin === "task" && e.taskId === t.id)) continue;
      alive.push({
        id: "a-" + t.id, taskId: t.id, date: t.given || t.created || today(),
        task: t.description || t.name || "Task",
        status: t.status, url: t.ref || "", origin: "task",
      });
      added = true;
    }
    if (added || alive.length !== log.length) window.TrackerStore.set(LOG, alive);
  }
  // Called at the foot of this file, not here: migrate() reads today(), which
  // is declared further down, and calling it from this line threw before the
  // app had rendered a single row.

  /* ---------- attachment bytes ---------- */
  const idb = () => new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const putBlob = async (id, blob) => {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, id);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  };
  const getBlob = async (id) => {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const rq = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => reject(rq.error);
    });
  };
  const dropBlob = async (id) => {
    const db = await idb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
  };

  /* ---------- dates ---------- */
  const today = () => new Date().toISOString().slice(0, 10);
  const overdue = (t) => t.due && t.status !== "Done" && t.due < today();
  const dueSoon = (t) => {
    if (!t.due || t.status === "Done" || overdue(t)) return false;
    const d = new Date(t.due + "T00:00:00"), n = new Date(today() + "T00:00:00");
    return (d - n) / 86400000 <= 2;
  };

  /* ---------- create / edit ---------- */
  async function editTask(id) {
    const list = load();
    const cur = id ? list.find((t) => t.id === id) : null;
    if (id && !cur) return;
    const projects = (window.TrackerProjectNames ? window.TrackerProjectNames() : []);
    // Every field is optional: a task with nothing filled in at all is valid,
    // so the only thing that stops a save is cancelling the dialog.
    const values = await window.TrackerUI.formDialog({
      title: cur ? "Edit task" : "New task",
      submitLabel: cur ? "Save changes" : "Add task",
      fields: [
        // Project leads, because it is what the number is followed by in the
        // table and it is chosen before anything is written.
        { name: "project", label: "Project", type: "select",
          options: ["", ...projects, "Other"], value: cur ? cur.project : "",
          help: "The projects listed on the Overview page." },
        { name: "name", label: "Name of task", value: cur ? (cur.name || "") : "",
          placeholder: "Short name shown in the table", standardize: true, capitalize: true },
        { name: "description", label: "Detailed description", type: "textarea", rows: 4,
          value: cur ? cur.description : "",
          help: "Shown when you click the task, not in the table.",
          placeholder: "What needs doing", standardize: true, capitalize: true },
        // Filled in with today for a new task, and only as a default: editing
        // shows the task's own date, including one deliberately cleared. The
        // stored key stays `given` - renaming it would blank this column for
        // every task already saved, which is data loss dressed as a rename.
        { name: "given", label: "Task Create Date", type: "date",
          value: cur ? (cur.given || "") : today() },
        { name: "due", label: "Due Date", type: "date", value: cur ? cur.due : "" },
        { name: "ref", label: "Reference link", value: cur ? cur.ref : "", placeholder: "https://…" },
        // Only when editing. A new task is In progress by definition - you are
        // writing down something to do - so asking for a status at creation is
        // a field with one sensible answer. It is changed afterwards, from
        // here or from the dropdown in the pane.
        ...(cur ? [{ name: "status", label: "Status", type: "select",
                     options: [...new Set([...STATUSES, cur.status].filter(Boolean))],
                     value: cur.status }] : []),
        // A new task is assigned to Jim unless you say otherwise. Editing shows
        // the task's own assignee, including a deliberately empty one: a
        // default that overwrites what you already saved is a different
        // feature, and a worse one.
        { name: "assignee", label: "Assignee", value: cur ? (cur.assignee || "") : DEFAULT_ASSIGNEE },
        { name: "files", label: "Attach an image/file", type: "attachments",
          value: cur ? cur.attachments || [] : [],
          help: "Paste a screenshot with Ctrl+V, or choose files. Up to five. " +
                "Stored in this browser only, and never in the backup file." },
      ],
    });
    if (!values) return;

    // A status change made in the dialog moves the task between the two pages
    // exactly as the dropdown in the pane does, so it asks the same question.
    // Declining keeps the status it had and saves the rest of the edit: the
    // answer was about the move, not about the other six fields.
    if (cur && values.status && values.status !== cur.status &&
        LOGGED(values.status) !== LOGGED(cur.status) &&
        !await confirmMove(cur, values.status)) {
      values.status = cur.status;
    }

    const target = cur || { id: "t-" + Date.now(), created: today(), attachments: [] };
    Object.assign(target, {
      // No "no" here: the number is the task's position, worked out at render.
      name: values.name, description: values.description, given: values.given,
      due: values.due, ref: values.ref, status: values.status || ACTIVE,
      assignee: values.assignee, project: values.project,
    });

    const kept = (target.attachments || []).filter((a) => values.files.keep.includes(a.id));
    for (const gone of (target.attachments || []).filter((a) => !kept.includes(a) && a.kind !== "link")) {
      await dropBlob(gone.id);
    }
    for (const file of values.files.added) {
      const aid = "a-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      await putBlob(aid, file);
      kept.push({ id: aid, name: file.name, size: file.size, type: file.type, kind: "file" });
    }
    target.attachments = kept;

    if (!cur) list.push(target);
    save(list);
    syncLog(target);
    window.TrackerRender();
  }

  /**
   * Keep the activity log agreeing with the task's status, in both directions.
   *
   * logDone only ever wrote, and only for Done, which is why a task could not
   * come back: the entry was a record of a moment rather than a reflection of
   * where the task is now. Blocked and Done put a task in the log; anything
   * else takes it out again. Still one entry per task, guarded on the task id,
   * so Done to Blocked updates the entry it already has rather than adding a
   * second - and the date and any wording edited by hand survive that.
   *
   * Entries typed by hand (origin "manual") are never touched here.
   */
  function syncLog(t) {
    const log = logRead();
    const mine = log.find((e) => e.origin === "task" && e.taskId === t.id);
    if (!LOGGED(t.status)) {
      if (!mine) return;
      return logWrite(log.filter((e) => e !== mine));
    }
    if (mine) {
      mine.status = t.status;
      return logWrite(log);
    }
    log.push({
      id: "a-" + Date.now(), taskId: t.id, date: today(),
      task: t.description || t.name || "Task",
      status: t.status, url: t.ref || "", origin: "task",
    });
    logWrite(log);
  }

  /**
   * Ask before a status change moves the task to the other page.
   *
   * Both directions ask, because both move something. Marking a task Blocked
   * or Done takes it off the To Do List; putting it back to In progress
   * deletes the entry it had in Daily activity, and a log entry disappearing
   * with no prompt is the worse of the two surprises. The dialog is the one
   * every delete in the app already uses rather than a new pattern.
   */
  function confirmMove(t, status) {
    const name = String(t.name || t.description || "This task").slice(0, 60);
    if (LOGGED(status)) {
      return window.TrackerUI.confirmDialog({
        title: status === DONE ? "Mark as done" : "Mark as blocked",
        intro: `"${name}" will move off the To Do List and be logged in ` +
               `Daily activity as ${status}.`,
        confirmLabel: status === DONE ? "Mark done" : "Mark blocked",
      });
    }
    return window.TrackerUI.confirmDialog({
      title: "Back to in progress",
      intro: `"${name}" will return to the To Do List, and its Daily activity ` +
             "entry will be removed.",
      confirmLabel: "Move back",
    });
  }

  /**
   * Set a task's status, and keep the two pages agreeing about where it lives.
   *
   * Nothing is written until the prompt is answered, and declining re-renders:
   * the dropdown snaps back to the status actually saved rather than sitting
   * on one nobody agreed to.
   */
  async function setStatus(id, status) {
    const t = load().find((x) => x.id === id);
    if (!t || t.status === status) return;
    if (!await confirmMove(t, status)) return window.TrackerRender();
    // Read again: the dialog was open, and awaiting it is time in which
    // anything else could have written to storage.
    const list = load();
    const target = list.find((x) => x.id === id);
    if (!target) return window.TrackerRender();
    target.status = status;
    save(list);
    syncLog(target);
    window.TrackerRender();
  }

  async function removeTask(id) {
    const list = load();
    const t = list.find((x) => x.id === id);
    if (!t) return;
    const n = (t.attachments || []).length;
    const yes = await window.TrackerUI.confirmDialog({
      title: "Remove task",
      intro: `Remove "${t.name || "this task"}"?` +
             (n ? ` Its ${n} attachment${n === 1 ? "" : "s"} go with it.` : ""),
      confirmLabel: "Remove task",
    });
    if (!yes) return;
    for (const a of t.attachments || []) if (a.kind !== "link") await dropBlob(a.id);
    save(list.filter((x) => x.id !== id));
    window.TrackerRender();
  }

  /**
   * Open an attachment held in IndexedDB in a new TAB.
   *
   * This used to call window.open(url, "_blank", "noopener"). Passing a third
   * windowFeatures argument makes browsers open a stripped-down popup WINDOW
   * rather than a tab in the window you are already in. A synthetic anchor
   * click is an ordinary target="_blank" navigation, which every other link
   * in the app already uses.
   */
  async function openAttachment(id) {
    const blob = await getBlob(id);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /**
   * Save an attachment to disk, under the name it was attached with.
   *
   * An anchor carrying `download` on a blob URL saves immediately rather than
   * navigating, which is what makes an attachment behave like a file again
   * once it is inside IndexedDB.
   */
  async function downloadAttachment(id) {
    const list = load();
    const meta = list.flatMap((t) => t.attachments || []).find((a) => a.id === id);
    const blob = await getBlob(id);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (meta && meta.name) || "attachment";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ---------- render ---------- */
  const ROWS_PER_PAGE = 10;
  // The table carries what you scan by; everything else is in the pane beside
  // it. A column removed from here must stay reachable there, which the guard
  // asserts field by field.
  const COLUMNS = ["Task No.", "Name of task", "Project"];
  let openRow = null;   // the task shown in the pane

  /** Every link on a task, wherever it was entered. */
  function taskLinks(t) {
    const out = [];
    if (t.ref) out.push({ url: t.ref, label: "Open ↗" });
    for (const a of t.attachments || []) {
      if (a.kind === "link" && a.url) out.push({ url: a.url, label: "Link ↗" });
    }
    return out;
  }

  function refCell(t) {
    const links = taskLinks(t);
    if (!links.length) return `<span class="tag dead">—</span>`;
    return links.map((l) =>
      `<a class="btn sm" href="${esc(l.url)}" target="_blank" rel="noopener">${l.label}</a>`
    ).join(" ");
  }

  /**
   * One attachment, as View and Download.
   *
   * Two actions rather than one, because they are different jobs: View opens
   * the blob in a tab to look at, Download saves it under its own name. The
   * bytes are in IndexedDB either way, so both are resolved on click - a blob
   * URL minted at render time for every attachment on the page would leak one
   * per row per render.
   *
   * Links attached under the old "Attach a link" field are still shown. That
   * field is gone, but records that carry one are not, and a saved link that
   * stopped rendering would read as lost data.
   */
  function attachmentChip(a) {
    if (a.kind === "link") {
      return `<a class="tag" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name || "link")} ↗</a>`;
    }
    const img = /^image\//.test(a.type || "");
    return `<span class="attitem">
        <button class="tag attchip" data-att="${esc(a.id)}" title="${esc(a.name)}">
          ${img ? "🖼 " : ""}${esc(a.name)}</button>
        <button class="tag attdl" data-attdl="${esc(a.id)}" title="Download ${esc(a.name)}">Download</button>
      </span>`;
  }

  /**
   * The clicked task fills the pane beside the table: its own table of that
   * task's details, one labelled row per field, rather than a loose block.
   * Every field is listed even when empty, so what is missing is as visible as
   * what is filled in - and since the table itself now shows three columns,
   * this is the only place the rest of them exist.
   */
  function detailPane(t) {
    if (!t) {
      return `<aside class="taskpane empty-pane">
          <div class="empty">Click a task to see everything on it.</div>
        </aside>`;
    }
    return `<aside class="taskpane">${detailBody(t)}</aside>`;
  }

  function detailBody(t) {
    const atts = (t.attachments || []).map(attachmentChip).join("");
    const shots = (t.attachments || []).filter((a) => /^image\//.test(a.type || ""));
    const dash = `<span class="tag dead">—</span>`;
    const val = (v) => (v ? esc(v) : dash);
    const rows = [
      ["Task No.", val(t.no)],
      ["Name of task", val(t.name)],
      ["Project", t.project ? `<span class="tag accent">${esc(t.project)}</span>` : dash],
      ["Description", t.description
        ? `<span class="detaildesc">${esc(t.description)}</span>` : dash],
      ["Task Create Date", val(t.given)],
      ["Due Date", t.due
        ? `${esc(t.due)}${overdue(t) ? ` <span class="tag warn">overdue</span>` : ""}` : dash],
      ["Reference link", t.ref
        ? `<a class="btn sm" href="${esc(t.ref)}" target="_blank" rel="noopener">Open ↗</a>` : dash],
      // The status is set here rather than by a separate tick. A tick could
      // only ever say "Done"; the four statuses a task can be in all belong in
      // one control, in the row that names them. Any status already saved that
      // is not in the list is kept and offered on that record, so nothing
      // written before this change is rewritten or silently dropped.
      ["Status", `<select class="statuspick" data-status="${esc(t.id)}"
          aria-label="Status">${
          [...new Set([...STATUSES, t.status].filter(Boolean))].map((s) =>
            `<option value="${esc(s)}"${s === (t.status || STATUSES[0]) ? " selected" : ""}>${esc(s)}</option>`
          ).join("")}</select>`],
      ["Assignee", val(t.assignee)],
      ["Attachments", atts || dash],
    ];
    // Images get a strip of their own above the list. A thumbnail you can
    // click is how you tell one screenshot from four, which a row of filenames
    // never does. The src is filled in after render, since the bytes live in
    // IndexedDB and reading them is asynchronous.
    if (shots.length) {
      rows.splice(rows.length - 1, 0, ["Images", shots.map((a) =>
        `<button class="shot" data-att="${esc(a.id)}" title="${esc(a.name)}">
           <img data-shot="${esc(a.id)}" alt="${esc(a.name)}">
         </button>`).join("")]);
    }
    return `<div class="taskdetail">
          <div class="panehead">
            <h3>${t.name ? esc(t.name) : "Task " + esc(t.no || "")}</h3>
            <div class="row">
              ${window.TrackerUI.iconButton("edit", "Edit", `data-edit="task:${esc(t.id)}"`)}
              ${window.TrackerUI.iconButton("remove", "Remove", `data-remove="task:${esc(t.id)}"`)}
            </div>
          </div>
          <div class="tablewrap"><table class="detailtable">
            <tbody>${rows.map(([k, v]) =>
              `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`).join("")}</tbody>
          </table></div>
        </div>`;
  }

  function taskRow(t) {
    const dash = `<span class="tag dead">—</span>`;
    const short = (t.description || "").split("\n")[0].slice(0, 90);
    // Tasks created before "Name of task" existed fall back to their description.
    return `<tr class="taskrow${t.status === "Done" ? " done" : ""}${openRow === t.id ? " open" : ""}"
                data-open="${esc(t.id)}">
        <td>${t.no ? esc(t.no) : dash}</td>
        <td class="wrap"><span class="taskname">${t.name ? esc(t.name) : (short ? esc(short) : dash)}</span></td>
        <td>${t.project ? `<span class="tag accent">${esc(t.project)}</span>` : dash}${
          overdue(t) ? ` <span class="tag warn">overdue</span>` : ""}</td>
      </tr>`;
  }

  /**
   * The number in the Task No. column.
   *
   * It is the task's position in creation order, worked out here and attached
   * to this render's own copies - never stored. It used to be an editable
   * field pre-filled with max+1, which is how a list came to read 1, 2, 3, 4,
   * 1: nothing checked what you typed. Derived, it cannot collide, cannot be
   * edited into a duplicate, and closes its own gaps when a task is deleted.
   *
   * Attaching it as `no` rather than keeping a separate map is deliberate:
   * sorting, searching and the detail table all read fields off the task, so
   * they keep working untouched. load() parses fresh objects on every call, so
   * this cannot leak back into storage.
   */
  function numbered(list) {
    list.forEach((t, i) => { t.no = String(i + 1); });
    return list;
  }

  /**
   * The tasks the To Do List shows: the ones still to do.
   *
   * Blocked and Done live on the Daily activity page instead, so a task is on
   * exactly one of the two pages and the sidebar count beside "To Do List"
   * counts the rows you can actually see.
   */
  function active() { return load().filter((t) => !LOGGED(t.status)); }

  function view(q) {
    const all = numbered(active());
    // Only the projects tasks actually carry, so a project with no task is
    // never offered as a filter that would empty the table.
    const projects = [...new Set(all.map((t) => t.project).filter(Boolean))].sort();
    const picked = window.TrackerUI.colFilter("tasks", "project");
    const rows = window.TrackerUI.sortRows("tasks",
      all.filter((t) => !q || JSON.stringify(t).toLowerCase().includes(q))
         .filter((t) => !picked || t.project === picked));
    const late = rows.filter(overdue).length;
    const cur = window.TrackerUI.pageIndex("tasks", rows.length, ROWS_PER_PAGE);
    const slice = rows.slice(cur * ROWS_PER_PAGE, (cur + 1) * ROWS_PER_PAGE);
    // The pane's thumbnails need the DOM this string becomes, so they are
    // filled on the next tick rather than here.
    setTimeout(paintShots, 0);
    return `
      <h2 class="page">To Do List</h2>
      <p class="lede">${rows.length} of ${all.length} tasks in progress${late ? ` · ${late} overdue` : ""}.
        Blocked and completed tasks move to Daily activity.
        Click a task to see everything on it, beside the list.</p>
      <div class="pagetools">
        ${window.TrackerLinks.searchBox("todo", "Search tasks…")}
        <button class="btn primary" data-edit="task:new">New task</button>
      </div>
      ${rows.length
        ? `<div class="tasksplit">
             <div class="tasklist">
               <div class="tablewrap"><table class="tasktable">
                 <thead><tr>
                   ${window.TrackerUI.sortHeader("tasks", "no", COLUMNS[0])}
                   ${window.TrackerUI.sortHeader("tasks", "name", COLUMNS[1])}
                   ${window.TrackerUI.filterHeader("tasks", "project", COLUMNS[2],
                       projects, picked, "Filter by project")}
                 </tr></thead>
                 <tbody>${slice.map(taskRow).join("")}</tbody>
               </table></div>
               ${window.TrackerUI.pager("tasks", rows.length, ROWS_PER_PAGE)}
             </div>
             ${detailPane(load().find((t) => t.id === openRow) || null)}
           </div>`
        : `<div class="empty">No tasks yet.</div>`}`;
  }

  /**
   * Fill in the thumbnails once the pane is on screen.
   *
   * The bytes are in IndexedDB, so a src cannot be written during render. Each
   * blob URL is revoked when the pane is replaced, which is every render - a
   * task list left open would otherwise hold one URL per image per click.
   */
  let shotUrls = [];
  function paintShots() {
    for (const u of shotUrls) URL.revokeObjectURL(u);
    shotUrls = [];
    for (const img of document.querySelectorAll("img[data-shot]")) {
      getBlob(img.dataset.shot).then((blob) => {
        if (!blob || !img.isConnected) return;
        const u = URL.createObjectURL(blob);
        shotUrls.push(u);
        img.src = u;
      }).catch(() => { /* a missing blob simply shows no thumbnail */ });
    }
  }

  /* ---------- wiring ---------- */
  document.addEventListener("click", (e) => {
    const row = e.target.closest("[data-open]");
    if (row && !e.target.closest("a,button")) {
      openRow = openRow === row.dataset.open ? null : row.dataset.open;
      return window.TrackerRender();
    }
    const ed = e.target.closest('[data-edit^="task:"]');
    if (ed) {
      const id = window.TrackerUI.actionId(ed, "edit");
      return editTask(id === "new" ? null : id);
    }
    const rm = e.target.closest('[data-remove^="task:"]');
    if (rm) return removeTask(window.TrackerUI.actionId(rm, "remove"));
    const dl = e.target.closest("[data-attdl]");
    if (dl) return downloadAttachment(dl.dataset.attdl);
    const att = e.target.closest("[data-att]");
    if (att) return openAttachment(att.dataset.att);
  });

  /* ---------- activity log, rendered by the Daily activity page ---------- */
  function logAll() { return logRead(); }
  async function logRemove(id) {
    const cur = logRead().find((e) => e.id === id);
    if (!cur) return;
    const yes = await window.TrackerUI.confirmDialog({
      title: "Remove activity",
      intro: `Remove the entry "${String(cur.task || "").slice(0, 60)}" from the log?`,
      confirmLabel: "Remove entry",
    });
    if (!yes) return;
    logWrite(logRead().filter((e) => e.id !== id));
    window.TrackerRender();
  }
  async function logEdit(id) {
    const log = logRead();
    const cur = id ? log.find((e) => e.id === id) : null;
    const v = await window.TrackerUI.formDialog({
      title: cur ? "Edit activity" : "Log an activity",
      submitLabel: cur ? "Save changes" : "Add entry",
      fields: [
        { name: "date", label: "Date", type: "date", value: cur ? cur.date : today() },
        { name: "task", label: "Activity", type: "textarea", rows: 3, value: cur ? cur.task : "" },
        // Only the two statuses this page is for. A logged activity is
        // something finished or something stuck; a task still in progress
        // belongs on the To Do List, and offering it here would put the same
        // task on both pages. A status already saved outside the two is kept
        // and offered, so an older entry stays readable and editable as it is.
        { name: "status", label: "Status", type: "select",
          options: [...new Set([DONE, BLOCKED, cur && cur.status].filter(Boolean))],
          value: cur ? cur.status : DONE },
        { name: "url", label: "Reference link", value: cur ? cur.url : "", placeholder: "https://…" },
      ],
    });
    if (!v) return;
    if (cur) Object.assign(cur, v);
    else log.push({ id: "m-" + Date.now(), origin: "manual", ...v });
    logWrite(log);
    window.TrackerRender();
  }

  document.addEventListener("change", (e) => {
    const st = e.target.closest("[data-status]");
    if (st) return setStatus(st.dataset.status, st.value);
  });

  document.addEventListener("click", (e) => {
    const ed = e.target.closest('[data-edit^="act:"]');
    if (ed) {
      const id = window.TrackerUI.actionId(ed, "edit");
      return logEdit(id === "new" ? null : id);
    }
    const rm = e.target.closest('[data-remove^="act:"]');
    if (rm) return logRemove(window.TrackerUI.actionId(rm, "remove"));
  });

  migrate();

  window.TrackerTasks = { view, load, active, editTask, setStatus, STATUSES, COLUMNS,
                          logAll, logEdit, logRemove };
})();
