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

  const ATT_MAX = 5;
  const isImage = (t) => /^image\//.test(String(t || ""));

  function fieldHtml(f) {
    const id = "fd_" + f.name;
    const v = f.value ?? "";
    // Opt-in, never blanket: fieldHtml renders every field in the app, and a
    // capitalised URL is a broken URL. Marked fields are wired in formDialog.
    const cap = f.capitalize ? ' data-capitalize="1"' : "";
    let control;
    if (f.type === "textarea") {
      control = `<textarea id="${id}"${cap} rows="${f.rows || 4}" placeholder="${esc(f.placeholder || "")}">${esc(v)}</textarea>`;
    } else if (f.type === "select") {
      control = `<select id="${id}">${(f.options || []).map((o) =>
        `<option value="${esc(o)}"${String(o) === String(v) ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    } else if (f.type === "attachments") {
      const list = (f.value || []).map(attachmentRow).join("");
      // Three parts: what is already attached, what you have just added in this
      // dialog, and the picker. The staged list is filled by wireAttachments,
      // because a file input's FileList cannot be appended to - picking twice
      // would otherwise replace the first pick rather than add to it, which is
      // exactly what "select up to 5" needs.
      control = `<div class="attachments" data-attfield="${esc(f.name)}">
          ${list || `<div class="m nothingyet">Nothing attached yet.</div>`}
          <div class="attstaged" data-staged="${esc(f.name)}"></div>
          <input id="${id}" type="file" multiple accept="image/*,*/*">
          <div class="attcount" data-attcount="${esc(f.name)}"></div>
        </div>`;
    } else {
      control = `<input id="${id}"${cap} type="${f.type || "text"}" value="${esc(v)}"
        placeholder="${esc(f.placeholder || "")}" spellcheck="false">`;
    }
    // The label row carries the field's own tools on the right. Today that
    // is the standardize button; anything per-field goes here rather than
    // floating over the control, which would sit on top of the text.
    const tools = f.standardize
      ? `<span class="fieldtools">
           ${iconButton("wand", "Standardize text", `data-standardize="${id}"`)}
         </span>`
      : "";
    return `<div class="field">
        <div class="fieldhead"><label for="${id}">${esc(f.label)}</label>${tools}</div>
        ${control}
        <div class="fieldnote" data-note="${id}" hidden></div>
        ${f.help ? `<small>${esc(f.help)}</small>` : ""}
      </div>`;
  }

  /**
   * The attachment picker: paste, choose, count, and a hard ceiling.
   *
   * Files added in this dialog are held here rather than in the file input,
   * because a FileList is read-only: choosing a second time replaces the first
   * choice instead of adding to it. Staging them makes "up to five" mean five
   * across every way of adding one.
   *
   * Pasting is the point of the change - a screenshot on the clipboard is a
   * file in clipboardData.files, and it arrives with a useless name, so it is
   * renamed to something a download can be saved as. A tool that pastes a path
   * or HTML instead of a file cannot be caught here; Choose Files still works.
   */
  function wireAttachments(box, fields) {
    const staged = new Map();
    const urls = [];
    const specs = fields.filter((f) => f.type === "attachments");
    if (!specs.length) return { staged, revoke: () => {} };

    const kept = (f) => (f.value || [])
      .filter((a) => !box.querySelector(`[data-drop="${cssEsc(a.id)}"]`)?.checked).length;

    function paint(f) {
      const list = staged.get(f.name) || [];
      const host = box.querySelector(`[data-staged="${cssEsc(f.name)}"]`);
      if (host) {
        host.innerHTML = list.map((file, i) => {
          let thumb = "";
          if (isImage(file.type)) {
            const u = URL.createObjectURL(file);
            urls.push(u);
            thumb = `<img class="attthumb" src="${u}" alt="">`;
          }
          return `<div class="attrow staged">
              ${thumb}
              <span class="attname">${esc(file.name)}</span>
              <span class="tag dead">${Math.ceil(file.size / 1024)} KB</span>
              <button type="button" class="attdrop" data-unstage="${esc(f.name)}:${i}">remove</button>
            </div>`;
        }).join("");
      }
      const total = kept(f) + list.length;
      const max = f.max || ATT_MAX;
      const note = box.querySelector(`[data-attcount="${cssEsc(f.name)}"]`);
      if (note) note.textContent = `${total} of ${max} attached.` +
        (total >= max ? " Remove one to add another." : " Paste a screenshot, or choose files.");
      const picker = box.querySelector("#fd_" + f.name);
      if (picker) picker.disabled = total >= max;
      const empty = box.querySelector(".nothingyet");
      if (empty) empty.hidden = list.length > 0;
    }

    /** Add what we can, and say plainly what would not fit. */
    function add(f, files) {
      const max = f.max || ATT_MAX;
      const list = staged.get(f.name) || [];
      const room = Math.max(0, max - kept(f) - list.length);
      const taking = [...files].slice(0, room);
      const refused = [...files].length - taking.length;
      let n = list.length;
      for (const file of taking) {
        // A pasted screenshot arrives as "image.png" or with no name at all.
        const named = (!file.name || /^image\.[a-z]+$/i.test(file.name)) && isImage(file.type)
          ? new File([file], `Pasted image ${++n}.${(file.type.split("/")[1] || "png")}`,
                     { type: file.type })
          : file;
        list.push(named);
      }
      staged.set(f.name, list);
      paint(f);
      const note = box.querySelector(`[data-note="fd_${cssEsc(f.name)}"]`);
      if (note) {
        note.hidden = !refused;
        note.textContent = refused
          ? `${refused} file${refused === 1 ? "" : "s"} not attached: the limit is ${max}.`
          : "";
      }
    }

    for (const f of specs) {
      staged.set(f.name, []);
      const picker = box.querySelector("#fd_" + f.name);
      if (picker) picker.addEventListener("change", () => {
        add(f, picker.files || []);
        picker.value = "";   // so choosing the same file twice still registers
      });
      paint(f);
    }

    box.addEventListener("paste", (e) => {
      const files = (e.clipboardData && e.clipboardData.files) || [];
      if (!files.length) return;
      e.preventDefault();
      add(specs[0], files);
    });

    box.addEventListener("click", (e) => {
      const un = e.target.closest("[data-unstage]");
      if (un) {
        const [name, i] = un.dataset.unstage.split(":");
        const list = staged.get(name) || [];
        list.splice(Number(i), 1);
        staged.set(name, list);
        paint(specs.find((f) => f.name === name));
      }
      // Ticking an existing attachment to remove it frees a slot immediately.
      if (e.target.matches("[data-drop]")) specs.forEach(paint);
    });

    return { staged, revoke: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
  }

  /** Escape a value for use inside a CSS attribute selector. */
  const cssEsc = (v) => String(v).replace(/["\\]/g, "\\$&");

  /**
   * Upper-case the first letter of a marked field, as it is typed or pasted.
   *
   * Only the first character, and only when it is a lower-case letter: a name
   * starting with a digit, a bracket or an already-capital initial is left
   * exactly as it is. Everything after it is untouched, so "check the iOS
   * build" keeps its iOS.
   *
   * The caret is not moved, because only index 0 changes and the value stays
   * the same length. Setting .value would otherwise send the caret to the end
   * and make typing impossible.
   */
  function wireCapitals(box) {
    for (const el of box.querySelectorAll("[data-capitalize]")) {
      el.addEventListener("input", () => {
        const v = el.value;
        if (!v) return;
        const up = v[0].toUpperCase();
        if (up === v[0]) return;
        const at = el.selectionStart, to = el.selectionEnd;
        el.value = up + v.slice(1);
        try { el.setSelectionRange(at, to); } catch { /* a date input has no range */ }
      });
    }
  }

  /**
   * Open a form. Resolves with an object keyed by field name, or null if the
   * dialog was cancelled — so a caller can always tell "saved nothing" from
   * "saved an empty value".
   *
   * An attachments field resolves to { keep: [ids], added: [File] }.
   */
  /**
   * `choices` replaces the Cancel/Save pair with named buttons, for a dialog
   * that offers two equal actions rather than one commit. It resolves with
   * the chosen button's value instead of the field values.
   */
  function formDialog({ title, intro, fields, submitLabel = "Save", choices = null,
                       cancelLabel = null }) {
    const box = ensureHost();
    box.innerHTML = `<div class="box">
        <h3>${esc(title)}</h3>
        ${intro ? `<p class="lede">${esc(intro)}</p>` : ""}
        <div class="fieldset">${fields.map(fieldHtml).join("")}</div>
        <div class="actions">
          ${choices
            ? choices.map((c) =>
                `<button class="btn${c.primary ? " primary" : ""}" data-fd="choice"
                         data-value="${esc(c.value)}">${esc(c.label)}</button>`).join("") +
              `<button class="btn" data-fd="cancel">${esc(cancelLabel || "Close")}</button>`
            : `<button class="btn" data-fd="cancel">${esc(cancelLabel || "Cancel")}</button>
               <button class="btn primary" data-fd="save">${esc(submitLabel)}</button>`}
        </div>
      </div>`;
    box.hidden = false;
    wireCapitals(box);
    const atts = wireAttachments(box, fields);
    const first = box.querySelector("input,textarea,select");
    if (first) first.focus();

    return new Promise((resolve) => {
      const close = (value) => {
        atts.revoke();
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
              // Staged, not el.files: a file input only remembers the last pick.
              added: [...(atts.staged.get(f.name) || [])],
            };
          } else {
            out[f.name] = el ? el.value.trim() : "";
          }
        }
        return out;
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); close(null); }
        // Enter used to submit the whole dialog from any input. On a ten-field
        // form that saves everything below the caret as blank, which is how a
        // task could be created with its link fields empty. Enter now moves to
        // the next field; Ctrl/Cmd+Enter or the button saves.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); close(collect()); return; }
        if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "file") {
          e.preventDefault();
          const inputs = [...box.querySelectorAll("input, textarea, select")]
            .filter((el) => !el.disabled && el.type !== "hidden");
          const i = inputs.indexOf(e.target);
          if (i > -1 && i + 1 < inputs.length) inputs[i + 1].focus();
        }
      };
      const onClick = (e) => {
        if (e.target === box || e.target.closest('[data-fd="cancel"]')) return close(null);
        const choice = e.target.closest('[data-fd="choice"]');
        if (choice) return close({ choice: choice.dataset.value });
        if (e.target.closest('[data-fd="save"]')) return close(collect());
      };
      document.addEventListener("keydown", onKey);
      box.addEventListener("click", onClick);
    });
  }

  /**
   * One confirmation for every destructive action in the app.
   *
   * Deleting used to mean two different things depending on where you stood:
   * a project or a table made you retype its name, while a link, an artifact,
   * a milestone, a task, a log entry and a pinned Drive file went instantly
   * with nothing asked at all. Six of the eight could be lost to a misplaced
   * click, and the two that were guarded were guarded so heavily that the
   * heading being uppercased by CSS needed a note explaining what to type.
   *
   * Every one of them comes through here now: say what goes, offer Confirm
   * and Cancel, resolve true only for Confirm. A delete added later inherits
   * it by calling this instead of inventing a ninth pattern.
   */
  const confirmDialog = ({ title, intro, confirmLabel = "Delete" }) =>
    formDialog({
      title, intro, fields: [],
      choices: [{ value: "confirm", label: confirmLabel, primary: true }],
      cancelLabel: "Cancel",
    }).then((r) => !!(r && r.choice === "confirm"));

  /**
   * Strip the dashes a model reaches for, whatever the prompt asked.
   *
   * The prompt says not to use them. This makes sure. An instruction is a
   * request and a regex is a guarantee, and the difference shows up on the
   * one rewrite in fifty where the model does it anyway.
   *
   * Deliberately narrow. A hyphen inside "well-known" and an en dash between
   * "2024-2025" are not the problem and are left alone; only the dash used as
   * punctuation between words is rewritten, as the comma it was standing in
   * for.
   */
  function tidyDashes(text) {
    return String(text ?? "")
      // A range between numbers is not the problem. Handled first, or the
      // rule below turns "2024-2025" into "2024, 2025" - which it did, and
      // the check caught it.
      .replace(/(\d)\s*[\u2014\u2013]\s*(?=\d)/g, "$1-")
      // " word - word " and "word-word": the parenthetical dash becomes the
      // comma it was standing in for.
      .replace(/\s*[\u2014\u2013]\s*(?=[A-Za-z0-9])/g, (m, off, str) =>
        /[A-Za-z0-9]$/.test(str.slice(0, off)) ? ", " : " ")
      // A trailing one with nothing after it is just noise.
      .replace(/\s*[\u2014\u2013]\s*$/g, "")
      .replace(/ {2,}/g, " ")
      .replace(/ +([,.;:!?])/g, "$1")
      .trim();
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

  /** Move a table to a given page from outside its own pager buttons. */
  const goToPage = (key, index) => { page[key] = Math.max(0, index); };

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

  /* ---------- shared column sorting ----------
     app.js had a sortable-header mechanism the link table never called, so
     its columns could not be sorted at all. One helper here instead, keyed
     per table, so every table gets it and the next one inherits it. */
  const sorts = {};

  /** Header cell that reports and toggles its own direction. */
  const sortHeader = (key, field, label) => {
    const s2 = sorts[key];
    const arrow = s2 && s2.field === field ? (s2.dir === "desc" ? " ↓" : " ↑") : "";
    return `<th data-sortkey="${key}" data-sortfield="${field}">${label}${arrow}</th>`;
  };

  /** Apply the current sort for `key`. Alphabetical, numbers read as numbers. */
  const sortRows = (key, rows) => {
    const s2 = sorts[key];
    if (!s2) return rows;
    return rows.slice().sort((a, b) =>
      String(a[s2.field] ?? "").localeCompare(String(b[s2.field] ?? ""),
        undefined, { numeric: true, sensitivity: "base" }) * (s2.dir === "desc" ? -1 : 1));
  };

  document.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sortfield]");
    if (!th) return;
    const key = th.dataset.sortkey, field = th.dataset.sortfield;
    const cur = sorts[key];
    sorts[key] = { field, dir: cur && cur.field === field && cur.dir === "asc" ? "desc" : "asc" };
    window.TrackerRender();
  });

  /**
   * The id out of a data-edit / data-remove attribute.
   *
   * These are written "kind:id" and every handler used to slice off the
   * prefix by a hand-counted length. drive.js had unpin(...slice(7)) where
   * "drive:" is six characters, so Remove passed an id one character short,
   * matched nothing, and did nothing at all - while Edit, on slice(6) one
   * line above, worked. Ten sites counted; one was wrong. Nothing counts now.
   */
  const actionId = (el, kind) => {
    const raw = (el && el.dataset ? el.dataset[kind] : "") || "";
    const i = raw.indexOf(":");
    return i === -1 ? raw : raw.slice(i + 1);
  };

  /* ---------- icon buttons ----------
     Nineteen action buttons across five modules spelled out "Edit", "Remove",
     "Delete", "Rename". One helper instead, so an icon is drawn once and every
     button keeps a real name for screen readers and on hover - an icon with no
     accessible name is a button nobody can identify. */
  const ICONS = {
    edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 6.5l3 3"/>',
    remove: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6.5 7l1 12h9l1-12"/><path d="M10 11v5M14 11v5"/>',
    rename: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 6.5l3 3"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    done: '<path d="M4 12.5l5 5L20 6.5"/>',
    // A drawing pin seen side on: head, shaft, point. It reads as pinned
    // when the button fills it, which is the whole point of the control.
    pin: '<path d="M9 3h6l-1 5 3.5 3.5H6.5L10 8z"/><path d="M12 11.5V21"/>',
    // A wand with a spark: the conventional "let the machine have a go at
    // this" mark, and distinct at 14px from the pencil that means "edit".
    wand: '<path d="M4 20L15 9"/><path d="M14.5 5.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"/><path d="M19 15l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  };

  /**
   * An icon button. `attrs` carries whatever the caller needs on it, usually
   * data-edit / data-remove, so the existing handlers are untouched.
   */
  const iconButton = (icon, label, attrs = "", cls = "") =>
    `<button class="btn sm icon ${cls}" ${attrs} title="${esc(label)}" aria-label="${esc(label)}">
       <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon] || ""}</svg>
     </button>`;

  /* ---------- standardize a field ----------
     The button belongs to the dialog, not to any one caller, so it is wired
     once here. Whatever produces the improved text is injected as
     window.TrackerAI, so this file stays free of any provider.

     Two rules the whole thing is built around. What you typed is never lost:
     the original is kept and Undo puts it back exactly. And a failure leaves
     your text alone and says why in words, because a rewriter that eats a
     paragraph on a flaky connection is worse than no rewriter. */
  const originals = new Map();

  const noteFor = (id) => document.querySelector(`[data-note="${id}"]`);
  function setNote(id, html, kind = "") {
    const el = noteFor(id);
    if (!el) return;
    el.className = "fieldnote" + (kind ? " " + kind : "");
    el.innerHTML = html;
    el.hidden = !html;
  }

  async function standardize(btn) {
    const id = btn.dataset.standardize;
    const field = document.getElementById(id);
    if (!field) return;
    const text = field.value.trim();
    if (!text) return setNote(id, "Write something first.", "warn");
    if (!window.TrackerAI) return setNote(id, "The text helper is not loaded.", "warn");

    btn.disabled = true;
    btn.classList.add("working");
    setNote(id, "Standardizing…");
    try {
      const improved = tidyDashes(await window.TrackerAI.standardize(text, {
        kind: field.tagName === "TEXTAREA" ? "description" : "title",
      }));
      if (!improved) throw new Error("Nothing came back.");
      originals.set(id, text);            // only on success: nothing to undo otherwise
      field.value = improved;
      setNote(id, `Standardized. <button type="button" class="linkish"
                     data-undo="${id}">Undo</button>`, "ok");
    } catch (err) {
      // The field is deliberately untouched here.
      setNote(id, esc(err.message || "That did not work."), "warn");
    } finally {
      btn.disabled = false;
      btn.classList.remove("working");
    }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-standardize]");
    if (b) { e.preventDefault(); return standardize(b); }
    const u = e.target.closest("[data-undo]");
    if (u) {
      e.preventDefault();
      const id = u.dataset.undo;
      const field = document.getElementById(id);
      if (field && originals.has(id)) field.value = originals.get(id);
      originals.delete(id);
      return setNote(id, "");
    }
  });

  window.TrackerUI = { formDialog, confirmDialog, tidyDashes, pager, pageIndex, goToPage, sortHeader, sortRows, actionId,
                       iconButton, ICONS };
})();
