#!/usr/bin/env python3
"""
MPLADS Watch — Data Scraper
Fetches real MP-wise MPLADS fund release data from mplads.gov.in
using the SSRS ReportViewer CSV export endpoint.

Strategy:
  1. GET the report page to capture ASP.NET session cookies + ViewState
  2. POST with state=All / member=All to trigger report generation
  3. Extract the SSRS ReportSession token from the response
  4. Hit the export URL with Format=CSV to get the full dataset
  5. Parse CSV → write data/ JSON files

Runs without login. The /AuthenticatedPages/ path is misleading — these
citizen-facing reports do not require a user account.

Usage:
    python scraper/fetch.py              # update all JSON files
    python scraper/fetch.py --dry-run    # print plan, no writes
    python scraper/fetch.py --ls 18      # fetch only 18th LS (default: 17+18)
"""

import argparse
import csv
import http.cookiejar
import io
import json
import logging
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Optional

DATA_DIR = Path(__file__).parent.parent / "data"

BASE = "https://mplads.gov.in/mplads/AuthenticatedPages/Reports/Citizen"
ENDPOINTS = {
    "fund_release": f"{BASE}/rptDetailsSummary.aspx",
    "sector_works": f"{BASE}/rptCMSStateWiseSummaryOfWork.aspx",
    "expenditure":  f"{BASE}/rptExpSummaryReportOLDFormat.aspx",
}

