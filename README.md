# Tracker

A single, searchable index of every link, site and document used across my
Business Analyst projects — currently **GLASS**, **EDRMS ADB** and the **LHUB**
Jira intake role — generated from `BA_Master_Tracker.xlsx` and served as a static
site.

> ⚠️ This repository is **public** so that GitHub Pages is free. Account email
> addresses in `data/tracker.json` are masked, `robots.txt` and a `noindex` tag
> keep it out of search engines, and the source workbook is git-ignored. The
> SharePoint URLs are published as-is — they all require a login.

## What's in here

| Path | What it is |
| --- | --- |
| `index.html`, `assets/` | The site: sidebar navigation, global search, filters, sortable tables |
| `data/tracker.json` | Generated data — the only file the site reads |
| `scripts/build_data.py` | Converts the workbook into `data/tracker.json` |
| `BA_Master_Tracker.xlsx` | The source workbook — **upload this yourself** (see below) |
| `config.js` | Optional Google client ID / API key defaults (leave blank) |
| `.github/workflows/` | Pages deployment + data rebuild |

## Pages in the site

- **Overview** — every tracked link as a card, with a live count and a "links to
  verify" figure.
- **GLASS** — CR documents, UAT cases, master data, user guide.
- **EDRMS ADB** — all 28 sites and documents with the account each one needs,
  the Release 2026.2 concerns table, and the five release phases with their
  source links.
- **LHUB** — working links, the clarification checklist for the remote BA, and
  the numbered Jira epic/story/sub-task creation steps.
- **Daily activity** — the daily log, filterable by project and sortable by any column.
- **Communications** — Teams/WeCom updates with owner, due date and status.
- **Google Drive** — see below.

Press <kbd>/</kbd> anywhere to jump to the search box. Search covers every page.

## Running it locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` straight from disk will not work — browsers block `fetch()`
on `file://` URLs, and the page will tell you so.

## Updating the data

The workbook itself is not in the initial commit (it is a binary file and holds
client data). Upload it once via **Add file → Upload files** in the GitHub web UI,
or `git add BA_Master_Tracker.xlsx` locally, so the rebuild workflow can find it.

1. Replace `BA_Master_Tracker.xlsx` with your latest copy.
2. `pip install openpyxl && python3 scripts/build_data.py BA_Master_Tracker.xlsx`
3. Commit `data/tracker.json`.

Pushing a new workbook to `main` also triggers `.github/workflows/rebuild-data.yml`,
which does steps 2–3 for you.

### About "check link" badges

Some hyperlinks were stored in Excel as *relative* paths (`../../../:x:/r/sites/...`)
because the workbook itself lives in SharePoint. The build script re-roots those on
`https://avepointcrm.sharepoint.com/`, which is right for the
`Gen_ADB_DRM_Internal` and `Jim'sSite` links but is a guess for a couple of others.
Those are flagged with an amber **check link** badge — open each one once and, if it
is wrong, fix the hyperlink in the workbook and rebuild.

## Connecting Google Drive

The site is static, so there is no server to hold a secret. It uses Google
Identity Services in the browser to get a read-only Drive token, which lives in
memory only and is never stored or transmitted anywhere but Google.

One-time setup:

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → choose *Internal* if your Google
   Workspace allows it, otherwise *External*; add yourself as a test user; add the
   scope `.../auth/drive.readonly`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Web application**. Under *Authorised JavaScript origins* add:
   - `http://localhost:8000` (for local use)
   - your live site origin, e.g. `https://<your-username>.github.io`
5. Copy the Client ID. Optionally also create an **API key** on the same page.
6. Open the site → **Settings** in the sidebar → paste the Client ID (and API key)
   → **Save**. They are kept in your browser's `localStorage`, never in git.
7. Go to **Google Drive** in the sidebar → **Connect Google Drive**.

You can then browse your recent Drive files and **pin** any of them into the
tracker; pinned links appear on the Overview page and in search. **Add a link
manually** does the same for any URL at all (SharePoint, Jira, Azure DevOps).

Pinned links live in your browser. Use **Export JSON** in the top bar to take a
copy, or paste the permanent ones into the workbook so they become part of the
generated data.

> If you would rather have Drive links shared across devices and teammates, that
> needs a small backend (a service account plus a scheduled job writing a
> `data/drive.json`) — not possible from a static page alone.

## Going live

GitHub Pages is already wired up in `.github/workflows/pages.yml`. To turn it on:

**Settings → Pages → Build and deployment → Source: GitHub Actions**, then run the
*Deploy site to GitHub Pages* workflow (or push any commit to `main`).

Because this repository is private, Pages requires a paid GitHub plan
(Pro / Team / Enterprise). The options are:

| Option | Trade-off |
| --- | --- |
| Keep private + GitHub Pro | ~$4/month, site is still visible to anyone with the URL |
| Make the repository public | Free, but every internal URL and work email in it becomes public — **not recommended** |
| Run it locally only | Free and fully private, `python3 -m http.server` |
| Deploy to Netlify/Cloudflare Pages with password protection | Free tier, access-controlled, connects to this repository |

If you need it live *and* private, Cloudflare Pages with Cloudflare Access is the
cleanest free route.
