/* ═══════════════════════════════════════════════════════
   Sansad Kharch — app.js
   Charts, card rendering, filtering, state table, freshness
═══════════════════════════════════════════════════════ */

'use strict';

// ─── State ──────────────────────────────────────────────
const state = {
  summary:       null,
  states:        null,
  sectors:       null,
  mps:           null,
  currentChamber: 'all',
  currentState:  '',
  currentParty:  '',
  currentSort:   'unspent',   // default: most wasteful first
  searchQuery:   '',
  photoCache:    new Map(),
  stateView:     'best',
  stateChamber:  'LS',
};

// ─── Helpers ─────────────────────────────────────────────
const SECTOR_COLORS = {
  'Roads & Bridges':          '#ec4899',
  'Education':                '#22c55e',
  'Drinking Water':           '#06b6d4',
  'Sanitation':               '#10b981',
  'Health':                   '#ef4444',
  'Sports & Culture':         '#8b5cf6',
  'Natural Resources & Agri': '#84cc16',
  'Energy':                   '#f59e0b',
  'Other':                    '#6b7280',
};

function avatarColor(name) {
  const hues = [210, 280, 30, 160, 350, 190, 50, 320];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % hues.length;
  return `hsl(${hues[h]}, 55%, 35%)`;
}

function initials(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function fmtCr(n) {
  if (n == null) return '—';
  return `₹${n.toFixed(1)} Cr`;
}

function fmtNum(n) {
  return n != null ? n.toLocaleString('en-IN') : '—';
}

function daysSince(dateStr) {
  const then = new Date(dateStr);
  const now  = new Date();
  return Math.floor((now - then) / 86400000);
}

// ─── Data loading ────────────────────────────────────────
async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Failed to load ${path}: ${r.status}`);
  return r.json();
}

async function loadAll() {
  try {
    [state.summary, state.states, state.sectors, state.mps] = await Promise.all([
      loadJSON('data/summary.json'),
      loadJSON('data/states.json'),
      loadJSON('data/sectors.json'),
      loadJSON('data/mps.json'),
    ]);
    init();
  } catch (err) {
    console.error('Data load failed:', err);
    document.querySelector('.cards-loading').textContent =
      '⚠️ Could not load data. Check console for details.';
  }
}

// ─── Main init ───────────────────────────────────────────
function init() {
  updateFreshness();
  updateHeroNumbers();
  renderShameChart();
  renderSectorChart();
  renderStateTable();
  populateFilters();
  renderCards();
  bindToolbar();
}

// ─── Freshness ───────────────────────────────────────────
function updateFreshness() {
  const d    = state.summary.meta.last_updated;
  const days = daysSince(d);
  const txt  = days === 0 ? 'Updated today' : `Updated ${days}d ago`;
  document.getElementById('freshness-text').textContent = txt;

  const dot = document.querySelector('.freshness-dot');
  if (days > 14)     dot.style.background = '#ef4444';
  else if (days > 7) dot.style.background = '#f59e0b';

  const footerEl = document.getElementById('footer-freshness');
  if (footerEl) footerEl.textContent = `Data last updated: ${d} (${txt}). Source: mplads.gov.in`;
}

// ─── Hero numbers ────────────────────────────────────────
function updateHeroNumbers() {
  const n = state.summary.national;

  document.getElementById('hero-released').textContent =
    `₹${n.total_released_cr.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;
  document.getElementById('hero-spent').textContent =
    `₹${n.total_spent_cr.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;

  document.getElementById('hero-util').textContent = `${n.utilisation_pct}%`;

  // Derive works totals — all from states.json to keep dataset consistent
  // sectors.json works_count is sector-categorisation data, not sanctioned works count
  const totalRec  = state.states.states.reduce((s, st) => s + (st.works_recommended || 0), 0);
  const totalComp = state.states.states.reduce((s, st) => s + (st.works_completed   || 0), 0);
  // Proxy for "has digital record": works appearing in sectors.json (sector data exists = eSAKSHI record exists)
  const totalWithEvidence = state.sectors.national_breakdown.reduce((s, sec) => s + (sec.works_count || 0), 0);
  const totalNoEvidence   = Math.max(0, totalComp - totalWithEvidence);

  document.getElementById('hero-recommended').textContent  = fmtNum(totalRec  || null);
  document.getElementById('hero-completed').textContent    = fmtNum(totalComp || null);
  document.getElementById('hero-no-evidence').textContent  = fmtNum(totalNoEvidence || null);

  // Util bar
  document.getElementById('hero-util-bar').style.width = `${n.utilisation_pct}%`;
  document.getElementById('hero-util-label').textContent =
    `National average · ${n.utilisation_pct}% of allocated funds spent`;

  // Pipeline summary — only use states.json numbers (same dataset)
  const pipelineEl = document.getElementById('hero-pipeline');
  if (totalRec > 0) {
    const compPer100 = Math.round((totalComp / totalRec) * 100);
    const noPer100   = Math.round((totalNoEvidence / totalRec) * 100);
    pipelineEl.textContent =
      `Of every 100 works recommended: ${compPer100} marked complete — but ${noPer100} have no digital evidence`;
  }
}

// ─── Hall of Shame Chart ─────────────────────────────────
function renderShameChart() {
  const MPs = [...state.mps.mps]
    .filter(mp => (mp.stats.unspent_cr || 0) > 0)
    .sort((a, b) => b.stats.unspent_cr - a.stats.unspent_cr)
    .slice(0, 15)
    .map(mp => ({
      name:        mp.name,
      constituency: mp.constituency,
      spent_cr:    mp.stats.spent_cr,
      unspent_cr:  mp.stats.unspent_cr,
    }));

  const canvas  = document.getElementById('shameChart');
  canvas.height = MPs.length * 28 + 40;

  const ctx = canvas.getContext('2d');
  if (window._shameChart) window._shameChart.destroy();

  window._shameChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: MPs.map(m => `${m.name} · ${m.constituency}`),
      datasets: [
        {
          label: 'Spent (₹Cr)',
          data:  MPs.map(m => m.spent_cr),
          backgroundColor: 'rgba(34,197,94,0.75)',
          borderRadius: 2,
          barThickness: 10,
        },
        {
          label: 'Unspent (₹Cr)',
          data:  MPs.map(m => m.unspent_cr),
          backgroundColor: 'rgba(239,68,68,0.85)',
          borderRadius: 2,
          barThickness: 10,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: {
          stacked: true,
          grid:  { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#6B7280', font: { family: 'DM Sans', size: 11 } },
        },
        y: {
          stacked: true,
          grid:  { display: false },
          ticks: { color: '#F0ECE4', font: { family: 'DM Sans', size: 10 }, padding: 4 },
        },
      },
      plugins: {
        legend: { labels: { color: '#9CA3AF', font: { family: 'DM Sans' } } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ₹${ctx.parsed.x.toFixed(2)} Cr`,
          },
        },
      },
    },
  });
}

