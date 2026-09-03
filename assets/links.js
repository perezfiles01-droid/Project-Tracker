/* The link inventory: workbook rows, your edits, and links you add yourself,
   merged into one list.

   data/tracker.json is a build artefact generated from the workbook and served
   read-only — this is a static site, there is nothing to write back to. So an
   edit cannot change the JSON. It is held as an overlay in this browser,
   keyed by a stable id derived from the row, and applied over the workbook
   data at render time.

   That id is the load-bearing part. Workbook rows carry no identity of their
   own: GLASS links are {group,name,url,verified} and only the 31 EDRMS sites
   have an "sn". Without a derived key an edit has nothing to attach to. */
(() => {
  const EDITS = "tracker.linkEdits";   // { id: {name,description,account,url,removed} }
  const ADDED = "tracker.userLinks";   // [ {id,project,name,description,account,url} ]
  const DRIVE = "tracker.driveLinks";  // owned by drive.js; shared shape

  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return JSON.parse(fallback); }
  };
  const edits = () => read(EDITS, "{}");
  const added = () => read(ADDED, "[]");
  const drive = () => read(DRIVE, "[]");
  const writeEdits = (o) => localStorage.setItem(EDITS, JSON.stringify(o));
  const writeAdded = (a) => localStorage.setItem(ADDED, JSON.stringify(a));
  const writeDrive = (a) => localStorage.setItem(DRIVE, JSON.stringify(a));

  const slug = (s) => String(s ?? "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "x";

  /** The Drive card groups pinned files and anything you add without a project. */
  const DRIVE_GROUP = "Google Drive";

  /**
   * Every link the app knows about, in one shape.
   *
   * origin says where an edit must be written back to, which differs per
   * source: workbook rows get an overlay entry, Drive links are edited in
   * place in their own store, and links you added live in theirs.
   */
  function resolved() {
    const data = window.TrackerState.data;
    const ov = edits();
    const out = [];
    const seen = new Set();

    const push = (row) => {
      // A derived id can collide (two rows with the same name in one section);
      // suffix rather than let one edit silently apply to both.
      let id = row.id;
      let n = 2;
      while (seen.has(id)) id = `${row.id}~${n++}`;
      seen.add(id);
      const patch = ov[id] || {};
      if (patch.removed) return;
      out.push({ ...row, id, ...patch });
    };

    for (const p of data.projects.filter((x) => x.active !== false)) {
      for (const sec of p.sections) {
        const base = `${p.id}:${slug(sec.title)}`;
        if (sec.type === "links") {
          for (const i of sec.items) {
            push({ id: `${base}:${slug(i.name)}`, name: i.name, url: i.url,
                   description: i.note || "", account: "", verified: i.verified,
                   project: p.name, origin: "workbook" });
          }
        } else if (sec.type === "sites") {
          for (const i of sec.items) {
            // label is "link" / "link (demo)" — a link-type marker, not a
            // description. Left empty so the column reads as fillable.
            push({ id: `${base}:${slug(i.name)}`, name: i.name, url: i.url,
                   description: "", account: i.account || "", verified: i.verified,
                   project: p.name, origin: "workbook" });
          }
        } else if (sec.type === "phases") {
          for (const ph of sec.items) {
            for (const st of ph.steps) {
              if (!st.url) continue;
              push({ id: `${base}:${slug(st.name)}`, name: st.name, url: st.url,
                     description: st.description || ph.title, account: "",
                     verified: st.verified, project: p.name, origin: "workbook" });
            }
          }
        }
      }
    }

    for (const d of drive()) {
      push({ id: d.id, name: d.name, url: d.url, description: d.description || "",
             account: d.account || "", verified: true,
             project: d.project || DRIVE_GROUP, origin: "drive" });
    }
    for (const u of added()) {
      push({ id: u.id, name: u.name, url: u.url, description: u.description || "",
             account: u.account || "", verified: true,
             project: u.project || DRIVE_GROUP, origin: "user" });
    }
    return out;
  }

  /** One card per project, plus the Drive group, in workbook order. */
  function groups() {
    const rows = resolved();
    const order = window.TrackerState.data.projects
      .filter((p) => p.active !== false).map((p) => p.name);
    if (!order.includes(DRIVE_GROUP)) order.push(DRIVE_GROUP);
    for (const r of rows) if (!order.includes(r.project)) order.push(r.project);
    return order.map((name) => {
      const items = rows.filter((r) => r.project === name);
      return { key: slug(name), name, count: items.length,
               undescribed: items.filter((r) => !r.description).length };
    }).filter((g) => g.count || g.name === DRIVE_GROUP);
  }

  const groupByKey = (key) => groups().find((g) => g.key === key);
  const rowsFor = (key) => {
    const g = groupByKey(key);
    return g ? resolved().filter((r) => r.project === g.name) : [];
  };

  /* ---------- writes ---------- */
  function saveRow(row, values) {
    if (row.origin === "workbook") {
      const ov = edits();
      ov[row.id] = { ...(ov[row.id] || {}), name: values.name, url: values.url,
                     description: values.description, account: values.account };
      writeEdits(ov);
    } else if (row.origin === "drive") {
      const list = drive();
      const t = list.find((l) => l.id === row.id);
      if (t) { Object.assign(t, values); writeDrive(list); }
    } else {
      const list = added();
      const t = list.find((l) => l.id === row.id);
      if (t) { Object.assign(t, values); writeAdded(list); }
    }
  }

  function addRow(groupName, values) {
    const list = added();
    list.push({ id: "u-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
                project: groupName, ...values });
    writeAdded(list);
  }

  function removeRow(row) {
    if (row.origin === "workbook") {
      const ov = edits();
      // Kept as a tombstone rather than dropped: the workbook row still
      // exists and would come straight back on the next render.
      ov[row.id] = { ...(ov[row.id] || {}), removed: true };
      writeEdits(ov);
    } else if (row.origin === "drive") {
      writeDrive(drive().filter((l) => l.id !== row.id));
    } else {
      writeAdded(added().filter((l) => l.id !== row.id));
    }
  }

  /* ---------- views ---------- */
  const esc = (s2) => String(s2 ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ROWS_PER_PAGE = 10;
  const match = (r, q) => !q || JSON.stringify(r).toLowerCase().includes(q);

  /** Overview: one card per project, plus the Drive group. */
  function overview(q) {
    const gs = groups().filter((g) => !q || g.name.toLowerCase().includes(q) ||
      rowsFor(g.key).some((r) => match(r, q)));
    return `
      <h2 class="page">Overview</h2>
      <p class="lede">Open a project to see its links, add your own, and write
        the description for each one.</p>
      <div class="grid cards">${gs.map((g) => `
        <button class="card groupcard" data-route="g:${esc(g.key)}">
          <div class="t">${esc(g.name)}</div>
          <div class="m">${g.count} link${g.count === 1 ? "" : "s"}${
            g.undescribed ? ` · ${g.undescribed} without a description` : ""}</div>
          <div class="row"><span class="tag accent">Open</span></div>
        </button>`).join("") || `<div class="empty">Nothing matches your search.</div>`}
      </div>`;
  }

  /** One group's links: Site, Description, Email Access, Link — paginated. */
  function tableView(key, q) {
    const g = groupByKey(key);
    if (!g) return `<div class="empty">Unknown project.</div>`;
    const all = rowsFor(key);
    const rows = all.filter((r) => match(r, q));
    const pkey = "links:" + key;
    const cur = window.TrackerUI.pageIndex(pkey, rows.length, ROWS_PER_PAGE);
    const slice = rows.slice(cur * ROWS_PER_PAGE, (cur + 1) * ROWS_PER_PAGE);
    const dash = `<span class="tag dead">—</span>`;

    const body = slice.map((r) => `<tr>
        <td class="wrap"><span class="sitename">${esc(r.name)}</span></td>
        <td class="wrap">${r.description ? esc(r.description) : dash}</td>
        <td>${r.account ? esc(r.account) : dash}</td>
        <td>${r.url
          ? `<a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">Open ↗</a>`
          : dash}</td>
        <td class="actions">
          <button class="btn sm" data-edit="link:${esc(r.id)}">Edit</button>
          <button class="btn sm" data-remove="link:${esc(r.id)}">Remove</button>
        </td>
      </tr>`).join("");

    return `
      <h2 class="page">${esc(g.name)}</h2>
      <p class="lede">${rows.length} of ${all.length} links.</p>
      <div class="chips">
        <button class="btn" data-route="overview">‹ All projects</button>
        <button class="btn primary" data-addlink="${esc(key)}">Add link</button>
      </div>
      ${rows.length
        ? `<div class="tablewrap"><table class="linktable">
             <thead><tr>
               <th>Site</th><th>Description</th><th>Email Access</th><th>Link</th><th></th>
             </tr></thead>
             <tbody>${body}</tbody>
           </table></div>${window.TrackerUI.pager(pkey, rows.length, ROWS_PER_PAGE)}`
        : `<div class="empty">Nothing matches your search.</div>`}`;
  }

  /* ---------- wiring ---------- */
  const fields = (r) => [
    { name: "name", label: "Site", value: r ? r.name : "", placeholder: "What this link is" },
    { name: "description", label: "Description", type: "textarea", rows: 3,
      value: r ? r.description : "", placeholder: "What it is for, in your own words" },
    { name: "account", label: "Email Access", value: r ? r.account : "",
      placeholder: "Which account opens it" },
    { name: "url", label: "Link", value: r ? r.url : "", placeholder: "https://…" },
  ];

  async function edit(id) {
    const row = resolved().find((r) => r.id === id);
    if (!row) return;
    const v = await window.TrackerUI.formDialog({
      title: "Edit link", submitLabel: "Save changes", fields: fields(row),
    });
    if (!v) return;
    saveRow(row, v);
    window.TrackerRender();
  }

  async function add(key) {
    const g = groupByKey(key);
    if (!g) return;
    const v = await window.TrackerUI.formDialog({
      title: "Add link to " + g.name, submitLabel: "Add link", fields: fields(null),
    });
    if (!v || (!v.name && !v.url)) return;
    addRow(g.name, { ...v, name: v.name || v.url });
    window.TrackerRender();
  }

  document.addEventListener("click", (e) => {
    const ed = e.target.closest('[data-edit^="link:"]');
    if (ed) return edit(ed.dataset.edit.slice(5));
    const rm = e.target.closest('[data-remove^="link:"]');
    if (rm) {
      const row = resolved().find((r) => r.id === rm.dataset.remove.slice(5));
      if (row) { removeRow(row); window.TrackerRender(); }
      return;
    }
    const ad = e.target.closest("[data-addlink]");
    if (ad) return add(ad.dataset.addlink);
  });

  window.TrackerLinks = {
    resolved, groups, groupByKey, rowsFor, saveRow, addRow, removeRow, slug, DRIVE_GROUP,
    overview, tableView, ROWS_PER_PAGE,
  };
})();
