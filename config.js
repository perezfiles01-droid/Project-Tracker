/* Optional build-time defaults. Leave blank to configure in the UI (Settings),
   which stores the values in this browser's localStorage instead of in git. */
window.TRACKER_CONFIG = {
  googleClientId: "",   // e.g. "1234567890-abc.apps.googleusercontent.com"
  googleApiKey: "",     // e.g. "AIzaSy..."
  // Drive folder to open by default in the picker ("" = My Drive root).
  driveFolderId: "",

  /* Accounts. Paste the web config from your Firebase project here and the
     site gains Google sign-in, an email/password register and login, and a
     tracker that follows the account to another computer. Leave it blank and
     the site keeps working as one tracker for this browser.

     This block is NOT a secret and belongs in git: a Firebase web config
     identifies the project and grants nothing. What stops one account
     reading another is firestore.rules, which the server enforces.

     It lives here rather than in Settings because it is needed BEFORE anyone
     is signed in, and Settings is stored per account.

     Steps: README.md -> "Turning on accounts". */
  firebase: {
    apiKey: "",
    authDomain: "",        // e.g. "your-project.firebaseapp.com"
    projectId: "",
    appId: ""
  }
};