// ─── Sector Chart ────────────────────────────────────────
function renderSectorChart() {
  const data = state.sectors.national_breakdown;
  const ctx  = document.getElementById('sectorChart').getContext('2d');
  if (window._sectorChart) window._sectorChart.destroy();

  window._sectorChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.map(d => d.sector),
      datasets: [{
        data:            data.map(d => d.pct),
        backgroundColor: data.map(d => d.color),
        borderColor:     'rgba(10,15,30,0.8)',
        borderWidth:     2,
        hoverOffset:     8,
      }],
    },
    options: {
      responsive: true,
      cutout: '55%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${ctx.parsed.toFixed(1)}%  (₹${data[ctx.dataIndex].amount_cr.toFixed(0)} Cr)`,
          },
        },
      },
    },
  });

  const legendEl = document.getElementById('sector-legend');
  legendEl.innerHTML = data.map(d => `
    <div class="sector-legend-item">
      <div class="sector-legend-dot" style="background:${d.color}"></div>
      <span class="sector-legend-name">${d.sector}</span>
      <span class="sector-legend-pct">${d.pct.toFixed(1)}%</span>
    </div>
    <div style="font-size:0.72rem;color:var(--text-muted);margin-left:20px;margin-top:-4px;margin-bottom:4px">
      ₹${d.amount_cr.toFixed(0)} Cr · ${fmtNum(d.works_count)} works
    </div>
  `).join('');
}

// ─── State Leaderboard ───────────────────────────────────
window.setStateChamber = function(chamber) {
  state.stateChamber = chamber;
  document.querySelectorAll('.state-chamber-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.chamber === chamber);
  });
  renderStateTable();
};

window.showStateView = function(view) {
  state.stateView = view;
  ['best', 'worst', 'all'].forEach(v => {
    document.getElementById(`tab-${v}`).classList.toggle('active', v === view);
  });
  renderStateTable();
};

