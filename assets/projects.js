/* Artifacts and timeline for each project.
 *
 * The link tables answer "where is it". These two answer "what are we
 * producing" and "where are we". Both are yours to edit: the workbook seeds
 * them once (EDRMS ADB arrives with five release phases, GLASS with its
 * reference files), after which every add, rename and delete is stored in
 * this browser and the seed is never re-applied over your edits.
 */
(() => {
  const ART = "tracker.artifacts";     // [ {id, project, name, type, status, owner, url, description} ]
  const TL = "tracker.timeline";       // [ {id, project, name, start, end, progress, status, notes} ]
  const SEEDED = "tracker.seeded";     // projects whose seed has already run

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } };
  const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  const ART_STATUS = ["Not started", "In progress", "For review", "Signed off", "Blocked"];
  const TL_STATUS = ["Not started", "In progress", "Complete", "Blocked"];

  /**
   * Seed once per project from whatever the workbook already knows, then get
   * out of the way. Re-seeding would resurrect entries you deleted.
   */
  function seed(project) {
    const done = read(SEEDED);
    if (done.includes(project.id)) return;

    const arts = read(ART), tls = read(TL);
    for (const sec of project.sections || []) {
      if (sec.type === "links") {
        for (const i of sec.items || []) {
          if (!i.name) continue;
          arts.push({ id: "ar-" + project.id + "-" + arts.length, project: project.id,
                      name: i.name, type: i.group || "Document", status: ART_STATUS[0],
                      owner: "", url: i.url || "", description: i.note || "" });
        }
      } else if (sec.type === "phases") {
        for (const ph of sec.items || []) {
          for (const st of ph.steps || []) {
            tls.push({ id: "tl-" + project.id + "-" + tls.length, project: project.id,
                       name: st.name, phase: ph.title, start: "", end: "",
                       progress: 0, status: TL_STATUS[0], notes: st.description || "",
                       url: st.url || "" });
          }
        }
      }
    }
    write(ART, arts); write(TL, tls);
    write(SEEDED, [...done, project.id]);
  }

  const artifactsOf = (id) => read(ART).filter((a) => a.project === id);
  const timelineOf = (id) => read(TL).filter((t) => t.project === id);

  /** Project progress is the mean of its milestones, so it cannot disagree. */
  function rollup(id) {
    const rows = timelineOf(id);
    if (!rows.length) return null;
    const total = rows.reduce((n, r) => n + (Number(r.progress) || 0), 0);
    return Math.round(total / rows.length);
  }

  /* ---------- dialogs ---------- */
  async function editArtifact(projectId, id) {
    const all = read(ART);
    const cur = all.find((a) => a.id === id);
    const v = await window.TrackerUI.formDialog({
      title: cur ? "Edit artifact" : "New artifact",
      submitLabel: cur ? "Save changes" : "Add artifact",
      fields: [
        { name: "name", label: "Artifact", value: cur ? cur.name : "", placeholder: "What is being produced" },
        { name: "type", label: "Type", value: cur ? cur.type : "", placeholder: "FSD, deck, test case…" },
        { name: "status", label: "Status", type: "select", options: ART_STATUS,
          value: cur ? cur.status : ART_STATUS[0] },
        { name: "owner", label: "Owner", value: cur ? cur.owner : "" },
        { name: "url", label: "Link", value: cur ? cur.url : "", placeholder: "https://…" },
        { name: "description", label: "Description", type: "textarea", rows: 3,
          value: cur ? cur.description : "" },
      ],
    });
    if (!v) return;
    if (cur) Object.assign(cur, v);
    else all.push({ id: "ar-" + Date.now(), project: projectId, ...v });
    write(ART, all);
    window.TrackerRender();
  }

  async function editMilestone(projectId, id) {
    const all = read(TL);
    const cur = all.find((t) => t.id === id);
    const v = await window.TrackerUI.formDialog({
      title: cur ? "Edit milestone" : "New milestone",
      submitLabel: cur ? "Save changes" : "Add milestone",
      fields: [
        { name: "name", label: "Milestone", value: cur ? cur.name : "" },
        { name: "phase", label: "Phase", value: cur ? cur.phase || "" : "", placeholder: "Optional grouping" },
        { name: "start", label: "Start", type: "date", value: cur ? cur.start : "" },
        { name: "end", label: "Target date", type: "date", value: cur ? cur.end : "" },
        { name: "progress", label: "Progress %", type: "number",
          value: cur ? String(cur.progress ?? 0) : "0" },
        { name: "status", label: "Status", type: "select", options: TL_STATUS,
          value: cur ? cur.status : TL_STATUS[0] },
        { name: "url", label: "Link", value: cur ? cur.url || "" : "", placeholder: "https://…" },
        { name: "notes", label: "Notes", type: "textarea", rows: 3, value: cur ? cur.notes : "" },
      ],
    });
    if (!v) return;
    // Clamped rather than trusted: a percentage outside 0-100 would make the
    // roll-up meaningless without anything on screen looking wrong.
    const pct = Math.max(0, Math.min(100, Number(v.progress) || 0));
    if (cur) Object.assign(cur, v, { progress: pct });
    else all.push({ id: "tl-" + Date.now(), project: projectId, ...v, progress: pct });
    write(TL, all);
    window.TrackerRender();
  }

  const removeArtifact = (id) => { write(ART, read(ART).filter((a) => a.id !== id)); window.TrackerRender(); };
  const removeMilestone = (id) => { write(TL, read(TL).filter((t) => t.id !== id)); window.TrackerRender(); };

  /* ---------- render ---------- */
  const dash = `<span class="tag dead">—</span>`;
  const statusTag = (s) => {
    const v = String(s || "").toLowerCase();
    const cls = v.includes("signed") || v.includes("complete") ? "ok"
      : v.includes("progress") || v.includes("review") ? "info"
      : v.includes("block") ? "warn" : "";
    return `<span class="tag ${cls}">${esc(s || "—")}</span>`;
  };

  function bar(pct) {
    const n = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="progress" title="${n}%"><span style="width:${n}%"></span></div>
            <span class="pctnum">${n}%</span>`;
  }

  function artifactsTable(p, q) {
    const rows = artifactsOf(p.id).filter((a) => !q || JSON.stringify(a).toLowerCase().includes(q));
    return `<section class="linksection">
      <div class="sectionhead">
        <div class="sectionleft">
          <h3 class="sec">Artifacts (${rows.length})</h3>
          ${window.TrackerLinks.searchBox("art:" + p.id, "Search artifacts…")}
        </div>
        <div class="sectiontools">
          <button class="btn sm" data-edit="art:${esc(p.id)}|new">Add artifact</button>
        </div>
      </div>
      ${rows.length ? `<div class="tablewrap"><table class="linktable projtable"><thead><tr>
          <th class="namecol">Artifact</th><th class="phasecol">Type</th>
          <th class="statuscol">Status</th><th class="phasecol">Owner</th>
          <th class="datecol">Link</th><th class="actcol"></th>
        </tr></thead><tbody>${rows.map((a) => `
          <tr>
            <td class="wrap"><span class="sitename">${esc(a.name)}</span>
              ${a.description ? `<div class="note2" title="${esc(a.description)}">${esc(a.description)}</div>` : ""}</td>
            <td>${a.type ? `<span class="tag">${esc(a.type)}</span>` : dash}</td>
            <td>${statusTag(a.status)}</td>
            <td>${a.owner ? esc(a.owner) : dash}</td>
            <td>${a.url ? `<a class="btn sm" href="${esc(a.url)}" target="_blank" rel="noopener">Open ↗</a>` : dash}</td>
            <td><span class="actions">
              <button class="btn sm" data-edit="art:${esc(p.id)}|${esc(a.id)}">Edit</button>
              <button class="btn sm" data-remove="art:${esc(a.id)}">Remove</button>
            </span></td>
          </tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">No artifacts yet.</div>`}
    </section>`;
  }

  function timelineTable(p, q) {
    const rows = timelineOf(p.id).filter((t) => !q || JSON.stringify(t).toLowerCase().includes(q));
    const overall = rollup(p.id);
    return `<section class="linksection">
      <div class="sectionhead">
        <div class="sectionleft">
          <h3 class="sec">Timeline (${rows.length})</h3>
          ${window.TrackerLinks.searchBox("tl:" + p.id, "Search milestones…")}
        </div>
        <div class="sectiontools">
          ${overall === null ? "" : `<span class="rollup">Overall ${bar(overall)}</span>`}
          <button class="btn sm" data-edit="tl:${esc(p.id)}|new">Add milestone</button>
        </div>
      </div>
      ${rows.length ? `<div class="tablewrap"><table class="linktable projtable"><thead><tr>
          <th class="namecol">Milestone</th><th class="phasecol">Phase</th>
          <th class="datecol">Start</th><th class="datecol">Target</th>
          <th class="progcol">Progress</th><th class="statuscol">Status</th><th class="actcol"></th>
        </tr></thead><tbody>${rows.map((t) => `
          <tr>
            <td class="wrap"><span class="sitename">${esc(t.name)}</span>
              ${t.notes ? `<div class="note2" title="${esc(t.notes)}">${esc(t.notes)}</div>` : ""}
              ${t.url ? `<a class="btn sm" href="${esc(t.url)}" target="_blank" rel="noopener">Open ↗</a>` : ""}</td>
            <td class="wrap">${t.phase ? esc(t.phase) : dash}</td>
            <td>${t.start ? esc(t.start) : dash}</td>
            <td>${t.end ? esc(t.end) : dash}</td>
            <td class="pcell">${bar(t.progress)}</td>
            <td>${statusTag(t.status)}</td>
            <td><span class="actions">
              <button class="btn sm" data-edit="tl:${esc(p.id)}|${esc(t.id)}">Edit</button>
              <button class="btn sm" data-remove="tl:${esc(t.id)}">Remove</button>
            </span></td>
          </tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">No milestones yet.</div>`}
    </section>`;
  }

  function view(p) {
    seed(p);
    const qa = window.TrackerLinks.findValue("art:" + p.id);
    const qt = window.TrackerLinks.findValue("tl:" + p.id);
    return artifactsTable(p, qa) + timelineTable(p, qt);
  }

  /* ---------- wiring ---------- */
  document.addEventListener("click", (e) => {
    const a = e.target.closest('[data-edit^="art:"]');
    if (a) {
      const [pid, id] = a.dataset.edit.slice(4).split("|");
      return editArtifact(pid, id === "new" ? null : id);
    }
    const m = e.target.closest('[data-edit^="tl:"]');
    if (m) {
      const [pid, id] = m.dataset.edit.slice(3).split("|");
      return editMilestone(pid, id === "new" ? null : id);
    }
    const ra = e.target.closest('[data-remove^="art:"]');
    if (ra) return removeArtifact(ra.dataset.remove.slice(4));
    const rm = e.target.closest('[data-remove^="tl:"]');
    if (rm) return removeMilestone(rm.dataset.remove.slice(3));
  });

  window.TrackerProjects = { view, artifactsOf, timelineOf, rollup };
})();
