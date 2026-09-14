/* The Image Generator: a prompt, a picture, and a gallery of what you made.

   Three things shape this module.

   1. THE BYTES ARE NEVER TEXT. A generated picture is a Blob from the moment
      it exists (TrackerAI.b64ToBlob decodes straight to bytes) and the only
      place it is ever written is IndexedDB, through TrackerBlobs. The record
      in localStorage keeps the prompt, the engine, the model and the blob id -
      never the picture. localStorage holds about 5 MB for the whole origin and
      one generated image would eat most of it, taking the task list and the
      pinned links down with it. check_images.mjs asserts across the whole app
      that no data: URI reaches localStorage.

   2. THE GALLERY IS BROWSER-LOCAL, AND THAT IS A CHOICE WITH A COST. The key
      is in KEYS.local, so generations are scoped per account but stay out of
      the backup file - a gallery of pictures you can regenerate from their
      prompts is not worth tens of megabytes in every backup. The cost, stated
      where store.js states it too: deleting a generation is NOT an undo step,
      because record() gates on KEYS.data. That is why removing one asks first,
      through the same confirmDialog every other delete in this app uses,
      rather than leaning on the arrows in the sidebar.

   3. IT WORKS WITH NOTHING SET UP. Pollinations needs no key, and it is the
      default engine, so the section generates a picture on a browser that has
      never been configured. Gemini is there for anyone who wants an uploaded
      basis picture honoured, which is the one thing a keyless GET interface
      cannot do.

   The settings live in this section rather than in the global Settings dialog,
   as asked. They are the engine, its model and its key - read from the same
   TrackerAI registry the dialog reads, and narrowed through the same
   classify(), so the two can never disagree about which models draw. */