function deriveStateStats(house) {
  const byState = {};
  state.mps.mps
    .filter(mp => mp.house === house)
    .forEach(mp => {
      if (!byState[mp.state]) {
        byState[mp.state] = { state: mp.state, mps: 0, released_cr: 0, spent_cr: 0 };
      }
      byState[mp.state].mps++;
      byState[mp.state].released_cr += mp.stats.released_cr || 0;
      byState[mp.state].spent_cr    += mp.stats.spent_cr    || 0;
    });

  return Object.values(byState)
    .map(s => ({
      ...s,
      released_cr:      +s.released_cr.toFixed(1),
      spent_cr:         +s.spent_cr.toFixed(1),
      utilisation_pct:  s.released_cr > 0
        ? +((s.spent_cr / s.released_cr) * 100).toFixed(1)
        : 0,
    }))
    .sort((a, b) => b.utilisation_pct - a.utilisation_pct)
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

function renderStateTable() {
  const tbody = document.getElementById('state-tbody');
  const allRows = deriveStateStats(state.stateChamber);

  if (allRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="state-no-data">No ${state.stateChamber === 'LS' ? 'Lok Sabha' : 'Rajya Sabha'} data available.</td></tr>`;
    return;
  }

  let rows;
  if      (state.stateView === 'best')  rows = allRows.slice(0, 8);
  else if (state.stateView === 'worst') rows = allRows.slice(-8).reverse();
  else                                  rows = allRows;

  tbody.innerHTML = rows.map(s => `
    <tr>
      <td class="state-rank">${s.rank}</td>
      <td><strong>${s.state}</strong></td>
      <td style="color:var(--text-secondary)">${s.mps}</td>
      <td style="color:var(--text-secondary)">₹${s.released_cr.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
      <td style="color:var(--text-secondary)">₹${s.spent_cr.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
      <td class="util-bar-cell">
        <div class="util-bar-wrap">
          <div class="util-bar-bg">
            <div class="util-bar-fill" style="width:${s.utilisation_pct}%"></div>
          </div>
          <span class="util-bar-pct">${s.utilisation_pct}%</span>
        </div>
      </td>
    </tr>`).join('');
}

// ─── Populate state/party dropdowns ──────────────────────
function populateFilters() {
  const states  = [...new Set(state.mps.mps.map(mp => mp.state))].filter(Boolean).sort();
  const stateEl = document.getElementById('state-filter');
  states.forEach(s => {
    const opt   = document.createElement('option');
    opt.value   = s;
    opt.textContent = s;
    stateEl.appendChild(opt);
  });

  const parties  = [...new Set(state.mps.mps.map(mp => mp.party).filter(Boolean))].sort();
  const partyEl  = document.getElementById('party-filter');
  parties.forEach(p => {
    const opt   = document.createElement('option');
    opt.value   = p;
    opt.textContent = p;
    partyEl.appendChild(opt);
  });
}

// ─── Toolbar bindings ────────────────────────────────────
function bindToolbar() {
  document.getElementById('mp-search').addEventListener('input', e => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    renderCards();
  });

  document.querySelectorAll('.chamber-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chamber-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentChamber = btn.dataset.chamber;
      renderCards();
    });
  });

  document.getElementById('state-filter').addEventListener('change', e => {
    state.currentState = e.target.value;
    renderCards();
  });

  document.getElementById('party-filter').addEventListener('change', e => {
    state.currentParty = e.target.value;
    renderCards();
  });

  document.getElementById('sort-select').addEventListener('change', e => {
    state.currentSort = e.target.value;
    renderCards();
  });
}

// ─── Cards ───────────────────────────────────────────────
function filteredMPs() {
  let list = state.mps.mps;

  if (state.currentChamber !== 'all') {
    list = list.filter(mp => mp.house === state.currentChamber);
  }

  if (state.currentState) {
    list = list.filter(mp => mp.state === state.currentState);
  }

  if (state.currentParty) {
    list = list.filter(mp => mp.party === state.currentParty);
  }

  if (state.searchQuery) {
    const q = state.searchQuery;
    list = list.filter(mp =>
      mp.name.toLowerCase().includes(q) ||
      mp.constituency.toLowerCase().includes(q) ||
      mp.state.toLowerCase().includes(q) ||
      (mp.party && mp.party.toLowerCase().includes(q))
    );
  }

  // Sort
  list = [...list];
  switch (state.currentSort) {
    case 'unspent':
      list.sort((a, b) => {
        const ua = a.stats.unspent_cr ?? (a.stats.released_cr - a.stats.spent_cr) ?? 0;
        const ub = b.stats.unspent_cr ?? (b.stats.released_cr - b.stats.spent_cr) ?? 0;
        return ub - ua;
      });
      break;
    case 'util_asc':
      list.sort((a, b) => (a.stats.utilisation_pct ?? 0) - (b.stats.utilisation_pct ?? 0));
      break;
    case 'util_desc':
      list.sort((a, b) => (b.stats.utilisation_pct ?? 0) - (a.stats.utilisation_pct ?? 0));
      break;
    case 'released':
      list.sort((a, b) => (b.stats.released_cr ?? 0) - (a.stats.released_cr ?? 0));
      break;
    case 'name':
      list.sort((a, b) => a.name.localeCompare(b.name));
      break;
  }

  return list;
}

function renderCards() {
  const grid  = document.getElementById('cards-grid');
  const count = document.getElementById('cards-count');
  const mps   = filteredMPs();

  if (mps.length === 0) {
    grid.innerHTML = '<div class="cards-loading">No MPs match your filter.</div>';
    count.textContent = '';
    return;
  }

  grid.innerHTML = mps.map(mp => buildCardHTML(mp)).join('');
  count.textContent = `${mps.length} MPs`;

  grid.querySelectorAll('.mp-card-wrap').forEach(wrap => {
    wrap.addEventListener('click', () => {
      wrap.querySelector('.mp-card').classList.toggle('flipped');
    });
    wrap.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        wrap.querySelector('.mp-card').classList.toggle('flipped');
      }
    });
  });

  observePhotos(grid);
}

// ─── Card HTML builder ───────────────────────────────────
function buildCardHTML(mp) {
  const s     = mp.stats;
  const house = mp.house || 'LS';
  const ini   = initials(mp.name);
  const avatarBg = avatarColor(mp.name);

  // Chamber strip color
  const stripColor = house === 'RS' ? '#92400E' : house === 'Nominated' ? '#374151' : '#1E3A5F';

  // Location line
  let locationLine;
  if      (house === 'RS')        locationLine = `State Representative · ${mp.state}`;
  else if (house === 'Nominated') locationLine = 'Nominated · All India';
  else                            locationLine = `${mp.constituency} · ${mp.state}`;

  // Chamber badge
  let chamberBadge;
  if      (house === 'RS')        chamberBadge = `<span class="chamber-badge chamber-rs">RAJYA SABHA</span>`;
  else if (house === 'Nominated') chamberBadge = `<span class="chamber-badge chamber-nominated">NOMINATED</span>`;
  else                            chamberBadge = `<span class="chamber-badge chamber-ls">LOK SABHA</span>`;

  // Unspent ₹ — the emotional hook
  const unspent = s.unspent_cr ?? ((s.released_cr ?? 0) - (s.spent_cr ?? 0));
  const unspentDisplay = unspent != null ? `₹${unspent.toFixed(1)} Cr` : '—';

  // Utilisation
  const utilPct    = s.utilisation_pct ?? 0;
  const utilWidth  = Math.min(100, Math.max(0, utilPct));
  const utilLabel  = `${utilPct.toFixed(0)}% utilised · ${fmtCr(s.spent_cr)} of ${fmtCr(s.released_cr)}`;

  // Works pipeline text
  const rec  = s.works_recommended ?? '—';
  const sanc = s.works_sanctioned  ?? '—';
  const comp = s.works_completed   ?? '—';
  const pipelineText = `${rec} rec  ›  ${sanc} sanctioned  ›  ${comp} complete`;

  // Evidence (use proof_score as proxy; individual counts not yet in data)
  const onTimePct     = s.completion_rate_pct;
  const onTimeDisplay = onTimePct != null ? `${onTimePct.toFixed(0)}%` : '—';

  // Grade badge
  const grade = s.grade || null;
  const gradeBadge = grade
    ? `<span class="grade-badge grade-${grade.toLowerCase()}">${grade}</span>`
    : '';

  // POR badge
  const porBadge = s.proof_score != null
    ? `<span class="por-badge">POR ${s.proof_score}/100</span>`
    : `<span class="por-badge por-na">POR N/A</span>`;

  // Era indicator
  let eraDot, eraLabel;
  if      (mp.ls_period === '18th') { eraDot = 'era-digital'; eraLabel = 'Full eSAKSHI data'; }
  else if (mp.ls_period === '17th') { eraDot = 'era-partial'; eraLabel = 'Partial digital (2023-24 only)'; }
  else                              { eraDot = 'era-legacy';  eraLabel = 'Legacy — no digital trail'; }

  // Era banner (back of card)
  let eraBanner = '';
  if (mp.ls_period === '17th') {
    eraBanner = `<div class="era-banner">Digital evidence available for 2023-24 only. 4 of 5 years have no digital trail.</div>`;
  } else if (!mp.ls_period) {
    eraBanner = `<div class="era-banner">Pre-digital era — no photo or document trail exists.</div>`;
  }

  // House note (back of card)
  let houseNote = '';
  if (house === 'RS') {
    houseNote = `<div class="house-note">Rajya Sabha MPs can spend anywhere in their state. Works spread across multiple districts — harder for any single citizen to verify locally.</div>`;
  } else if (house === 'Nominated') {
    houseNote = `<div class="house-note">Nominated MPs can spend in any state in India. No fixed constituency — citizen verification requires knowing spend districts in advance.</div>`;
  }

  // Yearly bars (back)
  const yearlyBars = mp.yearly.length > 0
    ? mp.yearly.map(y => `
        <div class="yearly-bar-row">
          <span class="yearly-year">${y.year.slice(2)}</span>
          <div class="yearly-bar-bg">
            <div class="yearly-bar-fill" style="width:${Math.min(100, y.pct)}%"></div>
          </div>
          <span class="yearly-pct">${y.pct.toFixed(0)}%</span>
        </div>`).join('')
    : '<div style="font-size:0.64rem;color:var(--text-muted);font-style:italic">No yearly data</div>';

  // Sector bars (back)
  const sec = mp.sectors || {};
  const sectorBars = [
    { name: 'Roads',     pct: sec.roads_pct,     color: '#ec4899' },
    { name: 'Education', pct: sec.education_pct, color: '#22c55e' },
    { name: 'Water',     pct: sec.water_pct,     color: '#06b6d4' },
    { name: 'Health',    pct: sec.health_pct,    color: '#ef4444' },
    { name: 'Other',     pct: sec.other_pct,     color: '#6b7280' },
  ].map(d => `
    <div class="back-sector-row">
      <div class="back-sector-dot" style="background:${d.color}"></div>
      <span class="back-sector-name">${d.name}</span>
      <span class="back-sector-pct">${d.pct != null ? d.pct + '%' : '—'}</span>
    </div>`).join('');

  return `
  <div class="mp-card-wrap" data-id="${mp.id}" role="button" tabindex="0" aria-label="MP card for ${mp.name}. Unspent: ${unspentDisplay}">
    <div class="mp-card">

      <!-- FRONT -->
      <div class="mp-card-front">
        <div class="card-chamber-strip" style="background:${stripColor}"></div>
        <div class="card-fold-front"></div>

        <div class="card-header">
          ${chamberBadge}
          <div class="card-header-right">
            ${mp.party ? `<span class="card-party-badge">${mp.party}</span>` : ''}
            ${gradeBadge}
            <span class="card-ls-period">${mp.ls_period || '—'} LS</span>
          </div>
        </div>

        <div class="card-identity">
          <div class="mp-photo-wrap">
            <img
              class="mp-photo"
              src=""
              alt="${mp.name}"
              data-wiki="${encodeURIComponent(mp.wiki_title || '')}"
              data-lsid="${mp.ls_member_id || ''}"
              onerror="handlePhotoError(this)"
              style="display:none"
            />
            <div class="avatar-init" style="background:${avatarBg}">${ini}</div>
          </div>
          <div class="card-name-block">
            <div class="card-mp-name">${mp.name}</div>
            <div class="card-location">${locationLine}</div>
          </div>
        </div>

        <div class="card-unspent-block">
          <div class="card-unspent-num">${unspentDisplay}</div>
          <div class="card-unspent-label">UNSPENT ALLOCATION</div>
        </div>

        <div class="card-util-section">
          <div class="card-util-bar-bg">
            <div class="card-util-bar-fill" style="width:${utilWidth}%"></div>
          </div>
          <div class="card-util-label">${utilLabel}</div>
        </div>

        <div class="card-pipeline">${pipelineText}</div>

        <div class="card-evidence-row">
          <span class="card-evidence-item">📷 Photos <span class="ev-val">—</span></span>
          <span class="card-evidence-item">📄 Docs <span class="ev-val">—</span></span>
          <span class="card-evidence-item">⏱ On time <span class="ev-val">${onTimeDisplay}</span></span>
          ${porBadge}
        </div>
      </div>

      <!-- BACK -->
      <div class="mp-card-back">
        <div class="card-fold-back"></div>

        <div>
          <div class="card-back-title">${mp.name}</div>
          <div class="card-back-subtitle">${mp.constituency}, ${mp.state}</div>
        </div>

        <div>
          <div class="card-back-section-label">Year-wise Utilisation</div>
          <div class="yearly-bars">${yearlyBars}</div>
        </div>

        <div>
          <div class="card-back-section-label">Spend by Sector</div>
          <div class="back-sectors">${sectorBars}</div>
        </div>

        <div class="era-indicator-row">
          <span class="era-dot ${eraDot}"></span>
          <span class="era-label">${eraLabel}</span>
          <a href="https://mplads.mospi.gov.in" target="_blank" rel="noopener" class="era-link">eSAKSHI ↗</a>
        </div>

        ${eraBanner}
        ${houseNote}

        <div class="card-back-source">
          <a href="${mp.source_url}" target="_blank" rel="noopener">View on mplads.gov.in ↗</a><br/>
          ⚠️ Completed = self-reported. No independent verification pre-2023.
        </div>
      </div>

    </div>
  </div>`;
}

// ─── Photo loading ───────────────────────────────────────
let photoObserver = null;

function observePhotos(container) {
  if (photoObserver) photoObserver.disconnect();

  photoObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      photoObserver.unobserve(entry.target);
      loadMPPhoto(entry.target);
    });
  }, { root: null, rootMargin: '200px', threshold: 0 });

  container.querySelectorAll('.mp-photo[data-wiki]').forEach(img => photoObserver.observe(img));
}

async function loadMPPhoto(img) {
  const wikiTitle = decodeURIComponent(img.dataset.wiki || '');
  const lsId      = img.dataset.lsid || '';

  if (!wikiTitle && !lsId) return;

  if (wikiTitle && state.photoCache.has(wikiTitle)) {
    const cached = state.photoCache.get(wikiTitle);
    if (cached) setPhoto(img, cached);
    return;
  }

  if (wikiTitle) {
    try {
      const url  = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(wikiTitle)}&prop=pageimages&format=json&pithumbsize=200&origin=*`;
      const res  = await fetch(url, { headers: { 'User-Agent': 'SansadKharch/1.0 (citizen accountability tool)' } });
      const data = await res.json();
      const page = Object.values(data?.query?.pages || {})[0];
      const thumb = page?.thumbnail?.source;
      if (thumb) {
        state.photoCache.set(wikiTitle, thumb);
        setPhoto(img, thumb);
        return;
      }
    } catch (_) { /* fall through */ }
  }

  if (lsId) {
    const lsUrl = `https://sansad.in/ls/members/photo/${lsId}.jpg`;
    state.photoCache.set(wikiTitle, lsUrl);
    setPhoto(img, lsUrl);
    return;
  }

  state.photoCache.set(wikiTitle, false);
}

function setPhoto(img, src) {
  img.src = src;
  img.style.display = 'block';
  const wrap = img.closest('.mp-photo-wrap');
  if (wrap) {
    const avatar = wrap.querySelector('.avatar-init');
    if (avatar) avatar.style.display = 'none';
  }
}

window.handlePhotoError = function(img) {
  img.style.display = 'none';
  const wrap = img.closest('.mp-photo-wrap');
  if (wrap) {
    const avatar = wrap.querySelector('.avatar-init');
    if (avatar) avatar.style.display = 'flex';
  }
  const wikiTitle = decodeURIComponent(img.dataset.wiki || '');
  if (wikiTitle) state.photoCache.set(wikiTitle, false);
};

// ─── FAQ accordion ───────────────────────────────────────
window.toggleFAQ = function(btn) {
  const item   = btn.closest('.faq-item');
  const answer = item.querySelector('.faq-a');
  const isOpen = item.classList.contains('open');

  item.classList.toggle('open', !isOpen);
  answer.style.maxHeight = isOpen ? '0' : `${answer.scrollHeight}px`;
};

// ─── Keyboard accessibility ──────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.mp-card.flipped').forEach(c => c.classList.remove('flipped'));
  }
});

// ─── Boot ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadAll);
