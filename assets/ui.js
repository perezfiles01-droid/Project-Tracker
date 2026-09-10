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

  /* ---------- the sanitizer ----------
     Nothing in this app may store or render markup that has not been through
     here. It is written first, and applied on save AND again on render,
     because content written by an older version or edited in storage by hand
     must not be able to bypass it.

     An ALLOWLIST, never a blocklist. A blocklist is a list of the attacks
     somebody thought of; anything not on this list is unwrapped to its text,
     so a tag invented after this was written is inert by default rather than
     dangerous by default.

     Parsed with DOMParser into an inert document, never assigned to a live
     node's innerHTML. That distinction is the whole point: assigning
     "<img src=x onerror=alert(1)>" to a live element fires the handler during
     parsing, before any sanitizer gets a chance to look at it. */
  const ALLOWED = new Set(["P", "BR", "B", "STRONG", "I", "EM", "U", "S", "STRIKE",
                           "UL", "OL", "LI",
                           "TABLE", "THEAD", "TBODY", "TR", "TH", "TD",
                           "IMG"]);
  /* Every attribute is dropped except these two, on cells only, and only when
     they are small positive integers. colspan="1e9" is a denial of service
     rendered as a table. */
  const SPAN_ATTRS = new Set(["colspan", "rowspan"]);
  const spanOk = (v) => /^[0-9]{1,2}$/.test(String(v)) && Number(v) >= 1;

  /* An image is stored by REFERENCE, never by value.
   *
   * data-blob names bytes in IndexedDB; src is never stored and never read
   * from your content. That is a storage decision and a security one at once.
   *
   * Storage: a description lives in localStorage, which holds about 5 MB for
   * the whole origin. This app's own header already says two screenshots
   * would exhaust it "taking the pinned links and the task list down with
   * them", and a failed write returns false rather than throwing - so
   * embedding base64 here would lose your data quietly.
   *
   * Security: because the only thing that ever sets src is this app resolving
   * an id it wrote itself, no javascript: URL, no remote tracking pixel and
   * no data: payload can arrive through content at all.
   */
  const IMG_ATTRS = new Set(["data-blob", "alt"]);
  const blobRefOk = (v) => /^[a-z0-9][a-z0-9-]{0,63}$/i.test(String(v));

  /**
   * Arbitrary HTML in, only what this app permits out.
   *
   * A disallowed element is UNWRAPPED rather than deleted - its text survives
   * and only the tag goes - except for the few whose content is not prose and
   * would be dumped into the page as visible garbage if kept.
   */
  const DROP_WHOLE = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME",
                              "OBJECT", "EMBED", "SVG", "MATH", "HEAD", "LINK", "META"]);

  function cleanHtml(dirty) {
    const src = String(dirty ?? "");
    if (!src) return "";
    let doc;
    try {
      doc = new DOMParser().parseFromString("<body>" + src + "</body>", "text/html");
    } catch { return ""; }
    if (!doc || !doc.body) return "";

    const walk = (node) => {
      // A static list: the loop below moves and removes children, and a live
      // childNodes collection would skip half of them as it went.
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) continue;                 // text, always kept
        if (child.nodeType !== 1) { child.remove(); continue; }  // comments, PIs
        const tag = child.tagName.toUpperCase();
        if (DROP_WHOLE.has(tag)) { child.remove(); continue; }
        walk(child);
        if (!ALLOWED.has(tag)) {
          // Unwrap: keep what the person wrote, lose the tag around it.
          const parent = child.parentNode;
          while (child.firstChild) parent.insertBefore(child.firstChild, child);
          child.remove();
          continue;
        }
        for (const attr of [...child.attributes]) {
          const name = attr.name.toLowerCase();
          const keep = tag === "IMG"
            ? (IMG_ATTRS.has(name) && (name !== "data-blob" || blobRefOk(attr.value)))
            : (SPAN_ATTRS.has(name) && (tag === "TD" || tag === "TH") && spanOk(attr.value));
          if (!keep) child.removeAttribute(attr.name);
        }
        // An image with no bytes behind it is not an image. Dropped rather
        // than left as a broken icon in the middle of your text - and this is
        // what removes a pasted <img src="https://..."> whose src has just
        // been stripped, because this app opens from one file with no network
        // and cannot fetch it later.
        if (tag === "IMG" && !child.getAttribute("data-blob")) child.remove();
      }
    };
    walk(doc.body);
    return doc.body.innerHTML;
  }

  /* ---------- images in a rich field ----------
     Bytes to IndexedDB, a reference in the text. See IMG_ATTRS above for why
     this is not negotiable. */
  const IMG_MAX_EDGE = 1600;      // a phone screenshot is far larger than any cell
  const IMG_MAX_BYTES = 20 * 1024 * 1024;

  /**
   * Shrink a picture to something a table cell can live with.
   *
   * A phone screenshot is several megabytes and thousands of pixels wide.
   * IndexedDB would take it, but six of them in one description makes the pane
   * crawl and every render decode them again. Anything already small enough is
   * returned untouched rather than re-encoded, so a small PNG does not become
   * a slightly worse JPEG for no reason.
   */
  function shrinkImage(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const { width: w, height: h } = img;
        const scale = Math.min(1, IMG_MAX_EDGE / Math.max(w, h));
        if (scale >= 1) { URL.revokeObjectURL(url); return resolve(file); }
        try {
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            URL.revokeObjectURL(url);
            resolve(blob || file);       // a failed encode keeps the original
          }, "image/jpeg", 0.85);
        } catch { URL.revokeObjectURL(url); resolve(file); }
      };
      // A file the browser cannot decode is stored as it came: it may still be
      // a format something else can open, and refusing it would be a guess.
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  /** Store one picture and return the markup that refers to it. */
  async function storeImage(file) {
    if (!file || !/^image\//.test(file.type || "")) return null;
    if (file.size > IMG_MAX_BYTES) return { error: `That image is ` +
      `${Math.round(file.size / 1048576)} MB. The limit is ` +
      `${IMG_MAX_BYTES / 1048576} MB.` };
    const blob = await shrinkImage(file);
    const id = window.TrackerBlobs.id("img");
    await window.TrackerBlobs.put(id, blob);
    return { html: `<img data-blob="${esc(id)}" alt="${esc(file.name || "image")}">` };
  }

  /**
   * Turn any data: image in some markup into stored bytes, BEFORE sanitizing.
   *
   * Order matters and is easy to get wrong. cleanHtml drops an <img> that
   * carries no data-blob, so a picture pasted from Word - which uses data:
   * URIs - would be deleted before anything had a chance to convert it. This
   * runs first, so what reaches the sanitizer already refers to bytes.
   *
   * Returns the markup unchanged when there is nothing to adopt, so the
   * ordinary paste path costs one regex test.
   */
  async function adoptDataUris(html) {
    const src = String(html ?? "");
    if (!/<img[^>]+src\s*=\s*["']?data:image\//i.test(src)) return src;
    let doc;
    try {
      doc = new DOMParser().parseFromString("<body>" + src + "</body>", "text/html");
    } catch { return src; }
    for (const img of [...doc.querySelectorAll("img")]) {
      const url = img.getAttribute("src") || "";
      if (!/^data:image\//i.test(url)) continue;
      try {
        const res = await fetch(url);            // a data: URL, not the network
        const blob = await res.blob();
        const stored = await storeImage(new File([blob], img.getAttribute("alt") || "image",
                                                 { type: blob.type || "image/png" }));
        if (stored && stored.html) {
          const holder = doc.createElement("div");
          holder.innerHTML = stored.html;        // inert document, not the page
          img.replaceWith(holder.firstElementChild);
        } else {
          img.remove();
        }
      } catch { img.remove(); }
    }
    return doc.body.innerHTML;
  }

  /**
   * Fill in every referenced picture, wherever it is on the page.
   *
   * src is resolved here and only here, from an id this app wrote. Object URLs
   * from the previous pass are revoked first: a pane re-rendered on every edit
   * would otherwise leak one URL per image per render for the life of the tab.
   */
  let imgUrls = [];
  function paintImages(root = document) {
    for (const u of imgUrls) URL.revokeObjectURL(u);
    imgUrls = [];
    for (const img of root.querySelectorAll("img[data-blob]")) {
      const id = img.getAttribute("data-blob");
      window.TrackerBlobs.get(id).then((blob) => {
        if (!blob || !img.isConnected) return;
        const u = URL.createObjectURL(blob);
        imgUrls.push(u);
        img.src = u;
      }).catch(() => { /* a missing blob simply shows no picture */ });
    }
  }

  /** Every picture a piece of markup refers to, for the lifecycle in store.js. */
  function imageRefs(html) {
    const out = [];
    const src = String(html ?? "");
    if (!/data-blob/i.test(src)) return out;
    try {
      const doc = new DOMParser().parseFromString("<body>" + src + "</body>", "text/html");
      for (const img of doc.querySelectorAll("img[data-blob]")) {
        const id = img.getAttribute("data-blob");
        if (id && !out.includes(id)) out.push(id);
      }
    } catch { /* unparseable markup refers to nothing */ }
    return out;
  }

  /** The words in some markup, for searching and for narrow table columns. */
  function htmlText(html) {
    const src = String(html ?? "");
    if (!src) return "";
    if (!/[<&]/.test(src)) return src;          // already plain, nothing to parse
    try {
      const doc = new DOMParser().parseFromString("<body>" + src + "</body>", "text/html");
      // A separator between block elements, or textContent runs adjacent cells
      // together: a two-column row came back as "ItemDescription", which reads
      // as one word in a flat column and lets a search for "itemdescription"
      // match a table that contains no such phrase.
      for (const el of doc.body.querySelectorAll("td,th,li,p,br,tr")) {
        el.insertAdjacentText("beforebegin", " ");
      }
      return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
    } catch { return src; }
  }

  /** Does this value carry markup, or is it the plain text an older save left? */
  const isHtml = (v) => /<(p|br|b|strong|i|em|u|s|strike|ul|ol|li|table|tr|td|th)\b/i
    .test(String(v ?? ""));

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

  /* The ceiling every attachments field falls back to. One constant, read by
     the field, by its help text and by the guard - so the number cannot be
     raised in one place and left stale in another. */
  const ATT_MAX = 20;
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
    } else if (f.type === "links") {
      // A repeating field: one row per link, each with a note of its own that
      // stays out of the way until asked for. Rows are keyed by a counter and
      // never renumbered - a removed row that renumbered the rest would leave
      // every standardize button below it pointing at the wrong box.
      const rows = (f.value || []).length ? f.value : [{ url: "", note: "" }];
      control = `<div class="linkrows" data-linkfield="${esc(f.name)}">
          ${rows.map((r, i) => linkRow(f, r, i)).join("")}
          <div class="linkadd">
            ${iconButton("add", "Add another link", `data-linkadd="${esc(f.name)}"`)}
            <span class="m">Add another link</span>
          </div>
        </div>`;
    } else if (f.type === "rich") {
      // contenteditable, not a textarea: a textarea holds characters, and what
      // this field holds is a small document. Rendered through cleanHtml even
      // on the way IN, because the value may have been written by an older
      // version or edited in storage by hand.
      control = `<div class="richfield">
          ${richToolbar(id)}
          <div class="richbox" id="${id}" contenteditable="true" spellcheck="true"
               role="textbox" aria-multiline="true" aria-label="${esc(f.label)}"
               data-rich="1"${cap} data-placeholder="${esc(f.placeholder || "")}"
               style="min-height:${(f.rows || 4) * 22}px">${
            isHtml(v) ? cleanHtml(v) : esc(v).replace(/\n/g, "<br>")}</div>
        </div>`;
    } else if (f.type === "attachments") {
      const list = (f.value || []).map(attachmentRow).join("");
      // Three parts: what is already attached, what you have just added in this
      // dialog, and the picker. The staged list is filled by wireAttachments,
      // because a file input's FileList cannot be appended to - picking twice
      // would otherwise replace the first pick rather than add to it, which is
      // exactly what a ceiling on the total needs.
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

  /* ---------- the rich text toolbar ----------
     execCommand is deprecated and has no replacement with comparable support
     and no build step. This app inlines itself into one file that opens by
     double-clicking with no server, so an editor library from a CDN would be
     a blank field the moment the file is opened offline. Hand-rolled it is,
     and the deprecation is stated in the brief rather than hidden here. */
  const RICH_COMMANDS = [
    ["bold", "B", "Bold", "b"],
    ["italic", "I", "Italic", "i"],
    ["underline", "U", "Underline", "u"],
    ["strikeThrough", "S", "Strikethrough", ""],
    ["insertUnorderedList", "\u2022", "Bulleted list", ""],
    ["insertOrderedList", "1.", "Numbered list", ""],
  ];

  const TABLE_OPS = [
    ["rowAbove", "\u2912", "Insert row above"],
    ["rowBelow", "\u2913", "Insert row below"],
    ["colLeft", "\u21e4", "Insert column left"],
    ["colRight", "\u21e5", "Insert column right"],
    ["delRow", "\u2296R", "Delete row"],
    ["delCol", "\u2296C", "Delete column"],
    ["merge", "\u29c9", "Merge selected cells"],
    ["split", "\u2ae8", "Split cell"],
    ["delTable", "\u2327", "Delete table"],
  ];

  /* ---------- table operations ----------
     execCommand has nothing for any of this, so the grid is walked by hand.

     The invariant every one of these must preserve: every row has the same
     total column count once colspan is counted. Insert a cell at an index
     without accounting for a merged cell earlier in the row and the table
     silently goes crooked - the guard asserts the invariant after each
     operation rather than eyeballing the markup. */

  /**
   * The cell the selection is in.
   *
   * Three nodes are tried, not one. A caret sitting in text gives a
   * startContainer inside the cell, but a selection that spans whole cells -
   * which is what selecting a row produces, and what a merge is made of - has
   * its startContainer on the <tr>, with no cell above it at all. Reading only
   * that node made the table tools vanish at exactly the moment you were
   * trying to merge.
   */
  function cellAt(box) {
    const sel = box.ownerDocument.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const up = (n) => {
      if (!n) return null;
      if (n.nodeType === 3) n = n.parentNode;
      return n && n.closest ? n.closest("td,th") : null;
    };
    // The row case: a range starting on a <tr> points at its cells by offset.
    const fromOffset = () => {
      let n = range.startContainer;
      if (n && n.nodeType === 1 && /^(TR|TABLE|TBODY|THEAD)$/.test(n.tagName)) {
        const kid = n.childNodes[range.startOffset] || n.firstChild;
        return up(kid) || (kid && kid.querySelector ? kid.querySelector("td,th") : null);
      }
      return null;
    };
    const cell = up(range.startContainer) || up(sel.anchorNode) ||
                 fromOffset() || up(range.commonAncestorContainer);
    return cell && box.contains(cell) ? cell : null;
  }

  /**
   * The table as a grid of cells, one entry per occupied position.
   *
   * A merged cell appears at every position it spans, so "the cell at column
   * 3" is answerable without counting colspans by hand at each call site -
   * which is exactly where off-by-ones in this kind of code live.
   */
  function gridOf(table) {
    const rows = [...table.rows];
    const grid = rows.map(() => []);
    rows.forEach((tr, r) => {
      let c = 0;
      for (const cell of tr.cells) {
        while (grid[r][c]) c++;                       // skip spots taken from above
        const cs = Math.max(1, cell.colSpan || 1);
        const rs = Math.max(1, cell.rowSpan || 1);
        for (let dr = 0; dr < rs; dr++) {
          for (let dc = 0; dc < cs; dc++) {
            if (grid[r + dr]) grid[r + dr][c + dc] = cell;
          }
        }
        c += cs;
      }
    });
    return grid;
  }

  const newCell = (doc, tag = "td") => {
    const el = doc.createElement(tag);
    el.innerHTML = "<br>";      // an empty cell you cannot click into is not a cell
    return el;
  };

  /** Where in the grid a given cell starts. */
  function posOf(grid, cell) {
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        if (grid[r][c] === cell) return { r, c };
      }
    }
    return null;
  }

  /** Every cell the current selection touches, and whether it is a rectangle. */
  function selectedCells(box, table) {
    const sel = box.ownerDocument.getSelection();
    const cells = [...table.querySelectorAll("td,th")].filter((cell) => {
      if (!sel || !sel.rangeCount) return false;
      const range = sel.getRangeAt(0);
      return range.intersectsNode ? range.intersectsNode(cell) : false;
    });
    return cells.length ? cells : [];
  }

  function tableOp(box, op) {
    const cell = cellAt(box);
    if (!cell) return "Put the caret inside a table first.";
    const table = cell.closest("table");
    const doc = box.ownerDocument;
    const grid = gridOf(table);
    const at = posOf(grid, cell);
    if (!at) return "";

    if (op === "delTable") { table.remove(); return ""; }

    if (op === "rowAbove" || op === "rowBelow") {
      const width = grid[0] ? grid[0].length : 1;
      const tr = doc.createElement("tr");
      for (let i = 0; i < width; i++) tr.appendChild(newCell(doc));
      const ref = cell.parentNode;
      // Below a merged cell means below every row it spans, not the next line.
      const span = Math.max(1, cell.rowSpan || 1);
      const target = op === "rowAbove" ? ref : table.rows[at.r + span] || null;
      ref.parentNode.insertBefore(tr, op === "rowAbove" ? ref : target);
      return "";
    }

    if (op === "colLeft" || op === "colRight") {
      const span = Math.max(1, cell.colSpan || 1);
      const index = op === "colLeft" ? at.c : at.c + span;
      const seen = new Set();
      for (let r = 0; r < grid.length; r++) {
        const occupant = grid[r][index];
        if (occupant && grid[r][index - 1] === occupant) {
          // The new column falls INSIDE a merged cell, so that cell widens
          // rather than a new one being inserted beside it.
          if (!seen.has(occupant)) { occupant.colSpan = (occupant.colSpan || 1) + 1; seen.add(occupant); }
          continue;
        }
        const tr = table.rows[r];
        if (!tr) continue;
        const before = occupant && occupant.parentNode === tr ? occupant : null;
        tr.insertBefore(newCell(doc, tr.parentNode.tagName === "THEAD" ? "th" : "td"), before);
      }
      return "";
    }

    if (op === "delRow") {
      if (table.rows.length <= 1) { table.remove(); return ""; }
      const tr = cell.parentNode;
      for (const c of [...tr.cells]) {
        if ((c.rowSpan || 1) > 1) c.rowSpan = c.rowSpan - 1;   // keep the grid square
      }
      tr.remove();
      return "";
    }

    if (op === "delCol") {
      const width = grid[0] ? grid[0].length : 0;
      if (width <= 1) { table.remove(); return ""; }
      const dropped = new Set();
      for (let r = 0; r < grid.length; r++) {
        const occupant = grid[r][at.c];
        if (!occupant || dropped.has(occupant)) continue;
        if ((occupant.colSpan || 1) > 1) occupant.colSpan = occupant.colSpan - 1;
        else occupant.remove();
        dropped.add(occupant);
      }
      return "";
    }

    if (op === "split") {
      const cs = Math.max(1, cell.colSpan || 1), rs = Math.max(1, cell.rowSpan || 1);
      if (cs === 1 && rs === 1) return "That cell is not merged.";
      cell.colSpan = 1; cell.rowSpan = 1;
      for (let dr = 0; dr < rs; dr++) {
        const tr = table.rows[at.r + dr];
        if (!tr) continue;
        for (let dc = 0; dc < cs; dc++) {
          if (dr === 0 && dc === 0) continue;
          const g = gridOf(table);
          const after = (g[at.r + dr] || [])[at.c + dc - 1] || null;
          tr.insertBefore(newCell(doc), after && after.parentNode === tr ? after.nextSibling : null);
        }
      }
      return "";
    }

    if (op === "merge") {
      const cells = selectedCells(box, table);
      if (cells.length < 2) return "Select the cells to merge first.";
      const g = gridOf(table);
      const spots = cells.map((c) => posOf(g, c)).filter(Boolean);
      const r0 = Math.min(...spots.map((s) => s.r)), r1 = Math.max(...spots.map((s, i) =>
        s.r + Math.max(1, cells[i].rowSpan || 1) - 1));
      const c0 = Math.min(...spots.map((s) => s.c)), c1 = Math.max(...spots.map((s, i) =>
        s.c + Math.max(1, cells[i].colSpan || 1) - 1));
      // A rectangle, or nothing. Merging an L shape cannot produce a valid
      // table, and quietly merging its bounding box would swallow cells the
      // person never selected.
      const inside = new Set();
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) if (g[r] && g[r][c]) inside.add(g[r][c]);
      }
      if (inside.size !== cells.length) {
        return "Select a rectangle of cells to merge.";
      }
      const keep = g[r0][c0];
      const parts = [];
      for (const c of inside) {
        if (c === keep) continue;
        const t = c.innerHTML.replace(/<br\s*\/?>/gi, "").trim();
        if (t) parts.push(t);            // nothing typed is ever silently lost
        c.remove();
      }
      if (parts.length) keep.innerHTML = [keep.innerHTML, ...parts].join(" ");
      keep.colSpan = c1 - c0 + 1;
      keep.rowSpan = r1 - r0 + 1;
      return "";
    }
    return "";
  }

  /** The n x m grid picker, the shape Word and Outlook both use. */
  function pickerGrid(id, rows = 8, cols = 8) {
    // Built as ONE balanced template rather than a string accumulated across
    // several. check_views reads these files for markup that opens more tags
    // than it closes, and a closing tag added by a later `+` reads to it - and
    // to a person skimming - as a div that was never closed.
    const cells = [];
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        cells.push(`<span class="pickcell" data-pick="${id}:${r}:${c}"></span>`);
      }
    }
    return `<div class="pickhead" data-picklabel="${id}">Insert table</div>
      <div class="pickgrid">${cells.join("")}</div>`;
  }

  function insertTable(box, rows, cols) {
    const doc = box.ownerDocument;
    let html = "<table><thead><tr>";
    for (let c = 0; c < cols; c++) html += "<th><br></th>";
    html += "</tr></thead><tbody>";
    for (let r = 1; r < rows; r++) {
      html += "<tr>";
      for (let c = 0; c < cols; c++) html += "<td><br></td>";
      html += "</tr>";
    }
    html += "</tbody></table><p><br></p>";
    box.focus();
    doc.execCommand("insertHTML", false, html);
  }

  function richToolbar(id) {
    const btn = ([cmd, face, label]) =>
      `<button type="button" class="richbtn" data-cmd="${cmd}" data-for="${id}"
               title="${esc(label)}" aria-label="${esc(label)}" aria-pressed="false"
               tabindex="-1">${face}</button>`;
    return `<div class="richbar" data-richbar="${id}">
        ${RICH_COMMANDS.slice(0, 4).map(btn).join("")}
        <span class="richsep"></span>
        ${RICH_COMMANDS.slice(4).map(btn).join("")}
        <span class="richsep"></span>
        <button type="button" class="richbtn" data-imgpick="${id}"
                title="Insert an image" aria-label="Insert an image"
                tabindex="-1">\u1f5bc</button>
        <input type="file" accept="image/*" hidden data-imginput="${id}" multiple>
        <span class="richsep"></span>
        <button type="button" class="richbtn" data-tableopen="${id}"
                title="Insert table" aria-label="Insert table" tabindex="-1">\u25a6</button>
        <span class="tabletools" data-tabletools="${id}" hidden>
          ${TABLE_OPS.map(([op, face, label]) =>
            `<button type="button" class="richbtn" data-tableop="${op}" data-for="${id}"
                     title="${esc(label)}" aria-label="${esc(label)}"
                     tabindex="-1">${face}</button>`).join("")}
        </span>
      </div>
      <div class="tablepicker" data-picker="${id}" hidden></div>`;
  }

  /**
   * One link row: the URL, a toggle for its note, and the note itself.
   *
   * The note starts open when there is one to read - a note saved last week
   * that only appears after you happen to click the icon is a note you have
   * lost. It carries the same wand as Name of task and Detailed description,
   * which needs no new code: standardize() finds its target by id.
   *
   * The URL input is deliberately not capitalised. A capitalised URL is a
   * broken URL; the note, being prose, is.
   */
  function linkRow(f, r = { url: "", note: "" }, key = 0) {
    const base = `fd_${f.name}__${key}`;
    const open = !!(r.note || "").trim();
    return `<div class="linkrow" data-linkrow="${esc(f.name)}:${key}">
        <div class="linkline">
          <input id="${base}_url" type="url" value="${esc(r.url || "")}"
                 placeholder="${esc(f.placeholder || "https://…")}" spellcheck="false">
          ${iconButton("note", "Add a note about this link",
              `data-noteopen="${base}" aria-expanded="${open}"`)}
          ${iconButton("remove", "Remove this link", `data-linkdrop="${esc(f.name)}:${key}"`)}
        </div>
        <div class="linknote" data-notebox="${base}"${open ? "" : " hidden"}>
          <div class="fieldhead">
            <label for="${base}_note">What this link is</label>
            <span class="fieldtools">
              ${iconButton("wand", "Standardize text", `data-standardize="${base}_note"`)}
            </span>
          </div>
          <textarea id="${base}_note" data-capitalize="1" rows="2"
            placeholder="What this link is for">${esc(r.note || "")}</textarea>
          <div class="fieldnote" data-note="${base}_note" hidden></div>
        </div>
      </div>`;
  }

  /**
   * Add a row, remove a row, and show or hide a note.
   *
   * Bound to the dialog rather than the document, so it dies with the dialog.
   * A row added here is wired for capitals on the spot: wireCapitals ran once
   * when the dialog opened, and a row created afterwards would silently miss
   * it - the third link's note behaving unlike the first two.
   */
  function wireLinks(box) {
    let next = 1e6;   // beyond any key the initial render used
    box.addEventListener("click", (e) => {
      const addBtn = e.target.closest("[data-linkadd]");
      if (addBtn) {
        e.preventDefault();
        const name = addBtn.dataset.linkadd;
        const host = box.querySelector(`[data-linkfield="${cssEsc(name)}"]`);
        if (!host) return;
        const holder = document.createElement("div");
        holder.innerHTML = linkRow({ name }, { url: "", note: "" }, next++);
        const row = holder.firstElementChild;
        host.insertBefore(row, host.querySelector(".linkadd"));
        wireCapitals(row);
        paintDrops(box);
        const input = row.querySelector("input");
        if (input) input.focus();
        return;
      }
      const drop = e.target.closest("[data-linkdrop]");
      if (drop) {
        e.preventDefault();
        const row = drop.closest("[data-linkrow]");
        if (row) row.remove();
        paintDrops(box);
        return;
      }
      const toggle = e.target.closest("[data-noteopen]");
      if (toggle) {
        e.preventDefault();
        const note = box.querySelector(`[data-notebox="${cssEsc(toggle.dataset.noteopen)}"]`);
        if (!note) return;
        note.hidden = !note.hidden;
        toggle.setAttribute("aria-expanded", String(!note.hidden));
        if (!note.hidden) {
          const ta = note.querySelector("textarea");
          if (ta) ta.focus();
        }
      }
    });
    paintDrops(box);
  }

  /* The last remaining row keeps no Remove button: a field emptied of every
     row would take its own "add another" affordance down with it. */
  function paintDrops(box) {
    for (const host of box.querySelectorAll("[data-linkfield]")) {
      const rows = host.querySelectorAll("[data-linkrow]");
      for (const r of rows) {
        const b = r.querySelector("[data-linkdrop]");
        if (b) b.hidden = rows.length < 2;
      }
    }
  }

  /**
   * The attachment picker: paste, choose, count, and a hard ceiling.
   *
   * Files added in this dialog are held here rather than in the file input,
   * because a FileList is read-only: choosing a second time replaces the first
   * choice instead of adding to it. Staging them makes the ceiling mean the
   * same number across every way of adding one.
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

    /* Bound on the document, not on the dialog.
     *
     * A paste event fires at whatever has focus. With the caret in a field it
     * bubbles through the dialog either way, but a paste with nothing focused
     * lands on the body and never reaches the dialog element - so Ctrl+V did
     * nothing, silently, in exactly the case where a person expects it to work
     * most. Removed again when the dialog closes, so it cannot outlive the
     * fields it stages into. */
    const onPaste = (e) => {
      const files = (e.clipboardData && e.clipboardData.files) || [];
      if (!files.length) return;
      e.preventDefault();
      add(specs[0], files);
    };
    document.addEventListener("paste", onPaste);

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

    return {
      staged,
      revoke: () => {
        document.removeEventListener("paste", onPaste);
        urls.forEach((u) => URL.revokeObjectURL(u));
      },
    };
  }

  /** Escape a value for use inside a CSS attribute selector. */
  const cssEsc = (v) => String(v).replace(/["\\]/g, "\\$&");

  /**
   * Everything a rich field needs, bound to the dialog rather than the document
   * so it dies with it.
   */
  function wireRich(box) {
    const boxes = [...box.querySelectorAll("[data-rich]")];
    if (!boxes.length) return;

    const say = (id, msg, kind = "warn") => setNote(id, msg ? esc(msg) : "", msg ? kind : "");

    /** Light the buttons that apply where the caret is, and offer table tools. */
    function paintState() {
      for (const el of boxes) {
        const bar = box.querySelector(`[data-richbar="${cssEsc(el.id)}"]`);
        if (!bar) continue;
        const active = el.contains(el.ownerDocument.activeElement) ||
                       el === el.ownerDocument.activeElement;
        for (const b of bar.querySelectorAll("[data-cmd]")) {
          let on = false;
          try { on = active && document.queryCommandState(b.dataset.cmd); } catch { on = false; }
          b.setAttribute("aria-pressed", String(!!on));
          b.classList.toggle("on", !!on);
        }
        const tools = bar.querySelector(`[data-tabletools="${cssEsc(el.id)}"]`);
        if (tools) tools.hidden = !(active && cellAt(el));
      }
    }
    box.addEventListener("keyup", paintState);
    box.addEventListener("mouseup", paintState);
    document.addEventListener("selectionchange", paintState);

    /* A paste is sanitized BEFORE it reaches the document, never after.
       Letting the browser insert Word's markup and cleaning up afterwards
       means the dangerous markup is briefly live in the page - which is
       exactly when an onerror handler fires. */
    for (const el of boxes) {
      el.addEventListener("paste", (e) => {
        const cd = e.clipboardData;
        if (!cd) return;
        const files = [...(cd.files || [])].filter((f) => /^image\//.test(f.type || ""));
        e.preventDefault();
        // A pasted screenshot arrives as a FILE, not as markup, so the files
        // are taken first. Copying an image from a web page usually puts both
        // on the clipboard; preferring the file is what stores the bytes
        // rather than a remote URL this app could never fetch offline.
        if (files.length) {
          rememberCaret(el.id);
          insertImages(el.id, files);
          return;
        }
        const html = cd.getData("text/html");
        const plain = cd.getData("text/plain");
        if (!html) {
          el.ownerDocument.execCommand("insertHTML", false,
            esc(plain).replace(/\n/g, "<br>"));
          paintState();
          return;
        }
        // Data URIs become stored bytes FIRST, then the markup is sanitized:
        // the other order deletes the picture before it can be adopted, and
        // the order after that would put base64 into localStorage.
        rememberCaret(el.id);
        adoptDataUris(html).then((adopted) => {
          restoreCaret(el.id, el);
          el.ownerDocument.execCommand("insertHTML", false, cleanHtml(adopted));
          paintImages(el);
          paintState();
        });
      });
      // Enter inside a table cell must not split the table into two.
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && cellAt(el)) {
          e.preventDefault();
          el.ownerDocument.execCommand("insertLineBreak");
        }
      });
    }

    box.addEventListener("mousedown", (e) => {
      // Keep the caret where it is: focusing a toolbar button would collapse
      // the selection the command is about to act on.
      if (e.target.closest(".richbtn, .pickcell")) e.preventDefault();
    });

    box.addEventListener("click", (e) => {
      const cmd = e.target.closest("[data-cmd]");
      if (cmd) {
        e.preventDefault();
        const el = box.querySelector("#" + cssEsc(cmd.dataset.for));
        if (!el) return;
        el.focus();
        try { el.ownerDocument.execCommand(cmd.dataset.cmd, false, null); } catch { /* ignore */ }
        paintState();
        return;
      }
      const pickImg = e.target.closest("[data-imgpick]");
      if (pickImg) {
        e.preventDefault();
        const id = pickImg.dataset.imgpick;
        // The caret is remembered before the file dialog opens: choosing a
        // file takes focus away, and without this the image would land at the
        // start of the field rather than in the cell you were standing in.
        rememberCaret(id);
        const input = box.querySelector(`[data-imginput="${cssEsc(id)}"]`);
        if (input) input.click();
        return;
      }
      const open = e.target.closest("[data-tableopen]");
      if (open) {
        e.preventDefault();
        const id = open.dataset.tableopen;
        const picker = box.querySelector(`[data-picker="${cssEsc(id)}"]`);
        if (!picker) return;
        if (picker.hidden) picker.innerHTML = pickerGrid(id);
        picker.hidden = !picker.hidden;
        return;
      }
      const pick = e.target.closest("[data-pick]");
      if (pick) {
        e.preventDefault();
        const [id, r, c] = pick.dataset.pick.split(":");
        const el = box.querySelector("#" + cssEsc(id));
        const picker = box.querySelector(`[data-picker="${cssEsc(id)}"]`);
        if (el) insertTable(el, Number(r), Number(c));
        if (picker) picker.hidden = true;
        paintState();
        return;
      }
      const op = e.target.closest("[data-tableop]");
      if (op) {
        e.preventDefault();
        const el = box.querySelector("#" + cssEsc(op.dataset.for));
        if (!el) return;
        el.focus();
        const problem = tableOp(el, op.dataset.tableop);
        say(el.id, problem);
        paintState();
      }
    });

    /* Where the caret was before focus moved to a file dialog. Without it an
       image chosen from the picker lands at the top of the field instead of
       in the cell you were working in, which is the whole point of the
       request. */
    const carets = new Map();
    function rememberCaret(id) {
      const el = box.querySelector("#" + cssEsc(id));
      const sel = el && el.ownerDocument.getSelection();
      if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
        carets.set(id, sel.getRangeAt(0).cloneRange());
      }
    }
    function restoreCaret(id, el) {
      const range = carets.get(id);
      el.focus();
      if (!range || !el.contains(range.startContainer)) return;
      const sel = el.ownerDocument.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    /** Store each picture and insert it where the caret is. */
    async function insertImages(id, files) {
      const el = box.querySelector("#" + cssEsc(id));
      if (!el) return;
      const problems = [];
      for (const file of [...files]) {
        const res = await storeImage(file);
        if (!res) continue;
        if (res.error) { problems.push(res.error); continue; }
        restoreCaret(id, el);
        el.ownerDocument.execCommand("insertHTML", false, res.html);
        rememberCaret(id);
      }
      say(id, problems.join(" "));
      paintImages(el);
      paintState();
    }

    for (const el of boxes) {
      const input = box.querySelector(`[data-imginput="${cssEsc(el.id)}"]`);
      if (!input) continue;
      input.addEventListener("change", async () => {
        await insertImages(el.id, input.files || []);
        input.value = "";      // so choosing the same file twice still registers
      });
    }

    // Hovering the picker shows the size it would insert, the way Word does.
    box.addEventListener("mouseover", (e) => {
      const cell = e.target.closest("[data-pick]");
      if (!cell) return;
      const [id, r, c] = cell.dataset.pick.split(":");
      const picker = box.querySelector(`[data-picker="${cssEsc(id)}"]`);
      const label = picker && picker.querySelector("[data-picklabel]");
      if (label) label.textContent = `Insert ${r}x${c} table`;
      for (const s of picker.querySelectorAll("[data-pick]")) {
        const [, sr, sc] = s.dataset.pick.split(":");
        s.classList.toggle("lit", Number(sr) <= Number(r) && Number(sc) <= Number(c));
      }
    });
    paintState();
  }

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
        if (el.dataset.rich) return capitaliseRich(el);
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
   * The same rule inside a rich field: only the first character, only when it
   * is a lower-case letter.
   *
   * Dropping this when the description became a rich field would have quietly
   * removed a behaviour that was already there - the guard caught exactly that
   * and it is restored rather than explained away.
   *
   * The caret is put back by offset within the same text node, which is safe
   * because only index 0 changes and the length is unaltered. Anything more
   * ambitious would fight the browser for control of the selection.
   */
  function capitaliseRich(el) {
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.nodeValue.trim()) node = walker.nextNode();
    if (!node) return;
    const v = node.nodeValue;
    const i = v.search(/\S/);
    if (i < 0) return;
    const up = v[i].toUpperCase();
    if (up === v[i]) return;
    const sel = el.ownerDocument.getSelection();
    const keep = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const sameNode = keep && keep.startContainer === node;
    const at = sameNode ? keep.startOffset : -1;
    node.nodeValue = v.slice(0, i) + up + v.slice(i + 1);
    if (sameNode) {
      try {
        const r = el.ownerDocument.createRange();
        r.setStart(node, Math.min(at, node.nodeValue.length));
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      } catch { /* the caret moved elsewhere; leave it */ }
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
    wireLinks(box);
    wireRich(box);
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
          } else if (f.type === "links") {
            // Read the rows as rendered, not the spec they started from: rows
            // are added and removed while the dialog is open. A row with no
            // URL is not a link, so it is dropped along with whatever note was
            // typed against it.
            out[f.name] = [...box.querySelectorAll(`[data-linkfield="${cssEsc(f.name)}"] [data-linkrow]`)]
              .map((row) => ({
                url: (row.querySelector('input[type="url"]') || {}).value || "",
                note: (row.querySelector("textarea") || {}).value || "",
              }))
              .map((r) => ({ url: r.url.trim(), note: r.note.trim() }))
              .filter((r) => r.url);
          } else if (f.type === "rich") {
            // innerHTML, not value - a contenteditable has no value, and a
            // field read with .value would save empty every time. Sanitized on
            // the way out as well as on the way in.
            const html = el ? cleanHtml(el.innerHTML) : "";
            // A document holding nothing but an empty paragraph is empty.
            out[f.name] = htmlText(html) || /<(table|img)/i.test(html) ? html : "";
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
        if (e.key === "Enter" && e.target.closest && e.target.closest("[data-rich]")) return;
        if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "file") {
          e.preventDefault();
          const inputs = [...box.querySelectorAll("input, textarea, select")]
            .filter((el) => !el.disabled && el.type !== "hidden");
          const i = inputs.indexOf(e.target);
          if (i > -1 && i + 1 < inputs.length) inputs[i + 1].focus();
        }
      };
      const onClick = (e) => {
        // Deliberately NOT `e.target === box`. The host covers the whole
        // screen, so a click anywhere beside the panel used to cancel it -
        // and this dialog holds typed text, rich-text updates and staged
        // attachments, all of which went with it. Only Cancel, a choice or
        // Save ends the dialog now; Escape still works, from onKey.
        if (e.target.closest('[data-fd="cancel"]')) return close(null);
        const choice = e.target.closest('[data-fd="choice"]');
        if (choice) return close({ choice: choice.dataset.value });
        if (e.target.closest('[data-fd="save"]')) return close(collect());
      };
      document.addEventListener("keydown", onKey);
      box.addEventListener("click", onClick);
    });
  }

  /**
   * A read-only dialog carrying markup this file did not build.
   *
   * formDialog escapes everything it is given, which is right for a title and
   * an intro typed by a person. A caller that has already rendered a table -
   * the task update trail, opened from the Daily activity page - needs that
   * table shown rather than printed as text, and duplicating the renderer so
   * one copy escapes and one does not is how two views of the same data start
   * to disagree. The markup is the caller's to make safe; every caller here
   * builds it with the same esc() the pane does.
   */
  function htmlDialog({ title, html, closeLabel = "Close" }) {
    const box = ensureHost();
    box.innerHTML = `<div class="box wide">
        <h3>${esc(title)}</h3>
        <div class="dialogbody">${html}</div>
        <div class="actions">
          <button class="btn primary" data-fd="cancel">${esc(closeLabel)}</button>
        </div>
      </div>`;
    box.hidden = false;
    return new Promise((resolve) => {
      const close = () => {
        box.hidden = true;
        box.innerHTML = "";
        document.removeEventListener("keydown", onKey);
        box.removeEventListener("click", onClick);
        resolve(null);
      };
      const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
      const onClick = (e) => {
        // Same rule as formDialog: the backdrop is not a close button. This
        // one loses nothing when it closes, but two dialogs that dismiss
        // differently teach the reader to trust neither.
        if (e.target.closest('[data-fd="cancel"]')) close();
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

  /**
   * A column header that also filters its own column.
   *
   * The same shape the Email Access column uses, made shared rather than
   * copied: the filter belongs to the column it acts on, because a lone
   * "All projects" select above a table gives no clue which column it filters.
   * `values` are the ones actually present in the data, so a project with no
   * tasks is never offered.
   */
  const filterHeader = (key, field, label, values, chosen, hint) =>
    `<th class="filterhead" data-sortkey="${key}" data-sortfield="${field}">
       <span class="filterlabel">${label}</span>
       ${values.length ? `<select class="colpick" data-colfilter="${key}:${field}"
         title="${hint}" aria-label="${hint}">
         <option value="">All</option>
         ${values.map((v) =>
           `<option value="${v}"${v === chosen ? " selected" : ""}>${v}</option>`).join("")}
       </select>` : ""}
     </th>`;

  /* Which value each filtering column is set to, keyed "route:field". Held in
     memory like the account filter, so a reload shows everything again. */
  const colFilters = {};
  const colFilter = (key, field) => colFilters[`${key}:${field}`] || "";
  document.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-colfilter]");
    if (!sel) return;
    colFilters[sel.dataset.colfilter] = sel.value;
    window.TrackerRender();
  });
  // The select lives inside a sortable header; clicking it must not also sort.
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-colfilter]")) e.stopPropagation();
  }, true);

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
    // A page with two lines of writing on it: "there is something written
    // about this", which is what the note toggle promises.
    note: '<path d="M6 3h9l3 3v15H6z"/><path d="M9 11h6M9 15h4"/>',
    // A clock with an arrow curving back into it: the conventional "history"
    // mark. Not the pencil, which means "change what this says", and not the
    // plus, which means "add another one of these" - this opens a trail of
    // dated entries, and at 14px the dial reads as time rather than as a
    // circle.
    update: '<path d="M3.5 12a8.5 8.5 0 1 1 2.6 6.1"/><path d="M3 19v-5h5"/><path d="M12 7.5V12l3 2"/>',
    // An arrow curving back on itself, anticlockwise: the conventional undo
    // mark. Redo is its mirror, so the pair reads as one control at a glance
    // rather than as two unrelated buttons.
    undo: '<path d="M4 9h10a5 5 0 0 1 0 10H9"/><path d="M8 5L4 9l4 4"/>',
    redo: '<path d="M20 9H10a5 5 0 0 0 0 10h5"/><path d="M16 5l4 4-4 4"/>',
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

  /* ---------- clamped prose ----------
     Long text in a table cell had no height bound at all, so one update ran
     the height of the pane and pushed every entry after it off the screen.
     Written here rather than in the table that reported it, because two
     places have prose in a cell and a third will be written eventually: one
     mechanism means the next one inherits the bound instead of repeating the
     fault.

     Two things this gets right that the obvious version does not:

       1. Whether the text overflows is MEASURED after the browser has laid it
          out, never counted from newlines. A single unbroken paragraph wraps
          to eight visual lines with not one "\n" in it, and a toggle offered
          on text that already fits is a button that does nothing.
       2. What is expanded is remembered by key. The pane re-renders on any
          status change or edit, and a toggle that only flipped a class would
          snap shut on the next render - which reads exactly like a button
          that does not work. */
  const CLAMP_LINES = 3;
  const expandedClamps = new Set();

  /**
   * A block of prose bounded to `lines`, with a control that opens it.
   *
   * The key identifies the text across renders, so it must be the id of the
   * thing the text belongs to rather than its position in a list: expanding
   * the third update and then deleting the first must not leave a different
   * entry open.
   *
   * The toggle is rendered hidden and revealed by paintClamps only where the
   * text really is too tall, so nothing here has to guess.
   */
  function clampBlock({ key, text, lines = CLAMP_LINES, html = false }) {
    const open = expandedClamps.has(key);
    // Sanitized again here, not only on save: a value written by an older
    // version, or edited in storage by hand, must not reach the page unfiltered.
    const body = html && isHtml(text) ? cleanHtml(text) : esc(text);
    return `<div class="clamp${open ? " open" : ""}" data-clamp="${esc(key)}"
                 style="--clamp-lines:${Number(lines) || CLAMP_LINES}">
        <div class="clamptext${html ? " rich" : ""}">${body}</div>
        <button type="button" class="linkish clamptoggle" data-clamptoggle="${esc(key)}"
                aria-expanded="${open}" hidden>${open ? "Show less" : "Show more"}</button>
      </div>`;
  }

  /**
   * Reveal the toggle only where the text is actually clipped.
   *
   * Measured with the block collapsed, always - an open block is temporarily
   * closed for the measurement and reopened, because an expanded block has no
   * overflow to report and would keep a toggle it no longer needs after its
   * text was edited down to one line.
   *
   * Called on the tick after a render, the same way paintShots is, because
   * scrollHeight is meaningless until the DOM exists.
   */
  function paintClamps(root = document) {
    for (const box of root.querySelectorAll("[data-clamp]")) {
      const text = box.querySelector(".clamptext");
      const btn = box.querySelector(".clamptoggle");
      if (!text || !btn) continue;
      const wasOpen = box.classList.contains("open");
      if (wasOpen) box.classList.remove("open");
      // One pixel of slack: sub-pixel line heights round scrollHeight up by a
      // fraction on text that fits exactly, which would offer a toggle that
      // reveals nothing.
      const clipped = text.scrollHeight > text.clientHeight + 1;
      if (wasOpen) box.classList.add("open");
      btn.hidden = !clipped;
      if (!clipped && wasOpen) {
        // The text no longer needs opening, so it is no longer open.
        box.classList.remove("open");
        expandedClamps.delete(box.dataset.clamp);
      }
    }
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-clamptoggle]");
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();   // the row underneath opens a task; this does not
    const box = t.closest("[data-clamp]");
    if (!box) return;
    const key = box.dataset.clamp;
    const open = !box.classList.contains("open");
    box.classList.toggle("open", open);
    if (open) expandedClamps.add(key); else expandedClamps.delete(key);
    t.textContent = open ? "Show less" : "Show more";
    t.setAttribute("aria-expanded", String(open));
  });

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
    const rich = field.dataset && field.dataset.rich;
    const text = (rich ? field.innerText : field.value).trim();
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
      // The original is kept as it really is - the markup for a rich field, so
      // Undo restores the formatting and not a flattened copy of it.
      originals.set(id, rich ? field.innerHTML : text);
      if (rich) field.innerHTML = esc(improved).replace(/\n/g, "<br>");
      else field.value = improved;
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
      if (field && originals.has(id)) {
        if (field.dataset && field.dataset.rich) field.innerHTML = originals.get(id);
        else field.value = originals.get(id);
      }
      originals.delete(id);
      return setNote(id, "");
    }
  });

  window.TrackerUI = { formDialog, confirmDialog, htmlDialog, cleanHtml, htmlText, isHtml, ATT_MAX,
                       paintImages, imageRefs, storeImage, clampBlock, paintClamps, tidyDashes, pager, pageIndex, goToPage, sortHeader, sortRows, actionId, filterHeader, colFilter,
                       iconButton, ICONS };
})();
