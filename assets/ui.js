/* Shared form dialog.

   Everything you author by hand in this tracker — a pinned Drive link, a
   manual link, a task — needs the same three things: create it, correct it
   when you mistype, delete it. Before this file only Settings had a real
   form; links were three chained prompt() boxes and could not be edited at
   all, so a typo cost a delete and a re-add.

   One dialog serves all of them. Fields are described as data, so a caller
   adds a field without touching this file. */
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let host = null;
  const ensureHost = () => {
    if (!host) {
      host = document.createElement("div");
      host.className = "modal";
      host.id = "formDialog";
      host.hidden = true;
      document.body.appendChild(host);
    }
    return host;
  };

  /** One attachment row inside an attachments field: keep it, or tick to drop. */
  function attachmentRow(a) {
    const label = a.kind === "link" ? "link" : (a.size ? Math.ceil(a.size / 1024) + " KB" : "file");
    return `<label class="attrow">
        <input type="checkbox" data-drop="${esc(a.id)}">
        <span class="attname">${esc(a.name)}</span>
        <span class="tag dead">${esc(label)}</span>
        <span class="attdrop">remove</span>
      </label>`;
  }

  function fieldHtml(f) {
    const id = "fd_" + f.name;
    const v = f.value ?? "";
    let control;
    if (f.type === "textarea") {
      control = `<textarea id="${id}" rows="${f.rows || 4}" placeholder="${esc(f.placeholder || "")}">${esc(v)}</textarea>`;
    } else if (f.type === "select") {
      control = `<select id="${id}">${(f.options || []).map((o) =>
        `<option value="${esc(o)}"${String(o) === String(v) ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    } else if (f.type === "attachments") {
      const list = (f.value || []).map(attachmentRow).join("");
      control = `<div class="attachments">
          ${list || `<div class="m">Nothing attached yet.</div>`}
          <input id="${id}" type="file" multiple>
        </div>`;
    } else {
      control = `<input id="${id}" type="${f.type || "text"}" value="${esc(v)}"
        placeholder="${esc(f.placeholder || "")}" spellcheck="false">`;
    }
    return `<div class="field">
        <label for="${id}">${esc(f.label)}</label>
        ${control}
        ${f.help ? `<small>${esc(f.help)}</small>` : ""}
      </div>`;
  }

  /**
   * Open a form. Resolves with an object keyed by field name, or null if the
   * dialog was cancelled — so a caller can always tell "saved nothing" from
   * "saved an empty value".
   *
   * An attachments field resolves to { keep: [ids], added: [File] }.
   */
  function formDialog({ title, intro, fields, submitLabel = "Save" }) {
    const box = ensureHost();
    box.innerHTML = `<div class="box">
        <h3>${esc(title)}</h3>
        ${intro ? `<p class="lede">${esc(intro)}</p>` : ""}
        <div class="fieldset">${fields.map(fieldHtml).join("")}</div>
        <div class="actions">
          <button class="btn" data-fd="cancel">Cancel</button>
          <button class="btn primary" data-fd="save">${esc(submitLabel)}</button>
        </div>
      </div>`;
    box.hidden = false;
    const first = box.querySelector("input,textarea,select");
    if (first) first.focus();

    return new Promise((resolve) => {
      const close = (value) => {
        box.hidden = true;
        box.innerHTML = "";
        document.removeEventListener("keydown", onKey);
        box.removeEventListener("click", onClick);
        resolve(value);
      };
      const collect = () => {
        const out = {};
        for (const f of fields) {
          const el = box.querySelector("#fd_" + f.name);
          if (f.type === "attachments") {
            const dropped = [...box.querySelectorAll("[data-drop]:checked")].map((c) => c.dataset.drop);
            out[f.name] = {
              keep: (f.value || []).map((a) => a.id).filter((id) => !dropped.includes(id)),
              added: el && el.files ? [...el.files] : [],
            };
          } else {
            out[f.name] = el ? el.value.trim() : "";
          }
        }
        return out;
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); close(null); }
        if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); close(collect()); }
      };
      const onClick = (e) => {
        if (e.target === box || e.target.closest('[data-fd="cancel"]')) return close(null);
        if (e.target.closest('[data-fd="save"]')) return close(collect());
      };
      document.addEventListener("keydown", onKey);
      box.addEventListener("click", onClick);
    });
  }

  /* ---------- shared pager ----------
     Lifted out of drive.js, where it was private to that closure while two
     tables used it and a third needed it. One implementation, keyed per
     table, so paging one never disturbs another. */
  const page = {};

  /**
   * Clamp a page index to a list that may have shrunk (a search, or removing
   * the last item on the final page) so a table can never render empty with
   * its rows sitting on an earlier page.
   */
  const pageIndex = (key, total, perPage) => {
    const last = Math.max(0, Math.ceil(total / perPage) - 1);
    if ((page[key] || 0) > last) page[key] = last;
    return page[key] || 0;
  };

  /** Pager control. Renders nothing for a single page. */
  const pager = (key, total, perPage) => {
    const pages = Math.ceil(total / perPage) || 1;
    if (pages <= 1) return "";
    const cur = pageIndex(key, total, perPage);
    const from = cur * perPage + 1;
    const to = Math.min(total, (cur + 1) * perPage);
    return `<div class="pager">
      <button class="btn sm" data-page="${key}:prev" ${cur === 0 ? "disabled" : ""}>‹ Prev</button>
      <span class="pageinfo">Showing ${from}–${to} of ${total} · page ${cur + 1} of ${pages}</span>
      <button class="btn sm" data-page="${key}:next" ${cur >= pages - 1 ? "disabled" : ""}>Next ›</button>
    </div>`;
  };

  document.addEventListener("click", (e) => {
    const pg = e.target.closest("[data-page]");
    if (!pg) return;
    const i = pg.dataset.page.lastIndexOf(":");
    const key = pg.dataset.page.slice(0, i), dir = pg.dataset.page.slice(i + 1);
    page[key] = Math.max(0, (page[key] || 0) + (dir === "next" ? 1 : -1));
    window.TrackerRender();
  });

  window.TrackerUI = { formDialog, pager, pageIndex };
})();
