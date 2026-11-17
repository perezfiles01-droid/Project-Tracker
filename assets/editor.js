/* Image editor — quick markup of pictures, Word / PowerPoint style.

   Asked for on 17 Nov 2026: a sidebar page under Index for dragging pictures
   in, cropping, rotating, resizing, and laying text, lines, arrows, shapes,
   pen and highlighter over them. Several images may share one canvas.

   How it holds together:
   - The document is plain data: { w, h, bg, objects[] }. Every object except
     a line or arrow is a box { x, y, w, h, rot } rotated about its centre;
     a pen stroke keeps its points normalised to that box, so moving and
     resizing it is the same code as for a rectangle.
   - Picture BYTES never touch localStorage (house rule, check_images.mjs).
     They go to IndexedDB through TrackerBlobs and the object keeps the id.
   - Drafts live under tracker.imageEditor, a KEYS.local key: this browser
     only, not in the backup, no app-level undo or sync. The editor keeps its
     own undo stack instead, because its steps are pointer drags, not saves.
   - Crop is non-destructive: the object keeps the source rectangle it shows. */
(() => {
  const KEY = "tracker.imageEditor";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const S = () => window.TrackerStore;
  const uid = () => "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const BOX = new Set(["image", "text", "rect", "ellipse", "pen", "hl"]);
  const LINE = new Set(["line", "arrow"]);

  /* ---------------------------------------------------------------- state */
  const fresh = () => ({ id: "d" + Date.now().toString(36), name: "", w: 1280, h: 720, bg: "#ffffff", objects: [] });
  let doc = fresh();
  let opened = false;            // first visit reopens the latest draft
  let tool = "select";
  let sel = null;                // selected object id
  let drag = null;               // the pointer gesture in progress
  let crop = null;               // { id, u0, v0, u1, v1 } while cropping
  let editing = null;            // text object id being typed into
  let zoom = "fit";
  let showDrafts = false;
  let notice = "";
  let undo = [], redo = [];
  const style = {
    stroke: "#ef4444", width: 4, fill: "#ef4444", fillOn: false,
    color: "#111111", size: 32, bold: false, italic: false, tbg: "#fff59d", tbgOn: false,
    pen: "#ef4444", penW: 4, hl: "#facc15", hlW: 22,
  };
  const imgs = {};               // blob id -> { el, ok }

  const snap = () => JSON.stringify(doc);
  const find = (id) => doc.objects.find((o) => o.id === id);
  const selected = () => (sel ? find(sel) : null);

  /* --------------------------------------------------------------- drafts */
  const drafts = () => S().get(KEY, []);
  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!doc.objects.length) return;
      const list = drafts().filter((d) => d.id !== doc.id);
      if (!doc.name) doc.name = "Edit " + new Date().toLocaleString(undefined,
        { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      doc.updated = new Date().toISOString();
      list.unshift(JSON.parse(snap()));
      S().set(KEY, list);
      paintDrafts();
    }, 250);
  }
  function openDraft(id) {
    const d = drafts().find((x) => x.id === id);
    if (!d) return;
    doc = JSON.parse(JSON.stringify(d));
    sel = null; crop = null; editing = null; undo = []; redo = [];
    refresh();
  }
  async function deleteDraft(id) {
    const d = drafts().find((x) => x.id === id);
    if (!d) return;
    const yes = await window.TrackerUI.confirmDialog({
      title: "Delete this draft?", intro: `"${d.name || "Untitled"}" will be removed from this browser.`,
    });
    if (!yes) return;
    const rest = drafts().filter((x) => x.id !== id);
    S().set(KEY, rest);
    // Bytes no remaining draft (or the open canvas) still points at.
    const used = new Set([...rest, doc].flatMap((x) => x.objects).map((o) => o.blob).filter(Boolean));
    const gone = d.objects.map((o) => o.blob).filter((b) => b && !used.has(b));
    if (gone.length) window.TrackerBlobs.purge(gone);
    if (doc.id === id) { doc = fresh(); sel = null; undo = []; redo = []; }
    refresh();
  }
  function newDoc() {
    persist();
    doc = fresh(); sel = null; crop = null; editing = null; undo = []; redo = [];
    tool = "select";
    refresh();
  }

  /* -------------------------------------------------------------- history */
  function checkpoint(before) {
    if (before === snap()) return;
    undo.push(before);
    if (undo.length > 80) undo.shift();
    redo = [];
    persist();
  }
  function change(fn) { const b = snap(); fn(); checkpoint(b); refresh(); }
  function stepBack() {
    if (!undo.length) return;
    redo.push(snap()); doc = JSON.parse(undo.pop());
    if (sel && !find(sel)) sel = null;
    crop = null; persist(); refresh();
  }
  function stepForward() {
    if (!redo.length) return;
    undo.push(snap()); doc = JSON.parse(redo.pop());
    if (sel && !find(sel)) sel = null;
    persist(); refresh();
  }

  /* --------------------------------------------------------------- images */
  function img(id) {
    if (!imgs[id]) {
      const rec = imgs[id] = { el: new Image(), ok: false };
      rec.el.onload = () => { rec.ok = true; draw(); };
      window.TrackerBlobs.get(id).then((b) => { if (b) rec.el.src = URL.createObjectURL(b); });
    }
    return imgs[id];
  }
  async function addImage(file, at) {
    if (!file || !/^image\//.test(file.type)) return;
    const id = window.TrackerBlobs.id("ie");
    await window.TrackerBlobs.put(id, file);
    const el = new Image();
    el.src = URL.createObjectURL(file);
    await new Promise((ok, no) => { el.onload = ok; el.onerror = no; }).catch(() => null);
    if (!el.naturalWidth) { notice = "That file could not be read as a picture."; return refresh(); }
    imgs[id] = { el, ok: true };
    const nw = el.naturalWidth, nh = el.naturalHeight;
    const k = Math.min(1, (doc.w * 0.9) / nw, (doc.h * 0.9) / nh);
    const w = Math.round(nw * k), h = Math.round(nh * k);
    const c = at || { x: doc.w / 2, y: doc.h / 2 };
    change(() => {
      const o = { id: uid(), type: "image", blob: id, x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2),
        w, h, rot: 0, crop: { x: 0, y: 0, w: nw, h: nh } };
      doc.objects.push(o); sel = o.id; tool = "select";
    });
  }
  function pickFiles() {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*"; inp.multiple = true;
    inp.onchange = () => [...inp.files].forEach((f, i) => addImage(f, i ? { x: doc.w / 2 + i * 30, y: doc.h / 2 + i * 30 } : null));
    inp.click();
  }

  /* ------------------------------------------------------------- geometry */
  const rotP = (p, a) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
  const centre = (o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
  const toLocal = (o, p) => { const c = centre(o); return rotP({ x: p.x - c.x, y: p.y - c.y }, -(o.rot || 0)); };
  const toWorld = (o, l) => { const c = centre(o); const r = rotP(l, o.rot || 0); return { x: c.x + r.x, y: c.y + r.y }; };
  const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  const hs = () => 9 / scale;   // handle half-size, constant on screen

  function hit(o, p) {
    if (LINE.has(o.type)) {
      const dx = o.x2 - o.x1, dy = o.y2 - o.y1, L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - o.x1) * dx + (p.y - o.y1) * dy) / L));
      return Math.hypot(p.x - (o.x1 + t * dx), p.y - (o.y1 + t * dy)) < o.width / 2 + 6 / scale;
    }
    const l = toLocal(o, p), pad = 4 / scale;
    return Math.abs(l.x) <= o.w / 2 + pad && Math.abs(l.y) <= o.h / 2 + pad;
  }
  function handleAt(o, p) {
    const r = hs() * 1.4;
    if (LINE.has(o.type)) {
      if (Math.hypot(p.x - o.x1, p.y - o.y1) < r) return { kind: "end", end: 1 };
      if (Math.hypot(p.x - o.x2, p.y - o.y2) < r) return { kind: "end", end: 2 };
      return null;
    }
    const l = toLocal(o, p);
    if (Math.hypot(l.x, l.y + o.h / 2 + 28 / scale) < r) return { kind: "rotate" };
    for (const [hx, hy] of HANDLES)
      if (Math.abs(l.x - hx * o.w / 2) < r && Math.abs(l.y - hy * o.h / 2) < r) return { kind: "resize", hx, hy };
    return null;
  }

  /** Resize in the object's own frame, keeping the opposite handle fixed. */
  function resizeBox(o0, hx, hy, p, keep) {
    const l = toLocal(o0, p);
    const a = { x: -hx * o0.w / 2, y: -hy * o0.h / 2 };
    let w = hx ? Math.max(6, (l.x - a.x) * hx) : o0.w;
    let h = hy ? Math.max(6, (l.y - a.y) * hy) : o0.h;
    if (keep && hx && hy) { const k = Math.max(w / o0.w, h / o0.h); w = o0.w * k; h = o0.h * k; }
    const cl = { x: hx ? a.x + hx * w / 2 : 0, y: hy ? a.y + hy * h / 2 : 0 };
    const c = toWorld(o0, cl);
    return { x: c.x - w / 2, y: c.y - h / 2, w, h };
  }

  /* --------------------------------------------------------------- render */
  let canvas = null, ctx = null, scale = 1;

  function textFont(o) { return `${o.italic ? "italic " : ""}${o.bold ? "bold " : ""}${o.size}px system-ui, -apple-system, Segoe UI, sans-serif`; }
  function measureText(o) {
    const c = (ctx || document.createElement("canvas").getContext("2d"));
    c.save(); c.font = textFont(o);
    const lines = String(o.text || " ").split("\n");
    const w = Math.max(...lines.map((s) => c.measureText(s || " ").width));
    c.restore();
    const pad = Math.round(o.size * 0.25);
    return { w: Math.ceil(w + pad * 2), h: Math.ceil(lines.length * o.size * 1.25 + pad * 2), pad, lines };
  }
  function fitText(o) {
    const c = centre(o), m = measureText(o);
    if (o.rot) { o.x = c.x - m.w / 2; o.y = c.y - m.h / 2; }
    o.w = m.w; o.h = m.h;
  }

  function arrowHead(c, o) {
    const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1), L = Math.max(12, o.width * 3.5);
    c.beginPath();
    c.moveTo(o.x2, o.y2);
    c.lineTo(o.x2 - L * Math.cos(a - 0.45), o.y2 - L * Math.sin(a - 0.45));
    c.lineTo(o.x2 - L * Math.cos(a + 0.45), o.y2 - L * Math.sin(a + 0.45));
    c.closePath(); c.fillStyle = o.stroke; c.fill();
  }

  function paint(c, o, cropping) {
    c.save();
    if (LINE.has(o.type)) {
      c.strokeStyle = o.stroke; c.lineWidth = o.width; c.lineCap = "round";
      const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1), back = o.type === "arrow" ? Math.max(12, o.width * 3.5) * 0.8 : 0;
      c.beginPath(); c.moveTo(o.x1, o.y1);
      c.lineTo(o.x2 - back * Math.cos(a), o.y2 - back * Math.sin(a)); c.stroke();
      if (o.type === "arrow") arrowHead(c, o);
      c.restore(); return;
    }
    const cc = centre(o);
    c.translate(cc.x, cc.y); c.rotate(o.rot || 0);
    const x = -o.w / 2, y = -o.h / 2;
    if (o.type === "image") {
      const r = img(o.blob);
      if (cropping) {
        // The whole picture, faint, with the kept part drawn over it.
        const sc = { w: o.w / o.crop.w, h: o.h / o.crop.h };
        const fx = x - o.crop.x * sc.w, fy = y - o.crop.y * sc.h;
        const fw = r.el.naturalWidth * sc.w, fh = r.el.naturalHeight * sc.h;
        if (r.ok) { c.globalAlpha = 0.35; c.drawImage(r.el, fx, fy, fw, fh); c.globalAlpha = 1; }
        const k = cropping, kx = fx + k.u0 * fw, ky = fy + k.v0 * fh, kw = (k.u1 - k.u0) * fw, kh = (k.v1 - k.v0) * fh;
        if (r.ok) c.drawImage(r.el, k.u0 * r.el.naturalWidth, k.v0 * r.el.naturalHeight,
          (k.u1 - k.u0) * r.el.naturalWidth, (k.v1 - k.v0) * r.el.naturalHeight, kx, ky, kw, kh);
        c.restore(); return;
      }
      if (r.ok) c.drawImage(r.el, o.crop.x, o.crop.y, o.crop.w, o.crop.h, x, y, o.w, o.h);
      else { c.fillStyle = "#e4e4e7"; c.fillRect(x, y, o.w, o.h); }
    } else if (o.type === "rect" || o.type === "ellipse") {
      c.beginPath();
      if (o.type === "rect") c.rect(x, y, o.w, o.h);
      else c.ellipse(0, 0, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
      if (o.fill) { c.fillStyle = o.fill; c.fill(); }
      if (o.width > 0) { c.strokeStyle = o.stroke; c.lineWidth = o.width; c.stroke(); }
    } else if (o.type === "pen" || o.type === "hl") {
      c.strokeStyle = o.stroke; c.lineWidth = o.width; c.lineCap = "round"; c.lineJoin = "round";
      if (o.type === "hl") { c.globalAlpha = 0.4; c.lineCap = "square"; }
      c.beginPath();
      o.pts.forEach(([nx, ny], i) => c[i ? "lineTo" : "moveTo"](x + nx * o.w, y + ny * o.h));
      if (o.pts.length === 1) c.lineTo(x + o.pts[0][0] * o.w + 0.1, y + o.pts[0][1] * o.h);
      c.stroke();
    } else if (o.type === "text") {
      const m = measureText(o);
      if (o.bg) { c.fillStyle = o.bg; c.fillRect(x, y, o.w, o.h); }
      if (editing !== o.id) {
        c.font = textFont(o); c.fillStyle = o.color; c.textBaseline = "top";
        const k = o.h / m.h;   // a box stretched by hand still draws its text inside it
        c.scale(o.w / m.w, k);
        m.lines.forEach((s, i) => c.fillText(s, -m.w / 2 + m.pad, -m.h / 2 + m.pad + i * o.size * 1.25 + o.size * 0.1));
      }
    }
    c.restore();
  }

  function paintSelection(c, o) {
    const s = 1 / scale, h = hs();
    c.save();
    c.strokeStyle = "#ef4444"; c.fillStyle = "#fff"; c.lineWidth = 1.5 * s;
    if (LINE.has(o.type)) {
      for (const [px, py] of [[o.x1, o.y1], [o.x2, o.y2]]) {
        c.beginPath(); c.arc(px, py, h, 0, Math.PI * 2); c.fill(); c.stroke();
      }
      c.restore(); return;
    }
    const cc = centre(o);
    c.translate(cc.x, cc.y); c.rotate(o.rot || 0);
    c.setLineDash([6 * s, 4 * s]); c.strokeRect(-o.w / 2, -o.h / 2, o.w, o.h); c.setLineDash([]);
    if (crop && crop.id === o.id) { c.restore(); return; }
    c.beginPath(); c.moveTo(0, -o.h / 2); c.lineTo(0, -o.h / 2 - 28 * s); c.stroke();
    c.beginPath(); c.arc(0, -o.h / 2 - 28 * s, h * 0.9, 0, Math.PI * 2); c.fill(); c.stroke();
    for (const [hx, hy] of HANDLES) { c.fillRect(hx * o.w / 2 - h / 2 * 1.4, hy * o.h / 2 - h / 2 * 1.4, h * 1.4, h * 1.4); c.strokeRect(hx * o.w / 2 - h / 2 * 1.4, hy * o.h / 2 - h / 2 * 1.4, h * 1.4, h * 1.4); }
    c.restore();
  }

  /** The crop frame, drawn in the picture's own frame. */
  function cropFrame(o) {
    const r = img(o.blob), nw = r.el.naturalWidth || o.crop.w, nh = r.el.naturalHeight || o.crop.h;
    const sw = o.w / o.crop.w, sh = o.h / o.crop.h;
    const fx = -o.w / 2 - o.crop.x * sw, fy = -o.h / 2 - o.crop.y * sh;
    return { fx, fy, fw: nw * sw, fh: nh * sh };
  }
  function paintCrop(c, o) {
    const f = cropFrame(o), k = crop, s = 1 / scale;
    const cc = centre(o);
    c.save(); c.translate(cc.x, cc.y); c.rotate(o.rot || 0);
    const x = f.fx + k.u0 * f.fw, y = f.fy + k.v0 * f.fh, w = (k.u1 - k.u0) * f.fw, h = (k.v1 - k.v0) * f.fh;
    c.strokeStyle = "#fff"; c.lineWidth = 2 * s; c.strokeRect(x, y, w, h);
    c.strokeStyle = "#ef4444"; c.setLineDash([6 * s, 4 * s]); c.strokeRect(x, y, w, h); c.setLineDash([]);
    c.fillStyle = "#ef4444";
    const b = hs() * 1.6;
    for (const [hx, hy] of HANDLES) c.fillRect(x + (hx + 1) / 2 * w - b / 2, y + (hy + 1) / 2 * h - b / 2, b, b);
    c.restore();
  }

  function render(c, withUi) {
    c.fillStyle = doc.bg; c.fillRect(0, 0, doc.w, doc.h);
    for (const o of doc.objects) paint(c, o, withUi && crop && crop.id === o.id ? crop : null);
    if (!withUi) return;
    const o = selected();
    if (o) paintSelection(c, o);
    if (crop) { const co = find(crop.id); if (co) paintCrop(c, co); }
    if (drag && drag.kind === "marquee") {}
  }

  function draw() {
    if (!canvas || !canvas.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.clearRect(0, 0, doc.w, doc.h);
    render(ctx, true);
    placeTextBox();
  }

  function sizeCanvas() {
    if (!canvas) return;
    const wrap = canvas.parentElement;
    if (zoom === "fit") {
      const aw = Math.max(200, wrap.clientWidth - 24), ah = Math.max(240, window.innerHeight - wrap.getBoundingClientRect().top - 60);
      scale = Math.min(1, aw / doc.w, ah / doc.h);
    } else scale = Number(zoom);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(doc.w * scale * dpr); canvas.height = Math.round(doc.h * scale * dpr);
    canvas.style.width = Math.round(doc.w * scale) + "px"; canvas.style.height = Math.round(doc.h * scale) + "px";
    draw();
  }

  /* ----------------------------------------------------------- text entry */
  function placeTextBox() {
    const ta = document.getElementById("ieText");
    const o = editing && find(editing);
    if (!ta) return;
    if (!o) { ta.hidden = true; return; }
    ta.hidden = false;
    ta.style.left = canvas.offsetLeft + o.x * scale + "px";
    ta.style.top = canvas.offsetTop + o.y * scale + "px";
    ta.style.width = Math.max(40, o.w * scale + 20) + "px";
    ta.style.height = o.h * scale + "px";
    ta.style.font = textFont({ ...o, size: o.size * scale });
    ta.style.color = o.color;
    ta.style.padding = measureText(o).pad * scale + "px";
    ta.style.lineHeight = "1.25";
    ta.style.transform = o.rot ? `rotate(${o.rot}rad)` : "";
  }
  function startEdit(o) {
    editing = o.id; sel = o.id;
    draw();
    const ta = document.getElementById("ieText");
    if (!ta) return;
    ta.value = o.text;
    ta.dataset.before = editBefore || snap();
    placeTextBox();
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
  }
  let editBefore = null;
  function endEdit() {
    const o = editing && find(editing);
    const ta = document.getElementById("ieText");
    editing = null;
    if (!o) return;
    const before = (ta && ta.dataset.before) || editBefore || snap();
    editBefore = null;
    if (!String(o.text).trim()) { doc.objects = doc.objects.filter((x) => x !== o); if (sel === o.id) sel = null; }
    checkpoint(before);
    if (ta) ta.hidden = true;
    refresh();
  }

  /* -------------------------------------------------------------- pointer */
  const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }; };

  function cropHandle(o, p) {
    const f = cropFrame(o), k = crop, l = toLocal(o, p), r = hs() * 1.6;
    const x = f.fx + k.u0 * f.fw, y = f.fy + k.v0 * f.fh, w = (k.u1 - k.u0) * f.fw, h = (k.v1 - k.v0) * f.fh;
    for (const [hx, hy] of HANDLES)
      if (Math.abs(l.x - (x + (hx + 1) / 2 * w)) < r && Math.abs(l.y - (y + (hy + 1) / 2 * h)) < r) return { hx, hy };
    if (l.x > x && l.x < x + w && l.y > y && l.y < y + h) return { move: true };
    return null;
  }

  function down(e) {
    if (e.button !== 0) return;
    if (editing) endEdit();
    const p = pt(e);
    canvas.setPointerCapture(e.pointerId);
    const before = snap();
    if (crop) {
      const o = find(crop.id), h = o && cropHandle(o, p);
      if (h) drag = { kind: "crop", h, p0: toLocal(o, p), k0: { ...crop }, f: cropFrame(o), before };
      return;
    }
    if (tool === "select") {
      const s = selected();
      const h = s && handleAt(s, p);
      if (h) { drag = { ...h, o0: JSON.parse(JSON.stringify(s)), p0: p, before }; return; }
      const o = [...doc.objects].reverse().find((x) => hit(x, p));
      sel = o ? o.id : null;
      if (o && e.detail === 2 && o.type === "text") { editBefore = before; startEdit(o); return refreshChrome(); }
      if (o) drag = { kind: "move", o0: JSON.parse(JSON.stringify(o)), p0: p, before };
      refreshChrome(); draw();
      return;
    }
    if (tool === "text") {
      const o = { id: uid(), type: "text", text: "", x: p.x, y: p.y - style.size * 0.6, w: 10, h: 10, rot: 0,
        size: style.size, color: style.color, bold: style.bold, italic: style.italic, bg: style.tbgOn ? style.tbg : null };
      fitText(o);
      doc.objects.push(o);
      editBefore = before;
      tool = "select";
      startEdit(o); refreshChrome();
      return;
    }
    if (tool === "pen" || tool === "hl") {
      const o = { id: uid(), type: tool, raw: [[p.x, p.y]], pts: [], x: p.x, y: p.y, w: 1, h: 1, rot: 0,
        stroke: tool === "pen" ? style.pen : style.hl, width: tool === "pen" ? style.penW : style.hlW };
      doc.objects.push(o);
      drag = { kind: "draw", id: o.id, before };
      return;
    }
    // line, arrow, rect, ellipse
    const o = LINE.has(tool)
      ? { id: uid(), type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, stroke: style.stroke, width: style.width }
      : { id: uid(), type: tool, x: p.x, y: p.y, w: 1, h: 1, rot: 0, stroke: style.stroke, width: style.width, fill: style.fillOn ? style.fill : null };
    doc.objects.push(o);
    sel = o.id;
    drag = { kind: "create", id: o.id, p0: p, before };
  }

  function move(e) {
    if (!drag) {
      if (!canvas) return;
      const p = pt(e), s = selected();
      const h = tool === "select" && !crop && s && handleAt(s, p);
      canvas.style.cursor = tool !== "select" ? "crosshair"
        : h ? (h.kind === "rotate" ? "grab" : h.kind === "end" ? "move" : "nwse-resize")
        : doc.objects.some((o) => hit(o, p)) ? "move" : "default";
      return;
    }
    const p = pt(e);
    if (drag.kind === "crop") {
      const o = find(crop.id), l = toLocal(o, p), f = drag.f, k0 = drag.k0;
      const u = (l.x - f.fx) / f.fw, v = (l.y - f.fy) / f.fh, cl = (n) => Math.max(0, Math.min(1, n));
      const MIN = 0.02;
      if (drag.h.move) {
        const du = (l.x - drag.p0.x) / f.fw, dv = (l.y - drag.p0.y) / f.fh;
        const w = k0.u1 - k0.u0, h = k0.v1 - k0.v0;
        const u0 = Math.max(0, Math.min(1 - w, k0.u0 + du)), v0 = Math.max(0, Math.min(1 - h, k0.v0 + dv));
        Object.assign(crop, { u0, v0, u1: u0 + w, v1: v0 + h });
      } else {
        if (drag.h.hx < 0) crop.u0 = Math.min(cl(u), k0.u1 - MIN);
        if (drag.h.hx > 0) crop.u1 = Math.max(cl(u), k0.u0 + MIN);
        if (drag.h.hy < 0) crop.v0 = Math.min(cl(v), k0.v1 - MIN);
        if (drag.h.hy > 0) crop.v1 = Math.max(cl(v), k0.v0 + MIN);
      }
      return draw();
    }
    if (drag.kind === "draw") {
      const o = find(drag.id); o.raw.push([p.x, p.y]); normalisePen(o); return draw();
    }
    if (drag.kind === "create") {
      const o = find(drag.id), a = drag.p0;
      let q = p;
      if (e.shiftKey && LINE.has(o.type)) {  // snap to 45 degrees
        const ang = Math.round(Math.atan2(p.y - a.y, p.x - a.x) / (Math.PI / 4)) * (Math.PI / 4), d = Math.hypot(p.x - a.x, p.y - a.y);
        q = { x: a.x + d * Math.cos(ang), y: a.y + d * Math.sin(ang) };
      }
      if (LINE.has(o.type)) { o.x2 = q.x; o.y2 = q.y; }
      else {
        let w = Math.abs(p.x - a.x), h = Math.abs(p.y - a.y);
        if (e.shiftKey) w = h = Math.max(w, h);
        o.x = p.x < a.x ? a.x - w : a.x; o.y = p.y < a.y ? a.y - h : a.y; o.w = w; o.h = h;
      }
      return draw();
    }
    const s = selected(); if (!s) return;
    const o0 = drag.o0, dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
    if (drag.kind === "move") {
      if (LINE.has(s.type)) Object.assign(s, { x1: o0.x1 + dx, y1: o0.y1 + dy, x2: o0.x2 + dx, y2: o0.y2 + dy });
      else { s.x = o0.x + dx; s.y = o0.y + dy; }
    } else if (drag.kind === "end") {
      s["x" + drag.end] = p.x; s["y" + drag.end] = p.y;
    } else if (drag.kind === "rotate") {
      const c = centre(o0);
      let a = Math.atan2(p.y - c.y, p.x - c.x) + Math.PI / 2;
      if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      s.rot = a;
    } else if (drag.kind === "resize") {
      const keep = e.shiftKey || (s.type === "image" && drag.hx && drag.hy) || s.type === "text";
      Object.assign(s, resizeBox(o0, drag.hx, drag.hy, p, keep));
      if (s.type === "text") {
        s.size = Math.max(6, Math.round(o0.size * s.h / o0.h));
      }
    }
    draw();
  }

  function normalisePen(o) {
    const xs = o.raw.map((q) => q[0]), ys = o.raw.map((q) => q[1]);
    const pad = o.width / 2;
    const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
    const w = Math.max(1, Math.max(...xs) + pad - x0), h = Math.max(1, Math.max(...ys) + pad - y0);
    Object.assign(o, { x: x0, y: y0, w, h, pts: o.raw.map(([x, y]) => [(x - x0) / w, (y - y0) / h]) });
  }

  function up() {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === "draw") {
      const o = find(d.id); normalisePen(o); delete o.raw;
      o.pts = o.pts.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
    }
    if (d.kind === "create") {
      const o = find(d.id);
      if (LINE.has(o.type)) {
        if (Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 4) Object.assign(o, { x2: o.x1 + 160, y2: o.y1 });
      } else if (o.w < 4 && o.h < 4) Object.assign(o, { x: o.x - 80, y: o.y - 50, w: 160, h: 100 });
      tool = "select";
    }
    if (d.kind === "crop") return;
    checkpoint(d.before);
    refreshChrome(); draw();
  }

  /* ----------------------------------------------------------- operations */
  function rotate90() {
    const o = selected();
    if (!o || LINE.has(o.type)) return;
    change(() => { o.rot = ((o.rot || 0) + Math.PI / 2) % (Math.PI * 2); });
  }
  function startCrop() {
    const o = selected();
    if (!o || o.type !== "image") return;
    const r = img(o.blob);
    const nw = r.el.naturalWidth || o.crop.w, nh = r.el.naturalHeight || o.crop.h;
    crop = { id: o.id, u0: o.crop.x / nw, v0: o.crop.y / nh, u1: (o.crop.x + o.crop.w) / nw, v1: (o.crop.y + o.crop.h) / nh, before: snap() };
    tool = "select";
    refresh();
  }
  function applyCrop() {
    const o = crop && find(crop.id);
    if (!o) { crop = null; return refresh(); }
    const k = crop, f = cropFrame(o), r = img(o.blob);
    const nw = r.el.naturalWidth || o.crop.w, nh = r.el.naturalHeight || o.crop.h;
    const before = crop.before;
    // New box in the picture's frame, then back to the canvas.
    const lx = f.fx + k.u0 * f.fw, ly = f.fy + k.v0 * f.fh, w = (k.u1 - k.u0) * f.fw, h = (k.v1 - k.v0) * f.fh;
    const c = toWorld(o, { x: lx + w / 2, y: ly + h / 2 });
    Object.assign(o, { x: c.x - w / 2, y: c.y - h / 2, w, h,
      crop: { x: k.u0 * nw, y: k.v0 * nh, w: (k.u1 - k.u0) * nw, h: (k.v1 - k.v0) * nh } });
    crop = null;
    checkpoint(before);
    refresh();
  }
  function canvasToImage() {
    const o = selected();
    if (!o || o.type !== "image") return;
    change(() => {
      const turned = Math.round((o.rot || 0) / (Math.PI / 2)) % 2 !== 0;
      const w = Math.round(o.crop.w), h = Math.round(o.crop.h);
      doc.w = turned ? h : w; doc.h = turned ? w : h;
      o.w = w; o.h = h; o.x = (doc.w - w) / 2; o.y = (doc.h - h) / 2;
    });
  }
  function arrange(dir) {
    const o = selected(); if (!o) return;
    change(() => {
      const i = doc.objects.indexOf(o);
      doc.objects.splice(i, 1);
      const j = dir === "front" ? doc.objects.length : dir === "back" ? 0 : dir === "fwd" ? Math.min(doc.objects.length, i + 1) : Math.max(0, i - 1);
      doc.objects.splice(j, 0, o);
    });
  }
  function duplicate() {
    const o = selected(); if (!o) return;
    change(() => {
      const c = JSON.parse(JSON.stringify(o)); c.id = uid();
      if (LINE.has(c.type)) { c.x1 += 20; c.y1 += 20; c.x2 += 20; c.y2 += 20; } else { c.x += 20; c.y += 20; }
      doc.objects.push(c); sel = c.id;
    });
  }
  function remove() {
    const o = selected(); if (!o) return;
    change(() => { doc.objects = doc.objects.filter((x) => x !== o); sel = null; });
  }
  function nudge(dx, dy) {
    const o = selected(); if (!o) return;
    change(() => {
      if (LINE.has(o.type)) { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; } else { o.x += dx; o.y += dy; }
    });
  }

  function exportBlob() {
    const c = document.createElement("canvas");
    c.width = doc.w; c.height = doc.h;
    const was = editing; editing = null;
    render(c.getContext("2d"), false);
    editing = was;
    return new Promise((ok) => c.toBlob(ok, "image/png"));
  }
  const fileName = () => (doc.name || "image").replace(/[\\/:*?"<>|]+/g, "-").trim() + ".png";
  async function download() {
    if (editing) endEdit();
    window.TrackerUI.saveBlob(await exportBlob(), fileName());
  }
  async function copy() {
    if (editing) endEdit();
    try {
      // The promise form keeps the user gesture alive in Safari.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": exportBlob() })]);
      notice = "Copied. Paste it into Teams, email or Word.";
    } catch (err) {
      notice = "This browser would not copy a picture (" + (err && err.message || "not allowed") + "). Use Download PNG instead.";
    }
    refreshChrome();
    setTimeout(() => { notice = ""; refreshChrome(); }, 4000);
  }

  /* ---------------------------------------------------------------- views */
  const ICON = {
    select: '<path d="M5 3l14 8-6 1.5L10 19z"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/>',
    crop: '<path d="M6 2v16h16M2 6h16v16"/>',
    rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 3v5h-5"/>',
    text: '<path d="M5 5h14M12 5v14M9 19h6"/>',
    line: '<path d="M5 19L19 5"/>',
    arrow: '<path d="M5 19L19 5M10 5h9v9"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6.5"/>',
    pen: '<path d="M4 20l1-5L16 4l4 4L9 19zM14 6l4 4"/>',
    hl: '<path d="M9 15l-4 5h6l2-2M8 13l6-9 6 6-9 6z"/>',
    undo: '<path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"/>',
    redo: '<path d="M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
  const toolBtn = (k, label) =>
    `<button class="ie-b" data-ie-tool="${k}" aria-pressed="${tool === k && !crop}" title="${label}">${svg(k)}<span>${label}</span></button>`;
  const actBtn = (act, icon, label, off) =>
    `<button class="ie-b" data-ie-act="${act}" title="${label}"${off ? " disabled" : ""}>${svg(icon)}<span>${label}</span></button>`;

  function ribbon() {
    const o = selected();
    const box = o && !LINE.has(o.type);
    return `<div class="ie-grp">${toolBtn("select", "Select")}</div>
      <div class="ie-grp"><span class="ie-cap">Picture</span>${actBtn("add", "image", "Add image")}
        ${actBtn("crop", "crop", "Crop", !(o && o.type === "image"))}${actBtn("rotate", "rotate", "Rotate", !box)}</div>
      <div class="ie-grp"><span class="ie-cap">Insert</span>${toolBtn("text", "Text")}${toolBtn("line", "Line")}${toolBtn("arrow", "Arrow")}
        ${toolBtn("rect", "Rectangle")}${toolBtn("ellipse", "Ellipse")}</div>
      <div class="ie-grp"><span class="ie-cap">Draw</span>${toolBtn("pen", "Pen")}${toolBtn("hl", "Highlighter")}</div>
      <div class="ie-grp">${actBtn("undo", "undo", "Undo", !undo.length)}${actBtn("redo", "redo", "Redo", !redo.length)}</div>`;
  }

  const color = (prop, v, label) =>
    `<label class="ie-f">${label}<input type="color" data-ie-prop="${prop}" value="${esc(v)}"></label>`;
  const num = (prop, v, label, min, max) =>
    `<label class="ie-f">${label}<input type="number" data-ie-prop="${prop}" value="${Math.round(v)}" min="${min}" max="${max}"></label>`;
  const check = (prop, on, label) =>
    `<label class="ie-f"><input type="checkbox" data-ie-prop="${prop}"${on ? " checked" : ""}>${label}</label>`;
  const small = (act, label, off) => `<button class="btn sm" data-ie-act="${act}"${off ? " disabled" : ""}>${label}</button>`;

  function formatBar() {
    if (crop) return `<span class="ie-hint">Drag the frame or its handles to choose what to keep.</span>
      ${small("crop-apply", "Apply crop")} ${small("crop-cancel", "Cancel")}`;
    const o = selected();
    const kind = o ? o.type : tool;
    let f = "";
    if (kind === "text") {
      const t = o || { size: style.size, color: style.color, bold: style.bold, italic: style.italic, bg: style.tbgOn ? style.tbg : null };
      f = num("size", t.size, "Size", 6, 400) + color("color", t.color, "Color") +
        `<button class="ie-tog${t.bold ? " on" : ""}" data-ie-prop="bold" title="Bold"><b>B</b></button>` +
        `<button class="ie-tog${t.italic ? " on" : ""}" data-ie-prop="italic" title="Italic"><i>I</i></button>` +
        check("bgOn", !!t.bg, "Background") + color("bg", t.bg || style.tbg, "");
    } else if (kind === "pen" || kind === "hl") {
      const t = o || { stroke: kind === "pen" ? style.pen : style.hl, width: kind === "pen" ? style.penW : style.hlW };
      f = color("stroke", t.stroke, "Color") + num("width", t.width, "Thickness", 1, 80);
    } else if (LINE.has(kind) || kind === "rect" || kind === "ellipse") {
      const t = o || { stroke: style.stroke, width: style.width, fill: style.fillOn ? style.fill : null };
      f = color("stroke", t.stroke, "Line") + num("width", t.width, "Thickness", 0, 60);
      if (!LINE.has(kind)) f += check("fillOn", !!t.fill, "Fill") + color("fill", t.fill || style.fill, "");
    } else if (kind === "image") {
      f = small("crop", "Crop") + small("rotate", "Rotate 90°") + small("fitcanvas", "Canvas = this image") +
        small("uncrop", "Reset crop", o.crop.x === 0 && o.crop.y === 0 && Math.round(o.crop.w) === (img(o.blob).el.naturalWidth || o.crop.w) && Math.round(o.crop.h) === (img(o.blob).el.naturalHeight || o.crop.h));
    } else {
      f = `<span class="ie-cap2">Canvas</span>` + num("cw", doc.w, "W", 50, 6000) + num("ch", doc.h, "H", 50, 6000) + color("cbg", doc.bg, "Background");
    }
    if (o) f += `<span class="ie-sep"></span>` + small("front", "Bring to front") + small("back", "Send to back") +
      small("dup", "Duplicate") + small("del", "Delete");
    return f;
  }

  function draftsHtml(q) {
    const list = drafts().filter((d) => !q || (d.name || "").toLowerCase().includes(q));
    if (!list.length) return `<div class="ie-none">${q ? "No draft matches that search." : "No drafts yet. Your edits save here on their own."}</div>`;
    return list.map((d) => `<div class="ie-draft${d.id === doc.id ? " cur" : ""}">
        <button class="ie-dopen" data-ie-open="${esc(d.id)}"><b>${esc(d.name || "Untitled")}</b>
          <small>${esc(new Date(d.updated || Date.now()).toLocaleString())} · ${d.objects.length} item${d.objects.length === 1 ? "" : "s"}</small></button>
        <button class="btn sm" data-ie-drop="${esc(d.id)}">Delete</button></div>`).join("");
  }

  let lastQ = "";
  function view(q) {
    lastQ = q || "";
    if (!opened) { opened = true; const d = drafts()[0]; if (d) doc = JSON.parse(JSON.stringify(d)); }
    if (q) showDrafts = true;
    return `<div id="ie">
      <div class="ie-head">
        <h2 class="page">Image editor</h2>
        <input class="ie-name" data-ie-name value="${esc(doc.name)}" placeholder="Untitled" aria-label="Draft name">
        <div class="ie-actions">
          <button class="btn sm" data-ie-act="drafts" aria-pressed="${showDrafts}">Drafts (${drafts().length})</button>
          <button class="btn sm" data-ie-act="new">New</button>
          <button class="btn sm" data-ie-act="copy">Copy</button>
          <button class="btn sm primary" data-ie-act="download">Download PNG</button>
        </div>
      </div>
      <div class="ie-drafts"${showDrafts ? "" : " hidden"}>
        <div class="pagetools">${window.TrackerLinks.searchBox("editor", "Search drafts…")}
          <small class="ie-local">Drafts are kept in this browser only. They are not in the backup.</small></div>
        <div class="ie-dlist" id="ieDrafts">${draftsHtml(lastQ)}</div>
      </div>
      <div class="ie-ribbon" id="ieRibbon">${ribbon()}</div>
      <div class="ie-format" id="ieFormat">${formatBar()}</div>
      <div class="ie-notice" id="ieNotice"${notice ? "" : " hidden"}>${esc(notice)}</div>
      <div class="ie-stage" id="ieStage">
        <canvas id="ieCanvas"></canvas>
        <textarea id="ieText" class="ie-text" hidden spellcheck="false"></textarea>
        <div class="ie-drop" id="ieDrop"${doc.objects.length ? " hidden" : ""}>
          <b>Drop images here</b><span>paste with Ctrl+V, or use Add image</span></div>
      </div>
      <div class="ie-foot">
        <label class="ie-f">Zoom <select data-ie-zoom>
          ${["fit", "0.5", "0.75", "1", "1.5", "2"].map((z) => `<option value="${z}"${String(zoom) === z ? " selected" : ""}>${z === "fit" ? "Fit" : Number(z) * 100 + "%"}</option>`).join("")}
        </select></label>
        <span>${doc.w} × ${doc.h}px</span>
        <span class="ie-keys">Shift keeps proportions · arrows nudge · Delete removes · Ctrl+Z / Ctrl+Y · Ctrl+D duplicates</span>
      </div>
    </div>`;
  }

  /** Called by app.js after every render of this route: the canvas is new. */
  function mount() {
    const c = document.getElementById("ieCanvas");
    if (!c) return;
    canvas = c; ctx = c.getContext("2d");
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    const stage = document.getElementById("ieStage");
    stage.addEventListener("dragover", (e) => { e.preventDefault(); stage.classList.add("over"); });
    stage.addEventListener("dragleave", () => stage.classList.remove("over"));
    stage.addEventListener("drop", (e) => {
      e.preventDefault(); stage.classList.remove("over");
      const at = pt(e);
      [...(e.dataTransfer.files || [])].forEach((f, i) => addImage(f, { x: at.x + i * 30, y: at.y + i * 30 }));
    });
    const ta = document.getElementById("ieText");
    ta.addEventListener("input", () => { const o = find(editing); if (o) { o.text = ta.value; fitText(o); draw(); } });
    ta.addEventListener("blur", () => { if (editing) endEdit(); });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); ta.blur(); }
      e.stopPropagation();
    });
    sizeCanvas();
  }

  /** Repaint the parts that change while working, leaving the canvas alone. */
  function refreshChrome() {
    const r = document.getElementById("ieRibbon"); if (r) r.innerHTML = ribbon();
    const f = document.getElementById("ieFormat"); if (f) f.innerHTML = formatBar();
    const n = document.getElementById("ieNotice"); if (n) { n.hidden = !notice; n.textContent = notice; }
    const d = document.getElementById("ieDrop"); if (d) d.hidden = doc.objects.length > 0;
    const nm = document.querySelector("[data-ie-name]"); if (nm && document.activeElement !== nm) nm.value = doc.name;
  }
  function paintDrafts() {
    const l = document.getElementById("ieDrafts"); if (l) l.innerHTML = draftsHtml(lastQ);
    const b = document.querySelector('[data-ie-act="drafts"]'); if (b) b.textContent = `Drafts (${drafts().length})`;
  }
  function refresh() {
    if (!document.getElementById("ie")) return;
    const sizeChanged = canvas && (canvas.style.width !== Math.round(doc.w * scale) + "px" || canvas.style.height !== Math.round(doc.h * scale) + "px");
    refreshChrome(); paintDrafts();
    const foot = document.querySelector(".ie-foot span"); if (foot) foot.textContent = `${doc.w} × ${doc.h}px`;
    if (sizeChanged || zoom === "fit") sizeCanvas(); else draw();
  }

  /* ---------------------------------------------------------------- events */
  const here = () => !!document.getElementById("ie");
  const typing = (el) => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

  document.addEventListener("click", (e) => {
    if (!here()) return;
    const t = e.target.closest("[data-ie-tool]");
    if (t) {
      if (editing) endEdit();
      if (crop) crop = null;
      tool = t.dataset.ieTool;
      if (tool !== "select") sel = null;
      return refresh();
    }
    const op = e.target.closest("[data-ie-open]");
    if (op) return openDraft(op.dataset.ieOpen);
    const dr = e.target.closest("[data-ie-drop]");
    if (dr) return deleteDraft(dr.dataset.ieDrop);
    const tg = e.target.closest("button[data-ie-prop]");
    if (tg) return setProp(tg.dataset.ieProp, null);
    const a = e.target.closest("[data-ie-act]");
    if (!a || a.disabled) return;
    const act = a.dataset.ieAct;
    ({
      add: pickFiles, crop: startCrop, rotate: rotate90, undo: stepBack, redo: stepForward,
      "crop-apply": applyCrop, "crop-cancel": () => { crop = null; refresh(); },
      fitcanvas: canvasToImage, front: () => arrange("front"), back: () => arrange("back"),
      dup: duplicate, del: remove, download, copy, new: newDoc,
      uncrop: () => { const o = selected(); const r = img(o.blob); change(() => {
        const nw = r.el.naturalWidth, nh = r.el.naturalHeight, k = o.w / o.crop.w;
        o.crop = { x: 0, y: 0, w: nw, h: nh }; o.w = nw * k; o.h = nh * k; }); },
      drafts: () => { showDrafts = !showDrafts; const d = document.querySelector(".ie-drafts"); if (d) d.hidden = !showDrafts;
        a.setAttribute("aria-pressed", showDrafts); sizeCanvas(); },
    }[act] || (() => {}))();
  });

  function setProp(prop, value) {
    const o = selected();
    const kind = o ? o.type : tool;
    if (prop === "cw" || prop === "ch") {
      const n = Math.max(50, Math.min(6000, Math.round(Number(value) || 0)));
      return change(() => { doc[prop === "cw" ? "w" : "h"] = n; });
    }
    if (prop === "cbg") return change(() => { doc.bg = value; });
    const apply = (t) => {
      if (prop === "bold" || prop === "italic") t[prop] = !t[prop];
      else if (prop === "size" || prop === "width") t[prop] = Math.max(prop === "width" ? 0 : 6, Number(value) || 0);
      else if (prop === "fillOn") t.fill = value ? (t.fillC || style.fill) : null;
      else if (prop === "fill") t.fill = value;
      else if (prop === "bgOn") t.bg = value ? style.tbg : null;
      else if (prop === "bg") t.bg = value;
      else t[prop] = value;
    };
    // The default for the next one drawn follows what you last chose.
    if (kind === "text") {
      if (prop === "bold" || prop === "italic") style[prop] = o ? !o[prop] : !style[prop];
      else if (prop === "size") style.size = Number(value) || style.size;
      else if (prop === "color") style.color = value;
      else if (prop === "bgOn") style.tbgOn = !!value;
      else if (prop === "bg") style.tbg = value;
    } else if (kind === "pen" || kind === "hl") {
      if (prop === "stroke") style[kind] = value;
      if (prop === "width") style[kind === "pen" ? "penW" : "hlW"] = Number(value) || 1;
    } else {
      if (prop === "stroke") style.stroke = value;
      if (prop === "width") style.width = Number(value) || 0;
      if (prop === "fill") style.fill = value;
      if (prop === "fillOn") style.fillOn = !!value;
    }
    if (!o) return refreshChrome();
    change(() => { apply(o); if (o.type === "text") fitText(o); });
  }

  document.addEventListener("change", (e) => {
    if (!here()) return;
    const p = e.target.closest("[data-ie-prop]");
    if (p && p.tagName === "INPUT") return setProp(p.dataset.ieProp, p.type === "checkbox" ? p.checked : p.value);
    const z = e.target.closest("[data-ie-zoom]");
    if (z) { zoom = z.value; return sizeCanvas(); }
    const n = e.target.closest("[data-ie-name]");
    if (n) { doc.name = n.value.trim(); persist(); }
  });

  document.addEventListener("paste", (e) => {
    if (!here() || typing(document.activeElement)) return;
    const files = [...(e.clipboardData && e.clipboardData.files || [])].filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    e.preventDefault();
    files.forEach((f, i) => addImage(f, i ? { x: doc.w / 2 + i * 30, y: doc.h / 2 + i * 30 } : null));
  });

  // Capture phase, so the app's own shortcuts never see a key meant for the canvas.
  document.addEventListener("keydown", (e) => {
    if (!here() || typing(document.activeElement) || document.querySelector(".modal:not([hidden])")) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && k === "z" && !e.shiftKey) { stop(); return stepBack(); }
    if (mod && (k === "y" || (k === "z" && e.shiftKey))) { stop(); return stepForward(); }
    if (mod && k === "d") { stop(); return duplicate(); }
    if (crop && k === "enter") { stop(); return applyCrop(); }
    if (k === "escape") { if (crop) crop = null; else { sel = null; tool = "select"; } return refresh(); }
    if ((k === "delete" || k === "backspace") && sel) { stop(); return remove(); }
    const step = e.shiftKey ? 10 : 1;
    const dir = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k];
    if (dir && sel) { stop(); return nudge(...dir); }
    if (k === "enter" && sel) { const o = selected(); if (o.type === "text") { stop(); editBefore = snap(); startEdit(o); } }
  }, true);

  window.addEventListener("resize", () => { if (here() && zoom === "fit") sizeCanvas(); });

  window.TrackerEditor = {
    view, mount,
    /* For the browser check: read the document, and drive it without a mouse. */
    _doc: () => doc, _addImage: addImage, _exportBlob: exportBlob,
  };
})();