HEADERS = {
    "User-Agent": (
        "MPLADSWatch/1.0 (https://github.com/mplads-watch; "
        "citizen accountability scraper; contact: mplads.watch@proton.me)"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

# House codes present in the CSV data (empirically verified)
# 7 = 17th LS (2019-2024), 8 = 18th LS (2024-present)
# "" (blank) = Rajya Sabha / ex-MPs with no LS period
HOUSE_TO_LS = {
    "1": "14th", "2": "13th", "3": "12th", "4": "11th",
    "5": "10th", "6": "16th", "7": "17th", "8": "18th",
}

# Dropdown values on the form (filter by LS)
# 0 = All, 8 = 17th LS, 7 = 16th LS, 1 = 15th LS, 24 = RS Sitting
LS_FILTER = {
    "all": "0",
    "18": "0",  # 18th LS is included in "All"; no separate filter value exposed
    "17": "8",
}

REQUEST_TIMEOUT = 45
RETRY_COUNT = 3
RETRY_DELAY = 8

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("mplads-scraper")


# ─── HTTP / session helpers ────────────────────────────────────────────

def make_opener() -> urllib.request.OpenerDirector:
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def fetch(opener, url: str, data: Optional[bytes] = None,
          extra_headers: Optional[dict] = None, attempt: int = 1) -> Optional[str]:
    headers = {**HEADERS, **(extra_headers or {})}
    if data:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers)
    for i in range(1, RETRY_COUNT + 1):
        try:
            with opener.open(req, timeout=REQUEST_TIMEOUT) as resp:
                charset = resp.info().get_content_charset("utf-8")
                return resp.read().decode(charset, errors="replace")
        except urllib.error.HTTPError as e:
            log.warning(f"HTTP {e.code} on {url} (attempt {i}/{RETRY_COUNT})")
        except Exception as e:
            log.warning(f"Error on {url}: {e} (attempt {i}/{RETRY_COUNT})")
        if i < RETRY_COUNT:
            time.sleep(RETRY_DELAY)
    return None


def extract_viewstate(html: str) -> dict:
    """Pull ASP.NET hidden fields needed for POST."""
    fields = {}
    for name in ("__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION",
                 "__VIEWSTATEENCRYPTED"):
        m = re.search(rf'(?:id|name)="{re.escape(name)}"[^>]*value="([^"]*)"', html)
        if not m:
            m = re.search(rf'value="([^"]*)"[^>]*(?:id|name)="{re.escape(name)}"', html)
        fields[name] = m.group(1) if m else ""
    ncf = re.search(r'name="__ncforminfo"[^>]*value="([^"]+)"', html)
    fields["__ncforminfo"] = ncf.group(1) if ncf else ""
    return fields


def get_export_url(html: str, base_site: str = "https://mplads.gov.in") -> Optional[str]:
    """Extract the SSRS CSV export URL from the rendered ReportViewer page."""
    m = re.search(r'"ExportUrlBase":"([^"]+)"', html)
    if not m:
        return None
    base = m.group(1).replace("\\u0026", "&")
    return base_site + base + "CSV"


# ─── Report fetchers ──────────────────────────────────────────────────

def fetch_fund_release_csv(dry_run: bool = False) -> Optional[str]:
    """
    Fetch the MP-wise fund release report as CSV.
    Returns raw CSV string or None on failure.
    """
    url = ENDPOINTS["fund_release"]
    log.info(f"Fetching fund release page: {url}")

    opener = make_opener()

    html = fetch(opener, url)
    if not html:
        log.error("fund_release: GET failed")
        return None

    vs = extract_viewstate(html)
    post_fields = {
        **vs,
        "ctl00$WebsiteBody$ddlstate":  "0",   # All states
        "ctl00$WebsiteBody$ddlMember": "0",    # All LS periods
        "ctl00$WebsiteBody$btnViewReport": "View Report",
        "ctl00$WebsiteBody$RepViewer$ctl03$ctl00": "",
        "ctl00$WebsiteBody$RepViewer$ctl03$ctl01": "",
        "ctl00$WebsiteBody$RepViewer$ctl11": "",
        "ctl00$WebsiteBody$RepViewer$ctl12": "",
        "ctl00$WebsiteBody$RepViewer$AsyncWait$HiddenCancelField": "False",
        "ctl00$WebsiteBody$RepViewer$ToggleParam$store": "",
        "ctl00$WebsiteBody$RepViewer$ToggleParam$collapse": "false",
        "ctl00$WebsiteBody$RepViewer$ctl09$ClientClickedId": "",
        "ctl00$WebsiteBody$RepViewer$ctl08$store": "",
        "ctl00$WebsiteBody$RepViewer$ctl08$collapse": "false",
        "ctl00$WebsiteBody$RepViewer$ctl10$VisibilityState$ctl00": "None",
        "ctl00$WebsiteBody$RepViewer$ctl10$ScrollPosition": "",
        "ctl00$WebsiteBody$RepViewer$ctl10$ReportControl$ctl02": "",
        "ctl00$WebsiteBody$RepViewer$ctl10$ReportControl$ctl03": "",
        "ctl00$WebsiteBody$RepViewer$ctl10$ReportControl$ctl04": "100",
    }
    post_data = urllib.parse.urlencode(post_fields).encode("utf-8")

    log.info("POSTing to generate report…")
    if dry_run:
        log.info("[dry-run] Skipping POST")
        return None

    html2 = fetch(opener, url, data=post_data, extra_headers={"Referer": url})
    if not html2:
        log.error("fund_release: POST failed")
        return None

    export_url = get_export_url(html2)
    if not export_url:
        vis = re.search(r'"VisibilityState.*?"([^"]+)"', html2)
        log.error(f"fund_release: no ExportUrlBase in response. VisibilityState={vis and vis.group(1)}")
        return None

    log.info(f"Downloading CSV export…")
    csv_text = fetch(opener, export_url, extra_headers={"Referer": url})
    if not csv_text:
        log.error("fund_release: CSV export download failed")
        return None

    log.info(f"Got CSV ({len(csv_text):,} bytes)")
    return csv_text


def fetch_sector_csv(dry_run: bool = False) -> Optional[str]:
    """Fetch the state/sector-wise summary of works as CSV."""
    url = ENDPOINTS["sector_works"]
    log.info(f"Fetching sector works page: {url}")

    opener = make_opener()
    html = fetch(opener, url)
    if not html:
        log.error("sector_works: GET failed")
        return None

    vs = extract_viewstate(html)
    post_fields = {
        **vs,
        "ctl00$WebsiteBody$ddlState":  "0",   # capital S — different from fund_release
        "ctl00$WebsiteBody$btnViewReport": "View Report",
        "ctl00$WebsiteBody$RepViewer$ctl03$ctl00": "",
        "ctl00$WebsiteBody$RepViewer$ctl03$ctl01": "",
        "ctl00$WebsiteBody$RepViewer$ctl11": "",
        "ctl00$WebsiteBody$RepViewer$ctl12": "",
        "ctl00$WebsiteBody$RepViewer$AsyncWait$HiddenCancelField": "False",
        "ctl00$WebsiteBody$RepViewer$ToggleParam$store": "",
        "ctl00$WebsiteBody$RepViewer$ToggleParam$collapse": "false",
        "ctl00$WebsiteBody$RepViewer$ctl09$ClientClickedId": "",
        "ctl00$WebsiteBody$RepViewer$ctl08$store": "",
        "ctl00$WebsiteBody$RepViewer$ctl08$collapse": "false",
        "ctl00$WebsiteBody$RepViewer$ctl10$VisibilityState$ctl00": "None",
        "ctl00$WebsiteBody$RepViewer$ctl10$ScrollPosition": "",
        "ctl00$WebsiteBody$RepViewer$ctl10$ReportControl$ctl02": "",
        "ctl00$WebsiteBody$RepViewer$ctl10$ReportControl$ctl03": "",
        "ctl00$WebsiteBody$RepViewer$ctl10$ReportControl$ctl04": "100",
    }
    if dry_run:
        log.info("[dry-run] Skipping sector POST")
        return None

    post_data = urllib.parse.urlencode(post_fields).encode("utf-8")
    html2 = fetch(opener, url, data=post_data, extra_headers={"Referer": url})
    if not html2:
        return None

    export_url = get_export_url(html2)
    if not export_url:
        log.error("sector_works: no ExportUrlBase")
        return None

    return fetch(opener, export_url, extra_headers={"Referer": url})


# ─── CSV parsers ──────────────────────────────────────────────────────

def safe_float(v: str) -> float:
    try:
        return float(str(v).replace(",", "").strip() or "0")
    except ValueError:
        return 0.0


def safe_int(v: str) -> int:
    try:
        return int(str(v).replace(",", "").strip() or "0")
    except ValueError:
        return 0


def parse_fund_release_csv(raw: str) -> list[dict]:
    """
    Parse the MP-wise fund release CSV.

    Returns list of dicts, one per MP row, with computed spent_cr and
    utilisation_pct. Only 17th and 18th LS rows are kept (House 7/8).
    Rajya Sabha and older LS rows are excluded.
    """
    lines = raw.splitlines()
    # Header row contains "State" and "MPName"
    try:
        header_idx = next(
            i for i, l in enumerate(lines) if "State" in l and "MPName" in l
        )
    except StopIteration:
        log.error("fund_release CSV: header row not found")
        return []

    reader = csv.DictReader(io.StringIO("\n".join(lines[header_idx:])))
    results = []

    for row in reader:
        name = row.get("MPName", "").strip()
        state = row.get("State", "").strip()
        house = row.get("House", "").strip()

        if not name or not state:
            continue

        # Only 17th LS (house=7) and 18th LS (house=8)
        if house not in ("7", "8"):
            continue

        released = safe_float(row.get("TotalGOIRelease", "0"))
        unsanctioned = safe_float(row.get("UnSanctionBalance", "0"))
        unspent = safe_float(row.get("UnspentBalance", "0"))

        # Spent = released minus what's still available (unsanctioned + unspent)
        # Negative unsanctioned balance means they've sanctioned from prior LS carry-over
        spent = released - max(0.0, unsanctioned) - max(0.0, unspent)
        spent = max(0.0, spent)  # can't spend negative
        utilisation = round(spent / released * 100, 1) if released > 0 else 0.0

        results.append({
            "name":         name,
            "state":        state,
            "constituency": row.get("Constituency", "").strip(),
            "district":     row.get("District", "").strip(),
            "house":        house,
            "ls_period":    HOUSE_TO_LS.get(house, ""),
            "released_cr":  round(released, 2),
            "spent_cr":     round(spent, 2),
            "unspent_cr":   round(max(0.0, unspent), 2),
            "utilisation_pct": utilisation,
            "last_inst_year": row.get("LastInstYear", "").strip(),
            "last_release_date": row.get("LastReleaseDate", "").strip(),
        })

    log.info(f"Parsed {len(results)} MP rows (17th+18th LS) from fund release CSV")
    return results


def parse_sector_csv(raw: str) -> list[dict]:
    """
    Parse the sector/scheme-wise CSV (rptCMSStateWiseSummaryOfWork).
    Columns: Textbox8, Name, TotalAmount, NumberOfWork, Textbox13, Textbox14
    Returns list of {sector, works_count, amount_cr}.
    """
    lines = raw.splitlines()
    # Header row has "Name" and "TotalAmount" or "NumberOfWork"
    try:
        header_idx = next(
            i for i, l in enumerate(lines)
            if "Name" in l and ("Amount" in l or "Work" in l)
        )
    except StopIteration:
        log.warning("sector CSV: header row not found")
        return []

    reader = csv.DictReader(io.StringIO("\n".join(lines[header_idx:])))
    results = []
    for row in reader:
        sector = row.get("Name", "").strip()
        if not sector:
            continue
        # TotalAmount is in lakhs on this report; convert to crore (÷100)
        amount_lakh = safe_float(row.get("TotalAmount", "0"))
        amount_cr = round(amount_lakh / 100, 2)
        works = safe_int(row.get("NumberOfWork", "0"))
        if amount_cr > 0 or works > 0:
            results.append({"sector": sector, "amount_cr": amount_cr, "works_count": works})

    return results


# ─── JSON builders ────────────────────────────────────────────────────

SECTOR_COLORS = [
    "#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6",
    "#06b6d4", "#f97316", "#ec4899", "#10b981", "#6b7280",
]

GRADE_THRESHOLDS = [
    (90, "S"), (75, "A"), (60, "B"), (40, "C"), (0, "D"),
]


def grade(util_pct: float) -> str:
    for threshold, letter in GRADE_THRESHOLDS:
        if util_pct >= threshold:
            return letter
    return "D"


def _norm(s: str) -> str:
    """Normalise a string for matching: lowercase, strip, collapse spaces."""
    return re.sub(r"\s+", " ", s.strip().lower())


def build_mps_json(mp_rows: list[dict], existing: dict) -> dict:
    """
    Merge scraped rows into the existing mps.json structure.

    Matching key: (constituency_normalised, ls_period).
    This is robust against name-format differences (e.g. seed has
    "Shashi Tharoor" but scraped data has "Dr. Shashi Tharoor").

    Strategy:
    - For each scraped row, look for a seed MP with the same constituency
      and LS period. If found, update its stats (preserving party, wiki_title,
      etc. from the seed). If not found, create a new entry.
    - Seed MPs that have no matching scraped row are removed (they have
      fabricated stats). This keeps the file clean after the first real scrape.
    """
    existing_list = existing.get("mps", [])

    # Index seed MPs by (constituency_norm, ls_period)
    seed_idx: dict[tuple, dict] = {}
    for mp in existing_list:
        key = (_norm(mp.get("constituency", "")), mp.get("ls_period", ""))
        seed_idx[key] = mp

    # Max ID so we can assign new IDs
    max_id = 0
    for mp in existing_list:
        mid = mp.get("id", "mp_000")
        try:
            max_id = max(max_id, int(mid.replace("mp_", "")))
        except ValueError:
            pass

    updated = 0
    result_mps: list[dict] = []

    for row in mp_rows:
        key = (_norm(row["constituency"]), row["ls_period"])
        if key in seed_idx:
            # Merge: keep seed metadata, overwrite stats with real data
            mp = dict(seed_idx[key])   # copy
            mp["stats"] = {
                **mp.get("stats", {}),
                "released_cr":     row["released_cr"],
                "spent_cr":        row["spent_cr"],
                "utilisation_pct": row["utilisation_pct"],
                "unspent_cr":      row["unspent_cr"],
                "grade":           grade(row["utilisation_pct"]),
            }
            result_mps.append(mp)
            updated += 1
        else:
            max_id += 1
            result_mps.append({
                "id":           f"mp_{max_id:03d}",
                "name":         row["name"],
                "constituency": row["constituency"],
                "state":        row["state"],
                "district":     row["district"],
                "party":        None,   # not in source; enrich separately
                "house":        "LS",
                "ls_period":    row["ls_period"],
                "stats": {
                    "released_cr":       row["released_cr"],
                    "spent_cr":          row["spent_cr"],
                    "utilisation_pct":   row["utilisation_pct"],
                    "unspent_cr":        row["unspent_cr"],
                    "grade":             grade(row["utilisation_pct"]),
                    "works_recommended": None,
                    "works_sanctioned":  None,
                    "works_completed":   None,
                    "completion_rate_pct": None,
                    "sc_st_spend_pct":   None,
                    "proof_score":       None,
                    "proof_note":        None,
                },
                "yearly":  [],
                "sectors": {},
                "source_url": ENDPOINTS["fund_release"],
            })

    new_count = len(result_mps) - updated
    log.info(
        f"mps.json: {updated} merged from seed, "
        f"{new_count} new, {len(existing_list) - updated} seed entries replaced by real data"
    )
    return {
        "meta": {
            "last_updated": date.today().isoformat(),
            "source": "mplads.gov.in rptDetailsSummary",
            "coverage": "17th LS (2019-2024) + 18th LS (2024-present)",
            "note": (
                "Stats auto-updated weekly by GitHub Actions. "
                "party/yearly/sectors fields enriched separately. "
                "Grade: S(≥90%)/A(≥75%)/B(≥60%)/C(≥40%)/D(<40%)."
            ),
        },
        "mps": result_mps,
    }


def build_summary_json(mp_rows: list[dict], existing: dict) -> dict:
    """Compute national summary from scraped MP rows."""
    h8 = [r for r in mp_rows if r["house"] == "8"]   # 18th LS
    h7 = [r for r in mp_rows if r["house"] == "7"]   # 17th LS

    def agg(rows: list[dict]) -> dict:
        if not rows:
            return {}
        total_rel = sum(r["released_cr"] for r in rows)
        total_spt = sum(r["spent_cr"]    for r in rows)
        return {
            "total_released_cr":    round(total_rel, 2),
            "total_spent_cr":       round(total_spt, 2),
            "utilisation_pct":      round(total_spt / total_rel * 100, 1) if total_rel else 0,
            "total_mps":            len(rows),
            "mps_above_75pct":      sum(1 for r in rows if r["utilisation_pct"] >= 75),
            "mps_below_40pct":      sum(1 for r in rows if r["utilisation_pct"] < 40),
            "unspent_cr":           round(total_rel - total_spt, 2),
            "annual_allocation_per_mp_cr": 5.0,
        }

    all_rows = h7 + h8
    top_unspent = sorted(all_rows, key=lambda r: r["unspent_cr"], reverse=True)[:5]

    return {
        "meta": {
            "last_updated": date.today().isoformat(),
            "source": "mplads.gov.in",
            "coverage": "17th LS (2019-2024) + 18th LS (2024-present)",
            "note": "Auto-updated by GitHub Actions scraper.",
        },
        "national": agg(all_rows),
        "by_ls": {
            "17th": {"period": "2019-2024", **agg(h7)},
            "18th": {"period": "2024-present", **agg(h8)},
        },
        "hall_of_shame": {
            "description": "MPs with highest unspent allocations (₹ Crore)",
            "top_unspent": [
                {
                    "name":         r["name"],
                    "constituency": r["constituency"],
                    "state":        r["state"],
                    "party":        None,
                    "released_cr":  r["released_cr"],
                    "spent_cr":     r["spent_cr"],
                    "unspent_cr":   r["unspent_cr"],
                }
                for r in top_unspent
            ],
        },
    }


def build_sectors_json(sector_rows: list[dict], existing: dict) -> dict:
    total_amt = sum(s["amount_cr"] for s in sector_rows) or 1
    existing_breakdown = existing.get("national_breakdown", [])
    color_map = {s["sector"]: s.get("color", "") for s in existing_breakdown}

    return {
        "meta": {
            "last_updated": date.today().isoformat(),
            "source": "mplads.gov.in rptCMSStateWiseSummaryOfWork",
            "note": "Sector percentages are of total sanctioned expenditure",
        },
        "national_breakdown": [
            {
                "sector":      s["sector"],
                "amount_cr":   s["amount_cr"],
                "pct":         round(s["amount_cr"] / total_amt * 100, 2),
                "works_count": s["works_count"],
                "color":       color_map.get(s["sector"], SECTOR_COLORS[i % len(SECTOR_COLORS)]),
            }
            for i, s in enumerate(sector_rows)
        ],
        "by_state_top3":  existing.get("by_state_top3", {}),
        "yearly_trend":   existing.get("yearly_trend", []),
    }


# ─── File I/O ─────────────────────────────────────────────────────────

def load_json(path: Path) -> dict:
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    log.info(f"Wrote {path} ({path.stat().st_size:,} bytes)")


def mark_stale(path: Path, reason: str) -> None:
    data = load_json(path)
    if "meta" in data:
        data["meta"]["stale"] = True
        data["meta"]["stale_reason"] = reason
        data["meta"]["scrape_attempted"] = date.today().isoformat()
        save_json(path, data)
        log.warning(f"Marked {path.name} as stale: {reason}")


# ─── Main ─────────────────────────────────────────────────────────────

def run(dry_run: bool = False) -> bool:
    today = date.today().isoformat()
    log.info(f"Starting MPLADS scrape — {today}")
    if dry_run:
        log.info("DRY RUN — no files will be written")

    overall_ok = True

    # ── Fund release (MP-wise) ─────────────────────────────────────
    csv_text = fetch_fund_release_csv(dry_run=dry_run)
    if csv_text:
        mp_rows = parse_fund_release_csv(csv_text)
        if mp_rows:
            existing_mps     = load_json(DATA_DIR / "mps.json")
            existing_summary = load_json(DATA_DIR / "summary.json")

            mps_data     = build_mps_json(mp_rows, existing_mps)
            summary_data = build_summary_json(mp_rows, existing_summary)

            if not dry_run:
                save_json(DATA_DIR / "mps.json",     mps_data)
                save_json(DATA_DIR / "summary.json", summary_data)
            else:
                log.info(f"[dry-run] Would write mps.json ({len(mps_data['mps'])} MPs)")
                log.info(f"[dry-run] Would write summary.json")
        else:
            log.error("fund_release: 0 MP rows parsed — HTML/CSV structure may have changed")
            if not dry_run:
                mark_stale(DATA_DIR / "summary.json", "parse returned 0 records")
            overall_ok = False
    else:
        if not dry_run:
            mark_stale(DATA_DIR / "summary.json", "HTTP fetch failed")
        overall_ok = False

    # ── Sector breakdown ──────────────────────────────────────────
    sector_csv = fetch_sector_csv(dry_run=dry_run)
    if sector_csv:
        sector_rows = parse_sector_csv(sector_csv)
        if sector_rows:
            existing_sectors = load_json(DATA_DIR / "sectors.json")
            sectors_data = build_sectors_json(sector_rows, existing_sectors)
            if not dry_run:
                save_json(DATA_DIR / "sectors.json", sectors_data)
            else:
                log.info(f"[dry-run] Would write sectors.json ({len(sector_rows)} sectors)")
        else:
            log.warning("sector_works: 0 sector rows parsed")
            if not dry_run:
                mark_stale(DATA_DIR / "sectors.json", "parse returned 0 records")
    else:
        if not dry_run:
            mark_stale(DATA_DIR / "sectors.json", "HTTP fetch failed")

    log.info(f"Scrape complete. Overall success: {overall_ok}")
    return overall_ok


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MPLADS Watch data scraper")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print plan without writing files")
    parser.add_argument("--ls", choices=["17", "18", "all"], default="all",
                        help="Which Lok Sabha to fetch (default: all)")
    args = parser.parse_args()

    ok = run(dry_run=args.dry_run)
    sys.exit(0 if ok else 1)
