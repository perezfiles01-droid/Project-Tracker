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
    clientId: localStorage.getItem("tracker.clientId") || (window.TRACKER_CONFIG?.googleClientId || ""),
    apiKey: localStorage.getItem("tracker.apiKey") || (window.TRACKER_CONFIG?.googleApiKey || ""),
    folderId: window.TRACKER_CONFIG?.driveFolderId || "",
  });

  const saved = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
  const save = (list) => localStorage.setItem(KEY, JSON.stringify(list));

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

  function unpin(id) { save(saved().filter((l) => l.id !== id)); window.TrackerRender(); }

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
  function pinnedTable(list) {
    if (!list.length) return `<div class="empty">Nothing pinned yet.</div>`;
    const cur = clampPage("pinned", list.length, PINNED_PER_PAGE);
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
               <button class="btn sm" data-edit="drive:${esc(l.id)}">Edit</button>
               <button class="btn sm" data-remove="drive:${esc(l.id)}">Remove</button>
             </div>
           </td>`
        : `<td class="pad"></td>`).join("")}</tr>`);
    }

    return `<div class="tablewrap"><table class="cellgrid">
        <tbody>${rows.join("")}</tbody>
      </table></div>${pager("pinned", list.length, PINNED_PER_PAGE)}`;
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

      <h3 class="sec">Pinned Drive links (${list.length})</h3>
      ${pinnedTable(list)}

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
    if (ed) return editLink(ed.dataset.edit.slice(6));
    const rm = e.target.closest('[data-remove^="drive:"]');
    if (rm) return unpin(rm.dataset.remove.slice(7));


    if (e.target.id === "openDrive") return window.TrackerGo("drive");
    if (e.target.id === "openSettings" || e.target.closest("[data-open-settings]")) {
      $("#clientId").value = localStorage.getItem("tracker.clientId") || "";
      $("#apiKey").value = localStorage.getItem("tracker.apiKey") || "";
      $("#settingsModal").hidden = false;
    }
    if (e.target.id === "settingsCancel" || e.target.id === "settingsModal") $("#settingsModal").hidden = true;
    if (e.target.id === "settingsSave") {
      localStorage.setItem("tracker.clientId", $("#clientId").value.trim());
      localStorage.setItem("tracker.apiKey", $("#apiKey").value.trim());
      $("#settingsModal").hidden = true;
      notice = "Credentials saved in this browser.";
      window.TrackerRender();
    }
  });

  window.TrackerDrive = {
    view, connect, saved, editLink,
    // Test seam for checks/check_render.mjs: the file list and token live in
    // this closure, so a browser-side check has no other way to exercise the
    // real render path without hitting Google.
    _seed(files) { token = "seed"; browsing = files; notice = ""; window.TrackerRender(); },
  };
})();
