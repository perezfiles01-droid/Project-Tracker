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
     "Completed" for a status the task list called "Done". */
  const STATUSES = ["To do", "In progress", "Blocked", "Done"];
  const DONE = "Done";
  const DEFAULT_ASSIGNEE = "Jim";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const LOG = "tracker.activity";
  const load = () => window.TrackerStore.get(KEY, []);
  const logRead = () => window.TrackerStore.get(LOG, []);
  const logWrite = (a) => window.TrackerStore.set(LOG, a);
  const save = (list) => window.TrackerStore.set(KEY, list);
  window.TrackerTasks = { load };

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
        { name: "status", label: "Status", type: "select", options: STATUSES,
          value: cur ? cur.status : STATUSES[0] },
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

    const wasDone = cur ? cur.status === "Done" : false;
    const target = cur || { id: "t-" + Date.now(), created: today(), attachments: [] };
    Object.assign(target, {
      // No "no" here: the number is the task's position, worked out at render.
      name: values.name, description: values.description, given: values.given,
      due: values.due, ref: values.ref, status: values.status || STATUSES[0],
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
    if (!wasDone && target.status === "Done") logDone(target);
    window.TrackerRender();
  }

  /**
   * A finished task becomes an activity entry. Guarded on the task id so
   * editing a task that is already Done cannot log it twice.
   */
  function logDone(t) {
    const log = logRead();
    if (log.some((e) => e.taskId === t.id)) return;
    log.push({
      id: "a-" + Date.now(), taskId: t.id, date: today(),
      task: t.description || t.name || "Task",
      status: DONE, url: t.ref || "", origin: "task",
    });
    logWrite(log);
  }

  /**
   * Set a task's status from the pane, and log it the first time it is Done.
   *
   * markDone was one direction only. This is every direction, and it keeps the
   * same promise: the activity log gets one entry per task, guarded on the
   * task id inside logDone, so moving a task out of Done and back does not
   * write a second one.
   */
  function setStatus(id, status) {
    const list = load();
    const t = list.find((x) => x.id === id);
    if (!t || t.status === status) return;
    t.status = status;
    save(list);
    if (status === DONE) logDone(t);
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

  function view(q) {
    const all = numbered(load());
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
      <p class="lede">${rows.length} of ${all.length} tasks${late ? ` · ${late} overdue` : ""}.
        Click a task to see everything on it, beside the list.
        Tasks are stored in this browser only.</p>
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
             ${detailPane(all.find((t) => t.id === openRow) || null)}
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
        // The same list the tasks use, not a second one that means the same
        // things in different words. A status already saved outside it is kept
        // and offered, so old entries are readable and editable as they are.
        { name: "status", label: "Status", type: "select",
          options: [...new Set([...STATUSES, cur && cur.status].filter(Boolean))],
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

  window.TrackerTasks = { view, load, editTask, setStatus, STATUSES, COLUMNS,
                          logAll, logEdit, logRemove };
})();
