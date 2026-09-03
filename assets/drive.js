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
           <b>Google Drive API</b>, then paste the Client ID under <b>Settings</b> below.
           Full walkthrough in the repository README.</div>`;

    return `
      <h2 class="page">Google Drive</h2>
      <p class="lede">Sign in with your Google account to browse Drive and pin files
        into this tracker. Pinned files are stored in this browser and show up in search
        and on the Overview page.</p>
      ${setup}
      ${notice ? `<div class="note" style="border-color:var(--warn)">${esc(notice)}</div>` : ""}
      <div class="chips" style="margin-top:14px">
        <button class="btn ${token ? "" : "primary"}" id="driveConnect">${token ? "Refresh files" : "Connect Google Drive"}</button>
        ${token ? `<button class="btn" id="driveDisconnect">Disconnect</button>` : ""}
        <button class="btn" id="driveAddManual">Add a link manually</button>
        ${apiKey ? "" : `<span class="tag dead" style="align-self:center">No API key needed</span>`}
      </div>

      <h3 class="sec">Pinned Drive links (${list.length})</h3>
      <div class="grid">${list.map((l) => `
        <div class="card">
          <div class="t"><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a></div>
          <div class="m">${esc(l.project)}${l.modified ? " · modified " + esc(l.modified) : ""}</div>
          <div class="row">
            <span class="tag">${esc(l.meta || "drive")}</span>
            <button class="btn sm" data-unpin="${esc(l.id)}">Remove</button>
          </div>
        </div>`).join("") || `<div class="empty">Nothing pinned yet.</div>`}

      ${token ? `<h3 class="sec">Your Drive — recent files (${files.length})</h3>
        <div class="grid">${files.map((f) => `
          <div class="card">
            <div class="t"><a href="${esc(f.webViewLink)}" target="_blank" rel="noopener">${esc(f.name)}</a></div>
            <div class="m">${esc((f.mimeType || "").split(".").pop())} · ${esc((f.modifiedTime || "").slice(0, 10))}</div>
            <div class="row"><button class="btn sm" data-pin="${esc(f.id)}">Pin to tracker</button></div>
          </div>`).join("") || `<div class="empty">No files.</div>`}` : ""}`;
  }

  /* ---------- wiring ---------- */
  document.addEventListener("click", (e) => {
    if (e.target.id === "driveConnect") return token ? listFiles() : connect();
    if (e.target.id === "driveDisconnect") return disconnect();
    if (e.target.id === "driveAddManual") {
      const url = prompt("Paste any link (Drive, SharePoint, Jira, anything):");
      if (!url) return;
      const name = prompt("Label for this link:", url) || url;
      const project = prompt("Which project? (GLASS / EDRMS ADB / LHUB / other)", "Google Drive") || "Google Drive";
      const list = saved();
      list.push({ id: "manual-" + Date.now(), name, url, project, meta: "manual", verified: true });
      save(list);
      return window.TrackerRender();
    }
    const p = e.target.closest("[data-pin]");
    if (p) return pin(browsing.find((f) => f.id === p.dataset.pin) || {}, null);
    const u = e.target.closest("[data-unpin]");
    if (u) return unpin(u.dataset.unpin);

    if (e.target.id === "openDrive") return window.TrackerGo("drive");
    if (e.target.id === "openSettings") {
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

  window.TrackerDrive = { view, connect, saved };
})();
