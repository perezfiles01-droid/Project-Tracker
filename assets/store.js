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
      // The Standardize engine: a key and a model, kept per engine so putting
      // a second one back never destroys the first one's setup.
      // tracker.aiKey and tracker.aiModel belonged to the Anthropic engine and
      // went with it. TrackerAI.adopt moves a Google key left in that slot.
      "tracker.geminiKey",
      "tracker.geminiModel",
      "tracker.openrouterKey",
      "tracker.openrouterModel",
      "tracker.aiEngine",
      // "all" when the picker is showing every engine at once. The engine that
      // runs is always a real id in tracker.aiEngine; this is only the view.
      "tracker.aiEngineMode",
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
    record(key);
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  };

  /** For the two plain strings (client id, api key) that are not JSON. */
  const getText = (key, fallback = "") => {
    const v = raw(key);
    return v === null ? fallback : v;
  };
  const setText = (key, value) => {
    record(key);
    try { localStorage.setItem(key, value); return true; } catch { return false; }
  };

  const remove = (key) => {
    record(key);
    try { localStorage.removeItem(key); } catch { /* nothing to remove */ }
  };

  /* ---------- undo and redo ----------
     Written here and nowhere else, because this file is already the one place
     the app talks to localStorage: five modules and about twenty-five write
     sites all arrive at set(), so one change makes every one of them
     undoable, including a module nobody has written yet.

     Three decisions that the obvious version gets wrong:

       1. Writes are grouped by tick, not one step per write. editTask calls
          save() and then syncLog() from a single click; ungrouped, marking a
          task Done would take two undo clicks and the first would leave the
          log disagreeing with the task.
       2. Only the data keys have history. Undoing "I changed the theme" with
          the same button that undoes "I deleted a task" makes the button
          unpredictable, and this file already draws that line for the backup.
       3. Deleted attachment bytes are held, not dropped, for as long as the
          step that deleted them can still be undone. An undo that gives you
          the task back and loses its screenshots is worse than no undo. */
  const DEPTH = 7;
  let undoStack = [];
  let redoStack = [];
  let pending = null;      // the step being collected this tick
  let replaying = false;   // true while undo/redo write, so they do not stack

  /** A snapshot of one key as it is right now, raw, null when absent. */
  const snap = (key) => raw(key);

  /**
   * Remember a key's value before it is overwritten.
   *
   * First write of the tick opens a step and schedules its close. Later writes
   * in the same tick join it, and a key written twice keeps its FIRST value -
   * that is the one undo has to return to.
   */
  function record(key) {
    if (replaying || !KEYS.data.includes(key)) return;
    if (!pending) {
      pending = { before: new Map(), blobs: [] };
      queueMicrotask(commit);
    }
    if (!pending.before.has(key)) pending.before.set(key, snap(key));
  }

  /** Close the tick's step and put it on the stack. */
  function commit() {
    const step = pending;
    pending = null;
    if (!step) return;
    // A write that changed nothing is not a step: undoing it would look like
    // the button doing nothing at all.
    let changed = false;
    for (const [k, before] of step.before) {
      step.before.set(k, before);
      if (snap(k) !== before) changed = true;
    }
    if (!changed) return dropBlobs(step);
    undoStack.push(step);
    while (undoStack.length > DEPTH) dropBlobs(undoStack.shift());
    // A new edit makes every redo unreachable, which is the only rule that
    // cannot produce a redo onto a state that no longer exists.
    redoStack.splice(0).forEach(dropBlobs);
    paint();
  }

  /**
   * Bytes whose owning step is gone are now genuinely deleted.
   *
   * Held only while the record that names them can still come back, so
   * nothing accumulates: a step that falls off the end of the stack, or is
   * discarded with the redo pile, takes its blobs with it.
   */
  function dropBlobs(step) {
    if (!step || !step.blobs || !step.blobs.length) return;
    const gone = step.blobs.splice(0);
    if (window.TrackerBlobs && window.TrackerBlobs.purge) window.TrackerBlobs.purge(gone);
  }

  /**
   * Hold an attachment's bytes against the step being written this tick.
   *
   * Called instead of deleting, by whatever is removing the record that names
   * them. With no step open the bytes are dropped at once, which is the right
   * answer for a delete that is not part of an undoable change.
   */
  function holdBlobs(ids) {
    const list = [...ids].filter(Boolean);
    if (!list.length) return;
    if (pending) { pending.blobs.push(...list); return; }
    const last = undoStack[undoStack.length - 1];
    if (last) last.blobs.push(...list);
    else if (window.TrackerBlobs && window.TrackerBlobs.purge) window.TrackerBlobs.purge(list);
  }

  /** Put a step's remembered values back, returning the state it replaced. */
  function apply(step) {
    const inverse = { before: new Map(), blobs: step.blobs };
    replaying = true;
    try {
      for (const [k, before] of step.before) {
        inverse.before.set(k, snap(k));
        if (before === null) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
        else { try { localStorage.setItem(k, before); } catch { /* ignore */ } }
      }
    } finally { replaying = false; }
    return inverse;
  }

  const canUndo = () => undoStack.length > 0;
  const canRedo = () => redoStack.length > 0;
  const undoDepth = () => undoStack.length;
  const redoDepth = () => redoStack.length;

  function undo() {
    if (!undoStack.length) return false;
    redoStack.push(apply(undoStack.pop()));
    while (redoStack.length > DEPTH) redoStack.shift();
    after();
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    undoStack.push(apply(redoStack.pop()));
    while (undoStack.length > DEPTH) undoStack.shift();
    after();
    return true;
  }

  function after() {
    paint();
    if (window.TrackerRender) window.TrackerRender();
  }

  /** The two buttons, told what they can do. Painted by app.js. */
  function paint() {
    if (window.TrackerPaintHistory) window.TrackerPaintHistory();
  }

  /**
   * A backup restore is not one edit, so it is not one undo.
   *
   * It replaces all twelve keys at once, and a single click silently
   * reverting an entire imported file is not something a button should be
   * able to do by accident. The history is cleared instead, which is honest:
   * what came before the restore is in the file you restored over.
   */
  function clearHistory() {
    undoStack.splice(0).forEach(dropBlobs);
    redoStack.splice(0).forEach(dropBlobs);
    pending = null;
    paint();
  }

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
    replaying = true;                        // a restore is not an undo step
    try {
      for (const k of KEYS.data) remove(k);  // replace, not merge
      for (const [k, v] of entries) setText(k, v);
    } finally { replaying = false; }
    clearHistory();
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
                          exportData, importData, saveToFile, restoreFromFile, openBackupDialog,
                          undo, redo, canUndo, canRedo, undoDepth, redoDepth,
                          holdBlobs, clearHistory, DEPTH };
})();
