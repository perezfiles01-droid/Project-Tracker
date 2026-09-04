#!/usr/bin/env python3
"""Stamp a version onto every local asset URL in the HTML that gets deployed.

Why this exists. GitHub Pages revalidates HTML more eagerly than it
revalidates assets/*.js, so for a window after each deploy a returning visitor
gets the NEW index.html wired to the OLD scripts. That mix is silent: no
console error, no missing file, just controls that render empty because the
JavaScript behind them is a version older than the markup.

That happened, and it was reproduced exactly by pairing a new index.html with
the previous deploy's drive.js and ai.js.

The fix is to make the URL change whenever the deploy changes. A fresh page
then names files the cache has never seen, so the JavaScript cannot be stale.

Run it in the Pages workflow before the artifact is uploaded:

    python3 scripts/stamp_assets.py <version>

with no arguments it uses the current git commit. It edits the files in place,
which is fine in CI because the checkout is disposable. Nothing about local
use or Tracker-standalone.html changes: both carry no stamps and need none.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Every HTML file that is served and references assets. Found by scanning, so
# a page added later is stamped without editing this list.
PAGES = sorted(p for p in ROOT.glob("*.html") if p.name != "Tracker-standalone.html")

# src="assets/x.js" or href="assets/x.css", but never a full URL and never
# something already stamped.
LOCAL_ASSET = re.compile(r'((?:src|href)=")((?!https?://|//|#|data:)[^"?]+\.(?:js|css))(")')
# The same reference once it already carries a stamp. Counted so that running
# twice is a no-op that SUCCEEDS: without this, a second run reports "nothing
# stamped" and fails, which is indistinguishable from a page that has no
# assets at all - the very confusion this script's exit code exists to avoid.
ALREADY = re.compile(r'(?:src|href)="(?!https?://|//|#|data:)[^"]+\.(?:js|css)\?v=')


def version() -> str:
    if len(sys.argv) > 1 and sys.argv[1].strip():
        return sys.argv[1].strip()
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return "dev"


def stamp(html: str, v: str) -> tuple[str, int]:
    n = 0

    def one(m):
        nonlocal n
        n += 1
        return f"{m.group(1)}{m.group(2)}?v={v}{m.group(3)}"

    return LOCAL_ASSET.sub(one, html), n


def main() -> int:
    v = version()
    stamped = already = 0
    for page in PAGES:
        text = page.read_text()
        was = len(ALREADY.findall(text))
        out, n = stamp(text, v)
        if n:
            page.write_text(out)
        note = f" ({was} already stamped)" if was else ""
        print(f"{page.name}: stamped {n} asset reference(s) with ?v={v}{note}")
        stamped += n
        already += was
    if not stamped and not already:
        # A stamper that silently finds nothing looks exactly like one that ran
        # correctly on a page with no assets. Say which happened, and fail, so
        # a refactor that moves the script tags cannot pass unnoticed.
        print("stamp_assets: no local asset references found, nothing stamped",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
