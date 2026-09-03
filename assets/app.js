/* Tracker — renders data/tracker.json plus any Drive links saved in this browser. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const state = {
    data: null,
    route: location.hash.slice(1) || "overview",
    query: "",
    filters: {},          // per-route chip filter
    sort: {},             // per-route {key, dir}
  };
  window.TrackerState = state;

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const matches = (obj, q) => !q || JSON.stringify(obj).toLowerCase().includes(q);

  function statusTag(s) {
    if (!s) return "";
    const v = s.toLowerCase();
    const cls = v.includes("complete") ? "ok"
      : v.includes("progress") ? "info"
      : v.includes("pending") || v.includes("block") ? "warn" : "";
    return `<span class="tag ${cls}">${esc(s)}</span>`;
  }

  function linkCard(item, extraTags = []) {
    const tags = [...extraTags];
    if (item.url && host(item.url)) tags.push(`<span class="tag dead">${esc(host(item.url))}</span>`);
    if (item.url && item.verified === false)
      tags.push(`<span class="tag warn" title="This link was relative inside the workbook and was re-rooted on the AvePoint tenant — open it once to confirm.">check link</span>`);
    const body = `
      <div class="t">${esc(item.name || "Untitled")}</div>
      ${item.meta ? `<div class="m">${esc(item.meta)}</div>` : ""}
      <div class="row">${tags.join("")}</div>`;
    return item.url
      ? `<a class="card" href="${esc(item.url)}" target="_blank" rel="noopener">${body}</a>`
      : `<div class="card">${body}<div class="m" style="color:var(--warn)">No link recorded in the workbook</div></div>`;
  }

  /* ---------- sortable table ---------- */
  function table(routeKey, cols, rows) {
    const s = state.sort[routeKey];
    let data = rows.slice();
    if (s) {
      data.sort((a, b) => {
        const x = (a[s.key] ?? ""), y = (b[s.key] ?? "");
        return String(x).localeCompare(String(y), undefined, { numeric: true }) * (s.dir === "desc" ? -1 : 1);
      });
    }
    const head = cols.map((c) =>
      `<th data-sort="${c.key}">${esc(c.label)}${s && s.key === c.key ? (s.dir === "desc" ? " ↓" : " ↑") : ""}</th>`
    ).join("");
    const body = data.map((r) =>
      `<tr>${cols.map((c) => `<td class="${c.wrap ? "wrap" : ""}">${c.render(r)}</td>`).join("")}</tr>`
    ).join("");
    return data.length
      ? `<div class="tablewrap"><table data-route="${routeKey}">
           <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
      : `<div class="empty">Nothing matches your search.</div>`;
  }

  const linkCell = (r) => r.url
    ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">Open${r.verified === false ? " ⚠" : ""}</a>`
    : `<span class="tag dead">none</span>`;

  function chips(routeKey, values, current) {
    return `<div class="chips" data-chips="${routeKey}">
      ${["All", ...values].map((v) =>
        `<button class="chip" data-value="${esc(v)}" aria-pressed="${(current || "All") === v}">${esc(v)}</button>`
      ).join("")}</div>`;
  }

  /* ---------- link inventory (flattened, for search + overview) ---------- */
  function allLinks() {
    const out = [];
    for (const p of state.data.projects) {
      for (const sec of p.sections) {
        if (sec.type === "links") {
          sec.items.forEach((i) => out.push({ ...i, project: p.name, section: sec.title }));
        } else if (sec.type === "sites") {
          sec.items.forEach((i) => out.push({
            name: i.name, url: i.url, verified: i.verified, meta: i.account,
            project: p.name, section: sec.title
          }));
        } else if (sec.type === "phases") {
          sec.items.forEach((ph) => ph.steps.forEach((st) => {
            if (st.url) out.push({
              name: st.name, url: st.url, verified: st.verified, meta: ph.title,
              project: p.name, section: sec.title
            });
          }));
        }
      }
    }
    for (const d of driveLinks()) out.push({ ...d, project: d.project || "Google Drive", section: "Google Drive" });
    return out;
  }

  const driveLinks = () => {
    try { return JSON.parse(localStorage.getItem("tracker.driveLinks") || "[]"); }
    catch { return []; }
  };
  window.TrackerDriveLinks = driveLinks;

  /* ---------- views ---------- */
  const views = {
    overview() {
      const q = state.query;
      const links = allLinks().filter((l) => matches(l, q));
      const daily = state.data.daily;
      const openComms = state.data.communications.filter((c) => (c.status || "").toLowerCase() !== "completed");
      const unverified = allLinks().filter((l) => l.url && l.verified === false).length;
      const stats = [
        ["Tracked links", allLinks().length],
        ["Projects", state.data.projects.length],
        ["Logged activities", daily.length],
        ["Open comms items", openComms.length],
        ["Links to verify", unverified],
      ];
      return `
        <h2 class="page">Overview</h2>
        <p class="lede">Everything from <code>${esc(state.data.source)}</code>, rebuilt
          ${esc(state.data.generatedAt)}.</p>
        <div class="stats">${stats.map(([l, n]) =>
          `<div class="stat"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`).join("")}</div>
        <h3 class="sec">${q ? `Links matching “${esc(q)}”` : "All links"} (${links.length})</h3>
        <div class="grid">${links.map((l) => linkCard(l,
          [`<span class="tag accent">${esc(l.project)}</span>`])).join("") ||
          `<div class="empty">No links match your search.</div>`}</div>`;
    },

    project(p) {
      const q = state.query;
      let html = `<h2 class="page">${esc(p.name)}</h2><p class="lede">${esc(p.full)} — ${esc(p.blurb)}</p>`;
      for (const sec of p.sections) {
        html += `<h3 class="sec">${esc(sec.title)}</h3>`;
        if (sec.type === "links") {
          const items = sec.items.filter((i) => matches(i, q));
          html += `<div class="grid">${items.map((i) => linkCard(i,
            i.group ? [`<span class="tag">${esc(i.group)}</span>`] : [])).join("") ||
            `<div class="empty">Nothing matches your search.</div>`}</div>`;
        } else if (sec.type === "sites") {
          const items = sec.items.filter((i) => matches(i, q));
          html += table(`${p.id}-sites`, [
            { key: "sn", label: "#", render: (r) => esc(r.sn) },
            { key: "name", label: "Site / document", wrap: true, render: (r) => esc(r.name) },
            { key: "account", label: "Account used", render: (r) => r.account ? esc(r.account) : `<span class="tag dead">—</span>` },
            { key: "url", label: "Link", render: linkCell },
          ], items);
        } else if (sec.type === "concerns") {
          const items = sec.items.filter((i) => matches(i, q));
          html += table(`${p.id}-concerns`, [
            { key: "sn", label: "#", render: (r) => esc(r.sn) },
            { key: "concern", label: "Concern", render: (r) => esc(r.concern) },
            { key: "description", label: "Description", wrap: true, render: (r) => esc(r.description) },
            { key: "reason", label: "Reason", wrap: true, render: (r) => esc(r.reason) },
            { key: "status", label: "Status", render: (r) => statusTag(r.status) },
          ], items);
        } else if (sec.type === "phases") {
          html += sec.items.map((ph) => {
            const steps = ph.steps.filter((s) => matches(s, q));
            if (!steps.length) return "";
            return `<h3 class="sec" style="color:var(--accent)">${esc(ph.title)}</h3>
              <div class="grid">${steps.map((s) => linkCard({
                name: `${s.sn}. ${s.name}`, url: s.url, verified: s.verified, meta: s.description
              })).join("")}</div>`;
          }).join("") || `<div class="empty">Nothing matches your search.</div>`;
        } else if (sec.type === "list") {
          const items = sec.items.filter((i) => matches(i, q));
          html += items.length
            ? `<ol class="steps">${items.map((i) => `<li>${esc(String(i).replace(/^\s*\d+[.)]\s*/, ""))}</li>`).join("")}</ol>`
            : `<div class="empty">Nothing matches your search.</div>`;
          if (sec.note) html += `<div class="note">${esc(sec.note)}</div>`;
        }
      }
      return html;
    },

    daily() {
      const q = state.query;
      const projects = [...new Set(state.data.daily.map((d) => d.project).filter(Boolean))];
      const f = state.filters.daily;
      const rows = state.data.daily
        .filter((d) => matches(d, q))
        .filter((d) => !f || f === "All" || d.project === f);
      return `
        <h2 class="page">Daily activity log</h2>
        <p class="lede">${rows.length} of ${state.data.daily.length} logged activities.</p>
        ${chips("daily", projects, f)}
        ${table("daily", [
          { key: "date", label: "Date", render: (r) => esc(r.date) },
          { key: "task", label: "Activity", wrap: true, render: (r) => esc(r.task) },
          { key: "category", label: "Category", render: (r) => r.category ? `<span class="tag">${esc(r.category)}</span>` : "" },
          { key: "project", label: "Project", render: (r) => r.project ? `<span class="tag accent">${esc(r.project)}</span>` : "" },
          { key: "source", label: "Source", render: (r) => esc(r.source) },
          { key: "status", label: "Status", render: (r) => statusTag(r.status) },
          { key: "url", label: "Link", render: linkCell },
        ], rows)}`;
    },

    comms() {
      const q = state.query;
      const f = state.filters.comms;
      const statuses = [...new Set(state.data.communications.map((c) => c.status).filter(Boolean))];
      const rows = state.data.communications
        .filter((c) => matches(c, q))
        .filter((c) => !f || f === "All" || c.status === f);
      return `
        <h2 class="page">Communication tracker</h2>
        <p class="lede">Updates received over Teams, WeCom and email that need an owner or an action.</p>
        ${chips("comms", statuses, f)}
        ${table("comms", [
          { key: "date", label: "Received", render: (r) => esc(r.date) },
          { key: "platform", label: "Platform", render: (r) => r.platform ? `<span class="tag">${esc(r.platform)}</span>` : "" },
          { key: "sender", label: "From", render: (r) => esc(r.sender) },
          { key: "summary", label: "Update", wrap: true, render: (r) => esc(r.summary) },
          { key: "area", label: "Affected area", wrap: true, render: (r) => esc(r.area) },
          { key: "owner", label: "Owner", render: (r) => esc(r.owner) },
          { key: "due", label: "Due", render: (r) => esc(r.due) },
          { key: "status", label: "Status", render: (r) => statusTag(r.status) },
          { key: "url", label: "Link", render: linkCell },
        ], rows)}`;
    },

    drive() { return window.TrackerDrive.view(state.query); },
  };

  /* ---------- shell ---------- */
  function renderNav() {
    const items = [
      ["overview", "Overview", allLinks().length],
      ...state.data.projects.map((p) => [`p:${p.id}`, p.name, null]),
      ["daily", "Daily activity", state.data.daily.length],
      ["comms", "Communications", state.data.communications.length],
      ["drive", "Google Drive", driveLinks().length],
    ];
    $("#nav").innerHTML =
      `<div class="nav-title">Index</div>` +
      items.map(([r, label, n], i) => {
        const head = (i === 1) ? `<div class="nav-title">Projects</div>` : "";
        const tail = (r === "daily") ? "" : "";
        return head + `<button data-route="${r}" aria-current="${state.route === r}">
          <span>${esc(label)}</span>${n !== null ? `<span class="count">${n}</span>` : ""}</button>` + tail;
      }).join("");
  }

  function render() {
    renderNav();
    let html;
    if (state.route.startsWith("p:")) {
      const p = state.data.projects.find((x) => x.id === state.route.slice(2));
      html = p ? views.project(p) : `<div class="empty">Unknown project.</div>`;
    } else {
      html = (views[state.route] || views.overview)();
    }
    $("#view").innerHTML = html;
  }
  window.TrackerRender = render;

  function go(route) {
    state.route = route;
    location.hash = route;
    render();
    window.scrollTo({ top: 0 });
  }
  window.TrackerGo = go;

  /* ---------- events ---------- */
  document.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-route]");
    if (nav && nav.tagName === "BUTTON") return go(nav.dataset.route);

    const th = e.target.closest("th[data-sort]");
    if (th) {
      const key = th.closest("table").dataset.route;
      const cur = state.sort[key];
      state.sort[key] = { key: th.dataset.sort,
        dir: cur && cur.key === th.dataset.sort && cur.dir === "asc" ? "desc" : "asc" };
      return render();
    }

    const chip = e.target.closest(".chip");
    if (chip) {
      state.filters[chip.closest("[data-chips]").dataset.chips] = chip.dataset.value;
      return render();
    }
  });

  $("#q").addEventListener("input", (e) => { state.query = e.target.value.trim().toLowerCase(); render(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $("#q")) { e.preventDefault(); $("#q").focus(); }
    if (e.key === "Escape") document.querySelectorAll(".modal").forEach((m) => (m.hidden = true));
  });

  $("#toggleTheme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("tracker.theme", next);
  });
  if (localStorage.getItem("tracker.theme")) {
    document.documentElement.dataset.theme = localStorage.getItem("tracker.theme");
  }

  $("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ ...state.data, driveLinks: driveLinks() }, null, 1)],
      { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tracker-export.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  window.addEventListener("hashchange", () => {
    const r = location.hash.slice(1) || "overview";
    if (r !== state.route) { state.route = r; render(); }
  });

  /* ---------- boot ---------- */
  fetch("data/tracker.json")
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      state.data = d;
      $("#genStamp").textContent = "Data built " + d.generatedAt;
      render();
    })
    .catch((err) => {
      $("#view").innerHTML = `<div class="empty">Could not load <code>data/tracker.json</code> (${esc(err.message)}).<br>
        If you opened this file straight from disk, serve it instead:
        <code>python3 -m http.server</code> in the repository folder.</div>`;
    });
})();
