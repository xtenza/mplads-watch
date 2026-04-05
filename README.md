# MPLADS Watch 🇮🇳

**Citizen accountability for India's MP Local Area Development Scheme.**

Every Indian MP gets ₹5 Crore/year to build roads, schools, and hospitals. This site tracks whether they're spending it — and whether that spending can be verified.

**Live site:** [mplads-watch.github.io](https://mplads-watch.github.io) *(deploy your fork to activate)*

---

## What it shows

- **₹14,823 Cr released. Only ₹10,941 Cr spent.** National utilisation across 788 MPs.
- **MP Report Cards** — trump/pokémon-style cards with grade (S/A/B/C/D), 5 performance stats, and a "Proof on Record" score exposing the gap between reported and verified completion.
- **Hall of Shame** — MPs with the most unspent allocation.
- **State Leaderboard** — best and worst states ranked.
- **Sector Breakdown** — where money actually goes (Roads, Education, Water…).
- **Works Funnel** — Recommended → Sanctioned → Completed drop-off.

---

## The "Proof on Record" score

> **CAG finding (2023-24):** Completion dates entered *before the MPLADS scheme existed* (pre-1993). RTI revealed 0 inspections done in Mumbai across 2017-18.

Every "completed" work on mplads.gov.in is **self-reported** by the implementing contractor. The Proof score measures verifiable evidence:

| Signal | Weight |
|---|---|
| Photos uploaded on eSAKSHI portal | 50% |
| Utilisation Certificate submitted | 25% |
| District inspected ≥10% of works | 15% |
| CAG adverse finding flag | −10% penalty |
| Pre-April 2023 data | N/A (no digital trail exists) |
| Self-reported completion with zero docs | capped at 25% max |

---

## Tech stack

- Pure HTML + CSS + JS (zero build step)
- Chart.js from CDN
- Static JSON in `/data/` fetched at page load
- GitHub Actions (Python scraper, runs weekly, auto-commits fresh data)
- GitHub Pages hosting (free, no server)

---

## File structure

```
mplads-watch/
├── data/
│   ├── summary.json        ← national totals
│   ├── states.json         ← state-wise fund + expenditure
│   ├── sectors.json        ← sector breakdown
│   └── mps.json            ← per-MP scorecard
├── .github/workflows/
│   └── refresh-data.yml    ← weekly scrape + commit
├── scraper/
│   ├── fetch.py            ← main weekly scraper
│   └── fetch_photos.py     ← one-time photo enrichment
├── index.html
├── style.css
├── app.js
└── README.md
```

---

## Fork and deploy

1. **Fork this repo** on GitHub.
2. Go to **Settings → Pages → Source:** `main` branch, `/ (root)`.
3. Your site is live at `https://<your-username>.github.io/mplads-watch/`.
4. The weekly scraper runs automatically using the built-in `GITHUB_TOKEN` — no setup needed.

### Run scraper locally

```bash
pip install beautifulsoup4 lxml
python scraper/fetch.py          # updates data/*.json
python scraper/fetch.py --dry-run  # preview without writing
```

### One-time photo enrichment

```bash
python scraper/fetch_photos.py          # validates wiki_title fields
python scraper/fetch_photos.py --dry-run
```

---

## MP photo loading

Photos are **not stored in this repo**. They load at runtime via a three-tier fallback:

1. **Wikipedia API** — fetched on-demand via `IntersectionObserver` (only when card scrolls into view). Covers ~85% of MPs.
2. **Lok Sabha official URL** — `sansad.in/ls/members/photo/{member_id}.jpg` — public domain images.
3. **Initials avatar** — generated from MP name. Never shows a broken image icon.

---

## Data sources

| Source | What |
|---|---|
| [mplads.gov.in](https://mplads.gov.in/mplads/AuthenticatedPages/Reports/Citizen/rptDetailsSummary.aspx) | MP-wise fund release |
| [mplads.gov.in](https://mplads.gov.in/mplads/AuthenticatedPages/Reports/Citizen/rptExpSummaryReportOLDFormat.aspx) | Expenditure summary |
| [mplads.gov.in](https://mplads.gov.in/mplads/AuthenticatedPages/Reports/Citizen/rptCMSStateWiseSummaryOfWork.aspx) | Sector-wise work details |
| [eSAKSHI portal](https://mplads.mospi.gov.in/digigov/dashboard.html) | Post-Apr 2023 photo/UC evidence |
| [sansad.in](https://sansad.in) | MP photos, membership data |

**Note:** mplads.gov.in runs IIS 7.5 (end-of-life since 2020) and is frequently unstable. The scraper fails gracefully: if unreachable, cached JSON is served with a "stale data" banner.

---

## Caveats

- Pre-April 2023 completion data is **self-reported with no independent verification**.
- CAG audits (2023-24) flagged systemic data quality issues including impossible dates.
- This site presents government data as-is. "Completed" ≠ verified completed.
- Not affiliated with any political party or government body.

---

## Contributing

Issues and PRs welcome. Especially needed:
- Expanding `mps.json` with all 788 MPs
- Scraper parsing for the live mplads.gov.in HTML structure
- eSAKSHI portal integration for post-2023 proof scores
- RTI data integration

---

*Facts do the talking. No editorialising. Screenshot and share.*