(() => {
  const KEY = "tracker.images";
  const PER_PAGE = 9;
  const UI = () => window.TrackerUI;
  const AI = () => window.TrackerAI;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const load = () => window.TrackerStore.get(KEY, []);
  const save = (list) => window.TrackerStore.set(KEY, list);
  const getText = (k) => window.TrackerStore.getText(k);

  /* Whether the settings panel is open, and whatever the last attempt said.
     Module-level rather than in storage: neither is worth persisting, and a
     notice that survived a reload would report a failure you had already
     read and acted on. */
  let showSettings = false;
  let notice = "";
  let busy = false;
  /** The basis picture staged in this session, as { base64, type, name }. */
  let basis = null;

  /* ------------------------------------------------------------- the engine */
  const engines = () => AI().imageEngines();
  const current = () => AI().imageEngine();
  /** Model names offered for the chosen engine, asked of the engine itself. */
  let modelCache = {};

  async function loadModels(id) {
    const p = engines().find((x) => x.id === id);
    if (!p) return [];
    if (modelCache[id]) return modelCache[id];
    try {
      // The engine answers, narrowed by the engine. This module never decides
      // what counts as an image model - classify() does, inside ai.js, which
      // is the same call the Settings dialog groups its picker by.
      const list = await p.listImageModels(p.key ? p.key() : "");
      modelCache[id] = list;
      return list;
    } catch {
      // A list that could not be fetched must not empty the picker: the model
      // already saved still works, and an engine needing no key should never
      // present as unusable because a listing request failed.
      modelCache[id] = [];
      return [];
    }
  }

  /* ------------------------------------------------------------- generating */
  async function generate(prompt) {
    if (busy) return;
    const text = String(prompt || "").trim();
    if (!text) { notice = "Type what you want a picture of first."; return window.TrackerRender(); }
    const p = current();
    if (!p) { notice = "No image engine is available."; return window.TrackerRender(); }

    busy = true;
    notice = `Drawing with ${p.label}…`;
    window.TrackerRender();

    try {
      const blob = await AI().image(text, { basis, engineId: p.id });
      // The id comes from the store, which scopes it to the signed-in account
      // and makes two written in the same millisecond impossible to collide.
      const id = window.TrackerBlobs.id("img");
      await window.TrackerBlobs.put(id, blob);
      const list = load();
      list.push({
        id: "g-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        blob: id, prompt: text, engine: p.id, engineLabel: p.label,
        model: p.imageModel ? p.imageModel() : "",
        type: blob.type || "image/png", size: blob.size || 0,
        at: new Date().toISOString(),
        // Kept so a card can say it was drawn from a picture you supplied,
        // rather than leaving you to guess why two prompts differ.
        fromBasis: basis ? (basis.name || "an uploaded picture") : "",
      });
      save(list);
      notice = "";
    } catch (err) {
      // Named, never swallowed. Every reason TrackerAI.image can refuse is a
      // sentence someone can act on - a missing key points at the settings
      // above, a rate limit says to wait - and "it did not work" points at
      // nothing.
      notice = (err && err.message) ? err.message : "That did not work.";
    } finally {
      busy = false;
      window.TrackerRender();
    }
  }

  /* ---------------------------------------------------------------- basis */
  /**
   * Stage a picture to work from.
   *
   * Read to base64 here rather than at generate time so the file is held as
   * data this module owns, not as a File handle that can go stale if the file
   * is moved or the input is re-rendered - and every render replaces the DOM.
   */
  function stageBasis(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || "")) {
      notice = "That is not an image file.";
      return window.TrackerRender();
    }
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      basis = { base64: s.slice(s.indexOf(",") + 1), type: file.type, name: file.name };
      const p = current();
      // Said at the moment of upload, not at the moment of generating. Being
      // told after a wait that the engine never wanted your picture is the
      // worse order to learn it in.
      notice = p && !p.canBasis
        ? `${p.label} cannot work from an uploaded picture. Choose an engine that can, in the settings above.`
        : "";
      window.TrackerRender();
    };
    r.onerror = () => { notice = "That file could not be read."; window.TrackerRender(); };
    r.readAsDataURL(file);
  }

  /* --------------------------------------------------------------- export */
  /**
   * Save a generation to disk.
   *
   * Through TrackerUI.saveBlob, which every save in this app goes through, so
   * this is a call rather than a fifth copy of the anchor idiom.
   */
  async function exportImage(id) {
    const rec = load().find((x) => x.id === id);
    if (!rec) return;
    const blob = await window.TrackerBlobs.get(rec.blob);
    if (!blob) { notice = "That picture is no longer stored."; return window.TrackerRender(); }
    const ext = (blob.type || "image/png").split("/")[1] || "png";
    // Named from the prompt, so a folder of exports is readable. Trimmed to
    // something a filesystem accepts: punctuation out, length capped.
    const slug = rec.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "").slice(0, 60) || "image";
    UI().saveBlob(blob, `${slug}-${rec.at.slice(0, 10)}.${ext}`);
  }

  async function remove(id) {
    const rec = load().find((x) => x.id === id);
    if (!rec) return;
    // Asks, like every other delete here - and it matters more than most,
    // because this key is not in KEYS.data so there is no undo step behind it.
    const yes = await UI().confirmDialog({
      title: "Remove picture",
      intro: `Remove the picture of "${String(rec.prompt).slice(0, 60)}"? ` +
             "This cannot be undone, so export it first if you want to keep it.",
      confirmLabel: "Remove picture",
    });
    if (!yes) return;
    save(load().filter((x) => x.id !== id));
    // Dropped for real. The undo history is what normally holds bytes back
    // until a step expires, and this key has no steps, so nothing else will
    // ever come for them.
    window.TrackerBlobs.purge([rec.blob]);
    window.TrackerRender();
  }

  /* ----------------------------------------------------------------- view */
  const readable = (n) => !n ? "" :
    n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

  function settingsPanel() {
    const p = current();
    const list = engines();
    const models = (modelCache[p ? p.id : ""] || []);
    return `<div class="note rich imgsettings">
        <h3>Image generator settings</h3>
        <p class="lede">The free tools that can draw. Only models that generate
          images are offered here. Keys stay in this browser and are never put
          in a backup file.</p>
        <div class="field">
          <label for="imgEngine">Engine</label>
          <select id="imgEngine" data-imgengine>${list.map((e) =>
            `<option value="${esc(e.id)}"${p && e.id === p.id ? " selected" : ""}>${esc(e.label)}</option>`
          ).join("")}</select>
          <small>${p ? esc(p.keyHelp || "") : ""}${
            p && !p.canBasis ? " This engine cannot work from an uploaded picture." : ""}</small>
        </div>
        <div class="field">
          <label for="imgModel">Model</label>
          <select id="imgModel" data-imgmodel>${
            (models.length ? models : [p ? p.imageModel() : ""]).filter(Boolean).map((m) =>
              `<option value="${esc(m)}"${p && m === p.imageModel() ? " selected" : ""}>${esc(m)}</option>`
            ).join("")}</select>
          <small>${models.length
            ? "Read from the engine itself."
            : "The engine has not listed its models yet. The one saved still works."}</small>
        </div>
        ${p && p.keyless
          ? `<p class="m">${esc(p.label)} needs no key.</p>`
          : `<div class="field">
               <label for="imgKey">API key</label>
               <input id="imgKey" type="password" placeholder="Paste your key"
                      spellcheck="false" autocomplete="off"
                      value="${esc(p && p.key ? p.key() : "")}">
               <small>Stored in this browser only.</small>
             </div>`}
        <div class="actions">
          <button class="btn" data-imgsettings="close">Close settings</button>
          <button class="btn primary" data-imgsettings="save">Save settings</button>
        </div>
      </div>`;
  }

  function card(rec) {
    return `<div class="gencard">
        <button class="genshot" data-imgopen="${esc(rec.id)}" title="Open full size">
          <img data-blob="${esc(rec.blob)}" alt="${esc(rec.prompt)}">
        </button>
        <div class="genmeta">
          <div class="genprompt">${esc(rec.prompt)}</div>
          <div class="m">${esc(rec.engineLabel || rec.engine)}${
            rec.model ? " · " + esc(rec.model) : ""}${
            rec.size ? " · " + readable(rec.size) : ""}</div>
          <div class="m">${esc(String(rec.at).slice(0, 16).replace("T", " "))}${
            rec.fromBasis ? ` · from ${esc(rec.fromBasis)}` : ""}</div>
        </div>
        <div class="genactions">
          <button class="btn sm" data-imgexport="${esc(rec.id)}">Export</button>
          ${UI().iconButton("remove", "Remove this picture", `data-remove="image:${esc(rec.id)}"`)}
        </div>
      </div>`;
  }

  function view(q) {
    const all = load().slice().reverse();          // newest first
    const needle = String(q || "").toLowerCase();
    const rows = all.filter((r) => !needle ||
      (r.prompt + " " + (r.engineLabel || "") + " " + (r.model || "")).toLowerCase().includes(needle));
    const cur = UI().pageIndex("images", rows.length, PER_PAGE);
    const slice = rows.slice(cur * PER_PAGE, (cur + 1) * PER_PAGE);
    const p = current();
    const ready = p ? AI().imageReady(p) : false;

    // The thumbnails resolve from IndexedDB, which cannot happen during
    // render, so the shared painter runs on the next tick.
    setTimeout(() => UI().paintImages(), 0);

    return `
      <h2 class="page">Image Generator</h2>
      <p class="lede">${all.length} picture${all.length === 1 ? "" : "s"} made in this browser.
        They are kept here and deliberately left out of the backup file, so export
        the ones you want to keep. Drawing runs on ${p ? esc(p.label) : "no engine"}.</p>

      <div class="pagetools">
        ${window.TrackerLinks.searchBox("images", "Search your pictures…")}
        <button class="btn" data-imgsettings="open">Settings</button>
      </div>

      ${showSettings ? settingsPanel() : ""}

      <div class="genbar">
        <textarea id="imgPrompt" rows="3" data-imgprompt
                  placeholder="Describe the picture you want"></textarea>
        <div class="genbarrow">
          <label class="btn sm" for="imgBasis">${basis ? "Change basis image" : "Upload a basis image"}</label>
          <input id="imgBasis" type="file" accept="image/*" hidden>
          ${basis ? `<span class="tag">${esc(basis.name || "image")}
              <button class="tag" data-imgbasis="clear" title="Remove the basis image">×</button></span>` : ""}
          <button class="btn primary" data-imggo ${busy ? "disabled" : ""}>${
            busy ? "Drawing…" : "Generate"}</button>
        </div>
        ${!ready ? `<p class="m">${esc(p ? `${p.label} needs a key. Open Settings above.`
                                        : "No engine available.")}</p>` : ""}
        ${notice ? `<p class="note">${esc(notice)}</p>` : ""}
      </div>

      ${rows.length
        ? `<div class="gengrid">${slice.map(card).join("")}</div>
           ${UI().pager("images", rows.length, PER_PAGE)}`
        : `<div class="empty">${all.length
             ? "No picture matches that search."
             : "No pictures yet. Describe one above and press Generate."}</div>`}`;
  }

  /* --------------------------------------------------------------- wiring */
  document.addEventListener("click", (e) => {
    const s = e.target.closest("[data-imgsettings]");
    if (s) {
      const what = s.dataset.imgsettings;
      if (what === "open") {
        showSettings = true;
        notice = "";
        // Asked once the panel is open rather than on every render, so a page
        // you are only looking at makes no network call at all.
        const p = current();
        if (p) loadModels(p.id).then(() => window.TrackerRender());
        return window.TrackerRender();
      }
      if (what === "close") { showSettings = false; return window.TrackerRender(); }
      if (what === "save") return saveSettings();
    }
    if (e.target.closest("[data-imggo]")) {
      const box = document.querySelector("[data-imgprompt]");
      return generate(box ? box.value : "");
    }
    const b = e.target.closest("[data-imgbasis]");
    if (b) { basis = null; notice = ""; return window.TrackerRender(); }
    const x = e.target.closest("[data-imgexport]");
    if (x) return exportImage(x.dataset.imgexport);
    const rm = e.target.closest('[data-remove^="image:"]');
    if (rm) return remove(UI().actionId(rm, "remove"));
    const op = e.target.closest("[data-imgopen]");
    if (op) return openFull(op.dataset.imgopen);
  });

  document.addEventListener("change", (e) => {
    if (e.target.id === "imgBasis") return stageBasis(e.target.files && e.target.files[0]);
    if (e.target.id === "imgEngine") {
      // Saved immediately, so the help text and the key box below it describe
      // the engine now selected rather than the one before.
      window.TrackerStore.setText("tracker.imageEngine", e.target.value);
      notice = "";
      loadModels(e.target.value).then(() => window.TrackerRender());
      return window.TrackerRender();
    }
  });

  function saveSettings() {
    const p = current();
    if (!p) return;
    const model = document.querySelector("[data-imgmodel]");
    if (model && model.value && p.imageModelSetting) {
      window.TrackerStore.setText(p.imageModelSetting, model.value);
    }
    const key = document.querySelector("#imgKey");
    if (key && !p.keyless && p.keySetting) {
      const v = key.value.trim();
      // An empty box clears the key rather than being ignored: someone
      // deleting a key is asking for it to be gone.
      if (v) window.TrackerStore.setText(p.keySetting, v);
      else window.TrackerStore.remove(p.keySetting);
    }
    showSettings = false;
    notice = "Settings saved.";
    window.TrackerRender();
  }

  /** Open a generation full size, in a tab, through the shared opener. */
  async function openFull(id) {
    const rec = load().find((x) => x.id === id);
    if (!rec) return;
    const blob = await window.TrackerBlobs.get(rec.blob);
    if (blob) UI().openBlob(blob);
  }

  window.TrackerImages = { view, load, generate, exportImage, remove,
                           count: () => load().length };
})();
