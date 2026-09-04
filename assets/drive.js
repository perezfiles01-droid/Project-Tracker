/* Google Drive integration.

   The site is a static page (GitHub Pages), so there is no server to hold a
   secret. It uses Google Identity Services for a browser OAuth token and talks
   to the Drive REST API directly. The token lives in memory only; the client ID
   and API key live in localStorage (Settings) or config.js.

   Scope: drive.readonly — read file names/links, never modify anything. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
  const KEY = "tracker.driveLinks";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let token = null;          // in-memory access token
  let tokenClient = null;
  let browsing = [];         // last fetched file list
  let notice = "";

  // Page sizes for the two paged tables on this page. The pager itself is
  // shared (assets/ui.js) so every table in the app pages the same way.
  const PINNED_COLS = 3, PINNED_ROWS = 2;          // 3 across, 2 down = 6 a page
  const PINNED_PER_PAGE = PINNED_COLS * PINNED_ROWS;
  const FILES_PER_PAGE = 10;
  const clampPage = (key, total, perPage) => window.TrackerUI.pageIndex(key, total, perPage);
  const pager = (key, total, perPage) => window.TrackerUI.pager(key, total, perPage);

  // Opened from disk there is no usable web origin, so name the hosted site instead.
  const originHint = () =>
    location.protocol.startsWith("http") ? location.origin : "https://perezfiles01-droid.github.io";

  const cfg = () => ({
    clientId: window.TrackerStore.getText("tracker.clientId") || (window.TRACKER_CONFIG?.googleClientId || ""),
    apiKey: window.TrackerStore.getText("tracker.apiKey") || (window.TRACKER_CONFIG?.googleApiKey || ""),
    folderId: window.TRACKER_CONFIG?.driveFolderId || "",
  });

  const saved = () => window.TrackerStore.get(KEY, []);
  const save = (list) => window.TrackerStore.set(KEY, list);

  /* ---------- auth ---------- */
  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) return resolve();
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load Google Identity Services (offline or blocked)."));
      document.head.appendChild(s);
    });
  }

  async function connect() {
    const { clientId } = cfg();
    if (!clientId) {
      notice = "Add your OAuth Client ID in Settings first.";
      return window.TrackerRender();
    }
    try { await loadGis(); }
    catch (e) { notice = e.message; return window.TrackerRender(); }

    tokenClient = tokenClient || google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { notice = "Sign-in failed: " + resp.error; return window.TrackerRender(); }
        token = resp.access_token;
        notice = "";
        listFiles();
      },
    });
    tokenClient.requestAccessToken({ prompt: token ? "" : "consent" });
  }

  function disconnect() {
    if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
    token = null; browsing = []; notice = "Disconnected.";
    window.TrackerRender();
  }

  /* ---------- drive api ---------- */
  async function listFiles(query = "") {
    if (!token) return;
    const { folderId } = cfg();
    const clauses = ["trashed = false"];
    if (query) clauses.push(`name contains '${query.replace(/'/g, "\\'")}'`);
    else if (folderId) clauses.push(`'${folderId}' in parents`);
    const url = "https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({
      q: clauses.join(" and "),
      pageSize: "50",
      orderBy: "modifiedTime desc",
      fields: "files(id,name,mimeType,webViewLink,modifiedTime,iconLink,owners(displayName))",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    try {
      const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
      if (!r.ok) throw new Error(`Drive API ${r.status}: ${(await r.text()).slice(0, 200)}`);
      browsing = (await r.json()).files || [];
      notice = browsing.length ? "" : "No files returned for that query.";
    } catch (e) {
      notice = e.message;
    }
    window.TrackerRender();
  }

  function pin(file, project) {
    const list = saved();
    if (list.some((l) => l.id === file.id)) return;
    list.push({
      id: file.id,
      name: file.name,
      url: file.webViewLink || `https://drive.google.com/open?id=${file.id}`,
      meta: file.mimeType?.split(".").pop(),
      modified: (file.modifiedTime || "").slice(0, 10),
      project: project || "Google Drive",
      verified: true,
    });
    save(list);
    window.TrackerRender();
  }

  async function unpin(id) {
    const cur = saved().find((l) => l.id === id);
    if (!cur) return;
    const yes = await window.TrackerUI.confirmDialog({
      title: "Remove link", intro: `Remove "${cur.name}" from Google Drive links?`,
      confirmLabel: "Remove link",
    });
    if (!yes) return;
    save(saved().filter((l) => l.id !== id));
    window.TrackerRender();
  }

  /**
   * Create or correct a saved link through the shared dialog.
   *
   * Editing is the point: a mistyped label used to cost a delete and a
   * re-add, which for a pinned Drive file meant finding it in Drive again.
   */
  async function editLink(id) {
    const list = saved();
    const cur = id ? list.find((l) => l.id === id) : null;
    if (id && !cur) return;
    const values = await window.TrackerUI.formDialog({
      title: cur ? "Edit link" : "Add a link",
      intro: cur ? "" : "Any link — Drive, SharePoint, Jira, anything.",
      submitLabel: cur ? "Save changes" : "Add link",
      fields: [
        { name: "name", label: "Label", value: cur ? cur.name : "", placeholder: "What this link is" },
        { name: "url", label: "URL", value: cur ? cur.url : "", placeholder: "https://…" },
        { name: "project", label: "Project", value: cur ? cur.project : "Google Drive",
          help: "GLASS, EDRMS ADB, or anything you like — it shows as a tag." },
      ],
    });
    if (!values) return;
    if (!values.name && !values.url) return;
    if (cur) {
      Object.assign(cur, {
        name: values.name || cur.name,
        url: values.url || cur.url,
        project: values.project || cur.project,
      });
    } else {
      list.push({
        id: "manual-" + Date.now(),
        name: values.name || values.url,
        url: values.url,
        project: values.project || "Google Drive",
        meta: "manual",
        verified: true,
      });
    }
    save(list);
    window.TrackerRender();
  }

  /**
   * Pinned links as a table laid out PINNED_COLS across and PINNED_ROWS down.
   * A table rather than a grid so the columns stay aligned as names vary in
   * length, and paged so the page does not grow without limit.
   */
  function pinnedTable(list, key = "pinned") {
    if (!list.length) return `<div class="empty">Nothing here yet.</div>`;
    const cur = clampPage(key, list.length, PINNED_PER_PAGE);
    const slice = list.slice(cur * PINNED_PER_PAGE, (cur + 1) * PINNED_PER_PAGE);

    const rows = [];
    for (let r = 0; r < PINNED_ROWS; r++) {
      const cells = slice.slice(r * PINNED_COLS, (r + 1) * PINNED_COLS);
      if (!cells.length) break;
      // Pad the final row so the columns keep their width.
      while (cells.length < PINNED_COLS) cells.push(null);
      rows.push(`<tr>${cells.map((l) => l
        ? `<td>
             <div class="t"><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a></div>
             <div class="m">${esc(l.project)}${l.modified ? " · modified " + esc(l.modified) : ""}</div>
             <div class="row">
               <span class="tag">${esc(l.meta || "drive")}</span>
               ${window.TrackerUI.iconButton("edit", "Edit", `data-edit="drive:${esc(l.id)}"`)}
               ${window.TrackerUI.iconButton("remove", "Remove", `data-remove="drive:${esc(l.id)}"`)}
             </div>
           </td>`
        : `<td class="pad"></td>`).join("")}</tr>`);
    }

    return `<div class="tablewrap"><table class="cellgrid">
        <tbody>${rows.join("")}</tbody>
      </table></div>${pager(key, list.length, PINNED_PER_PAGE)}`;
  }

  /**
   * Recent Drive files as a paged table, FILES_PER_PAGE rows at a time.
   * Fifty cards in a column is unreadable; a table gives the name room and
   * keeps type, date and the pin action in fixed columns.
   */
  function filesTable(files) {
    if (!files.length) return `<div class="empty">No files.</div>`;
    const cur = clampPage("files", files.length, FILES_PER_PAGE);
    const slice = files.slice(cur * FILES_PER_PAGE, (cur + 1) * FILES_PER_PAGE);

    const kind = (m) => (m || "").replace("application/vnd.google-apps.", "").split("/").pop() || "file";

    return `<div class="tablewrap"><table class="filetable">
        <thead><tr>
          <th>Name</th><th>Type</th><th>Modified</th><th></th>
        </tr></thead>
        <tbody>${slice.map((f) => `
          <tr>
            <td><a class="namecell" href="${esc(f.webViewLink)}" target="_blank" rel="noopener">${esc(f.name)}</a></td>
            <td><span class="tag">${esc(kind(f.mimeType))}</span></td>
            <td>${esc((f.modifiedTime || "").slice(0, 10))}</td>
            <td><button class="btn sm" data-pin="${esc(f.id)}">Pin to tracker</button></td>
          </tr>`).join("")}</tbody>
      </table></div>${pager("files", files.length, FILES_PER_PAGE)}`;
  }

  /* ---------- view ---------- */
  function view(q) {
    const { clientId, apiKey } = cfg();
    const list = saved().filter((l) => !q || JSON.stringify(l).toLowerCase().includes(q));
    const files = browsing.filter((f) => !q || f.name.toLowerCase().includes(q));

    // Two tables rather than one: a file pinned from the Drive list and a link
    // typed in by hand are different things and were previously mixed in one
    // list. "manual" is the marker the add path already writes.
    const fromDrive = list.filter((l) => l.meta !== "manual");
    const added = list.filter((l) => l.meta === "manual");

    const setup = clientId
      ? ""
      : `<div class="note rich"><b>Not connected yet.</b> In the Google Cloud console open
           <b>Google Auth Platform → Clients</b>, create a <b>Web application</b> client with
           <code>${esc(originHint())}</code> as an authorised JavaScript origin, enable the
           <b>Google Drive API</b>, then paste the Client ID using the <b>Enter your Client ID</b> button below.
           Full walkthrough in the repository README.</div>`;

    return `
      <h2 class="page">Google Drive</h2>
      <p class="lede">Sign in with your Google account to browse Drive and pin files
        into this tracker. Pinned files are stored in this browser and show up in search
        and on the Overview page.</p>
      ${setup}
      ${notice ? `<div class="note" style="border-color:var(--warn)">${esc(notice)}</div>` : ""}
      <div class="pagetools">${window.TrackerLinks.searchBox("drive", "Search pinned links and files…")}</div>
      <div class="chips" style="margin-top:14px">
        ${clientId
          ? `<button class="btn ${token ? "" : "primary"}" id="driveConnect">${token ? "Refresh files" : "Connect Google Drive"}</button>`
          : `<button class="btn primary" data-open-settings>Enter your Client ID</button>
             <button class="btn" id="driveConnect">Connect Google Drive</button>`}
        ${token ? `<button class="btn" id="driveDisconnect">Disconnect</button>` : ""}
        <button class="btn" id="driveAddManual">Add a link manually</button>
        ${apiKey ? "" : `<span class="tag dead" style="align-self:center">No API key needed</span>`}
      </div>

      <h3 class="sec">Pinned from Drive (${fromDrive.length})</h3>
      ${pinnedTable(fromDrive, "pinned")}

      <h3 class="sec">Links you added (${added.length})</h3>
      ${pinnedTable(added, "added")}

      ${token ? `<h3 class="sec">Your Drive — recent files (${files.length})</h3>
        ${filesTable(files)}` : ""}`;
  }

  /* ---------- wiring ---------- */
  document.addEventListener("click", (e) => {
    if (e.target.id === "driveConnect") return token ? listFiles() : connect();
    if (e.target.id === "driveDisconnect") return disconnect();
    if (e.target.id === "driveAddManual") return editLink(null);

    const p = e.target.closest("[data-pin]");
    if (p) return pin(browsing.find((f) => f.id === p.dataset.pin) || {}, null);

    const ed = e.target.closest('[data-edit^="drive:"]');
    if (ed) return editLink(window.TrackerUI.actionId(ed, "edit"));
    const rm = e.target.closest('[data-remove^="drive:"]');
    if (rm) return unpin(window.TrackerUI.actionId(rm, "remove"));


    if (e.target.id === "openDrive") return window.TrackerGo("drive");
    if (e.target.id === "openSettings" || e.target.closest("[data-open-settings]")) {
      $("#clientId").value = window.TrackerStore.getText("tracker.clientId");
      $("#apiKey").value = window.TrackerStore.getText("tracker.apiKey");
      renderAiSettings();
      $("#settingsModal").hidden = false;
    }
    if (e.target.id === "settingsCancel" || e.target.id === "settingsModal") $("#settingsModal").hidden = true;
    if (e.target.id === "settingsSave") {
      window.TrackerStore.setText("tracker.clientId", $("#clientId").value.trim());
      window.TrackerStore.setText("tracker.apiKey", $("#apiKey").value.trim());
      saveAiSettings();
      $("#settingsModal").hidden = true;
      notice = "Credentials saved in this browser.";
      window.TrackerRender();
    }
  });

  /* ---------- the Standardize engine, in the same dialog ----------
     Key and model are stored PER ENGINE, so switching engine to look at the
     other one never wipes the setup you already had. The model list is read
     from the account rather than baked in here: model names churn, and a
     stale name is a 404 the reader cannot act on. */
  /* ---------- which engine is on screen, and which one will run ----------
     The Engine picker offers every provider plus "All engines", so the model
     list can span them. Only ever a real provider id is saved as the engine:
     standardize() dispatches on it, and handing it a pseudo-engine would be a
     bug that only shows up when the wand is clicked. The pseudo choice is kept
     apart, in tracker.aiEngineMode, purely so the dialog reopens as you left
     it. */
  const ALL = "all";
  /* Whether the list on screen spans every engine. Held apart from the Engine
     box's value on purpose: picking a model moves that box to the engine that
     owns the model, and the list it was picked from must survive being
     picked from. Only the user choosing an engine leaves union mode. */
  let unionMode = false;
  const providers = () => (window.TrackerAI && window.TrackerAI.PROVIDERS) || [];
  const byId = (id) => providers().find((p) => p.id === id);
  /** What the Engine box says right now, which may be the pseudo choice. */
  const enginePicked = () => ($("#aiEngine") && $("#aiEngine").value) || "";
  /** Which engines' lists are on screen: all of them, or just the one. */
  const enginesShown = () =>
    unionMode ? providers().filter((p) => p.key())
              : [byId(enginePicked()) || providers()[0]].filter(Boolean);
  /** The engine that would actually run: the model's owner, under All. */
  const aiCurrentEngine = () => {
    if (enginePicked() !== ALL) return byId(enginePicked()) || providers()[0];
    // Still on the pseudo choice: the model's owner decides.
    const sel = $("#aiModel") && $("#aiModel").value;
    return modelEngine.get(sel) || providers().find((p) => p.key()) || providers()[0];
  };

  function renderAiSettings() {
    const list = providers();
    if (!list.length) return;
    const saved = window.TrackerStore.getText("tracker.aiEngine") ||
                  window.TrackerAI.DEFAULT_ENGINE;
    const mode = window.TrackerStore.getText("tracker.aiEngineMode") === ALL && list.length > 1
      ? ALL : saved;
    // "All engines" is only worth offering when there is more than one, and the
    // row itself still hides at one, so a single-engine build is unchanged.
    const opts = list.map((p) => [p.id, p.label])
      .concat(list.length > 1 ? [[ALL, "All engines"]] : []);
    $("#aiEngine").innerHTML = opts.map(([v, label]) =>
      `<option value="${v}"${v === mode ? " selected" : ""}>${label}</option>`).join("");
    const row = $("#aiEngine").closest(".field");
    if (row) row.hidden = list.length < 2;
    unionMode = mode === ALL;
    showEngine();
  }

  /** Fill the key, the help and the model list for whatever is picked. */
  function showEngine() {
    const p = aiCurrentEngine();
    if (!p) return;
    paintKey(p);
    const saved = window.TrackerStore.getText(p.modelSetting) || p.model();
    // Until the accounts answer, the saved model is the whole list: it is the
    // one name known to work, and it must stay selected through the wait.
    modelsHeld = [saved];
    modelEngine.clear();
    modelEngine.set(saved, p);
    setTier(tierOf(saved));
    paintModels(saved);
    loadModels(saved);
  }

  /** The key box always belongs to the engine that will run. */
  function paintKey(p) {
    if (!p) return;
    $("#aiKey").value = window.TrackerStore.getText(p.keySetting);
    $("#aiKeyHelp").textContent = p.keyHelp;
    const cost = p.free ? "Free tier. No card needed."
                        : "Uses purchased credit on that account.";
    $("#aiEngineHelp").textContent = unionMode
      ? `Every engine with a key, in one list. ${p.label} runs the model chosen. ${cost}`
      : cost;
  }

  /* ---------- the model picker: tier radios, purpose groups ----------
     The tier is this app's own labelling for Gemini, because Google's model
     list carries no billing information at all; OpenRouter publishes its
     prices, so its own classify reads them. Either way the filter never
     removes a model outright - "Show everything" is always there. */
  let modelsHeld = [];
  const modelEngine = new Map();
  const ai = () => window.TrackerAI || {};
  /* Classification belongs to the engine, not to this dialog. The shared rules
     are the fallback for an engine that declares none. */
  const classifierFor = (p) => (p && p.classify) || ai().classify ||
                               (() => ({ tier: "free", purpose: "text" }));
  const engineOwning = (m) => modelEngine.get(m) || aiCurrentEngine();
  const sortOf = (m) => classifierFor(engineOwning(m))(m);
  const tierOf = (m) => sortOf(m).tier;
  const purposeOf = (m) => sortOf(m).purpose;
  const tierPicked = () => {
    const on = $("#aiTier") && $("#aiTier").querySelector("input:checked");
    return on ? on.value : "free";
  };
  function setTier(tier) {
    const box = $("#aiTier");
    if (!box) return;
    const want = box.querySelector(`input[value="${tier}"]`) ||
                 box.querySelector('input[value="free"]');
    if (want) want.checked = true;
  }

  /**
   * Render the held list under the chosen tier, grouped by what each model is
   * for. Text first, because the Standardize button is a text job. Empty
   * groups are dropped rather than shown blank.
   *
   * Optgroups cannot nest, so under All engines the engine's name joins the
   * group label rather than wrapping it: "Text generation - OpenRouter". Every
   * option carries its engine, which is what lets picking one fill the Engine
   * box.
   */
  function paintModels(saved) {
    const sel = $("#aiModel");
    if (!sel) return 0;
    const tier = tierPicked();
    const shown = modelsHeld.filter((m) => tier === "all" || tierOf(m) === tier);
    const order = ai().PURPOSE_ORDER || ["text"];
    const label = ai().PURPOSE_LABEL || {};
    const many = unionMode;
    const engines = many ? enginesShown() : [aiCurrentEngine()].filter(Boolean);
    const groups = [];
    for (const k of order) {
      for (const p of engines) {
        const list = shown.filter((m) => purposeOf(m) === k && engineOwning(m) === p);
        if (list.length) groups.push([many ? `${label[k] || k} - ${p.label}` : (label[k] || k), p, list]);
      }
    }
    sel.innerHTML = groups.map(([text, p, list]) =>
      `<optgroup label="${text}">` + list.map((m) =>
        `<option value="${m}" data-engine="${p.id}"${m === saved ? " selected" : ""}>${m}</option>`).join("") +
      "</optgroup>").join("");
    if (shown.includes(saved)) sel.value = saved;
    else if (shown.length) sel.value = shown[0];
    return shown.length;
  }

  /**
   * Ask each engine on screen which models it can use. A failure is not worth
   * shouting about: the saved model stays selected and still works, so the note
   * says what happened and the dialog carries on. Under All engines one engine
   * failing must not empty the list, so each is asked separately and the ones
   * that answered are still shown.
   */
  async function loadModels(saved) {
    const engines = enginesShown();
    const keyed = engines.filter((p) => (p === aiCurrentEngine()
      ? ($("#aiKey").value.trim() || window.TrackerStore.getText(p.keySetting))
      : window.TrackerStore.getText(p.keySetting)));
    if (!keyed.length) {
      $("#aiModelHelp").textContent = unionMode
        ? "No engine has a key yet. Add one below to see the models it can use."
        : "Add a key to see the models it can use.";
      return;
    }
    $("#aiModelHelp").textContent = "Reading the models on that account…";
    const held = [];
    const owner = new Map();
    const broke = [];
    for (const p of keyed) {
      const key = p === aiCurrentEngine()
        ? ($("#aiKey").value.trim() || window.TrackerStore.getText(p.keySetting))
        : window.TrackerStore.getText(p.keySetting);
      try {
        const models = await p.listModels(key);
        for (const m of models) if (!owner.has(m)) { owner.set(m, p); held.push(m); }
      } catch (err) {
        broke.push(`${p.label} (${err.message || "failed"})`);
      }
    }
    if (!held.length) {
      $("#aiModelHelp").textContent = "Could not read the model list (" +
        (broke.join("; ") || "none listed") + "). Keeping " + saved + ".";
      return;
    }
    modelsHeld = held;
    modelEngine.clear();
    for (const [m, p] of owner) modelEngine.set(m, p);
    // Follow the saved model to its own side rather than quietly selecting a
    // different one: the choice already made is never changed behind a back.
    if (held.includes(saved)) setTier(tierOf(saved));
    const shown = paintModels(saved);
    const missing = enginesShown().length - keyed.length;
    $("#aiModelHelp").textContent =
      `Showing ${shown} of ${held.length} models, grouped by what each is for. ` +
      "The cheapest and fastest are first." +
      (broke.length ? ` Could not read ${broke.join("; ")}.` : "") +
      (missing > 0 ? ` ${missing} engine(s) skipped for want of a key.` : "");
    syncEngineToModel();
  }

  /**
   * Picking a model fills the Engine box with the engine that owns it.
   *
   * The list on screen is deliberately left alone: it was asked for as one
   * list across engines, and rebuilding it per pick would take the other
   * engines' models away the moment you touched one of them.
   */
  function syncEngineToModel() {
    const sel = $("#aiModel");
    if (!sel || !sel.selectedOptions || !sel.selectedOptions.length) return;
    const id = sel.selectedOptions[0].dataset.engine;
    const p = byId(id);
    if (!p) return;
    const box = $("#aiEngine");
    // Setting .value fires no change event, so union mode is not disturbed:
    // the box names the engine that will run while the list stays as it was.
    if (box && box.value !== p.id) box.value = p.id;
    paintKey(p);
  }

  function saveAiSettings() {
    const p = aiCurrentEngine();
    if (!p) return;
    // Never a pseudo-engine: standardize() dispatches on this value.
    window.TrackerStore.setText("tracker.aiEngine", p.id);
    window.TrackerStore.setText("tracker.aiEngineMode", unionMode ? ALL : "");
    window.TrackerStore.setText(p.keySetting, $("#aiKey").value.trim());
    window.TrackerStore.setText(p.modelSetting, $("#aiModel").value);
  }

  document.addEventListener("change", (e) => {
    if (e.target.id === "aiEngine") { unionMode = e.target.value === ALL; showEngine(); }
    if (e.target.id === "aiModel") syncEngineToModel();
    if (e.target.name === "aiTier") {
      const shown = paintModels($("#aiModel").value);
      syncEngineToModel();
      $("#aiModelHelp").textContent = modelsHeld.length > 1
        ? `Showing ${shown} of ${modelsHeld.length} models, grouped by what each is for. ` +
          "The cheapest and fastest are first."
        : $("#aiModelHelp").textContent;
    }
  });
  // A pasted key should fill the model list without needing a save first.
  document.addEventListener("blur", (e) => {
    if (e.target.id === "aiKey") loadModels($("#aiModel").value);
  }, true);

  window.TrackerDrive = {
    view, connect, saved, editLink,
    // Test seam for checks/check_render.mjs: the file list and token live in
    // this closure, so a browser-side check has no other way to exercise the
    // real render path without hitting Google.
    _seed(files) { token = "seed"; browsing = files; notice = ""; window.TrackerRender(); },
  };
})();
