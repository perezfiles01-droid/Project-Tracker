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

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
  const save = (list) => localStorage.setItem(KEY, JSON.stringify(list));
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
  const overdue = (t) => t.deadline && t.status !== "Done" && t.deadline < today();
  const dueSoon = (t) => {
    if (!t.deadline || t.status === "Done" || overdue(t)) return false;
    const d = new Date(t.deadline + "T00:00:00"), n = new Date(today() + "T00:00:00");
    return (d - n) / 86400000 <= 2;
  };

  /* ---------- create / edit ---------- */
  async function editTask(id) {
    const list = load();
    const cur = id ? list.find((t) => t.id === id) : null;
    if (id && !cur) return;
    const projects = (window.TrackerProjectNames ? window.TrackerProjectNames() : []);
    const values = await window.TrackerUI.formDialog({
      title: cur ? "Edit task" : "New task",
      submitLabel: cur ? "Save changes" : "Add task",
      fields: [
        { name: "title", label: "Task", value: cur ? cur.title : "", placeholder: "What needs doing" },
        { name: "description", label: "Description", type: "textarea",
          value: cur ? cur.description : "", placeholder: "Detail, context, links…" },
        { name: "status", label: "Status", type: "select", options: STATUSES, value: cur ? cur.status : STATUSES[0] },
        { name: "deadline", label: "Deadline", type: "date", value: cur ? cur.deadline : "" },
        { name: "assignee", label: "Assignee", value: cur ? cur.assignee : "", placeholder: "Who owns it" },
        { name: "project", label: "Project", type: "select",
          options: ["", ...projects, "Other"], value: cur ? cur.project : "" },
        { name: "linkUrl", label: "Attach a link", value: "",
          placeholder: "https://… (Drive, SharePoint, anything)",
          help: "Optional. Added alongside any files you upload." },
        { name: "files", label: "Attachments", type: "attachments", value: cur ? cur.attachments || [] : [],
          help: "Files are stored in this browser only." },
      ],
    });
    if (!values) return;
    if (!values.title) return;

    const target = cur || {
      id: "t-" + Date.now(),
      created: today(),
      attachments: [],
    };
    Object.assign(target, {
      title: values.title,
      description: values.description,
      status: values.status || STATUSES[0],
      deadline: values.deadline,
      assignee: values.assignee,
      project: values.project,
    });

    // Attachments: drop what was unticked, keep the rest, add the new.
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
    window.TrackerRender();
  }

  async function removeTask(id) {
    const list = load();
    const t = list.find((x) => x.id === id);
    if (!t) return;
    for (const a of t.attachments || []) if (a.kind !== "link") await dropBlob(a.id);
    save(list.filter((x) => x.id !== id));
    window.TrackerRender();
  }

  /** Open an attachment held in IndexedDB in a new tab. */
  async function openAttachment(id) {
    const blob = await getBlob(id);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ---------- render ---------- */
  function attachmentChip(a) {
    return a.kind === "link"
      ? `<a class="tag" href="${esc(a.url)}" target="_blank" rel="noopener">link</a>`
      : `<button class="tag attchip" data-att="${esc(a.id)}" title="${esc(a.name)}">${esc(a.name)}</button>`;
  }

  function taskCard(t) {
    const flag = overdue(t) ? `<span class="tag warn">overdue</span>`
      : dueSoon(t) ? `<span class="tag info">due soon</span>` : "";
    const atts = (t.attachments || []).map(attachmentChip).join("");
    return `<div class="card task${overdue(t) ? " late" : ""}">
        <div class="t">${esc(t.title)}</div>
        ${t.description ? `<div class="m desc">${esc(t.description)}</div>` : ""}
        <div class="row">
          ${t.deadline ? `<span class="tag">due ${esc(t.deadline)}</span>` : ""}
          ${flag}
          ${t.assignee ? `<span class="tag">${esc(t.assignee)}</span>` : ""}
          ${t.project ? `<span class="tag accent">${esc(t.project)}</span>` : ""}
        </div>
        ${atts ? `<div class="row atts">${atts}</div>` : ""}
        <div class="row">
          <button class="btn sm" data-edit="task:${esc(t.id)}">Edit</button>
          <button class="btn sm" data-remove="task:${esc(t.id)}">Remove</button>
        </div>
      </div>`;
  }

  function column(status, tasks) {
    return `<section class="taskcol">
        <h3 class="sec">${esc(status)} (${tasks.length})</h3>
        <div class="taskstack">${tasks.map(taskCard).join("") ||
          `<div class="empty">Nothing here.</div>`}</div>
      </section>`;
  }

  function view(q) {
    const all = load();
    const list = all.filter((t) => !q || JSON.stringify(t).toLowerCase().includes(q));
    const late = list.filter(overdue).length;
    return `
      <h2 class="page">To Do List</h2>
      <p class="lede">${list.length} of ${all.length} tasks${late ? ` · ${late} overdue` : ""}.
        Tasks are stored in this browser only.</p>
      <div class="chips">
        <button class="btn primary" data-edit="task:new">New task</button>
      </div>
      <div class="taskboard">${STATUSES.map((s) =>
        column(s, list.filter((t) => (t.status || STATUSES[0]) === s))).join("")}</div>`;
  }

  /* ---------- wiring ---------- */
  document.addEventListener("click", (e) => {
    const ed = e.target.closest('[data-edit^="task:"]');
    if (ed) {
      const id = ed.dataset.edit.slice(5);
      return editTask(id === "new" ? null : id);
    }
    const rm = e.target.closest('[data-remove^="task:"]');
    if (rm) return removeTask(rm.dataset.remove.slice(5));
    const att = e.target.closest("[data-att]");
    if (att) return openAttachment(att.dataset.att);
  });

  window.TrackerTasks = { view, load, editTask, STATUSES };
})();
