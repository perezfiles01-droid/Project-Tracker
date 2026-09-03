#!/usr/bin/env python3
"""Build Tracker-standalone.html — the whole site inlined into one file.

CSS, JS and data/tracker.json are embedded, so the file opens by double-clicking
with no web server. Run after build_data.py:

    python3 scripts/build_standalone.py
"""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
html = (root / "index.html").read_text()
css = (root / "assets" / "styles.css").read_text()
app = (root / "assets" / "app.js").read_text()
drive = (root / "assets" / "drive.js").read_text()
cfg = (root / "config.js").read_text()
data = json.loads((root / "data" / "tracker.json").read_text())

# The app fetches data/tracker.json; standalone reads a preloaded global instead.
app = app.replace(
    'fetch("data/tracker.json")\n    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })',
    'Promise.resolve(window.TRACKER_DATA)',
)

html = html.replace('<link rel="stylesheet" href="assets/styles.css">',
                    f"<style>\n{css}\n</style>")
html = html.replace('<link rel="icon" href="assets/favicon.svg">', "")
html = html.replace(
    '<script src="config.js"></script>\n<script src="assets/app.js"></script>\n<script src="assets/drive.js"></script>',
    "<script>\n" + cfg + "\nwindow.TRACKER_DATA = " + json.dumps(data) + ";\n</script>\n"
    "<script>\n" + app + "\n</script>\n<script>\n" + drive + "\n</script>",
)
html = html.replace("<title>Tracker —", "<title>Tracker (standalone) —")

dest = root / "Tracker-standalone.html"
dest.write_text(html)
print(f"wrote {dest} ({dest.stat().st_size // 1024} KB)")
