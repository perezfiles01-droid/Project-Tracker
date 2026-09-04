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
  const STATUSES = ["To do", "In progress", "Blocked", "Done"];
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
        { name: "given", label: "Task Given Date", type: "date", value: cur ? cur.given : "" },
        { name: "due", label: "Due Date", type: "date", value: cur ? cur.due : "" },
        { name: "ref", label: "Reference link", value: cur ? cur.ref : "", placeholder: "https://…" },
        { name: "status", label: "Status", type: "select", options: STATUSES,
          value: cur ? cur.status : STATUSES[0] },
        { name: "assignee", label: "Assignee", value: cur ? cur.assignee : "" },
        { name: "linkUrl", label: "Attach a link", value: "", placeholder: "https://…" },
        { name: "files", label: "Attachments", type: "attachments",
          value: cur ? cur.attachments || [] : [],
          help: "Files are stored in this browser only." },
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
    if (values.linkUrl) {
      kept.push({ id: "l-" + Date.now(), name: values.linkUrl, url: values.linkUrl, kind: "link" });
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
      status: "Completed", url: t.ref || "", origin: "task",
    });
    logWrite(log);
  }

  function markDone(id) {
    const list = load();
    const t = list.find((x) => x.id === id);
    if (!t || t.status === "Done") return;
    t.status = "Done";
    save(list);
    logDone(t);
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

  /* ---------- render ---------- */
  const ROWS_PER_PAGE = 10;
  const COLUMNS = ["Task No.", "Name of task", "Project", "Task Given Date", "Due Date", "Reference link"];
  let openRow = null;   // the task expanded in place

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

  function attachmentChip(a) {
    return a.kind === "link"
      ? `<a class="tag" href="${esc(a.url)}" target="_blank" rel="noopener">link</a>`
      : `<button class="tag attchip" data-att="${esc(a.id)}" title="${esc(a.name)}">${esc(a.name)}</button>`;
  }

  /** The expanded detail shown when a row is clicked. */
  /**
   * The clicked task opens its OWN table of that task's details, one labelled
   * row per field, rather than a loose block. Every field is listed even when
   * empty, so what is missing is as visible as what is filled in.
   */
  function detailRow(t) {
    const atts = (t.attachments || []).map(attachmentChip).join("");
    const dash = `<span class="tag dead">—</span>`;
    const val = (v) => (v ? esc(v) : dash);
    const rows = [
      ["Task No.", val(t.no)],
      ["Name of task", val(t.name)],
      ["Project", t.project ? `<span class="tag accent">${esc(t.project)}</span>` : dash],
      ["Description", t.description
        ? `<span class="detaildesc">${esc(t.description)}</span>` : dash],
      ["Task Given Date", val(t.given)],
      ["Due Date", t.due
        ? `${esc(t.due)}${overdue(t) ? ` <span class="tag warn">overdue</span>` : ""}` : dash],
      ["Reference link", t.ref
        ? `<a class="btn sm" href="${esc(t.ref)}" target="_blank" rel="noopener">Open ↗</a>` : dash],
      ["Status", `<span class="tag${t.status === "Done" ? " ok" : ""}">${esc(t.status || STATUSES[0])}</span>`],
      ["Assignee", val(t.assignee)],
      ["Attachments", atts || dash],
    ];
    return `<tr class="detail"><td colspan="${COLUMNS.length}">
        <div class="taskdetail">
          <div class="tablewrap"><table class="detailtable">
            <tbody>${rows.map(([k, v]) =>
              `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`).join("")}</tbody>
          </table></div>
          <div class="row">
            ${window.TrackerUI.iconButton("edit", "Edit", `data-edit="task:${esc(t.id)}"`)}
            ${window.TrackerUI.iconButton("remove", "Remove", `data-remove="task:${esc(t.id)}"`)}
            ${t.status === "Done" ? "" :
              `${window.TrackerUI.iconButton("done", "Mark done", `data-done="${esc(t.id)}"`)}`}
          </div>
        </div>
      </td></tr>`;
  }

  function taskRow(t) {
    const dash = `<span class="tag dead">—</span>`;
    const short = (t.description || "").split("\n")[0].slice(0, 90);
    // Tasks created before "Name of task" existed fall back to their description.
    return `<tr class="taskrow${t.status === "Done" ? " done" : ""}${openRow === t.id ? " open" : ""}"
                data-open="${esc(t.id)}">
        <td>${t.no ? esc(t.no) : dash}</td>
        <td class="wrap"><span class="taskname">${t.name ? esc(t.name) : (short ? esc(short) : dash)}</span></td>
        <td>${t.project ? `<span class="tag accent">${esc(t.project)}</span>` : dash}</td>
        <td>${t.given ? esc(t.given) : dash}</td>
        <td>${t.due ? esc(t.due) : dash}${overdue(t) ? ` <span class="tag warn">overdue</span>` : ""}</td>
        <td>${refCell(t)}</td>
      </tr>${openRow === t.id ? detailRow(t) : ""}`;
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
    const rows = window.TrackerUI.sortRows("tasks",
      all.filter((t) => !q || JSON.stringify(t).toLowerCase().includes(q)));
    const late = rows.filter(overdue).length;
    const cur = window.TrackerUI.pageIndex("tasks", rows.length, ROWS_PER_PAGE);
    const slice = rows.slice(cur * ROWS_PER_PAGE, (cur + 1) * ROWS_PER_PAGE);
    return `
      <h2 class="page">To Do List</h2>
      <p class="lede">${rows.length} of ${all.length} tasks${late ? ` · ${late} overdue` : ""}.
        Click a row to see its description. Tasks are stored in this browser only.</p>
      <div class="pagetools">
        ${window.TrackerLinks.searchBox("todo", "Search tasks…")}
        <button class="btn primary" data-edit="task:new">New task</button>
      </div>
      ${rows.length
        ? `<div class="tablewrap"><table class="tasktable">
             <thead><tr>
               ${window.TrackerUI.sortHeader("tasks", "no", COLUMNS[0])}
               ${window.TrackerUI.sortHeader("tasks", "name", COLUMNS[1])}
               ${window.TrackerUI.sortHeader("tasks", "project", COLUMNS[2])}
               ${window.TrackerUI.sortHeader("tasks", "given", COLUMNS[3])}
               ${window.TrackerUI.sortHeader("tasks", "due", COLUMNS[4])}
               <th>${COLUMNS[5]}</th>
             </tr></thead>
             <tbody>${slice.map(taskRow).join("")}</tbody>
           </table></div>${window.TrackerUI.pager("tasks", rows.length, ROWS_PER_PAGE)}`
        : `<div class="empty">No tasks yet.</div>`}`;
  }

  /* ---------- wiring ---------- */
  document.addEventListener("click", (e) => {
    const dn = e.target.closest("[data-done]");
    if (dn) return markDone(dn.dataset.done);
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
        { name: "status", label: "Status", type: "select",
          options: ["Completed", "In Progress", "Pending"], value: cur ? cur.status : "Completed" },
        { name: "url", label: "Reference link", value: cur ? cur.url : "", placeholder: "https://…" },
      ],
    });
    if (!v) return;
    if (cur) Object.assign(cur, v);
    else log.push({ id: "m-" + Date.now(), origin: "manual", ...v });
    logWrite(log);
    window.TrackerRender();
  }

  document.addEventListener("click", (e) => {
    const ed = e.target.closest('[data-edit^="act:"]');
    if (ed) {
      const id = window.TrackerUI.actionId(ed, "edit");
      return logEdit(id === "new" ? null : id);
    }
    const rm = e.target.closest('[data-remove^="act:"]');
    if (rm) return logRemove(window.TrackerUI.actionId(rm, "remove"));
  });

  window.TrackerTasks = { view, load, editTask, markDone, STATUSES, COLUMNS,
                          logAll, logEdit, logRemove };
})();
