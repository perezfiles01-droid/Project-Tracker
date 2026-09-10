/* The one place this app talks to localStorage.

   Eleven keys were read and written by twenty-five direct localStorage calls
   across five modules. Nothing owned the list, so "save everything to a file"
   had nothing to enumerate and a key added later would simply be missed by
   the backup - silently, and only discovered when a restore came back short.

   Every module goes through here now, and KEYS below is the definition of
   what this app stores. Adding a key to that list is what puts it in the
   backup; a check fails the build if a module reaches past this file. */
(() => {
  /* ---------- blob bytes ----------
     Lifted out of tasks.js, which owned the only IndexedDB in the app while
     four of the seven rich fields live in files that had none at all -
     links.js, projects.js and ui.js contained no reference to indexedDB
     between them. Duplicating the store would have given the app two
     databases that disagree about what exists.

     Same database and same object store, so nothing already saved moves or is
     re-keyed: an attachment written by the previous version is read by this
     one without migration. */
  const BLOB_DB = "tracker-files", BLOB_STORE = "blobs";
  const idb = () => new Promise((resolve, reject) => {
    const r = indexedDB.open(BLOB_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(BLOB_STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const putBlob = async (id, blob) => {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BLOB_STORE, "readwrite");
      tx.objectStore(BLOB_STORE).put(blob, id);
      tx.oncomplete = () => resolve(id); tx.onerror = () => reject(tx.error);
    });
  };
  const getBlob = async (id) => {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const rq = db.transaction(BLOB_STORE, "readonly").objectStore(BLOB_STORE).get(id);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => reject(rq.error);
    });
  };
  const dropBlob = async (id) => {
    const db = await idb();
    return new Promise((resolve) => {
      const tx = db.transaction(BLOB_STORE, "readwrite");
      tx.objectStore(BLOB_STORE).delete(id);
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
  };
  const listBlobs = async () => {
    const db = await idb();
    return new Promise((resolve) => {
      const rq = db.transaction(BLOB_STORE, "readonly").objectStore(BLOB_STORE).getAllKeys();
      rq.onsuccess = () => resolve([...rq.result]);
      rq.onerror = () => resolve([]);
    });
  };

  /**
   * One id per stored blob, unguessable enough that two written in the same
   * millisecond cannot collide.
   */
  const blobId = (prefix) =>
    (scope ? scope + "-" : "") + prefix + "-" + Date.now() + "-" +
    Math.random().toString(36).slice(2, 7);

  /**
   * The bytes store, for every module.
   *
   * purge is called by the undo history and by nothing else: a deleted blob's
   * id is held against the step that removed it, and the bytes are deleted for
   * real only once that step can no longer be undone.
   */
  window.TrackerBlobs = {
    put: putBlob, get: getBlob, list: listBlobs, id: blobId,
    purge: (ids) => { for (const id of ids) dropBlob(id).catch(() => {}); },
  };

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
      // How big you want a rich-text table drawn, on this screen. A setting
      // and not data, so it stays out of the backup with the theme: the size
      // you read a table at is a fact about this device, not about the update,
      // and nothing about it is written into anyone's saved text.
      "tracker.tableZoom",
    ],
  };
  const ALL = [...KEYS.data, ...KEYS.settings];

  /* ---------- account scope ----------
     Every key above is a logical name. What actually reaches localStorage is
     that name with the signed-in account's id appended, so two accounts on
     one computer never read a byte of each other's tracker.

     This is deliberately the ONLY place the mapping happens. Four functions -
     raw, set, setText, remove - are the whole door to storage for five
     modules and twenty-one keys, and check_storage.mjs fails the build if a
     module reaches past them. So one mapper here scopes every key the app has
     and every key anyone adds later, without another file being touched.

     With no scope set the key is unchanged. That is not a loophole, it is the
     offline standalone file and the moment before sign-in, where there is no
     account to scope to and nothing is rendered anyway. */
  let scope = "";
  const scoped = (key) => (scope ? key + "::" + scope : key);
  const getScope = () => scope;

  /**
   * Point the store at an account, or at nothing on sign-out.
   *
   * The history is cleared on every change, and that is not tidiness: a step
   * remembers a key's previous bytes, so an undo left on the stack across a
   * sign-in would write one account's content into another account's key.
   */
  function setScope(id) {
    const next = id ? String(id) : "";
    if (next === scope) return scope;
    scope = next;
    clearHistory();
    return scope;
  }

  /* ---------- who is signed in ----------
     Deliberately NOT one of the keys above, and deliberately NOT scoped: it
     is the pointer that SELECTS the scope, so scoping it would make it
     unreadable until you were already signed in, which is a circle.

     It holds an id and a display name and nothing else. No password, no
     token, no key - a credential in localStorage would be readable by
     anything that can read the tracker it is supposed to protect.

     It lives here rather than in account.js because this file is the only
     one allowed to touch localStorage, and check_storage.mjs fails the build
     if that stops being true. */
  const SESSION = "tracker.session";
  const getSession = () => {
    try { return JSON.parse(localStorage.getItem(SESSION) || "null"); } catch { return null; }
  };
  const setSession = (who) => {
    try {
      if (who) localStorage.setItem(SESSION, JSON.stringify({ id: who.id, name: who.name || "", email: who.email || "", kind: who.kind || "" }));
      else localStorage.removeItem(SESSION);
    } catch { /* storage blocked; the session simply does not survive a reload */ }
  };

  /** Raw string read. Returns null when absent, like localStorage itself. */
  const raw = (key) => {
    try { return localStorage.getItem(scoped(key)); } catch { return null; }
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

  /* ---------- the sync layer, when there is one ----------
     store.js does not know what TrackerSync is or where it writes. It only
     says which key changed. That keeps this file the owner of storage
     whether or not the app is signed in to anything, and it means a key
     added later is synced without this file being edited.

     Only the data keys go. A setting is a fact about this device - the
     theme, the table zoom, the Google client id pasted into this browser -
     and belongs in the machine it was set on, exactly as the backup already
     decides.

     quietSet is the way back in. A value that arrived from your other
     computer is not something you did on this one, so it must not land in
     the undo history: undoing it would "restore" a state this browser was
     never in. */
  const notify = (key) => {
    if (replaying || !KEYS.data.includes(key)) return;
    try { window.TrackerSync && window.TrackerSync.changed(key); }
    catch { /* a sync failure must never take a local write down with it */ }
  };
  const quietSet = (key, value) => {
    replaying = true;
    try {
      if (value === null || value === undefined) remove(key);
      else setText(key, value);
    } finally { replaying = false; }
  };

  const set = (key, value) => {
    record(key);
    try { localStorage.setItem(scoped(key), JSON.stringify(value)); }
    catch { return false; }
    notify(key);
    return true;
  };

  /** For the two plain strings (client id, api key) that are not JSON. */
  const getText = (key, fallback = "") => {
    const v = raw(key);
    return v === null ? fallback : v;
  };
  const setText = (key, value) => {
    record(key);
    try { localStorage.setItem(scoped(key), value); } catch { return false; }
    notify(key);
    return true;
  };

  const remove = (key) => {
    record(key);
    try { localStorage.removeItem(scoped(key)); } catch { /* nothing to remove */ }
    notify(key);
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
        if (before === null) { try { localStorage.removeItem(scoped(k)); } catch { /* ignore */ } }
        else { try { localStorage.setItem(scoped(k), before); } catch { /* ignore */ } }
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

  /* ---------- pictures and files in the backup ----------
     This app has two stores. What you type is in localStorage under the data
     keys above; the BYTES of every picture and attachment are in IndexedDB.
     The backup used to read only the first, so the file carried
     <img data-blob="img-123"> - the reference - and never the bytes behind
     it. Restored on another computer, paintImages asked for those bytes, got
     nothing, and left the <img> with no src at all: a missing picture, no
     error, nothing in the console.

     Which blobs go in the file is decided by ENUMERATING THE BLOB STORE and
     keeping every id that appears anywhere in the exported data. Not by
     walking the six places a picture can currently be referenced from -
     attachments, a task description, an update's images, an update's text,
     the activity log, a project's rich text - because that list is stale the
     moment someone adds a seventh field, and the seventh is exactly the one
     that would go missing silently, which is this bug again. */

  const b64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error || new Error("unreadable"));
    r.readAsDataURL(blob);
  });

  const unb64 = (data, type) => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || "" });
  };

  /** Every stored blob the exported data actually refers to. */
  async function collectBlobs(payload) {
    const hay = JSON.stringify(payload.keys || {});
    let ids = [];
    try { ids = await listBlobs(); } catch { return {}; }
    const out = {};
    for (const id of ids) {
      if (!hay.includes(id)) continue;          // referenced by nothing exported
      try {
        const blob = await getBlob(id);
        if (!blob) continue;
        out[id] = { type: blob.type || "", data: await b64(blob) };
      } catch { /* one unreadable picture must not lose the whole backup */ }
    }
    return out;
  }

  /**
   * The whole backup: the data AND the bytes it refers to.
   *
   * Async because IndexedDB is. exportData below stays synchronous and
   * byte-free - it is what the dialog counts with, and what a caller wanting
   * just the text still gets.
   */
  async function exportFile() {
    const payload = exportData();
    const blobs = await collectBlobs(payload);
    return { ...payload, version: 2, blobs };
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
  async function importData(payload) {
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

    /* Pictures, when the file has any. A version 1 file has none and restores
       exactly as it always did - your existing backups keep working, they
       simply never held the bytes.

       Decoded in full BEFORE anything is written, and written BEFORE the
       keys, so the two ways this can go wrong both leave storage as it was:
       a damaged picture throws while nothing has changed, and a failure
       putting the bytes down happens while the text is still the old text. */
    const blobs = payload.blobs;
    const decoded = [];
    if (blobs !== undefined && blobs !== null) {
      if (typeof blobs !== "object") throw new Error("The backup is damaged and was not loaded.");
      for (const [id, rec] of Object.entries(blobs)) {
        if (!rec || typeof rec !== "object" || typeof rec.data !== "string") {
          throw new Error("The pictures in that backup are damaged, so nothing was loaded.");
        }
        try { decoded.push([id, unb64(rec.data, rec.type)]); }
        catch { throw new Error("The pictures in that backup are damaged, so nothing was loaded."); }
      }
    }
    for (const [id, blob] of decoded) {
      try { await putBlob(id, blob); }
      catch { throw new Error("There was no room to store the pictures, so nothing was loaded."); }
    }

    replaying = true;                        // a restore is not an undo step
    try {
      for (const k of KEYS.data) remove(k);  // replace, not merge
      for (const [k, v] of entries) setText(k, v);
    } finally { replaying = false; }
    clearHistory();
    /* A restore is the one write that would otherwise never reach the account.
       It runs with replaying set - it is not an undo step - and that same flag
       suppresses the sync notification, so the file you just loaded would sit
       in this browser while your other computer kept the old copy and pushed
       it back over the top. Every data key is announced once, here, after the
       flag is down. */
    for (const k of KEYS.data) notify(k);
    return entries.length;
  }

  /* ---------- Save as file / Restore from file ---------- */

  async function saveToFile() {
    const payload = await exportFile();
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `project-tracker-backup-${payload.savedAt.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    return { keys: Object.keys(payload.keys).length,
             blobs: Object.keys(payload.blobs || {}).length };
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
        reader.onload = async () => {
          try {
            const parsed = JSON.parse(String(reader.result));
            const n = await importData(parsed);
            const pics = Object.keys(parsed.blobs || {}).length;
            resolve({ ok: true, message: `Restored ${n} item group${n === 1 ? "" : "s"}`
              + (pics ? `, with ${pics} picture${pics === 1 ? "" : "s"}.`
                      : `. This file carried no pictures — it was saved by an older version, `
                        + `so take a fresh backup on the computer that still has them.`) });
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
      await saveToFile();
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
                          setScope, getScope, getSession, setSession, quietSet,
                          exportData, exportFile, importData, saveToFile, restoreFromFile, openBackupDialog,
                          undo, redo, canUndo, canRedo, undoDepth, redoDepth,
                          holdBlobs, clearHistory, DEPTH };
})();
