# Publishing Tracker on GitHub Pages (public)

The repository will be **public**, which is what makes GitHub Pages free.
Two safeguards are already applied:

- `robots.txt` and a `noindex` meta tag keep the site out of Google results.
- The account email addresses in `data/tracker.json` are masked
  (`ji…@avepoint.com`) so they cannot be scraped, while still telling you
  which account each site needs.

To publish the real addresses instead, rebuild without the flag:
`python3 scripts/build_data.py BA_Master_Tracker.xlsx` (no `--redact-emails`).

The SharePoint URLs themselves are published as-is. They all require a login,
so this exposes site names and structure, not documents.

---

## Steps 1 & 2 — Repository and files: DONE

`perezfiles01-droid/Project-Tracker` exists and I pushed every file to `main`
for you. Nothing to upload by hand.

## Step 3 — Turn on Pages

1. Repository **Settings** (top row of the repo, not your account settings)
2. **Pages** in the left sidebar
3. **Build and deployment → Source** → select **GitHub Actions**

That is the whole configuration — there is no Save button; selecting the source
is enough. The workflow in `.github/workflows/pages.yml` takes over.

## Step 4 — Watch the first deploy

Open the **Actions** tab. A run called *Deploy site to GitHub Pages* starts
within a few seconds and takes about a minute. Green tick = live.

Your URL: **https://perezfiles01-droid.github.io/Project-Tracker/**

It also appears back on Settings → Pages once the first deploy finishes.

If Actions shows nothing, you skipped step 3 — go back and set the source, then
**Actions → Deploy site to GitHub Pages → Run workflow**.

## Step 5 — Point Google OAuth at the live URL

<https://console.cloud.google.com/auth/clients> → click **Tracker site**

Under **Authorised JavaScript origins**, make sure this exact value is listed
(no trailing slash, no `/Tracker` path):

```
https://perezfiles01-droid.github.io
```

**Save.** Google takes a few minutes to propagate; if sign-in fails with
`redirect_uri_mismatch` or `origin_mismatch`, wait five minutes and retry.

## Step 6 — Connect Drive

1. Open <https://perezfiles01-droid.github.io/Project-Tracker/>
2. Sidebar → **Settings** → paste the **Client ID** → **Save**
3. Sidebar → **Google Drive** → **Connect Google Drive** → pick your account
4. On the "Google hasn't verified this app" screen: **Advanced → Go to Tracker
   (unsafe)**. That warning is expected for your own unverified app.
5. Your recent Drive files list — **Pin to tracker** on any of them

The Client ID is safe to have in a public site; Google client IDs are designed to
be visible. Pinned links are stored in your browser only.

## Updating it later

**Do not upload `BA_Master_Tracker.xlsx` to this repository.** It is a public
repository and the workbook holds the unredacted email addresses and every raw
link. `.gitignore` blocks it, and there is no rebuild workflow for that reason.

Instead, rebuild on your own machine and commit only the generated files:

```bash
python3 scripts/build_data.py BA_Master_Tracker.xlsx --redact-emails
python3 scripts/build_standalone.py
```

Then upload the changed `data/tracker.json` and `Tracker-standalone.html`
through the GitHub web UI. Pages redeploys automatically on every commit
to `main`.

No Python on your machine? Send me the updated workbook here and I will
regenerate both files for you to upload.

## Making it private again

Settings → General → bottom → **Change repository visibility → Private**.
Pages then stops serving unless you have GitHub Pro. The site keeps working
locally via `Tracker-standalone.html`.
