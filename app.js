/* ═══════════════════════════════════════════════════════
   MPLADS Watch — app.js
   All charts, card rendering, photo loading, filtering,
   LS switcher, state table, and data freshness logic.
═══════════════════════════════════════════════════════ */

'use strict';

// ─── State ──────────────────────────────────────────────
const state = {
  summary: null,
  states: null,
  sectors: null,
  mps: null,
  currentLs: 'all',
  currentGrade: 'all',
  currentSort: 'grade',
  searchQuery: '',
  photoCache: new Map(),   // wiki_title → img URL (or false if failed)
  stateView: 'best',
};

// ─── Colour helpers ──────────────────────────────────────
const GRADE_COLOR = {
  S: '#fbbf24', A: '#22c55e', B: '#3b82f6', C: '#f59e0b', D: '#ef4444',
};

const SECTOR_COLORS = {
  'Roads & Bridges':          '#f59e0b',
  'Education':                '#3b82f6',
  'Drinking Water':           '#06b6d4',
  'Sanitation':               '#8b5cf6',
  'Health':                   '#ef4444',
  'Sports & Culture':         '#10b981',
  'Natural Resources & Agri': '#84cc16',
  'Energy':                   '#f97316',
  'Other':                    '#6b7280',
};

function gradeColor(g)     { return GRADE_COLOR[g] || '#6b7280'; }
function gradeBarColor(pct) {
  if (pct >= 90) return GRADE_COLOR.S;
  if (pct >= 75) return GRADE_COLOR.A;
  if (pct >= 60) return GRADE_COLOR.B;
  if (pct >= 40) return GRADE_COLOR.C;
  return GRADE_COLOR.D;
}

function avatarColor(name) {
  const hues = [210, 280, 30, 160, 350, 190, 50, 320];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % hues.length;
  return `hsl(${hues[h]}, 60%, 38%)`;
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
  renderGaugeChart();
  renderShameChart();
  updateFunnelNumbers();
  renderSectorChart();
  renderStateTable();
  renderCards();
  bindToolbar();
  bindLsSwitcher();
}

// ─── Freshness ───────────────────────────────────────────
function updateFreshness() {
  const d = state.summary.meta.last_updated;
  const days = daysSince(d);
  const txt = days === 0 ? 'Updated today' : `Updated ${days}d ago`;
  document.getElementById('freshness-text').textContent = txt;

  const dot = document.querySelector('.freshness-dot');
  if (days > 14) {
    dot.style.background = '#f59e0b';
  } else if (days > 7) {
    dot.style.background = '#fbbf24';
  }

  const footerEl = document.getElementById('footer-freshness');
  if (footerEl) {
    footerEl.textContent = `Data last updated: ${d} (${txt}). Source: mplads.gov.in`;
  }
}

// ─── Hero numbers ────────────────────────────────────────
function updateHeroNumbers() {
  const n = state.summary.national;
  document.getElementById('hero-released').textContent = `₹${n.total_released_cr.toLocaleString('en-IN', {maximumFractionDigits:0})} Cr`;
  document.getElementById('hero-spent').textContent    = `₹${n.total_spent_cr.toLocaleString('en-IN', {maximumFractionDigits:0})} Cr`;
  document.getElementById('hero-unspent').textContent  = `₹${n.unspent_cr.toLocaleString('en-IN', {maximumFractionDigits:0})} Cr`;
  document.getElementById('hero-mps').textContent      = n.total_mps;
  document.getElementById('hero-util').textContent     = `${n.utilisation_pct}%`;
  document.getElementById('hero-shame').textContent    = n.mps_below_40pct;
  document.getElementById('hero-above').textContent    = n.mps_above_75pct;
}

