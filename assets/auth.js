/* Firebase: who you are, and where your tracker is kept.

   Two things live here, both talking to the same project:

     TrackerAuth  - Google sign-in and an email/password register/login.
                    The account's uid becomes the scope every stored key
                    carries (assets/store.js), which is what makes one
                    person's tracker invisible to another's.
     TrackerSync  - the same content mirrored into Firestore under
                    accounts/{uid}, so signing in on another computer brings
                    your tracker with you, and so there is one place holding
                    every account.

   localStorage stays the working copy. Every module in this app reads it
   synchronously and none of them know this file exists; Firestore is a
   mirror, not a dependency of the render. So the tracker is instant, it
   survives a dropped connection, and it keeps working with no Firebase
   project configured at all - which is the state the site ships in until
   config.js is filled in.

   Nothing secret is in that config. A Firebase web config identifies the
   project; it grants nothing. What stops one account reading another is the
   Firestore rules in firestore.rules, enforced by the server. */
(() => {
  const SDK = "https://www.gstatic.com/firebasejs/10.12.5/";

  const cfg = () => {
    const c = window.TRACKER_CONFIG && window.TRACKER_CONFIG.firebase;
    return c && c.apiKey && c.projectId && c.appId ? c : null;
  };

  let mods = null;       // the loaded SDK
  let app = null, fbAuth = null, db = null;
  let loaded = false;    // resolved: the SDK is here and the project is real
  let tried = false;

  /**
   * Load Firebase, once.
   *
   * Returns false rather than throwing when there is no config or the CDN
   * cannot be reached - offline, blocked, or simply not set up yet. The app
   * falls back to the device account in that case, which is a working
   * tracker rather than a broken page.
   */
  async function ready() {
    if (tried) return loaded;
    tried = true;
    if (!cfg()) return false;
    try {
      const [core, auth, store] = await Promise.all([
        import(SDK + "firebase-app.js"),
        import(SDK + "firebase-auth.js"),
        import(SDK + "firebase-firestore.js"),
      ]);
      mods = { core, auth, store };
      app = core.initializeApp(cfg());
      fbAuth = auth.getAuth(app);
      db = store.getFirestore(app);
      // Survives a reload and a closed tab, which is what makes "sign in
      // once" true rather than "sign in on every visit".
      await auth.setPersistence(fbAuth, auth.browserLocalPersistence);
      loaded = true;
    } catch {
      loaded = false;
    }
    return loaded;
  }

  const available = () => loaded;

  /** Firebase's own wording is for developers. This is for the person. */
  function readable(e) {
    const code = (e && e.code) || "";
    if (code.includes("invalid-credential") || code.includes("wrong-password")
        || code.includes("user-not-found")) return "That email and password do not match an account.";
    if (code.includes("email-already-in-use")) return "There is already an account with that email. Sign in instead.";
    if (code.includes("weak-password")) return "That password is too short. Use at least six characters.";
    if (code.includes("invalid-email")) return "That does not look like an email address.";
    if (code.includes("popup-closed") || code.includes("cancelled-popup")) return "The Google window closed before you finished.";
    if (code.includes("popup-blocked")) return "Your browser blocked the Google window. Allow pop-ups for this site.";
    if (code.includes("network")) return "No connection to the sign-in service. Check your network.";
    if (code.includes("operation-not-allowed")) return "That way of signing in is not switched on in the Firebase project yet.";
    if (code.includes("unauthorized-domain")) return "This address is not in the Firebase project's authorised domains.";
    return (e && e.message) || "That did not work. Try again.";
  }

  const shape = (u) => (u ? {
    id: u.uid,
    name: u.displayName || (u.email || "").split("@")[0] || "Signed in",
    email: u.email || "",
    kind: "hosted",
  } : null);

  /**
   * Record the account itself, so there is a list of them to look at.
   *
   * Written on every sign-in rather than only on registration: an account
   * created before this existed, or through the Firebase console, still
   * appears the first time its owner signs in.
   */
  async function profile(u) {
    if (!db || !u) return;
    const { doc, setDoc, serverTimestamp } = mods.store;
    try {
      await setDoc(doc(db, "accounts", u.uid), {
        email: u.email || "", name: u.displayName || "",
        provider: (u.providerData && u.providerData[0] && u.providerData[0].providerId) || "",
        lastSignIn: serverTimestamp(),
      }, { merge: true });
    } catch { /* a profile that could not be written must not block a sign-in */ }
  }

  async function finish(cred) {
    const who = shape(cred.user);
    await profile(cred.user);
    return who;
  }

  async function signInWithGoogle() {
    if (!loaded) throw new Error("Sign-in is not available.");
    const { GoogleAuthProvider, signInWithPopup } = mods.auth;
    try { return await finish(await signInWithPopup(fbAuth, new GoogleAuthProvider())); }
    catch (e) { throw new Error(readable(e)); }
  }

  async function signIn(email, password) {
    if (!loaded) throw new Error("Sign-in is not available.");
    try { return await finish(await mods.auth.signInWithEmailAndPassword(fbAuth, email, password)); }
    catch (e) { throw new Error(readable(e)); }
  }

  async function register(email, password) {
    if (!loaded) throw new Error("Sign-in is not available.");
    try { return await finish(await mods.auth.createUserWithEmailAndPassword(fbAuth, email, password)); }
    catch (e) { throw new Error(readable(e)); }
  }

  /** The session Firebase is already holding, if any. */
  function restore() {
    if (!loaded) return Promise.resolve(null);
    return new Promise((resolve) => {
      const stop = mods.auth.onAuthStateChanged(fbAuth, (u) => {
        stop();
        if (u) profile(u);
        resolve(shape(u));
      }, () => { stop(); resolve(null); });
    });
  }

  async function signOut() {
    if (loaded) { try { await mods.auth.signOut(fbAuth); } catch { /* local sign-out still stands */ } }
  }

  window.TrackerAuth = { ready, available, signInWithGoogle, signIn, register, restore, signOut };

  /* ---------- the mirror ---------- */

  /**
   * The Firestore backend, behind an interface of two functions.
   *
   * Two functions and not a direct call, so a check can put a fake one in and
   * assert what the sync layer does with what comes back - which is where the
   * bugs are - without a Firebase project and a network.
   */
  const firestoreBackend = {
    async load(uid) {
      const { collection, getDocs } = mods.store;
      const out = {};
      const snap = await getDocs(collection(db, "accounts", uid, "keys"));
      snap.forEach((d) => { const v = d.data(); if (typeof v.value === "string") out[d.id] = v.value; });
      return out;
    },
    async save(uid, key, value) {
      const { doc, setDoc, deleteDoc, serverTimestamp } = mods.store;
      const ref = doc(db, "accounts", uid, "keys", key);
      if (value === null) return deleteDoc(ref);
      return setDoc(ref, { value, at: serverTimestamp() });
    },
  };

  let backend = null;
  let uid = "";
  let queue = new Map();
  let timer = null;
  let last = "";

  /**
   * Pull an account's tracker down, and point the mirror at it.
   *
   * Written through quietSet, so nothing arriving from your other computer
   * appears in this browser's undo history: undoing it would "restore" a
   * state this browser was never in.
   *
   * An account with nothing stored yet keeps whatever is already on screen
   * and pushes it up, which is what makes the first sign-in carry your work
   * with you instead of throwing it away.
   */
  async function start(who) {
    stop();
    if (!who || who.kind !== "hosted") return;
    backend = backend || (loaded ? firestoreBackend : null);
    if (!backend) return;
    /* The store must already be pointed at this account. If it is not,
       every quietSet below would file this account's tracker under whichever
       account is currently open - which is the exact cross-account write the
       scoping exists to prevent, arriving through the back door. Refuse
       rather than guess. */
    if (window.TrackerStore.getScope() !== who.id) return;
    uid = who.id;
    let remote = {};
    try { remote = await backend.load(uid); } catch { return; }
    const keys = window.TrackerStore.KEYS.data;
    const names = Object.keys(remote).filter((k) => keys.includes(k));
    if (names.length) {
      for (const k of keys) window.TrackerStore.quietSet(k, remote[k] ?? null);
      if (window.TrackerStore.clearHistory) window.TrackerStore.clearHistory();
      if (window.TrackerRender) window.TrackerRender();
    } else {
      for (const k of keys) changed(k);
    }
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    queue = new Map(); uid = "";
  }

  /**
   * A key changed locally. Debounced, because typing in a task description
   * writes on every keystroke and a write per keystroke is a write per
   * keystroke billed, sent and raced.
   */
  function changed(key) {
    if (!backend || !uid) return;
    queue.set(key, true);
    if (timer) return;
    timer = setTimeout(flush, 800);
  }

  async function flush() {
    timer = null;
    if (!backend || !uid) return;
    const keys = [...queue.keys()];
    queue.clear();
    for (const k of keys) {
      // Read at flush time, not at change time: the value that matters is the
      // one it settled on, not the one it passed through.
      const value = window.TrackerStore.getText(k, "") || null;
      try { await backend.save(uid, k, value); last = k; } catch { /* try again on the next change */ }
    }
  }

  window.TrackerSync = {
    changed, start, stop, flush,
    /* Test seam. The Firestore backend is the default in a real browser; a
       check puts its own in so the pull-and-push logic is assertable without
       a Firebase project. */
    _use: (b) => { backend = b; },
    _state: () => ({ uid, queued: [...queue.keys()], last }),
  };
})();
