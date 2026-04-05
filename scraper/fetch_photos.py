#!/usr/bin/env python3
"""
MPLADS Watch — One-time MP Photo Enrichment Script
Reads mps.json, queries Wikipedia API for each MP,
writes confirmed wiki_title + thumbnail URLs back to mps.json.

Run manually once:
    python scraper/fetch_photos.py
    python scraper/fetch_photos.py --dry-run   # preview without writing

DO NOT add to the weekly GitHub Actions workflow.
Photos are fetched at runtime in the browser (see app.js IntersectionObserver).
This script enriches wiki_title fields and validates them in advance.
"""

import json
import time
import sys
import argparse
import logging
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
MP_JSON  = DATA_DIR / "mps.json"

WIKI_API = "https://en.wikipedia.org/w/api.php"
HEADERS  = {
    "User-Agent": (
        "MPLADSWatch/1.0 (https://github.com/mplads-watch; "
        "citizen accountability tool; one-time photo enrichment)"
    ),
}

REQUEST_DELAY   = 0.5   # seconds between Wikipedia API calls (be polite)
REQUEST_TIMEOUT = 10

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("photo-enricher")


def wiki_lookup(title: str) -> tuple[bool, str | None]:
    """
    Query Wikipedia API for a page title.
    Returns (page_exists, thumbnail_url_or_None).
    """
    params = {
        "action":      "query",
        "titles":      title,
        "prop":        "pageimages|info",
        "format":      "json",
        "pithumbsize": 200,
        "origin":      "*",
    }
    url = f"{WIKI_API}?{urllib.parse.urlencode(params)}"
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        pages = data.get("query", {}).get("pages", {})
        page  = next(iter(pages.values()), {})

        if "-1" in pages or page.get("missing") is not None:
            return False, None

        thumb = page.get("thumbnail", {}).get("source")
        return True, thumb

    except urllib.error.URLError as e:
        log.warning(f"URL error for '{title}': {e.reason}")
        return False, None
    except Exception as e:
        log.warning(f"Error for '{title}': {e}")
        return False, None


def ls_photo_url(member_id: str) -> str:
    """Pattern URL for Lok Sabha member photos (public domain)."""
    return f"https://sansad.in/ls/members/photo/{member_id}.jpg"


def enrich(dry_run: bool = False) -> None:
    if not MP_JSON.exists():
        log.error(f"mps.json not found at {MP_JSON}")
        sys.exit(1)

    with open(MP_JSON, encoding="utf-8") as f:
        mp_data = json.load(f)

    mps = mp_data.get("mps", [])
    log.info(f"Processing {len(mps)} MPs…")

    changed = 0
    for mp in mps:
        name       = mp.get("name", "")
        wiki_title = mp.get("wiki_title", "")
        ls_id      = mp.get("ls_member_id")

        if not wiki_title:
            log.info(f"  {name}: no wiki_title, skipping Wikipedia lookup")
            continue

        log.info(f"  {name} → Wikipedia: '{wiki_title}'")
        exists, thumb = wiki_lookup(wiki_title)
        time.sleep(REQUEST_DELAY)

        if exists:
            log.info(f"    ✓ Page found. Thumbnail: {thumb or 'none'}")
            if not dry_run:
                mp["wiki_title"] = wiki_title   # confirmed
                # We don't store the thumb in JSON — it's fetched live in app.js
        else:
            log.warning(f"    ✗ Wikipedia page not found for '{wiki_title}'")
            # Try to find a redirect / alternative name
            # For now, we just flag it
            if not dry_run:
                mp["wiki_title_unverified"] = wiki_title
                mp["wiki_title"] = ""   # clear so app falls back to LS photo

            if ls_id:
                log.info(f"    → Will fall back to LS photo: {ls_photo_url(ls_id)}")

        changed += 1

    log.info(f"Processed {changed} MPs.")

    if not dry_run:
        with open(MP_JSON, "w", encoding="utf-8") as f:
            json.dump(mp_data, f, ensure_ascii=False, indent=2)
        log.info(f"Wrote enriched mps.json to {MP_JSON}")
    else:
        log.info("[dry-run] No files written.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Enrich mps.json with verified Wikipedia titles")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    enrich(dry_run=args.dry_run)