// ─── Gauge Chart ─────────────────────────────────────────
function renderGaugeChart() {
  const pct = getUtilPct();
  document.getElementById('gauge-pct').textContent = `${pct}%`;

  const ctx = document.getElementById('gaugeChart').getContext('2d');
  if (window._gaugeChart) window._gaugeChart.destroy();

  const val = pct / 100;
  window._gaugeChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [val, 1 - val],
        backgroundColor: [gradeBarColor(pct), 'rgba(42,48,66,0.7)'],
        borderWidth: 0,
        circumference: 180,
        rotation: 270,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      cutout: '72%',
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      animation: { duration: 800, easing: 'easeOutQuart' },
    },
  });
}

function getUtilPct() {
  const ls = state.currentLs;
  const n = state.summary;
  if (ls === 'all') return n.national.utilisation_pct;
  return n.by_ls[ls]?.utilisation_pct || n.national.utilisation_pct;
}

// ─── Hall of Shame Chart ─────────────────────────────────
function renderShameChart() {
  // Derive top-unspent from full mps list for more coverage
  const MPs = [...state.mps.mps]
    .filter(mp => (mp.stats.unspent_cr || 0) > 0)
    .sort((a, b) => b.stats.unspent_cr - a.stats.unspent_cr)
    .slice(0, 15)
    .map(mp => ({
      name: mp.name,
      constituency: mp.constituency,
      spent_cr:   mp.stats.spent_cr,
      unspent_cr: mp.stats.unspent_cr,
    }));

  const canvas = document.getElementById('shameChart');
  // Size canvas to fit all rows (approx 26px per row + padding)
  canvas.height = MPs.length * 26 + 40;

  const ctx = canvas.getContext('2d');
  if (window._shameChart) window._shameChart.destroy();

  window._shameChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: MPs.map(m => `${m.name} · ${m.constituency}`),
      datasets: [
        {
          label: 'Spent (₹Cr)',
          data: MPs.map(m => m.spent_cr),
          backgroundColor: 'rgba(34,197,94,0.75)',
          borderRadius: 2,
          barThickness: 8,
        },
        {
          label: 'Unspent (₹Cr)',
          data: MPs.map(m => m.unspent_cr),
          backgroundColor: 'rgba(239,68,68,0.85)',
          borderRadius: 2,
          barThickness: 8,
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
          grid:   { color: 'rgba(255,255,255,0.05)' },
          ticks:  { color: '#8892a4', font: { family: 'DM Sans', size: 11 } },
        },
        y: {
          stacked: true,
          grid:   { display: false },
          ticks:  { color: '#e8eaf0', font: { family: 'DM Sans', size: 10 }, padding: 4 },
        },
      },
      plugins: {
        legend: {
          labels: { color: '#8892a4', font: { family: 'DM Sans' } },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ₹${ctx.parsed.x.toFixed(2)} Cr`,
          },
        },
      },
    },
  });
}

// ─── Funnel ──────────────────────────────────────────────
function updateFunnelNumbers() {
  const n = state.summary.national;

  // Use pre-computed totals if present; otherwise derive from states + sectors data
  const recommended = n.total_works_recommended
    ?? state.states.states.reduce((sum, s) => sum + (s.works_recommended || 0), 0);
  const completed   = n.total_works_completed
    ?? state.states.states.reduce((sum, s) => sum + (s.works_completed   || 0), 0);
  const sanctioned  = n.total_works_sanctioned
    ?? state.sectors.national_breakdown.reduce((sum, s) => sum + (s.works_count || 0), 0);

  document.getElementById('funnel-recommended').textContent = fmtNum(recommended);
  document.getElementById('funnel-sanctioned').textContent  = fmtNum(sanctioned);
  document.getElementById('funnel-completed').textContent   = fmtNum(completed);

  // Update drop percentages dynamically
  const dropSanction  = document.getElementById('funnel-drop-sanctioned');
  const dropCompleted = document.getElementById('funnel-drop-completed');
  if (dropSanction && recommended > 0) {
    const pct = (((recommended - sanctioned) / recommended) * 100).toFixed(1);
    dropSanction.textContent = `−${pct}% dropped`;
  }
  if (dropCompleted && sanctioned > 0) {
    const pct = (((sanctioned - completed) / sanctioned) * 100).toFixed(1);
    dropCompleted.textContent = `−${pct}% dropped`;
  }
}

// ─── Sector Chart ────────────────────────────────────────
function renderSectorChart() {
  const data  = state.sectors.national_breakdown;
  const ctx   = document.getElementById('sectorChart').getContext('2d');
  if (window._sectorChart) window._sectorChart.destroy();

  window._sectorChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.map(d => d.sector),
      datasets: [{
        data: data.map(d => d.pct),
        backgroundColor: data.map(d => d.color),
        borderColor: 'rgba(13,15,20,0.8)',
        borderWidth: 2,
        hoverOffset: 8,
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

  // Legend
  const legendEl = document.getElementById('sector-legend');
  legendEl.innerHTML = data.map(d => `
    <div class="sector-legend-item">
      <div class="sector-legend-dot" style="background:${d.color}"></div>
      <span class="sector-legend-name">${d.sector}</span>
      <span class="sector-legend-pct">${d.pct.toFixed(1)}%</span>
    </div>
    <div style="font-size:0.72rem;color:var(--text-muted);margin-left:20px;margin-top:-4px;margin-bottom:2px">₹${d.amount_cr.toFixed(0)} Cr · ${fmtNum(d.works_count)} works</div>
  `).join('');
}

// ─── State Table ─────────────────────────────────────────
window.showStateView = function(view) {
  state.stateView = view;
  ['best','worst','all'].forEach(v => {
    document.getElementById(`tab-${v}`).classList.toggle('active', v === view);
  });
  renderStateTable();
};

function renderStateTable() {
  const all   = [...state.states.states];
  const view  = state.stateView;

  let rows;
  if (view === 'best')  rows = all.slice(0, 8);
  else if (view === 'worst') rows = all.slice(-8).reverse();
  else rows = all;

  const tbody = document.getElementById('state-tbody');
  tbody.innerHTML = rows.map((s, i) => {
    const pct   = s.utilisation_pct;
    const grade = pct >= 90 ? 'S' : pct >= 75 ? 'A' : pct >= 60 ? 'B' : pct >= 40 ? 'C' : 'D';
    const color = gradeColor(grade);
    const rank  = view === 'worst' ? all.length - i : i + 1;
    return `
      <tr>
        <td class="state-rank">${s.rank}</td>
        <td><strong>${s.state}</strong></td>
        <td style="color:var(--text-secondary)">${s.mps}</td>
        <td style="color:var(--text-secondary)">₹${s.released_cr.toLocaleString('en-IN', {maximumFractionDigits:0})}</td>
        <td style="color:var(--text-secondary)">₹${s.spent_cr.toLocaleString('en-IN', {maximumFractionDigits:0})}</td>
        <td class="util-bar-cell">
          <div class="util-bar-wrap">
            <div class="util-bar-bg">
              <div class="util-bar-fill" style="width:${pct}%;background:${color}"></div>
            </div>
            <span class="util-bar-pct" style="color:${color}">${pct}%</span>
          </div>
        </td>
        <td><span class="grade-pill grade-${grade}">${grade}</span></td>
      </tr>`;
  }).join('');
}

// ─── LS Switcher ─────────────────────────────────────────
function bindLsSwitcher() {
  document.getElementById('ls-switcher').addEventListener('click', e => {
    const btn = e.target.closest('.ls-btn');
    if (!btn) return;
    document.querySelectorAll('.ls-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.currentLs = btn.dataset.ls;
    renderGaugeChart();
    renderCards();
  });
}

// ─── Toolbar bindings ────────────────────────────────────
function bindToolbar() {
  document.getElementById('mp-search').addEventListener('input', e => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    renderCards();
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentGrade = btn.dataset.grade;
      renderCards();
    });
  });

  document.getElementById('sort-select').addEventListener('change', e => {
    state.currentSort = e.target.value;
    renderCards();
  });
}

// ─── Cards ───────────────────────────────────────────────
function filteredMPs() {
  let list = state.mps.mps;

  // LS filter
  if (state.currentLs !== 'all') {
    list = list.filter(mp => mp.ls_period === state.currentLs || mp.ls_period === 'All');
  }

  // Grade filter
  if (state.currentGrade !== 'all') {
    list = list.filter(mp => mp.stats.grade === state.currentGrade);
  }

  // Search
  if (state.searchQuery) {
    const q = state.searchQuery;
    list = list.filter(mp =>
      mp.name.toLowerCase().includes(q) ||
      mp.constituency.toLowerCase().includes(q) ||
      mp.state.toLowerCase().includes(q) ||
      mp.party.toLowerCase().includes(q)
    );
  }

  // Sort
  list = [...list];
  const gradeOrder = { S: 0, A: 1, B: 2, C: 3, D: 4 };
  list.sort((a, b) => {
    switch (state.currentSort) {
      case 'grade':       return gradeOrder[a.stats.grade] - gradeOrder[b.stats.grade];
      case 'utilisation': return b.stats.utilisation_pct - a.stats.utilisation_pct;
      case 'spent':       return b.stats.spent_cr - a.stats.spent_cr;
      case 'unspent':     return (b.stats.released_cr - b.stats.spent_cr) - (a.stats.released_cr - a.stats.spent_cr);
      default:            return 0;
    }
  });

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
  count.textContent = `Showing ${mps.length} of ${state.mps.mps.length} MPs`;

  // Flip on click
  grid.querySelectorAll('.mp-card-wrap').forEach(wrap => {
    wrap.addEventListener('click', () => {
      wrap.querySelector('.mp-card').classList.toggle('flipped');
    });
  });

  // Lazy photo loading via IntersectionObserver
  observePhotos(grid);
}

function buildCardHTML(mp) {
  const s     = mp.stats;
  const grade = s.grade;
  const gc    = `gc-${grade}`;
  const gt    = `gt-${grade}`;
  const gb    = `gb-${grade}`;
  const color = gradeColor(grade);
  const init  = initials(mp.name);
  const avatarBg = avatarColor(mp.name);

  // Stat bars (5 performance)
  const statDefs = [
    { label: 'Utilise', val: s.utilisation_pct,    max: 100, fmt: v => `${v.toFixed(0)}%` },
    { label: 'Complet', val: s.completion_rate_pct, max: 100, fmt: v => `${v.toFixed(0)}%` },
    { label: 'SC/ST',   val: s.sc_st_spend_pct,     max: 50,  fmt: v => `${v.toFixed(0)}%` },
    { label: 'Speed',   val: s.speed_index,          max: 100, fmt: v => `${v.toFixed(0)}` },
    { label: 'Consist', val: s.consistency_score,    max: 100, fmt: v => `${v.toFixed(0)}` },
  ];

  const statBars = statDefs.map(d => {
    const val    = d.val ?? 0;
    const barPct = Math.min(100, (val / d.max) * 100);
    const barColor = gradeBarColor(val);
    const display  = d.val != null ? d.fmt(d.val) : '<span style="color:var(--text-muted);font-size:0.6rem">N/A</span>';
    return `
      <div class="stat-row">
        <span class="stat-label">${d.label}</span>
        <div class="stat-bar-bg">
          <div class="stat-bar-fill" style="width:${barPct}%;background:${barColor}"></div>
        </div>
        <span class="stat-val">${display}</span>
      </div>`;
  }).join('');

  // Proof on Record
  const proofHTML = (() => {
    if (s.proof_score === null || s.proof_score === undefined) {
      return `
        <div class="stat-row proof-row">
          <span class="stat-label">Proof</span>
          <div class="stat-bar-bg">
            <div class="stat-bar-fill" style="width:0%;background:var(--proof-color)"></div>
          </div>
          <span class="stat-val" style="color:var(--text-muted);font-size:0.6rem">N/A</span>
        </div>`;
    }
    return `
      <div class="stat-row proof-row">
        <span class="stat-label">Proof</span>
        <div class="stat-bar-bg">
          <div class="stat-bar-fill" style="width:${s.proof_score}%;background:var(--proof-color)"></div>
        </div>
        <span class="stat-val" style="color:var(--proof-color)">${s.proof_score}</span>
      </div>`;
  })();

  // Back: yearly bars
  const yearlyBars = mp.yearly.map(y => {
    const barColor = gradeBarColor(y.pct);
    return `
      <div class="yearly-bar-row">
        <span class="yearly-year">${y.year.slice(2)}</span>
        <div class="yearly-bar-bg">
          <div class="yearly-bar-fill" style="width:${y.pct}%;background:${barColor}"></div>
        </div>
        <span class="yearly-pct">${y.pct.toFixed(0)}%</span>
      </div>`;
  }).join('');

  // Back: sector breakdown
  const sectorColors = {
    roads: '#f59e0b', education: '#3b82f6', water: '#06b6d4', health: '#ef4444', other: '#6b7280',
  };
  const sec = mp.sectors || {};
  const sectorBars = [
    { name: 'Roads',     pct: sec.roads_pct     ?? null, color: sectorColors.roads },
    { name: 'Education', pct: sec.education_pct ?? null, color: sectorColors.education },
    { name: 'Water',     pct: sec.water_pct     ?? null, color: sectorColors.water },
    { name: 'Health',    pct: sec.health_pct    ?? null, color: sectorColors.health },
    { name: 'Other',     pct: sec.other_pct     ?? null, color: sectorColors.other },
  ].map(d => `
    <div class="back-sector-row">
      <div class="back-sector-dot" style="background:${d.color}"></div>
      <span class="back-sector-name">${d.name}</span>
      <span class="back-sector-pct">${d.pct != null ? d.pct + '%' : '—'}</span>
    </div>`).join('');

  const proofNote = s.proof_note || '';

  return `
  <div class="mp-card-wrap" data-id="${mp.id}" data-grade="${grade}" role="button" tabindex="0" aria-label="MP card for ${mp.name}">
    <div class="mp-card">

      <!-- FRONT -->
      <div class="mp-card-front ${gb}">
        <div class="card-grade-stripe ${gc}"></div>

        <div class="card-header">
          <div class="card-grade-pill ${gc}" style="color:#000;">${grade}</div>
          <div class="card-party-badge">${mp.party}</div>
        </div>

        <div class="card-identity">
          <div class="mp-photo-wrap">
            <img
              class="mp-photo"
              src=""
              alt="${mp.name}"
              data-wiki="${encodeURIComponent(mp.wiki_title || '')}"
              data-lsid="${mp.ls_member_id || ''}"
              data-initials="${init}"
              onerror="handlePhotoError(this)"
              style="display:none"
            />
            <div class="avatar-init" style="background:${avatarBg}">${init}</div>
          </div>
          <div class="card-name-block">
            <div class="card-mp-name">${mp.name}</div>
            <div class="card-constituency">${mp.constituency}</div>
            <div class="card-state">${mp.state} · ${mp.house} · ${mp.ls_period} LS</div>
          </div>
        </div>

        <div class="card-stats">
          ${statBars}
          <div class="card-divider"></div>
          ${proofHTML}
          ${proofNote ? `<div style="font-size:0.56rem;color:var(--text-muted);margin-top:2px;line-height:1.3">${proofNote}</div>` : ''}
        </div>

        <div class="card-numbers">
          <div class="card-num-item">
            <div class="card-num-val">${fmtCr(s.released_cr)}</div>
            <div class="card-num-lbl">Released</div>
          </div>
          <div class="card-num-item">
            <div class="card-num-val ${gt}">${fmtCr(s.spent_cr)}</div>
            <div class="card-num-lbl">Spent</div>
          </div>
          <div class="card-num-item">
            <div class="card-num-val">${fmtNum(s.works_recommended)}</div>
            <div class="card-num-lbl">Works</div>
          </div>
        </div>

        <div class="card-flip-hint">TAP TO SEE HISTORY ↺</div>
      </div>

      <!-- BACK -->
      <div class="mp-card-back">
        <div>
          <div class="card-back-title">${mp.name}</div>
          <div class="card-back-subtitle">${mp.constituency}, ${mp.state}</div>
        </div>

        <div>
          <div class="card-back-subtitle" style="margin-bottom:0.4rem">Year-wise Utilisation</div>
          <div class="yearly-bars">${yearlyBars}</div>
        </div>

        <div>
          <div class="card-back-subtitle" style="margin-bottom:0.4rem">Spend by Sector</div>
          <div class="back-sectors">${sectorBars}</div>
        </div>

        <div class="card-back-source">
          <a href="${mp.source_url}" target="_blank" rel="noopener">View on mplads.gov.in ↗</a>
          <br/>⚠️ Completed = self-reported. No independent verification pre-2023.
        </div>
        <div class="card-back-flip-hint">TAP TO FLIP BACK ↺</div>
      </div>

    </div>
  </div>`;
}

// ─── Photo loading ───────────────────────────────────────
let photoObserver = null;

function observePhotos(container) {
  if (photoObserver) photoObserver.disconnect();

  const options = { root: null, rootMargin: '200px', threshold: 0 };
  photoObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const img = entry.target;
      photoObserver.unobserve(img);
      loadMPPhoto(img);
    });
  }, options);

  container.querySelectorAll('.mp-photo[data-wiki]').forEach(img => {
    photoObserver.observe(img);
  });
}

async function loadMPPhoto(img) {
  const wikiTitle = decodeURIComponent(img.dataset.wiki || '');
  const lsId      = img.dataset.lsid || '';
  const init      = img.dataset.initials || '';

  if (!wikiTitle && !lsId) return;  // keep initials

  // Check cache
  if (wikiTitle && state.photoCache.has(wikiTitle)) {
    const cached = state.photoCache.get(wikiTitle);
    if (cached) setPhoto(img, cached);
    return;
  }

  // Tier 1: Wikipedia
  if (wikiTitle) {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(wikiTitle)}&prop=pageimages&format=json&pithumbsize=200&origin=*`;
      const res  = await fetch(url, { headers: { 'User-Agent': 'MPLADSWatch/1.0 (https://github.com/mplads-watch; citizen accountability tool)' } });
      const data = await res.json();
      const pages = data?.query?.pages || {};
      const page  = Object.values(pages)[0];
      const thumb = page?.thumbnail?.source;
      if (thumb) {
        state.photoCache.set(wikiTitle, thumb);
        setPhoto(img, thumb);
        return;
      }
    } catch (_) { /* fall through */ }
  }

  // Tier 2: Lok Sabha official URL
  if (lsId) {
    const lsUrl = `https://sansad.in/ls/members/photo/${lsId}.jpg`;
    state.photoCache.set(wikiTitle, lsUrl);
    setPhoto(img, lsUrl);
    return;
  }

  // Tier 3: keep initials
  state.photoCache.set(wikiTitle, false);
}

function setPhoto(img, src) {
  img.src = src;
  img.style.display = 'block';
  // Hide the initials avatar that's a sibling inside the wrap
  const wrap = img.closest('.mp-photo-wrap');
  if (wrap) {
    const avatarDiv = wrap.querySelector('.avatar-init');
    if (avatarDiv) avatarDiv.style.display = 'none';
  }
}

window.handlePhotoError = function(img) {
  img.style.display = 'none';
  const wrap = img.closest('.mp-photo-wrap');
  if (wrap) {
    const avatarDiv = wrap.querySelector('.avatar-init');
    if (avatarDiv) avatarDiv.style.display = 'flex';
  }
  // Cache failure so we don't retry
  const wikiTitle = decodeURIComponent(img.dataset.wiki || '');
  if (wikiTitle) state.photoCache.set(wikiTitle, false);
};

// ─── Modal (for future expansion) ───────────────────────
window.closeModal = function() {
  document.getElementById('modal-overlay').classList.remove('open');
};

// ─── Keyboard accessibility ──────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

// ─── Boot ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadAll);
