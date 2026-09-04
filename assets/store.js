/* The one place this app talks to localStorage.

   Eleven keys were read and written by twenty-five direct localStorage calls
   across five modules. Nothing owned the list, so "save everything to a file"
   had nothing to enumerate and a key added later would simply be missed by
   the backup - silently, and only discovered when a restore came back short.

   Every module goes through here now, and KEYS below is the definition of
   what this app stores. Adding a key to that list is what puts it in the
   backup; a check fails the build if a module reaches past this file. */
(() => {
  /**
   * Every key the app owns.
   *
   * "data" holds what you author; "settings" holds machine-local preferences.
   * A backup carries the data and leaves the settings alone: restoring on
   * another machine should not overwrite that machine's theme, and the Google
   * client id belongs to the browser it was pasted into, not to the content.
   */
  const KEYS = {
    data: [
      "tracker.tasks",       // To Do List
      "tracker.activity",    // Daily activity log
      "tracker.artifacts",   // per-project artifacts
      "tracker.timeline",    // per-project milestones
      "tracker.linkEdits",   // edits laid over workbook links
      "tracker.linkTables",  // tables you named yourself
      "tracker.userLinks",   // links you added
      "tracker.driveLinks",  // pinned Drive files and manual links
      "tracker.projects",    // projects you added, renamed or hid
      "tracker.linkPins",    // links pinned to the top of their own table
      // Data, not a preference: it records which projects have already had
      // their artifacts seeded from the workbook. Restoring artifacts without
      // it lets the seed run a second time and duplicate every one of them.
      "tracker.seeded",
    ],
    settings: [
      "tracker.theme",
      "tracker.clientId",
      "tracker.apiKey",
      // The Anthropic key for the Standardize button. A setting, not data,
      // so it stays out of the backup file exactly like the two above.
      "tracker.aiKey",
      "tracker.aiModel",
    ],
  };
  const ALL = [...KEYS.data, ...KEYS.settings];

  /** Raw string read. Returns null when absent, like localStorage itself. */
  const raw = (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
  };

  /**
   * Parsed read with a fallback.
   *
   * Storage can throw (a browser set to block site data) and can hold
   * corrupt JSON; either way the caller gets its fallback rather than an
   * exception that would take the whole render down.
   */
  const get = (key, fallback) => {
    const v = raw(key);
    if (v === null) return fallback;
    try { return JSON.parse(v); } catch { return fallback; }
  };

  const set = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  };

  /** For the two plain strings (client id, api key) that are not JSON. */
  const getText = (key, fallback = "") => {
    const v = raw(key);
    return v === null ? fallback : v;
  };
  const setText = (key, value) => {
    try { localStorage.setItem(key, value); return true; } catch { return false; }
  };

  const remove = (key) => {
    try { localStorage.removeItem(key); } catch { /* nothing to undo */ }
  };

  /** Everything the backup carries: the data keys that actually hold something. */
  function exportData() {
    const out = {};
    for (const k of KEYS.data) {
      const v = raw(k);
      if (v !== null) out[k] = v;          // stored verbatim, re-parsed on restore
    }
    return { format: "project-tracker-backup", version: 1,
             savedAt: new Date().toISOString(), keys: out };
  }

  /**
   * Load a backup. Returns the number of keys restored, or throws with a
   * readable reason - a bad file must never leave storage half-written, so
   * the whole payload is validated before anything is set.
   */
  function importData(payload) {
    if (!payload || typeof payload !== "object" || payload.format !== "project-tracker-backup") {
      throw new Error("That is not a Project Tracker backup file.");
    }
    const keys = payload.keys;
    if (!keys || typeof keys !== "object") throw new Error("The backup has no data in it.");
    const entries = Object.entries(keys).filter(([k]) => KEYS.data.includes(k));
    if (!entries.length) throw new Error("The backup holds nothing this version can read.");
    for (const [, v] of entries) {
      if (typeof v !== "string") throw new Error("The backup is damaged and was not loaded.");
      JSON.parse(v);                        // throws before anything is written
    }
    for (const k of KEYS.data) remove(k);    // replace, not merge
    for (const [k, v] of entries) setText(k, v);
    return entries.length;
  }

  /* ---------- Save as file / Restore from file ---------- */

  function saveToFile() {
    const payload = exportData();
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `project-tracker-backup-${payload.savedAt.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    return Object.keys(payload.keys).length;
  }

  /** Read one chosen file and load it. Resolves with a message to show. */
  function restoreFromFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const n = importData(JSON.parse(String(reader.result)));
            resolve({ ok: true, message: `Restored ${n} item group${n === 1 ? "" : "s"}.` });
          } catch (e) {
            // Nothing was written: importData validates the whole payload
            // before it touches storage, so a bad file cannot half-load.
            resolve({ ok: false, message: e.message });
          }
        };
        reader.onerror = () => resolve({ ok: false, message: "That file could not be read." });
        reader.readAsText(file);
      });
      input.click();
    });
  }

  async function openBackupDialog() {
    const n = Object.keys(exportData().keys).length;
    const answer = await window.TrackerUI.formDialog({
      title: "Backup",
      intro: `Everything you add lives in this browser only. Save it to a file to move `
           + `it to another computer or to keep a copy — ${n} item group${n === 1 ? "" : "s"} `
           + `to save right now. Task attachments are named in the file but their contents `
           + `are not included. Restoring REPLACES what is in this browser.`,
      fields: [],
      choices: [
        { value: "save", label: "Save as file", primary: true },
        { value: "restore", label: "Restore from file" },
      ],
    });
    if (!answer) return;
    if (answer.choice === "save") {
      saveToFile();
      return;
    }
    const res = await restoreFromFile();
    if (!res) return;
    if (res.ok && window.TrackerRender) window.TrackerRender();
    await window.TrackerUI.formDialog({
      title: res.ok ? "Restored" : "Nothing was restored",
      intro: res.message + (res.ok ? "" : " Nothing in this browser was changed."),
      fields: [],
      choices: [{ value: "ok", label: "OK", primary: true }],
    });
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("#openBackup")) openBackupDialog();
  });

  window.TrackerStore = { KEYS, ALL, get, set, getText, setText, remove,
                          exportData, importData, saveToFile, restoreFromFile, openBackupDialog };
})();
