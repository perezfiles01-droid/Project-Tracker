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
  const TABLES = "tracker.linkTables"; // [ {id,project,name} ] tables you name yourself
  const PROJECTS = "tracker.projects"; // { added:[{key,name}], renamed:{key:name}, hidden:[key] }

  const read = (key, fallback) => {
    return window.TrackerStore.get(key, JSON.parse(fallback));
  };
  const edits = () => read(EDITS, "{}");
  const added = () => read(ADDED, "[]");
  const drive = () => read(DRIVE, "[]");
  const writeEdits = (o) => window.TrackerStore.set(EDITS, o);
  const writeAdded = (a) => window.TrackerStore.set(ADDED, a);
  const writeDrive = (a) => window.TrackerStore.set(DRIVE, a);
  const customTables = () => read(TABLES, "[]");
  const projectStore = () => {
    const v = read(PROJECTS, "{}");
    return { added: v.added || [], renamed: v.renamed || {}, hidden: v.hidden || [] };
  };
  const writeProjects = (v) => window.TrackerStore.set(PROJECTS, v);
  const writeTables = (a) => window.TrackerStore.set(TABLES, a);

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
                   project: p.name, table: sec.title, origin: "workbook" });
          }
        } else if (sec.type === "sites") {
          for (const i of sec.items) {
            // label is "link" / "link (demo)" — a link-type marker, not a
            // description. Left empty so the column reads as fillable.
            push({ id: `${base}:${slug(i.name)}`, name: i.name, url: i.url,
                   description: "", account: i.account || "", verified: i.verified,
                   project: p.name, table: sec.title, origin: "workbook" });
          }
        } else if (sec.type === "phases") {
          for (const ph of sec.items) {
            for (const st of ph.steps) {
              if (!st.url) continue;
              push({ id: `${base}:${slug(st.name)}`, name: st.name, url: st.url,
                     description: st.description || ph.title, account: "",
                     verified: st.verified, project: p.name, table: sec.title,
                     origin: "workbook" });
            }
          }
        }
      }
    }

    // Pinned Drive files are not a project, so they no longer appear in the
    // Projects section. They keep their own page, which is where they belong.
    for (const u of added()) {
      push({ id: u.id, name: u.name, url: u.url, description: u.description || "",
             account: u.account || "", verified: true,
             project: u.project || DRIVE_GROUP, table: u.table || "",
             origin: "user" });
    }
    return out;
  }

  /** One tile per project. Google Drive is not a project and is not here. */
  function groups() {
    const rows = resolved();
    const ps = projectStore();
    const order = window.TrackerState.data.projects
      .filter((p) => p.active !== false).map((p) => p.name);
    for (const r of rows) if (r.project && !order.includes(r.project)) order.push(r.project);
    for (const a of ps.added) if (!order.includes(a.name)) order.push(a.name);
    return order
      // A workbook project cannot be deleted from data/tracker.json, which is
      // served read-only, so "delete" is a tombstone keyed on the slug.
      .filter((name) => !ps.hidden.includes(slug(name)))
      .map((name) => ps.renamed[slug(name)] || name)
      .map((name) => {
      const items = rows.filter((r) => r.project === name);
      return { key: slug(name), name, count: items.length,
               tables: tablesFor(name).length,
               undescribed: items.filter((r) => !r.description).length };
    });
  }

  /**
   * The tables inside a project: the workbook's own sections, which are a
   * real categorisation already (EDRMS ADB arrives as "Sites & source links"
   * and "EDRMS release phases"), plus any you have named yourself.
   */
  function tablesFor(projectName) {
    const names = [];
    const owned = originalNames(projectName);
    for (const r of resolved()) {
      if (owned.includes(r.project) && r.table && !names.includes(r.table)) names.push(r.table);
    }
    for (const t of customTables()) {
      if (t.project === projectName && !names.includes(t.name)) names.push(t.name);
    }
    if (!names.length) names.push("Links");
    return names;
  }

  const groupByKey = (key) => groups().find((g) => g.key === key);
  /**
   * A rename changes the display name only; rows still carry the name they
   * were filed under, so both are accepted when collecting a project's rows.
   */
  const originalNames = (displayName) => {
    const ps = projectStore();
    const names = [displayName];
    for (const [k, v] of Object.entries(ps.renamed)) {
      if (v !== displayName) continue;
      for (const p of window.TrackerState.data.projects) if (slug(p.name) === k) names.push(p.name);
      for (const r of resolved()) if (slug(r.project) === k) names.push(r.project);
    }
    return [...new Set(names)];
  };
  const rowsFor = (key) => {
    const g = groupByKey(key);
    if (!g) return [];
    const names = originalNames(g.name);
    return resolved().filter((r) => names.includes(r.project));
  };
  const rowsIn = (projectName, tableName) => {
    const names = originalNames(projectName);
    return resolved().filter((r) =>
      names.includes(r.project) && (r.table || tablesFor(projectName)[0]) === tableName);
  };

  /* ---------- writes ---------- */
  function saveRow(row, values) {
    if (row.origin === "workbook") {
      const ov = edits();
      ov[row.id] = { ...(ov[row.id] || {}), name: values.name, url: values.url,
                     description: values.description, account: values.account,
                     table: values.table || row.table };
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

  function addTable(projectName, name) {
    const list = customTables();
    if (list.some((t) => t.project === projectName && t.name === name)) return;
    list.push({ id: "tb-" + Date.now(), project: projectName, name });
    writeTables(list);
  }

  /**
   * Rename a table. Tables come from two places - the workbook's own section
   * titles and ones you named yourself - so the rename is recorded once, at
   * the name level, and every row that quoted the old name is re-pointed.
   * A workbook row keeps its tombstone/override record; nothing is rewritten
   * in the data file.
   */
  function renameTable(projectName, oldName, newName) {
    newName = String(newName || "").trim();
    if (!newName || newName === oldName) return;

    const custom = customTables();
    const mine = custom.find((c) => c.project === projectName && c.name === oldName);
    if (mine) mine.name = newName;
    else custom.push({ id: "tb-" + Date.now(), project: projectName, name: newName });
    writeTables(custom);

    // Re-point rows you added or pinned.
    const own = added();
    for (const r of own) if (r.project === projectName && (r.table || "") === oldName) r.table = newName;
    writeAdded(own);
    const pinned = drive();
    for (const r of pinned) if (r.project === projectName && (r.table || "") === oldName) r.table = newName;
    writeDrive(pinned);

    // Workbook rows move by override, the same mechanism an edit already uses.
    const ov = edits();
    for (const r of resolved()) {
      if (r.origin === "workbook" && r.project === projectName && r.table === oldName) {
        ov[r.id] = { ...(ov[r.id] || {}), table: newName };
      }
    }
    writeEdits(ov);

    // The old custom entry, if the rename left one behind, is now empty.
    writeTables(customTables().filter((c) =>
      !(c.project === projectName && c.name === oldName)));
  }

  /**
   * Delete a table and every link in it. Workbook rows are tombstoned rather
   * than dropped, because the workbook still holds them and they would come
   * straight back on the next render.
   */
  function deleteTable(projectName, tableName) {
    for (const r of rowsIn(projectName, tableName)) removeRow(r);
    writeTables(customTables().filter((c) =>
      !(c.project === projectName && c.name === tableName)));
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

  const PROJ_COLS = 3, PROJ_ROWS = 2;               // 3 projects a row
  const PROJ_PER_PAGE = PROJ_COLS * PROJ_ROWS;
  const ROWS_PER_PAGE = 10;

  // Per-section state. Each search box and each account filter is its own,
  // so filtering one table never disturbs another.
  const find = {};        // { "projects": q, "links:<proj>:<table>": q }
  let selected = null;    // the project whose tables are open underneath
  const account = {};     // { "<proj>:<table>": chosen email }

  const has = (r, q) => !q ||
    (String(r.name || "") + " " + String(r.description || "")).toLowerCase().includes(q);

  const searchBox = (key, placeholder) => `<div class="search sectionsearch">
      <input type="search" data-search="${esc(key)}" value="${esc(find[key] || "")}"
             placeholder="${esc(placeholder)}" autocomplete="off">
    </div>`;

  /** Projects: three a row, paginated, exactly like the Drive page's grid. */
  function projectsTable() {
    const q = (find.projects || "").toLowerCase();
    const list = groups().filter((g) => !q || g.name.toLowerCase().includes(q));
    const cur = window.TrackerUI.pageIndex("projects", list.length, PROJ_PER_PAGE);
    const slice = list.slice(cur * PROJ_PER_PAGE, (cur + 1) * PROJ_PER_PAGE);
    const ib = window.TrackerUI.iconButton;

    // Independent tiles rather than cells of one table: each project is its
    // own thing, so it gets its own card and its own controls. Three across
    // and six to a page, with the seventh paging - unchanged.
    const tiles = slice.map((g) => `
      <div class="ptile${selected === g.key ? " picked" : ""}">
        <button class="ptileopen" data-pick="${esc(g.key)}">
          <span class="t">${esc(g.name)}</span>
        </button>
        <div class="ptileacts">
          ${ib("rename", "Rename project", `data-edit="project:${esc(g.key)}"`)}
          ${ib("remove", "Delete project", `data-remove="project:${esc(g.key)}"`)}
        </div>
      </div>`).join("");

    return `<div class="ptiles">${tiles ||
        `<div class="empty">No project matches that search.</div>`}</div>
      ${window.TrackerUI.pager("projects", list.length, PROJ_PER_PAGE)}`;
  }

  /** One named table inside a project. */
  function linkTable(projectName, tableName) {
    const key = `links:${slug(projectName)}:${slug(tableName)}`;
    const all = rowsIn(projectName, tableName);
    const emails = [...new Set(all.map((r) => r.account).filter(Boolean))].sort();
    const chosen = account[key] || "";
    let rows = all.filter((r) => has(r, (find[key] || "").toLowerCase()));
    if (chosen) rows = rows.filter((r) => r.account === chosen);
    rows = window.TrackerUI.sortRows(key, rows);

    const cur = window.TrackerUI.pageIndex(key, rows.length, ROWS_PER_PAGE);
    const slice = rows.slice(cur * ROWS_PER_PAGE, (cur + 1) * ROWS_PER_PAGE);
    const dash = `<span class="tag dead">—</span>`;

    const body = slice.map((r) => `<tr>
        <td class="wrap"><span class="sitename">${esc(r.name)}</span></td>
        <td class="wrap">${r.description ? esc(r.description) : dash}</td>
        <td class="acct">${r.account
          ? `<button class="acctcell" data-copy="${esc(r.account)}"
                     title="Click to copy ${esc(r.account)}">${esc(r.account)}</button>`
          : dash}</td>
        <td>${r.url
          ? `<a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">Open ↗</a>`
          : dash}</td>
        <td class="actions">
          ${window.TrackerUI.iconButton("edit", "Edit", `data-edit="link:${esc(r.id)}"`)}
          ${window.TrackerUI.iconButton("remove", "Remove", `data-remove="link:${esc(r.id)}"`)}
        </td>
      </tr>`).join("");

    // The filter belongs to its column, not to a separate control above the
    // table: a lone "All email access" select gave no clue which column it
    // acted on.
    const emailHeader = `<th class="emailhead">
        <span class="emaillabel">Email Access</span>
        ${emails.length ? `<select class="accountpick" data-account="${esc(key)}"
          title="Filter by account" aria-label="Filter by email access">
          <option value="">All</option>
          ${emails.map((a) => `<option value="${esc(a)}"${a === chosen ? " selected" : ""}>${esc(a)}</option>`).join("")}
        </select>` : ""}
      </th>`;

    return `<section class="linksection">
        <div class="sectionhead">
          <div class="sectionleft">
            <h3 class="sec">${esc(tableName)} (${rows.length})</h3>
            ${searchBox(key, "Search site or description…")}
          </div>
          <div class="sectiontools">
            ${window.TrackerUI.iconButton("add", "Add link", `data-addto="${esc(projectName)}|${esc(tableName)}"`)}
            ${window.TrackerUI.iconButton("rename", "Rename", `data-edit="table:${esc(projectName)}|${esc(tableName)}"`)}
            ${window.TrackerUI.iconButton("remove", "Delete", `data-remove="table:${esc(projectName)}|${esc(tableName)}"`)}
          </div>
        </div>
        ${rows.length
          ? `<div class="tablewrap"><table class="linktable">
               <thead><tr>
                 ${window.TrackerUI.sortHeader(key, "name", "Site")}
                 ${window.TrackerUI.sortHeader(key, "description", "Description")}
                 ${emailHeader}<th>Link</th><th></th>
               </tr></thead>
               <tbody>${body}</tbody>
             </table></div>${window.TrackerUI.pager(key, rows.length, ROWS_PER_PAGE)}`
          : `<div class="empty">Nothing in this table yet.</div>`}
      </section>`;
  }

  /** Overview: the Projects table, and the picked project's tables beneath it. */
  function overview() {
    const g = selected ? groupByKey(selected) : null;
    return `
      <h2 class="page">Projects</h2>
      <p class="lede">Open a project to see its tables. Add your own tables to
        group links however you need.</p>
      <div class="sectionhead">
        <div class="sectionleft">${searchBox("projects", "Search projects…")}</div>
        <div class="sectiontools">
          ${window.TrackerUI.iconButton("add", "Add project", `data-newproject="1"`)}
        </div>
      </div>
      ${projectsTable()}
      ${g ? `
        <div class="opened">
          <div class="sectionhead">
            <h2 class="page sub">Table of Artifacts</h2>
            ${window.TrackerUI.iconButton("add", "New table", `data-newtable="${esc(g.name)}"`)}
          </div>
          ${tablesFor(g.name).map((t) => linkTable(g.name, t)).join("")}
        </div>` : ""}`;
  }

  /** Kept so an existing #g:<project> bookmark still opens that project. */
  function tableView(key) {
    if (groupByKey(key)) selected = key;
    return overview();
  }

  /* ---------- wiring ---------- */
  const fields = (r, projectName, tableName) => [
    { name: "name", label: "Site", value: r ? r.name : "", placeholder: "What this link is" },
    { name: "description", label: "Description", type: "textarea", rows: 3,
      value: r ? r.description : "", placeholder: "What it is for, in your own words" },
    { name: "account", label: "Email Access", value: r ? r.account : "",
      placeholder: "Which account opens it" },
    { name: "url", label: "Link", value: r ? r.url : "", placeholder: "https://…" },
    { name: "table", label: "Table", type: "select",
      options: tablesFor(projectName), value: r ? (r.table || tableName) : tableName,
      help: "Move this link into another table in the same project." },
  ];

  async function edit(id) {
    const row = resolved().find((r) => r.id === id);
    if (!row) return;
    const v = await window.TrackerUI.formDialog({
      title: "Edit link", submitLabel: "Save changes",
      fields: fields(row, row.project, row.table),
    });
    if (!v) return;
    saveRow(row, v);
    window.TrackerRender();
  }

  async function add(projectName, tableName) {
    const v = await window.TrackerUI.formDialog({
      title: `Add link to ${tableName}`, submitLabel: "Add link",
      fields: fields(null, projectName, tableName),
    });
    if (!v || (!v.name && !v.url)) return;
    addRow(projectName, { ...v, name: v.name || v.url, table: v.table || tableName });
    window.TrackerRender();
  }

  async function newTable(projectName) {
    const v = await window.TrackerUI.formDialog({
      title: "New table in " + projectName, submitLabel: "Create table",
      fields: [{ name: "name", label: "Table name", value: "",
                 placeholder: "UAT links, CR links, anything" }],
    });
    if (!v || !v.name) return;
    addTable(projectName, v.name);
    window.TrackerRender();
  }

  async function newProject() {
    const v = await window.TrackerUI.formDialog({
      title: "Add project", submitLabel: "Add project",
      fields: [{ name: "name", label: "Project name", value: "",
                 placeholder: "What the project is called" }],
    });
    if (!v || !v.name) return;
    const ps = projectStore();
    if (!groups().some((g) => g.name === v.name)) {
      ps.added.push({ key: slug(v.name), name: v.name });
      // A project hidden earlier under the same name comes back rather than
      // being added twice.
      ps.hidden = ps.hidden.filter((k) => k !== slug(v.name));
      writeProjects(ps);
    }
    window.TrackerRender();
  }

  async function renameProject(key) {
    const g = groupByKey(key);
    if (!g) return;
    const v = await window.TrackerUI.formDialog({
      title: "Rename project", submitLabel: "Save name",
      fields: [{ name: "name", label: "Project name", value: g.name }],
    });
    if (!v || !v.name || v.name === g.name) return;
    const ps = projectStore();
    const own = ps.added.find((a) => slug(a.name) === key || a.key === key);
    if (own) own.name = v.name;          // one you added: rename it in place
    else ps.renamed[key] = v.name;       // a workbook one: overlay the name
    writeProjects(ps);
    if (selected === key) selected = slug(v.name);
    window.TrackerRender();
  }

  async function deleteProject(key) {
    const g = groupByKey(key);
    if (!g) return;
    const n = rowsFor(key).length;
    const yes = await window.TrackerUI.confirmDialog({
      title: "Delete project",
      intro: `Remove "${g.name}" from the tracker?` +
             (n ? ` Its ${n} link${n === 1 ? "" : "s"} go with it.` : " It has no links.") +
             " Links from the workbook can be brought back by adding the project again.",
      confirmLabel: "Delete project",
    });
    if (!yes) return;
    const ps = projectStore();
    ps.added = ps.added.filter((a) => slug(a.name) !== key && a.key !== key);
    if (!ps.hidden.includes(key)) ps.hidden.push(key);
    writeProjects(ps);
    if (selected === key) selected = null;
    window.TrackerRender();
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-newproject]")) return newProject();
    const pe = e.target.closest('[data-edit^="project:"]');
    if (pe) return renameProject(window.TrackerUI.actionId(pe, "edit"));
    const pd = e.target.closest('[data-remove^="project:"]');
    if (pd) return deleteProject(window.TrackerUI.actionId(pd, "remove"));

    const pick = e.target.closest("[data-pick]");
    if (pick) {
      selected = selected === pick.dataset.pick ? null : pick.dataset.pick;
      return window.TrackerRender();
    }
    const nt = e.target.closest("[data-newtable]");
    if (nt) return newTable(nt.dataset.newtable);
    const at = e.target.closest("[data-addto]");
    if (at) {
      const i = at.dataset.addto.lastIndexOf("|");
      return add(at.dataset.addto.slice(0, i), at.dataset.addto.slice(i + 1));
    }
    const tre = e.target.closest('[data-edit^="table:"]');
    if (tre) {
      const spec = window.TrackerUI.actionId(tre, "edit");
      const i = spec.lastIndexOf("|");
      return renamePrompt(spec.slice(0, i), spec.slice(i + 1));
    }
    const trd = e.target.closest('[data-remove^="table:"]');
    if (trd) {
      const spec = window.TrackerUI.actionId(trd, "remove");
      const i = spec.lastIndexOf("|");
      return deletePrompt(spec.slice(0, i), spec.slice(i + 1));
    }
    const ed = e.target.closest('[data-edit^="link:"]');
    if (ed) return edit(window.TrackerUI.actionId(ed, "edit"));
    const rm = e.target.closest('[data-remove^="link:"]');
    if (rm) return removeLink(window.TrackerUI.actionId(rm, "remove"));
  });

  async function removeLink(id) {
    const row = resolved().find((r) => r.id === id);
    if (!row) return;
    const yes = await window.TrackerUI.confirmDialog({
      title: "Remove link",
      intro: `Remove "${row.name}" from ${row.table || "this table"}?`,
      confirmLabel: "Remove link",
    });
    if (!yes) return;
    removeRow(row);
    window.TrackerRender();
  }

  // Re-rendering replaces the inputs, so focus and caret are restored by hand;
  // without this a section search loses focus after every keystroke.
  async function renamePrompt(projectName, tableName) {
    const v = await window.TrackerUI.formDialog({
      title: "Rename table",
      intro: `Renaming "${tableName}" in ${projectName}. Every link in it moves with the name.`,
      submitLabel: "Rename",
      fields: [{ name: "name", label: "Table name", value: tableName }],
    });
    if (!v || !v.name.trim() || v.name.trim() === tableName) return;
    renameTable(projectName, tableName, v.name.trim());
    window.TrackerRender();
  }

  async function deletePrompt(projectName, tableName) {
    const n = rowsIn(projectName, tableName).length;
    // Say the cost before it is paid: deleting a table takes its links too,
    // and a workbook link removed here does not come back on reload.
    const yes = await window.TrackerUI.confirmDialog({
      title: "Delete table",
      intro: `Delete "${tableName}" from ${projectName}?` +
             (n ? ` Its ${n} link${n === 1 ? "" : "s"} will be removed with it.` : " It is empty."),
      confirmLabel: n ? `Delete table and ${n} link${n === 1 ? "" : "s"}` : "Delete table",
    });
    if (!yes) return;
    deleteTable(projectName, tableName);
    window.TrackerRender();
  }

  document.addEventListener("input", (e) => {
    const box = e.target.closest("[data-search]");
    if (box) {
      const key = box.dataset.search;
      find[key] = box.value.trim();
      window.TrackerRender();
      const again = document.querySelector(`[data-search="${CSS.escape(key)}"]`);
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      return;
    }
    const sel = e.target.closest("[data-account]");
    if (sel) { account[sel.dataset.account] = sel.value; window.TrackerRender(); }
  });

  window.TrackerLinks = {
    searchBox, findValue: (key) => (find[key] || "").toLowerCase(),
    resolved, groups, groupByKey, rowsFor, rowsIn, tablesFor, newProject, saveRow, addRow, addTable,
    renameTable, deleteTable,
    removeRow, slug, DRIVE_GROUP, overview, tableView, ROWS_PER_PAGE, PROJ_COLS,
  };
})();
