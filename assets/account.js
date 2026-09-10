/* Who is using this tracker.

   Everything you author is stored under a key that carries your account id
   (assets/store.js), so two accounts on one computer never see each other's
   tasks, log, projects or links. This file decides what that id is, and
   holds the page shut until it knows.

   Two modes, decided by where the page is running:

     hosted   - served over http(s). A sign-in screen, and nothing of the
                tracker is drawn until it is passed.
     offline  - the standalone file opened straight from disk. There is no
                web origin there, so no hosted sign-in can work at all; it
                runs as a single local account and says so rather than
                locking you out of your own file.

   The identity provider itself is deliberately not in here twice: signIn()
   asks TrackerAuth, which account.js works without. With no provider wired
   up the screen offers the device account alone, so the site keeps working
   while its Firebase project is still being set up. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* The id used when there is no hosted identity: one account, this device.

     It is deliberately the EMPTY id, which store.js maps to the unscoped
     keys. Two reasons, and the second is the one that matters:

       1. "this computer only" is exactly what the unscoped namespace already
          means - one tracker per browser, which is what this app was before
          accounts existed.
       2. It makes the upgrade free. Everything anyone has already written is
          in those unscoped keys, and giving the device account an id of its
          own would have hidden every existing tracker behind a migration on
          first load. Instead the tracker you had is simply the device
          account, and signing in with Google starts the empty one. */
  const DEVICE_ID = "";

  const hosted = () => location.protocol.startsWith("http");

  let user = null;      // { id, name, email, kind } or null
  let notice = "";
  let busy = false;

  const current = () => user;

  /** The provider, if one has been wired up. Absent is a supported state. */
  const auth = () => (window.TrackerAuth && window.TrackerAuth.available() ? window.TrackerAuth : null);

  /**
   * Take an account and point the whole app at it.
   *
   * setScope is what actually isolates the data; the session pointer is only
   * so a reload comes back to the same account rather than to the screen.
   */
  function adopt(who) {
    user = who || null;
    window.TrackerStore.setScope(user ? user.id : "");
    window.TrackerStore.setSession(user);
    if (window.TrackerRender) window.TrackerRender();
  }

  async function signOut() {
    const a = auth();
    if (a && user && user.kind !== "device") { try { await a.signOut(); } catch { /* local sign-out still stands */ } }
    notice = "";
    adopt(null);
  }

  /* ---------- the screen ---------- */

  function view() {
    const a = auth();
    const rows = [];
    if (a) {
      rows.push(`<button class="btn primary wide" id="acctGoogle"${busy ? " disabled" : ""}>Continue with Google</button>
        <div class="acct-or"><span>or</span></div>
        <form id="acctForm" autocomplete="on">
          <div class="field"><label for="acctEmail">Email</label>
            <input id="acctEmail" type="email" required autocomplete="email" placeholder="you@example.com"></div>
          <div class="field"><label for="acctPass">Password</label>
            <input id="acctPass" type="password" required autocomplete="current-password"
                   minlength="6" placeholder="At least 6 characters"></div>
          <div class="acct-actions">
            <button class="btn primary" type="submit" data-acct="signin"${busy ? " disabled" : ""}>Sign in</button>
            <button class="btn" type="submit" data-acct="register"${busy ? " disabled" : ""}>Create account</button>
          </div>
        </form>`);
    } else {
      rows.push(`<p class="lede">Sign-in is not set up on this site yet, so the tracker
        is running as a single account on this computer. Anyone using this browser
        sees it. Setting up the Firebase project in <code>README.md</code> turns on
        Google sign-in and accounts that follow you to another computer.</p>`);
    }
    if (!hosted()) {
      rows.length = 0;
      rows.push(`<p class="lede">This is the offline copy, opened straight from disk.
        There is no web address here for a sign-in to work against, so it keeps one
        tracker for this computer. Use the hosted site if you want separate accounts.</p>`);
    }
    return `<div class="acct-gate">
      <div class="acct-box">
        <div class="brand"><div class="dot">T</div>
          <h1>Project Tracker<span>Sign in to see your own tracker</span></h1></div>
        ${notice ? `<div class="acct-notice">${esc(notice)}</div>` : ""}
        ${rows.join("")}
        <div class="acct-foot">
          <button class="btn" id="acctDevice"${busy ? " disabled" : ""}>Use this computer only</button>
          <small>Keeps everything in this browser, with no account. It stays on this
            computer and is not carried to another one.</small>
        </div>
      </div>
    </div>`;
  }

  /** The signed-in identity, and the way out, for the sidebar. */
  function sidebar() {
    if (!user) return "";
    const who = user.name || user.email || "This computer";
    const sub = user.kind === "device" ? "this computer only" : (user.email || "signed in");
    return `<div class="acct-who">
        <div class="acct-name" title="${esc(user.email || who)}">${esc(who)}</div>
        <div class="acct-sub">${esc(sub)}</div>
      </div>
      <button id="acctOut">Sign out</button>`;
  }

  /* ---------- events ---------- */

  async function run(fn) {
    busy = true; notice = ""; window.TrackerRender();
    try {
      const who = await fn();
      if (who) return adopt(who);
    } catch (e) {
      notice = e && e.message ? e.message : "That did not work. Try again.";
    } finally { busy = false; }
    window.TrackerRender();
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("#acctOut")) return signOut();
    if (e.target.closest("#acctDevice")) {
      return adopt({ id: DEVICE_ID, name: "This computer", email: "", kind: "device" });
    }
    if (e.target.closest("#acctGoogle")) {
      const a = auth(); if (a) run(() => a.signInWithGoogle());
      return;
    }
    const btn = e.target.closest("[data-acct]");
    if (btn) btn.form && (btn.form.dataset.intent = btn.dataset.acct);
  });

  document.addEventListener("submit", (e) => {
    const form = e.target.closest("#acctForm");
    if (!form) return;
    e.preventDefault();
    const a = auth(); if (!a) return;
    const email = $("#acctEmail").value.trim();
    const pass = $("#acctPass").value;
    const intent = form.dataset.intent === "register" ? "register" : "signin";
    run(() => (intent === "register" ? a.register(email, pass) : a.signIn(email, pass)));
  });

  /* ---------- boot ---------- */

  /**
   * Decide who is signed in, before the first render.
   *
   * Offline goes straight to the device account. Hosted asks the provider
   * first - it may already hold a session from last time - and falls back to
   * the pointer left by a previous visit, which is what makes a reload come
   * back to your own tracker instead of to this screen.
   */
  async function init() {
    if (!hosted()) {
      adopt({ id: DEVICE_ID, name: "This computer", email: "", kind: "device" });
      return;
    }
    const a = auth();
    if (a) {
      try {
        const who = await a.restore();
        if (who) return adopt(who);
      } catch { /* fall through to the pointer, then to the screen */ }
    }
    const last = window.TrackerStore.getSession();
    // Only a device account can be restored from the pointer alone. A hosted
    // account must come back from the provider, or anyone could sign in as
    // anyone by editing one line of storage.
    if (last && last.kind === "device") return adopt(last);
    adopt(null);
  }

  window.TrackerAccount = { current, view, sidebar, signOut, init, DEVICE_ID };
})();
