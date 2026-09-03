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
projects = (root / "assets" / "projects.js").read_text()
ui = (root / "assets" / "ui.js").read_text()
tasks = (root / "assets" / "tasks.js").read_text()
links = (root / "assets" / "links.js").read_text()
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
    '<script src="config.js"></script>\n<script src="assets/ui.js"></script>\n'
    '<script src="assets/tasks.js"></script>\n<script src="assets/projects.js"></script>\n'
    '<script src="assets/links.js"></script>\n'
    '<script src="assets/app.js"></script>\n'
    '<script src="assets/drive.js"></script>',
    "<script>\n" + cfg + "\nwindow.TRACKER_DATA = " + json.dumps(data) + ";\n</script>\n"
    "<script>\n" + ui + "\n</script>\n<script>\n" + tasks + "\n</script>\n"
    "<script>\n" + projects + "\n</script>\n"
    "<script>\n" + links + "\n</script>\n"
    "<script>\n" + app + "\n</script>\n<script>\n" + drive + "\n</script>",
)

# The script-tag replacement above is one long literal: adding a file to the
# search half and forgetting the replacement half consumes its tag and drops
# the file silently, which is exactly what happened once. Fail loudly instead.
# Checked by exact body, not by a marker line: every module ends with "})();"
# so a last-line marker matches a sibling's copy and reports success while the
# file is missing — which is how this check first failed to catch anything.
inlined = {"ui.js": ui, "tasks.js": tasks, "projects.js": projects,
           "links.js": links, "app.js": app, "drive.js": drive}
for js in sorted((root / "assets").glob("*.js")):
    if js.name not in inlined:
        raise SystemExit(f"build_standalone: {js.name} is not wired into the "
                         "standalone build — add it to the script-tag replacement")
    if inlined[js.name] not in html:
        raise SystemExit(f"build_standalone: {js.name} was not inlined — "
                         "check the script-tag replacement")
if 'src="assets' in html or 'src="config.js"' in html:
    raise SystemExit("build_standalone: a script tag was left unreplaced")
html = html.replace("<title>Project Tracker —", "<title>Project Tracker (standalone) —")

dest = root / "Tracker-standalone.html"
dest.write_text(html)
print(f"wrote {dest} ({dest.stat().st_size // 1024} KB)")
