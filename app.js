// CFB Ratings dashboard. Reads the JSON that build_dashboard_data.py writes to data/.
// Serve this folder (python3 -m http.server) rather than opening the file directly:
// browsers block fetch() from file:// pages.

const state = { season: null, teams: [], model: null, players: null, score: null, script: null, schedule: [], kind: 'passing', sort: {}, matchup: {}, price: {} };
const $ = (id) => document.getElementById(id);

const fmt = {
  num: (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '–' : Number(v).toFixed(d)),
  signed: (v, d = 1) => (v === null || v === undefined ? '–' : (v > 0 ? '+' : '') + Number(v).toFixed(d)),
  pct: (v) => (v === null || v === undefined ? '–' : (100 * v).toFixed(1) + '%'),
  int: (v) => (v === null || v === undefined ? '–' : Math.round(v).toLocaleString()),
};
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

// A rating placed on 0-100, where 0 is the lowest that rating has ever been across every season
// the dashboard holds and 100 the highest. FBS and FCS share one scale, because every rating is
// already in points against an average FBS team and should mean the same thing in both.
function scaled(key, value) {
  const range = state.scales?.[key];
  if (!range || value === null || value === undefined || Number.isNaN(value)) return null;
  const [low, high] = range;
  if (!(high > low)) return 50;
  return Math.min(100, Math.max(0, (100 * (value - low)) / (high - low)));
}

// The 0-100 number with the rating it came from on hover, coloured by the raw value so better
// and worse than an average FBS team still read at a glance - which the number alone no longer
// says, since zero points sits at a different place in every column. With no scales file it
// falls back to the points the page always showed.
function scoreText(row, column) {
  const value = row[column.key];
  const score = scaled(column.key, value);
  if (score === null) return fmt.signed(value, column.digits ?? 1);
  const raw = `${fmt.signed(value, column.digits ?? 1)} ${column.unit ?? 'points vs an average FBS team'}`;
  return `<span class="${tone(value)}" title="${raw}">${score.toFixed(1)}</span>`;
}

// the rankings table's version, which appends the plain rank the table shows
function scoreCell(row, column) {
  const rank = column.rankKey ? row[column.rankKey] : null;
  return scoreText(row, column) + (rank ? `<span class="sub">${rank}</span>` : '');
}
// Ranks are within a team's division; FCS ones say so wherever teams from both can meet
const division = (t) => t.division ?? 'FBS';
const rk = (t, key = 'rank') => (t[key] ? `#${t[key]}${division(t) === 'FCS' ? ' FCS' : ''}` : '');

async function getJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------- tables

// columns: [{key, label, text?, render?, digits?, signed?, title?}]
function renderTable(table, rows, columns, sortKey) {
  const sort = state.sort[sortKey] || { key: columns.find((c) => c.defaultSort)?.key, dir: -1 };
  state.sort[sortKey] = sort;
  const sorted = [...rows].sort((a, b) => {
    const x = a[sort.key], y = b[sort.key];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir;
  });
  const head = columns.map((c) => {
    const aria = c.key === sort.key ? ` aria-sort="${sort.dir < 0 ? 'descending' : 'ascending'}"` : '';
    return `<th class="${c.text ? 'text' : ''}" data-key="${c.key}"${aria}${c.title ? ` title="${c.title}"` : ''}>${c.label}</th>`;
  }).join('');
  const body = sorted.map((row) => '<tr>' + columns.map((c) => {
    const value = row[c.key];
    const shown = c.render ? c.render(row) : c.scale ? scoreCell(row, c)
      : c.signed ? fmt.signed(value, c.digits ?? 1) : c.pct ? fmt.pct(value) : c.text ? (value ?? '–') : fmt.num(value, c.digits ?? 0);
    const cls = [c.text ? 'text' : '', c.cls || '', c.signed ? tone(value) : ''].join(' ').trim();
    return `<td class="${cls}">${shown}</td>`;
  }).join('') + '</tr>').join('');
  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body || `<tr><td class="text" colspan="${columns.length}">No rows match.</td></tr>`}</tbody>`;
  table.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.key;
    const column = columns.find((c) => c.key === key);
    state.sort[sortKey] = sort.key === key ? { key, dir: -sort.dir } : { key, dir: column.text ? 1 : -1 };
    renderTable(table, rows, columns, sortKey);
  }));
}

// ---------------------------------------------------------------- rankings

const rankColumns = [
  { key: 'rank', label: 'Rk', defaultSort: true },
  { key: 'team', label: 'Team', text: true, cls: 'team', render: (t) => `${t.team}<span class="sub">${t.conference ?? ''}</span>` },
  { key: 'wins', label: 'W-L', render: (t) => `${t.wins}-${t.losses}` },
  { key: 'rating', label: 'Rating', signed: true, scale: true, title: 'Average of the EPA and play-success Elo ratings. 0-100 against every rating in the seasons the dashboard holds; hover for the points it stands for' },
  { key: 'epa_rating', label: 'EPA', signed: true, scale: true, rankKey: 'epa_rank', title: 'Opponent-adjusted expected points added, on the 0-100 scale' },
  { key: 'success_points', label: 'Success Elo', signed: true, scale: true, rankKey: 'success_rank', title: 'Play-success Elo (outcome = win chance implied by share of plays won), on the 0-100 scale' },
  { key: 'elo_points', label: 'Score Elo', signed: true, scale: true, rankKey: 'elo_rank', title: 'Season_Analyzer Elo score predictor, on the 0-100 scale (reference; not in Rating)' },
  { key: 'offense', label: 'EPA off', signed: true, scale: true, rankKey: 'offense_rank' },
  { key: 'defense', label: 'EPA def', signed: true, scale: true, rankKey: 'defense_rank' },
  { key: 'success_off', label: 'Succ off', signed: true, scale: true, rankKey: 'success_off_rank',
    title: "The play-success Elo's own offense rating, in points per game on the 0-100 scale. It rates a unit on the share of its plays that gain, so it reads a different thing from EPA off, which is scored on how much they gain" },
  { key: 'success_def', label: 'Succ def', signed: true, scale: true, rankKey: 'success_def_rank',
    title: "The play-success Elo's own defense rating, in points per game prevented, on the 0-100 scale" },
  { key: 'schedule_strength', label: 'SOS played', signed: true, scale: true, rankKey: 'schedule_rank', title: 'Average rating of the opponents played so far, on the 0-100 scale. Early in the season this mostly reflects who scheduled their weak opponents first' },
  { key: 'season_strength', label: 'SOS season', signed: true, scale: true, rankKey: 'season_schedule_rank', title: 'Average rating of every opponent on the schedule, played or not, at current ratings, on the 0-100 scale' },
  { key: 'off_epa_per_play', label: 'Off EPA/play', signed: true, scale: true, digits: 3, unit: 'EPA per play', title: 'Raw, not opponent-adjusted, on the 0-100 scale' },
  { key: 'def_epa_per_play', label: 'Def EPA/play', signed: true, scale: true, digits: 3, unit: 'EPA per play (+ is good)', title: 'Raw, not opponent-adjusted; + is good. On the 0-100 scale' },
  { key: 'points_for', label: 'PF' },
  { key: 'points_against', label: 'PA' },
];
function fillConferences() {
  const level = $('division').value;
  const conferences = [...new Set(state.teams.filter((t) => !level || division(t) === level).map((t) => t.conference).filter(Boolean))].sort();
  const current = $('conference').value;
  $('conference').innerHTML = '<option value="">All conferences</option>' + conferences.map((c) => `<option>${c}</option>`).join('');
  $('conference').value = conferences.includes(current) ? current : '';
}

function showRankings() {
  const query = $('team-search').value.trim().toLowerCase();
  const conference = $('conference').value;
  const level = $('division').value;
  // both divisions together: rank across both
  const rows = state.teams
    .filter((t) => (!level || division(t) === level) && (!query || t.team.toLowerCase().includes(query)) && (!conference || t.conference === conference))
    .map((t) => (level || !t.overall ? t : { ...t, ...t.overall }));
  if (!state.sort.rankings) state.sort.rankings = { key: 'rank', dir: 1 };
  renderTable($('rankings-table'), rows, rankColumns, 'rankings');
  const m = state.model;
  const early = m.calibration_season !== m.season;
  const span = state.seasons?.length ? `${state.seasons[0]}-${state.seasons[state.seasons.length - 1]}` : 'every season here';
  $('rankings-note').textContent = `Every rating is on a 0-100 scale: 0 is the lowest that rating has been in ${span}, 100 the highest, ` +
    `with FBS and FCS on one scale. Green is better than an average FBS team and red worse, which is no longer ` +
    `the middle of the scale. Hover a number for the points it stands for. ` +
    `${m.games_fitted} games with scores. EPA started from: ${m.epa_prior || 'average'}. Success Elo started from: ${m.success_prior}. ` +
    (early ? `Early season: the EPA ratings still lean on their preseason estimate and use ${m.calibration_season}'s points scale.` : '');
}

// ---------------------------------------------------------------- matchup

function normalCdf(x) {
  // Abramowitz-Stegun erf approximation, good to ~1e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + Math.sign(x) * erf);
}

// Season_Analyzer's tier gap -> win chance (one tier = 75%)
function tierWin(diff, r) {
  if (diff === 0) return 0.5;
  return diff < 0 ? 0.5 * r ** Math.abs(diff) : 1 - 0.5 * r ** Math.abs(diff);
}

// Inverse normal CDF (Acklam's approximation), to express a win chance as a points margin
function probit(p) {
  p = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Team colours for the matchup bar: both teams wear their primary colour, unless the two are too
// close to tell apart - then the visitor changes, like an away kit, to its secondary and failing
// that to grey. At a neutral site Team A counts as the home side.
function hexToRgb(hex) {
  const v = parseInt((hex || '').replace('#', ''), 16);
  return Number.isNaN(v) ? null : [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const distance = (x, y) => (x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) : 999);
const luminance = (rgb) => (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;

// Two neutrals, for when a team's own colour cannot be used - either it vanishes into one of the
// page backgrounds, or it is too close to the other team's. They are a pair picked to be told
// apart from each other, because both sides can need one in the same matchup.
const NEUTRALS = ['#8a8a93', '#4a5568'];

// a near-white or near-black team colour disappears into one of the two page backgrounds, so it
// is swapped for a neutral rather than shown as an apparently empty bar
const readable = (hex) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const l = luminance(rgb);
  return l > 0.78 || l < 0.08 ? null : hex;
};

function matchupColors(a, b, site) {
  if (!a.color || !b.color) return { a: null, b: null };
  const [host, visitor] = site === 'b' ? [b, a] : [a, b];
  // settle the home side first, so the away side is compared against what it will actually face
  const home = readable(host.color) || NEUTRALS[0];
  const worn = hexToRgb(home);
  let away = readable(visitor.color);
  if (!away || distance(worn, hexToRgb(away)) < 100) away = readable(visitor.alt_color);
  if (!away || distance(worn, hexToRgb(away)) < 100) {
    // whichever neutral sits furthest from what the home side ended up wearing: picking a fixed
    // one hands both sides the same grey when the home side has already fallen back to it
    away = [...NEUTRALS].sort((x, y) => distance(worn, hexToRgb(y)) - distance(worn, hexToRgb(x)))[0];
  }
  return site === 'b' ? { a: away, b: home } : { a: home, b: away };
}

// Team logos, straight from ESPN's image server (only the team's ESPN id is stored), with its
// dark-background version when the page is dark. A logo that fails to load just disappears.
function logo(team) {
  if (!team.espn_id) return '';
  const base = 'https://a.espncdn.com/i/teamlogos/ncaa';
  return `<picture><source media="(prefers-color-scheme: dark)" srcset="${base}/500-dark/${team.espn_id}.png">` +
    `<img class="logo" src="${base}/500/${team.espn_id}.png" alt="" loading="lazy" onerror="this.closest('picture').remove()"></picture>`;
}

function teamCard(team, side) {
  return `<div class="team-card ${side}">${logo(team)}<div><div class="name">${team.team}</div>` +
    `<div class="meta">${team.wins}-${team.losses} · ${rk(team)}${team.conference ? ` · ${team.conference}` : ''}</div></div></div>`;
}

// dark colours need light text and the other way round
function barStyle(color) {
  if (!color) return '';
  const rgb = hexToRgb(color);
  return `background:${color};color:${rgb && luminance(rgb) > 0.6 ? '#111' : '#fff'}`;
}

// A search box that filters the team list and lets you pick from it: type to narrow, arrow keys
// and Enter to choose, Escape to close. The chosen team lives in state.matchup, so a half-typed
// search never changes the prediction.
function setupCombo(id) {
  const input = $(id), list = $(`${id}-list`);
  let matches = [], active = -1;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const choose = (team) => {
    state.matchup[id] = team;
    input.value = team;
    close();
    showPrediction();
  };
  const render = (query) => {
    const text = query.trim().toLowerCase();
    matches = state.teams
      .filter((t) => !text || t.team.toLowerCase().includes(text) || (t.conference ?? '').toLowerCase().includes(text))
      .slice(0, 50);
    list.innerHTML = matches.length
      ? matches.map((t, i) => `<li role="option" data-team="${t.team}" aria-selected="${i === active}">${t.team}` +
          `<span class="sub">${t.conference ?? ''} · ${rk(t)}</span></li>`).join('')
      : '<li class="empty">No teams match</li>';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  input.addEventListener('input', () => { active = -1; render(input.value); });
  input.addEventListener('focus', () => { input.select(); render(''); });
  input.addEventListener('blur', () => setTimeout(() => {          // let a click land first
    input.value = state.matchup[id] ?? '';
    close();
  }, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return render(input.value);
      active = Math.min(Math.max(active + (e.key === 'ArrowDown' ? 1 : -1), 0), matches.length - 1);
      [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = matches[active] ?? matches[0];
      if (pick) choose(pick.team);
    } else if (e.key === 'Escape') {
      input.value = state.matchup[id] ?? '';
      close();
    }
  });
  list.addEventListener('mousedown', (e) => {                      // before blur
    const team = e.target.closest('li')?.dataset.team;
    if (team) choose(team);
  });
}

// ---------------------------------------------------------------- the blend
// What each model is worth, by where the season has got to. Fitted on one season and scored on
// the other over 2024-25 (3,348 games): a weighted mix beat the old flat EPA + success-Elo
// average in every part of the season, by 0.0147 Brier in weeks 1-3 easing to 0.0025 from week
// 10. The shape is the story - the simulator carries the early season, when the ratings have
// barely any games behind them, and hands most of it back to score Elo once they do. A weight
// under 5% is dropped and the rest renormalised, so every row the chart draws is a model that
// actually moves the number.
const BLEND_WEEKS = [
  { upto: 3,  weights: { script: 0.62, success: 0.20, epa: 0.11, elo: 0.07 } },
  { upto: 6,  weights: { script: 0.76, elo: 0.24 } },
  { upto: 9,  weights: { script: 0.62, elo: 0.38 } },
  { upto: 99, weights: { elo: 0.44, script: 0.32, epa: 0.15, success: 0.09 } },
];

// The week the season is up to: the earliest one that still has a game to play, or the last week
// on the schedule once they have all been played. With no schedule at all the season is treated
// as finished, which is the mix that leans on the ratings rather than the simulator.
function currentWeek() {
  const weeks = state.schedule.map((g) => g.week).filter((w) => w !== null && w !== undefined);
  if (!weeks.length) return 99;
  const left = state.schedule.filter((g) => !g.completed && g.week !== null && g.week !== undefined);
  return left.length ? Math.min(...left.map((g) => g.week)) : Math.max(...weeks);
}

// Pooling win chances is what made the old blend underconfident, and it got worse as the mix grew
// from two models to four. None of the parts is to blame: EPA, success Elo and score Elo are each
// mildly OVERconfident on their own (calibration slopes 0.92, 0.87, 0.84) and the simulator is
// almost exact at 1.05, yet averaging their probabilities came out at 1.188 - the pooled forecast
// was less spread out (sd of logit 1.52) than any model that went into it (1.63 to 1.96).
// Recalibrating each part first does not help, which is the proof: it leaves 1.220.
//
// Two things cause it and this fixes both. Averaging in log-odds rather than in probability stops
// the arithmetic mean dragging everything towards 50%, which gets 1.188 down to 1.103. The rest is
// not a fault at all - combining four models cuts noise, so the pool really does know more than
// its members and its log-odds want stretching outward, most of all when they agree. One fitted
// scale and intercept finishes the job: held out on the season it was not fitted on, the slope
// lands at 0.989 with the Brier unmoved (0.1658 against 0.1660). Fitting a separate calibration
// per part of the season was worse (0.1669), so there is one for the whole year.
//
// It is a stretch and nothing else. Letting the fit have an intercept as well made it slightly
// worse held out (slope 0.989 and Brier 0.1658, against 1.007 and 0.1655) and the intercept was
// not significant anyway (-0.035, SE 0.044), so dropping it costs nothing and buys symmetry: an
// evenly matched pair comes out at exactly 50%, whichever way round the two teams are entered.
const WIN_STRETCH = 1.09349;       // 3,348 games, 2024-25

const logOdds = (p) => Math.log(Math.min(Math.max(p, 1e-6), 1 - 1e-6) / (1 - Math.min(Math.max(p, 1e-6), 1 - 1e-6)));

// The composite's win chance: the weighted mean of the models' log-odds, stretched back out to
// where the results say it belongs. Margins are pooled plainly instead - they are points, not
// probabilities, and nothing drags them towards the middle.
function compositeWin(weights, parts) {
  let z = 0;
  for (const [k, w] of Object.entries(weights)) z += w * logOdds(parts[k].p);
  return 1 / (1 + Math.exp(-WIN_STRETCH * z));
}

// MARGIN GAIN on the score Elo. Regressing actual margin on predicted over the 1,420 FBS-vs-FBS
// games of 2024-25 that every model covers, the four models come out at: epa 1.052 (se 0.041),
// success 0.943 (0.037), score Elo 0.835 (0.031), game script 1.146 (0.040). Only two of them are
// significantly off 1 - the Elo is too LARGE and the simulator too SMALL, by t = -5.39 and +3.66 -
// so only those two are corrected. Fitting a factor for epa and success as well would be fitting
// noise at t = 1.29 and -1.56.
//
// The simulator's own correction lives in script.js, where it varies by week. The Elo's is flat:
// its per-bucket estimates (0.78, 0.74, 0.91, 0.99 from weeks 3-4 onward) differ by about two
// standard errors at most, which is not enough to spend four parameters on.
//
// Applied to the MARGIN only. The Elo's win chance stays on the ungained margin, because
// WIN_STRETCH and BLEND_WEEKS were fitted against the ungained probabilities.
const ELO_MARGIN_GAIN = 0.835;

// Against the spread the number itself is what matters, not who wins, so the spread columns use
// a mix fitted on absolute margin error rather than on log loss. Fitted on one season and scored
// on the other over the 1,550 FBS-vs-FBS games of 2024-25 that carry a closing line, it predicts
// the margin to 12.45 points against the old EPA + success-Elo average's 12.66 (paired p=0.004).
// Unlike the winner mix it does not want to vary by week - fitting a set per part of the season
// gained 0.01 points, which is nothing (p=0.81) - and the objective is flat enough that these
// weights are a direction rather than a precise point: every sensible set lands within 0.04 of
// the best. They are the average of the held-out fits, which is steadier than either season's.
//
// Being better at the margin did NOT make it better against the spread: 52.8% here against the
// winner mix's 53.1%, and no pair of models in that test was separable at all. Nothing in this
// file beats a closing line.
//
// REFITTED AND REJECTED once the per-model margin gains went in. The reasoning for refitting was
// sound - part of what these weights were doing was correcting scale, so correcting each model
// first should free them to express only which opinion is worth more - but the measurement did not
// agree. Over the 1,420 FBS-vs-FBS games of 2024-25 that every model covers, on this build with
// the gain applied: these weights give MAE 12.198, and a refit held out by season gives 12.189 -
// a difference of 0.009 points, paired t = -0.26, p = 0.79, bootstrap CI [-0.045, +0.033]. The
// refit was also worse on BOTH held-out folds taken singly (12.233 against 12.224, and 12.177
// against 12.172), so these are kept.
//
// The reason is that the two gains offset inside the mix: the simulator is scaled up and the score
// Elo down, and this mix holds both, so correcting each one individually leaves the blend close to
// where it already was. The gains are still worth having on their own terms - alone, the Elo goes
// from 12.768 to 12.614 and the simulator from 12.575 to 12.522 - and the case for them is
// calibration rather than accuracy. See the note in game_script.py.
const MARGIN_MIX = { epa: 0.06, success: 0.31, elo: 0.26, script: 0.37 };

// The margin mix over whichever models have a number, renormalised the same way blendWeights does
function mixMargin(parts) {
  let num = 0, den = 0;
  for (const [k, w] of Object.entries(MARGIN_MIX)) {
    if (!parts[k]) continue;
    num += w * parts[k].margin;
    den += w;
  }
  return den > 0.3 ? num / den : null;
}

// Running the simulator for a whole table is the one expensive thing the page does, so each
// matchup is kept once it is played out. 400 sims costs about 30ms - fine for the 60-odd games
// of a single week, too slow for every game of a season in one go, which is what the time budget
// in showWeeklyPredictions() is for.
const SCRIPT_TABLE_SIMS = 400;
const scriptCache = new Map();
// The week is part of the key because the projection carries that week's margin gain (see
// marginGain in script.js), so the same matchup simulated for week 2 and for week 10 is not the
// same number. Two meetings of the same pair in one season do not otherwise happen.
const scriptKey = (home, away, neutral, week) =>
  `${home}|${away}|${neutral ? 'n' : 'h'}|${week ?? '-'}`;

// undefined means "not played out yet", null means "this matchup has no simulation"
function scriptCached(home, away, neutral, week) {
  return scriptCache.get(scriptKey(home, away, neutral, week));
}
function scriptRun(home, away, neutral, week) {
  const key = scriptKey(home, away, neutral, week);
  if (scriptCache.has(key)) return scriptCache.get(key);
  const out = state.script
    ? scriptProjection(state.script, home, away, neutral ? 'neutral' : 'a', SCRIPT_TABLE_SIMS, week)
    : null;
  scriptCache.set(key, out);
  return out;
}

// The weights for a week, over the models that actually have a number for this matchup. A model
// that is missing does not vote, and the survivors are renormalised so they still sum to 1.
function blendWeights(week, available) {
  const table = (BLEND_WEEKS.find((b) => week <= b.upto) ?? BLEND_WEEKS[BLEND_WEEKS.length - 1]).weights;
  const out = {};
  let sum = 0;
  for (const [k, w] of Object.entries(table)) {
    if (available[k] === undefined || available[k] === null) continue;
    out[k] = w;
    sum += w;
  }
  if (!sum) return {};
  for (const k of Object.keys(out)) out[k] /= sum;
  return out;
}

function showPrediction() {
  const byName = Object.fromEntries(state.teams.map((t) => [t.team, t]));
  const a = byName[state.matchup['team-a']], b = byName[state.matchup['team-b']];
  if (!a || !b) return;
  const m = state.model;
  const site = $('site').value;
  const side = site === 'a' ? 1 : site === 'b' ? -1 : 0;
  // Each model's own opinion first; the blend that follows decides how much of each to take.
  // Success Elo home field: success_home_tiers added to the home team's tier.
  const epaMargin = a.epa_rating - b.epa_rating + side * m.home_field_points;
  const epaP = normalCdf(epaMargin / m.margin_sd);
  const successP = tierWin(a.success_tier - b.success_tier + side * (m.success_home_tiers ?? 0), m.randomness_factor);
  const successMargin = m.margin_sd * probit(successP);
  const eloMargin = a.elo_points - b.elo_points + side * m.elo_home_points;
  const eloSd = m.elo_points_per_tier * Math.sqrt(a.elo_off_sd ** 2 + b.elo_def_sd ** 2 + b.elo_off_sd ** 2 + a.elo_def_sd ** 2);
  const eloP = normalCdf(eloMargin / eloSd);
  // the game-script model plays the match out snap by snap, so it is its own opinion rather than
  // a second view of the ratings above
  const script = state.script
    ? scriptProjection(state.script, a.team, b.team, site, undefined, currentWeek())
    : null;

  // The mix for where the season has got to. Margins and win chances are weighted separately,
  // the same way the flat average did it.
  const week = currentWeek();
  const models = {
    script:  script && { label: 'Game script', margin: script.margin, p: script.p,
                         samples: script.samples.margin.map((v) => -v) },
    elo:     { label: 'Score Elo', margin: eloMargin * ELO_MARGIN_GAIN, p: eloP, sd: eloSd },
    epa:     { label: 'EPA model', margin: epaMargin, p: epaP, sd: m.margin_sd },
    success: { label: 'Success Elo', margin: successMargin, p: successP, sd: m.margin_sd },
  };
  const weights = blendWeights(week, models);
  let margin = 0;                                     // points, positive = Team A wins
  for (const [k, w] of Object.entries(weights)) margin += w * models[k].margin;
  const pA = compositeWin(weights, models);
  const [winner, loser, p] = pA >= 0.5 ? [a, b, pA] : [b, a, 1 - pA];
  const lean = (mg, pa) => `${mg >= 0 ? a.team : b.team} by ${Math.abs(mg).toFixed(1)}, ${fmt.pct(mg >= 0 ? pa : 1 - pa)}`;
  const where = site === 'neutral' ? 'on a neutral field' : `at ${site === 'a' ? a.team : b.team}`;
  // Rows with a key are on the rankings table's 0-100 scale, with the rating they came from on
  // hover; the rest are not ratings and stay as they are.
  const rows = [
    { label: 'Rating (average)', key: 'rating', rank: (t) => rk(t) },
    { label: 'EPA rating', key: 'epa_rating', rank: (t) => rk(t, 'epa_rank') },
    { label: 'Success Elo', key: 'success_points', rank: (t) => rk(t, 'success_rank') },
    { label: 'Success Elo tier', value: (t) => fmt.num(t.success_tier, 2) },
    { label: 'Score Elo (reference)', key: 'elo_points', rank: (t) => rk(t, 'elo_rank') },
    { label: 'Offense', key: 'offense', rank: (t) => rk(t, 'offense_rank') },
    { label: 'Defense', key: 'defense', rank: (t) => rk(t, 'defense_rank') },
    { label: 'Success Elo offense', key: 'success_off', rank: (t) => rk(t, 'success_off_rank') },
    { label: 'Success Elo defense', key: 'success_def', rank: (t) => rk(t, 'success_def_rank') },
    { label: 'Record', value: (t) => `${t.wins}-${t.losses}` },
    { label: 'Schedule strength', key: 'schedule_strength', rank: (t) => rk(t, 'schedule_rank') },
    { label: 'Off EPA/play (raw)', key: 'off_epa_per_play', digits: 3, unit: 'EPA per play' },
    { label: 'Def EPA/play (raw)', key: 'def_epa_per_play', digits: 3, unit: 'EPA per play (+ is good)' },
  ];
  const compareCell = (row, t) => {
    const rank = row.rank ? row.rank(t) : '';
    return `<td>${row.key ? scoreText(t, row) : row.value(t)}${rank ? ` <span class="sub">${rank}</span>` : ''}</td>`;
  };
  // the score model supplies the total; the margin is the page's own blend, so the two agree
  const colors = matchupColors(a, b, site);
  const projection = state.score ? projectScore(state.score, a.team, b.team, side, margin) : null;
  const scoreLine = projection
    ? `<p class="subline">Projected score: <strong>${a.team} ${projection.home.toFixed(0)} – ${b.team} ${projection.away.toFixed(0)}</strong>` +
      ` (total ${projection.total.toFixed(0)}, ${projection.plays.home}–${projection.plays.away} plays).` +
      ` Typical miss about 9 points a team; 8 games in 10 land inside ${projection.range.home[0].toFixed(0)}–${projection.range.home[1].toFixed(0)}` +
      ` and ${projection.range.away[0].toFixed(0)}–${projection.range.away[1].toFixed(0)}.</p>`
    : '';
  const scriptLine = script
    ? `<p class="subline">Game script: <strong>${a.team} ${script.a.toFixed(0)} – ${b.team} ${script.b.toFixed(0)}</strong>` +
      ` (total ${script.total.toFixed(0)}), ${script.margin >= 0 ? a.team : b.team} wins ${fmt.pct(script.margin >= 0 ? script.p : 1 - script.p)}.` +
      ` It simulates the downs: play calling, penalties, turnovers, 4th downs and kicking.</p>`
    : '';
  // Every model's whole distribution, not just where it lands: the two simulated models bring
  // their samples, the rating models their normal curve.
  //
  // The axis runs the way the page does - team A's wins to the left, team B's to the right, the
  // same order as the cards and the probability bar - so a margin is negated on its way in, and
  // read back out as a margin of victory for whichever side it falls on.
  //
  // Only the models carrying weight this week are drawn, heaviest first, each over its share of
  // the blend - so the chart says what the number is actually made of rather than listing every
  // model the page can compute.
  const marginRow = (label, aMargin, aChance, extra = {}) => ({
    label,
    mean: -aMargin,
    note: `by ${Math.abs(aMargin).toFixed(1)} · ${fmt.pct(aMargin >= 0 ? aChance : 1 - aChance)}`,
    ...extra,
  });
  const weightOrder = Object.entries(weights).sort((x, y) => y[1] - x[1]);
  const marginRows = [
    marginRow('Composite', margin, pA, { sd: m.margin_sd, sub: `week ${week} mix` }),
    ...weightOrder.map(([k, w]) => {
      const mod = models[k];
      return marginRow(mod.label, mod.margin, mod.p,
        { sub: `${(100 * w).toFixed(0)}% of the mix`,
          ...(mod.samples ? { samples: mod.samples } : { sd: mod.sd }) });
    }),
  ];
  // the score model's margin is recentred on the average above, so only its total is its own
  const totalRows = [];
  if (projection) {
    totalRows.push({ label: 'Score model', mean: projection.total, samples: projection.samples.total,
      note: `${projection.total.toFixed(0)} pts · 8 in 10: ${projection.range.total[0].toFixed(0)}–${projection.range.total[1].toFixed(0)}` });
  }
  if (script) {
    const lo = quantile([...script.samples.total].sort((x, y) => x - y), 0.1);
    const hi = quantile([...script.samples.total].sort((x, y) => x - y), 0.9);
    totalRows.push({ label: 'Game script', mean: script.total, samples: script.samples.total,
      note: `${script.total.toFixed(0)} pts · 8 in 10: ${lo.toFixed(0)}–${hi.toFixed(0)}` });
  }
  // The charts are drawn at the width their column actually gets, so 12px of label is 12px on
  // screen; that width is only knowable once the card is in the page, so drawCharts() fills them
  // in afterwards and again whenever the window changes size.
  state.charts = [
    { rows: marginRows,
      caption: 'Margin of victory <span>only the models carrying weight this week, heaviest first; the winner takes their own colour and their own side, and every row shares one height scale</span>',
      options: {
        zero: true,
        // left of zero is team A's, matching the cards and the probability bar above
        colors: { neg: colors.a || 'var(--accent)', pos: colors.b || '#8a8a93' },
        ends: { left: { label: a.team, color: colors.a || 'var(--accent)' },
                right: { label: b.team, color: colors.b || '#8a8a93' } },
        format: (v) => Math.abs(v).toFixed(0),
        describe: (low, high) => {
          // zero is always a bin edge, so a bin never straddles it
          const team = high <= 0 ? a.team : b.team;
          const near = Math.min(Math.abs(low), Math.abs(high));
          const far = Math.max(Math.abs(low), Math.abs(high));
          return `${team} by ${near}-${far}`;
        },
        label: `How often each model expects each margin of victory, ${a.team} against ${b.team}` } },
  ];
  if (totalRows.length) {
    state.charts.push({ rows: totalRows, caption: 'Points in the game <span>only the two simulated models predict a total; bar height is the share of games in a 7-point band</span>',
      options: { format: (v) => v.toFixed(0), unit: 'points', label: `How often each model expects each total score, ${a.team} against ${b.team}` } });
  }
  // A price the reader supplies, laid out the way a book lays it out - a row per team, spread /
  // to win / total across - so the numbers can be copied straight across. Multipliers are decimal
  // returns, so a stake of 1 comes back as the multiplier when the bet lands.
  const gameKind = division(a) === 'FBS' && division(b) === 'FBS' ? 'FBS vs FBS'
    : division(a) !== 'FBS' && division(b) !== 'FBS' ? 'FCS vs FCS' : 'cross-division';
  // the moneyline is priced off the composite, the spread off the margin-fitted mix
  const atsMargin = mixMargin(models) ?? margin;
  state.price.context = { a: a.team, b: b.team, margin, pA, atsMargin, projection, script, gameKind };
  const box = (id, ph, step) => `<input id="price-${id}" type="number" step="${step}" placeholder="${ph}" value="${state.price[id] ?? ''}">`;
  const cellFor = (line, mult, ev) =>
    `<div class="cell">${line}<div class="mult">${mult}<span class="x">\u00d7</span></div><div class="ev" id="ev-${ev}"></div></div>`;
  const priceBlock = `
    <div class="price">
      <h4>Test a price <span class="sub">enter the book's numbers; multipliers are decimal returns, so 1.91 is \u2212110</span></h4>
      <div class="price-scroll"><table class="price-grid">
        <thead><tr><th></th><th>Spread</th><th>To win</th><th>Total</th></tr></thead>
        <tbody>
          <tr>
            <td class="text">${a.team}</td>
            <td>${cellFor(box('spreadA', '-2.5', '0.5'), box('multSA', '1.92', '0.01'), 'spreadA')}</td>
            <td>${cellFor('<div class="blank"></div>', box('multMLA', '1.75', '0.01'), 'mlA')}</td>
            <td>${cellFor(`<span class="ou">O</span>${box('total', '50.5', '0.5')}`, box('multOver', '2.00', '0.01'), 'over')}</td>
          </tr>
          <tr>
            <td class="text">${b.team}</td>
            <td>${cellFor(box('spreadB', '+2.5', '0.5'), box('multSB', '2.04', '0.01'), 'spreadB')}</td>
            <td>${cellFor('<div class="blank"></div>', box('multMLB', '2.27', '0.01'), 'mlB')}</td>
            <td>${cellFor('<span class="ou">U</span><span class="mirror" id="price-under-line">\u2013</span>', box('multUnder', '1.92', '0.01'), 'under')}</td>
          </tr>
        </tbody>
      </table></div>
      <div id="price-out" class="price-out"></div>
    </div>`;
  const charts = `<div class="charts">${state.charts.map((c) =>
    `<figure class="chart"><figcaption>${c.caption}</figcaption><div class="plot"></div></figure>`).join('')}</div>`;
  const venue = site === 'neutral' ? 'neutral site' : site === 'a' ? `at ${a.team}` : `at ${b.team}`;
  $('prediction').innerHTML = `
    <div class="teams">${teamCard(a, 'a')}<div class="vs">vs<br><span>${venue}</span></div>${teamCard(b, 'b')}</div>
    <p class="headline">${winner.team} by ${Math.abs(margin).toFixed(1)}</p>
    ${scoreLine}
    ${scriptLine}
    <p class="subline">${weightOrder.map(([k, w]) => `${models[k].label} (${(100 * w).toFixed(0)}%): ${lean(models[k].margin, models[k].p)}`).join(' · ')}${
      Object.keys(models).filter((k) => models[k] && !weights[k]).length
        ? `<br>Carrying no weight in week ${week}: ${Object.keys(models).filter((k) => models[k] && !weights[k]).map((k) => `${models[k].label} (${lean(models[k].margin, models[k].p)})`).join(' · ')}`
        : ''}</p>
    <p class="subline">${winner.team} wins ${fmt.pct(p)} of the time ${where}${where.endsWith('.') ? '' : '.'} Typical miss: about ${Math.round(m.margin_sd * 0.8)} points either way.</p>
    <div class="probability">
      <div class="a" style="${barStyle(colors.a)};width:${(100 * pA).toFixed(1)}%">${pA >= 0.12 ? `${a.team} ${fmt.pct(pA)}` : ''}</div>
      <div class="b" style="${barStyle(colors.b)};width:${(100 * (1 - pA)).toFixed(1)}%">${1 - pA >= 0.12 ? `${fmt.pct(1 - pA)} ${b.team}` : ''}</div>
    </div>
    ${charts}
    ${priceBlock}
    <table class="compare">
      <thead><tr><th></th><th>${a.team}</th><th>${b.team}</th></tr></thead>
      <tbody>${rows.map((row) => `<tr><td class="text">${row.label}</td>${compareCell(row, a)}${compareCell(row, b)}</tr>`).join('')}</tbody>
    </table>`;
  drawCharts();
  PRICE_FIELDS.forEach((id) => $(`price-${id}`)?.addEventListener('input', showPrice));
  showPrice();
  $('predictor-note').textContent = `Ratings in the table are on the rankings page's 0-100 scale, where 0 is the lowest and 100 the highest ` +
    `any team has rated in the seasons here; hover one for the points it stands for. The scores and margins above are points. ` +
    `A weighted blend of the models that earn their place in week ${week}. EPA: rating difference plus ${m.home_field_points.toFixed(1)} home points, ` +
    `spread SD ${m.margin_sd.toFixed(1)} (${m.calibration_season} results). Success Elo (Season_Analyzer.py's Elo with each game scored by the ` +
    `win chance its play-success share implies, curve from ${m.success_beta_season}; home team +${m.success_home_tiers} tiers). Game script ` +
    `plays the match out snap by snap. The weights were fitted on one season and scored on the other across 2024-25 (3,348 games), so the ` +
    `simulator carries the early weeks and score Elo takes over once the ratings have games behind them; that beat the flat EPA + success-Elo ` +
    `average by 0.0147 Brier in weeks 1-3, easing to 0.0025 from week 10.`;
}

// Redrawing only re-bins numbers that are already in hand, so it is cheap enough to repeat on
// every resize; neither simulation runs again.
function drawCharts() {
  const plots = document.querySelectorAll('#prediction .chart .plot');
  plots.forEach((plot, i) => {
    const chart = state.charts?.[i];
    if (!chart) return;
    const width = plot.clientWidth;
    if (width > 0) plot.innerHTML = distributionChart(chart.rows, { ...chart.options, width });
  });
}

const PRICE_FIELDS = ['spreadA', 'multSA', 'multMLA', 'spreadB', 'multSB', 'multMLB', 'total', 'multOver', 'multUnder'];

// Reads the price grid, writes the expected return into each cell, and explains underneath what
// those returns rest on. Nothing here re-runs a model: the matchup's own margin, win chance and
// simulated totals are already in state.price.context.
function showPrice() {
  const out = $('price-out');
  if (!out || !state.price.context) return;
  const { a, b, margin, pA, atsMargin, projection, script, gameKind } = state.price.context;
  const num = (id) => {
    const raw = $(`price-${id}`)?.value.trim() ?? '';
    state.price[id] = raw;
    const v = raw === '' ? null : Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  const v = Object.fromEntries(PRICE_FIELDS.map((f) => [f, num(f)]));
  const pct = (x) => fmt.pct(x);
  const notes = [];
  const show = (id, value, muted = false) => {
    const el = $(`ev-${id}`);
    if (!el) return;
    el.textContent = value === null ? '' : `${fmt.signed(100 * value, 1)}%`;
    el.className = `ev ${value === null ? '' : muted ? 'flat' : tone(value)}`;
  };
  // the under mirrors the over's line, exactly as a book prints it on both rows
  const underLine = $('price-under-line');
  if (underLine) underLine.textContent = v.total === null ? '\u2013' : v.total.toFixed(1);

  // Spreads: each side priced on its own, so two books can be compared side by side.
  for (const [id, team, spreadKey, multKey, toMarketA] of
       [['spreadA', a, 'spreadA', 'multSA', (x) => -x], ['spreadB', b, 'spreadB', 'multSB', (x) => x]]) {
    const spread = v[spreadKey], mult = v[multKey] ?? 1.91;
    if (spread === null || mult <= 1) { show(id, null); continue; }
    const edgeForA = atsMargin - toMarketA(spread);
    const c = coverChanceFor(team === a ? edgeForA : -edgeForA);
    show(id, evFromMultiplier(c.chance, mult));
    notes.push(`<p><strong>${team} ${fmt.signed(spread, 1)}</strong> covers <strong>${pct(c.chance)}</strong> of the time ` +
      `(95%: ${pct(c.low)}\u2013${pct(c.high)}); at ${mult.toFixed(2)}\u00d7 you need ${pct(1 / mult)}. ` +
      `So the return is ${fmt.signed(100 * evFromMultiplier(c.chance, mult), 1)}%, ` +
      `anywhere from ${fmt.signed(100 * evFromMultiplier(c.low, mult), 1)}% to ${fmt.signed(100 * evFromMultiplier(c.high, mult), 1)}%.` +
      (c.extrapolating ? ` <span class="sub">Past where the data goes \u2014 only ${ATS_FIT.beyondP95} of ${ATS_FIT.games} ` +
        `fitted games disagreed by more than ${ATS_FIT.p95} points, so that interval is too narrow.</span>` : '') + `</p>`);
  }

  for (const [id, team, multKey, chance] of [['mlA', a, 'multMLA', pA], ['mlB', b, 'multMLB', 1 - pA]]) {
    const mult = v[multKey];
    if (mult === null || mult <= 1) { show(id, null); continue; }
    show(id, evFromMultiplier(chance, mult));
    notes.push(`<p><strong>${team} to win</strong> at ${mult.toFixed(2)}\u00d7 implies ${pct(1 / mult)}; ` +
      `the models say <strong>${pct(chance)}</strong>.</p>`);
  }

  // Totals. The simulated probability has no measured skill, so its return is shown muted rather
  // than green or red, and what is reported instead is whether the two models agree - the only
  // structure the backtest found.
  const line = v.total;
  const share = (samples) => (samples && line !== null ? samples.filter((t) => t > line).length / samples.length : null);
  const pScore = share(projection?.samples?.total), pScript = share(script?.samples?.total);
  const named = [[pScore, 'score model'], [pScript, 'game script']].filter(([x]) => x !== null);
  for (const [id, multKey, flip] of [['over', 'multOver', false], ['under', 'multUnder', true]]) {
    const mult = v[multKey];
    if (mult === null || mult <= 1 || !named.length) { show(id, null); continue; }
    show(id, evFromMultiplier(flip ? 1 - named[0][0] : named[0][0], mult), true);
  }
  if (line !== null && named.length && (v.multOver > 1 || v.multUnder > 1)) {
    const fit = totalsFitFor(gameKind);
    const both = named.map(([x]) => x);
    const sides = both.map((x) => (x > 0.5 ? 'over' : 'under'));
    const concord = both.length > 1 && sides[0] === sides[1];
    const state_ = both.length < 2 ? null
      : concord ? (sides[0] === 'over' ? fit.bothOver : fit.bothUnder) : fit.split;
    notes.push(`<p><strong>Total ${line.toFixed(1)}.</strong> ` +
      named.map(([x, name], i) => `${i ? 'the' : 'The'} ${name} puts it over ${pct(x)} of the time`).join(', and ') + '. ' +
      (state_ === null ? '' :
        concord ? `<strong>They agree on the ${sides[0]}</strong>, which landed ${pct(state_.hit)} of the time ` +
                  `over ${state_.games.toLocaleString()} such games \u2014 against ${pct(110 / 210)} to break even.`
                : `<strong>They disagree</strong>, and disagreements landed ${pct(state_.hit)} of the time over ` +
                  `${state_.games.toLocaleString()} games \u2014 a coin flip.`) + `</p>`);

    // say which population these figures come from, because they differ by game type
    const basis = fit.basis === 'all game types'
      ? `The error figures below are this matchup's own type, but ${gameKind} has only ${fit.ownGames} games with a ` +
        `total line in the test, so the agreement and calibration figures come from all ` +
        `${fit.pooledGames.toLocaleString()} games instead`
      : `Measured on ${fit.ownGames.toLocaleString()} ${fit.kind} games` +
        (fit.borrowed.length ? `, except the ${fit.borrowed.join(' and ')} figure, borrowed from all ` +
          `${fit.pooledGames.toLocaleString()} games for want of a big enough sample` : '');
    const cal = fit.calibration;
    notes.push(`<p class="sub">${basis}. Those percentages are not forecasts, which is why their returns are greyed ` +
      `out: totals the score model called ${cal[0][0]}\u2013${cal[0][1]}% likely to go over went over ${cal[0][2]}% ` +
      `of the time, and ones it called ${cal[3][0]}\u2013${cal[3][1]}% went over ${cal[3][2]}% \u2014 the whole range ` +
      `of predictions maps onto a few points of reality. Here the line misses the total by ${fit.lineMae} points ` +
      `against ${fit.modelMae} for the score model and ${fit.scriptMae} for the game script, which runs ` +
      `${fit.scriptBias > 0 ? fit.scriptBias + ' points high' : Math.abs(fit.scriptBias) + ' points low'}` +
      (Math.min(fit.modelMae, fit.scriptMae) < fit.lineMae
        ? ` \u2014 the one game type where a model of ours beats the line on totals` : '') + `.</p>`);
  }

  out.innerHTML = notes.length ? notes.join('')
    : '<p class="sub">Enter the book\'s lines and multipliers above to see what each is worth.</p>';
}

function fillTeamSelects() {
  // keep whoever is picked if they played this season, else fall back to the top two FBS teams
  const names = new Set(state.teams.map((t) => t.team));
  const top = (n) => state.teams.find((t) => division(t) === 'FBS' && t.rank === n)?.team;
  for (const [id, fallback] of [['team-a', top(1)], ['team-b', top(2)]]) {
    const wanted = state.matchup[id];
    state.matchup[id] = names.has(wanted) ? wanted : fallback;
    $(id).value = state.matchup[id] ?? '';
  }
}

// ---------------------------------------------------------------- weekly predictions

function miniLogo(team) {
  if (!team || !team.espn_id) return '';
  const base = 'https://a.espncdn.com/i/teamlogos/ncaa';
  return `<picture><source media="(prefers-color-scheme: dark)" srcset="${base}/500-dark/${team.espn_id}.png">` +
    `<img class="mini-logo" src="${base}/500/${team.espn_id}.png" alt="" loading="lazy" onerror="this.closest('picture').remove()"></picture>`;
}

function formatLine(home, away, margin, p) {
  if (margin === null || margin === undefined || Number.isNaN(margin)) return '–';
  if (Math.abs(margin) < 0.05) return 'PK';
  const fav = margin > 0 ? home : away;
  const pts = Math.abs(margin).toFixed(1);
  const pFav = margin > 0 ? p : (1 - p);
  const pStr = (pFav !== undefined && !Number.isNaN(pFav)) ? ` (${(pFav * 100).toFixed(0)}%)` : '';
  return `<span title="${fav} by ${pts}${pStr}"><strong>${fav}</strong> -${pts}</span>`;
}

function formatSpread(home, away, spread) {
  if (spread === null || spread === undefined || Number.isNaN(spread)) return '–';
  if (Math.abs(spread) < 0.05) return 'PK';
  const fav = spread < 0 ? home : away;
  return `<span><strong>${fav}</strong> -${Math.abs(spread).toFixed(1)}</span>`;
}

function renderWin(r) {
  if (r.win_p === null || r.win_p === undefined || Number.isNaN(r.win_p)) return '–';
  const p = Math.max(r.win_p, 1 - r.win_p);
  return `<span title="${r.win_pick} by ${Math.abs(r.win_margin).toFixed(1)}"><strong>${r.win_pick}</strong> <span class="sub">${(100 * p).toFixed(0)}%</span></span>`;
}

function renderEdge(r) {
  if (r.edge === null || r.edge === undefined || Number.isNaN(r.edge)) return '–';
  if (Math.abs(r.edge) < 0.2) return '<span class="sub">Even</span>';
  const pick = r.edge > 0 ? r.home : r.away;
  const pts = Math.abs(r.edge).toFixed(1);
  const cls = Math.abs(r.edge) >= 3.0 ? 'pos' : '';
  return `<span class="edge-val ${cls}" title="${pick} +${pts} pts of value vs spread"><strong>${pick}</strong> +${pts}</span>`;
}

function renderSignalBadge(r) {
  if (r.hasVegas) {
    if (r.isStrongSignal) {
      return `<span class="badge gold" title="EPA sees value here and success Elo does not, or the other way round. Backing the model line in this group went 182-150 (54.8%) over the 1,550 games of 2024-25, against a 52.4% break-even at -110 - the best of the three, and still inside the margin of error on 332 games.">Lean ${r.atsPick}</span>`;
    }
    if (r.modelsAgreeATS) {
      return `<span class="badge agree" title="EPA and success Elo pick the same side. Backing the model line in this group went 297-281 (51.4%) over the 1,550 games of 2024-25, under the 52.4% break-even at -110.">Agree ${r.atsPick}</span>`;
    }
    return `<span class="badge disagree" title="EPA and success Elo pick opposite sides. Backing the model line in this group went 339-301 (53.0%) over the 1,550 games of 2024-25, which is break-even once the vig is paid. These badges describe how the models relate, not an edge.">Split</span>`;
  }
  if (r.modelsAgreeSU) {
    return `<span class="badge agree" title="Both models pick ${r.suPick} to win">Agree (${r.suPick})</span>`;
  }
  return `<span class="badge disagree" title="Models split on straight-up winner">Split</span>`;
}

function formatDateTime(r) {
  if (!r.date) return '–';
  const parts = r.date.split('-');
  if (parts.length < 3) return r.date;
  const m = Number(parts[1]), d = Number(parts[2]);
  const dateObj = new Date(`${r.date}T${r.time || '12:00'}:00Z`);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = !isNaN(dateObj.getTime()) ? days[dateObj.getUTCDay()] + ' ' : '';
  return `${day}${m}/${d}${r.time ? ` · ${r.time}` : ''}`;
}

function goToMatchup(teamA, teamB, site) {
  state.matchup['team-a'] = teamA;
  state.matchup['team-b'] = teamB;
  $('team-a').value = teamA;
  $('team-b').value = teamB;
  $('site').value = site === 'neutral' ? 'neutral' : 'a';
  showPrediction();
  showView('predictor');
}

const weeklyColumns = [
  { key: 'kickoff_sort', label: 'Date/Time', text: true, render: (r) => formatDateTime(r) },
  { key: 'matchup_name', label: 'Matchup', text: true, cls: 'team matchup-cell', render: (r) => r.matchup_html },
  { key: 'win_sort', label: 'To win', title: 'Straight-up pick from the composite - the week-varying mix of models, the same one the Matchup page blends. Fitted on one season and scored on the other over 2024-25, it beat the flat EPA + success-Elo average at picking winners in every part of the season', render: (r) => renderWin(r) },
  { key: 'epa_margin', label: 'EPA Line', title: 'Opponent-adjusted EPA predicted line. Bold indicates favorite', render: (r) => formatLine(r.home, r.away, r.epa_margin, r.epa_p) },
  { key: 'success_margin', label: 'Success Elo', title: 'Play-success Elo predicted line. Bold indicates favorite', render: (r) => formatLine(r.home, r.away, r.success_margin, r.success_p) },
  { key: 'mix_margin', label: 'Model line', defaultSort: true, title: 'The predicted margin, from the mix fitted to be most accurate on raw margin: 37% game script, 31% success Elo, 26% score Elo, 6% EPA. Each model\'s margin is scaled to its own measured gain first. This is the number the Edge column is measured against', render: (r) => formatLine(r.home, r.away, r.mix_margin) },
  { key: 'spread', label: 'Spread', title: 'Consensus/closing Vegas spread (negative is favorite)', render: (r) => formatSpread(r.home, r.away, r.spread) },
  { key: 'edge', label: 'Edge', title: 'Model line vs Vegas spread. Points of value on favorite/underdog', render: (r) => renderEdge(r) },
  { key: 'signal_sort', label: 'Agreement', text: true, title: 'Whether the two models pick the same side against the spread. Hover a badge for how that rule did over 2024-25 - none of them beat the closing line', render: (r) => renderSignalBadge(r) },
  { key: 'result', label: 'Score', text: true, render: (r) => r.result_html || '–' },
];

function fillWeeks() {
  const weeks = [...new Set(state.schedule.map((g) => g.week).filter((w) => w !== null && w !== undefined))].sort((a, b) => a - b);
  const uncompleted = state.schedule.filter((g) => !g.completed && g.week !== null && g.week !== undefined);
  const nextWeek = uncompleted.length ? Math.min(...uncompleted.map((g) => g.week)) : (weeks[weeks.length - 1] ?? 1);
  const currentVal = $('weekly-week').value;
  $('weekly-week').innerHTML = weeks.map((w) => `<option value="${w}">${w === 0 ? 'Week 0' : 'Week ' + w}</option>`).join('');
  if (currentVal && weeks.includes(Number(currentVal))) {
    $('weekly-week').value = currentVal;
  } else {
    $('weekly-week').value = String(nextWeek);
  }
}

let weeklyLabel = '';              // the note's first sentence, so the filler can rewrite it cheaply
let scriptFilling = false;

// Plays out the matchups the first pass had no time for, in slices short enough that the page
// stays responsive, and redraws the table once at the end. Only the count in the note moves while
// it works - redrawing 800 rows per slice costs several times the simulation itself.
function scheduleScriptFill(games) {
  if (scriptFilling) return;
  scriptFilling = true;
  let i = 0;
  const step = () => {
    const stop = performance.now() + 60;
    while (i < games.length && performance.now() < stop) {
      const g = games[i++];
      // the week has to match what the table will ask for, or the fill lands under a different
      // cache key and every row is simulated a second time
      scriptRun(g.home, g.away, g.neutral, g.week);
    }
    if (i < games.length) {
      const note = $('weekly-note').firstChild;
      if (note) note.textContent = note.textContent.replace(/simulating \d+ more/, `simulating ${games.length - i} more`);
      setTimeout(step, 0);
      return;
    }
    scriptFilling = false;
    showWeeklyPredictions();
  };
  setTimeout(step, 0);
}

function showWeeklyPredictions() {
  if (!state.schedule || !state.schedule.length || !state.model || !state.teams.length) {
    $('weekly-table').innerHTML = '<tbody><tr><td class="text">No schedule data available for this season.</td></tr></tbody>';
    $('weekly-note').textContent = '';
    return;
  }
  const weekVal = $('weekly-week').value;
  const targetWeek = weekVal === '' ? null : Number(weekVal);
  const divFilter = $('weekly-division').value;
  const search = $('weekly-search').value.trim().toLowerCase();

  const byName = Object.fromEntries(state.teams.map((t) => [t.team, t]));
  const m = state.model;

  const filtered = state.schedule.filter((g) => {
    if (targetWeek !== null && g.week !== targetWeek) return false;
    const h = byName[g.home], a = byName[g.away];
    if (divFilter === 'FBS') {
      const hFbs = h && division(h) === 'FBS';
      const aFbs = a && division(a) === 'FBS';
      if (!hFbs && !aFbs) return false;
    }
    if (search) {
      const matchHome = g.home && g.home.toLowerCase().includes(search);
      const matchAway = g.away && g.away.toLowerCase().includes(search);
      const matchConf = (h?.conference && h.conference.toLowerCase().includes(search)) ||
                        (a?.conference && a.conference.toLowerCase().includes(search));
      if (!matchHome && !matchAway && !matchConf) return false;
    }
    return true;
  });

  // The simulator is played out for as many of these games as half a second allows, which covers
  // a single week - the usual view - before the table is first drawn. Anything left over is
  // filled in afterwards by scheduleScriptFill(), in slices, so picking All Weeks never freezes
  // the page. Each matchup costs about 50ms and is then cached for the rest of the session.
  const budget = performance.now() + 500;
  const unsimulated = [];

  const rows = filtered.map((g) => {
    const h = byName[g.home], a = byName[g.away];
    const side = g.neutral ? 0 : 1;
    let epaMargin = null, epaP = null, successMargin = null, successP = null, blendMargin = null, blendP = null;
    let edge = null, hasVegas = false, modelsAgreeATS = false, isStrongSignal = false, atsPick = '';
    let modelsAgreeSU = false, suPick = '';
    let winMargin = null, winP = null, winPick = '', mixM = null;

    if (h && a) {
      epaMargin = h.epa_rating - a.epa_rating + side * m.home_field_points;
      epaP = normalCdf(epaMargin / m.margin_sd);
      const diff = h.success_tier - a.success_tier + side * (m.success_home_tiers ?? 0);
      successP = tierWin(diff, m.randomness_factor);
      successMargin = m.margin_sd * probit(successP);
      blendMargin = (epaMargin + successMargin) / 2;
      blendP = (epaP + successP) / 2;

      modelsAgreeSU = Math.sign(epaMargin) === Math.sign(successMargin);
      suPick = blendMargin >= 0 ? g.home : g.away;

      // Picking the winner is the one job the week-varying mix was fitted for, so the To win
      // column uses it. The spread columns stay on the EPA + success-Elo blend, whose edge rules
      // and badges were calibrated on that pair.
      let script = scriptCached(g.home, g.away, g.neutral, g.week);
      if (script === undefined) {
        if (performance.now() < budget) script = scriptRun(g.home, g.away, g.neutral, g.week);
        else { script = null; unsimulated.push(g); }
      }
      const eloMarginRaw = h.elo_points - a.elo_points + side * m.elo_home_points;
      const parts = {
        script: script && { margin: script.margin, p: script.p },
        elo: { margin: eloMarginRaw * ELO_MARGIN_GAIN, p: null },
        epa: { margin: epaMargin, p: epaP },
        success: { margin: successMargin, p: successP },
      };
      const eloSdRow = m.elo_points_per_tier * Math.sqrt(h.elo_off_sd ** 2 + a.elo_def_sd ** 2 + a.elo_off_sd ** 2 + h.elo_def_sd ** 2);
      // the ungained margin, so the win chance keeps the basis WIN_STRETCH was fitted on
      parts.elo.p = normalCdf(eloMarginRaw / eloSdRow);
      const wts = blendWeights(g.week ?? 99, parts);
      winMargin = 0;
      for (const [k, wgt] of Object.entries(wts)) winMargin += wgt * parts[k].margin;
      winP = compositeWin(wts, parts);
      winPick = winP >= 0.5 ? g.home : g.away;
      // and the spread side on the margin-fitted mix
      mixM = mixMargin(parts);

      if (g.spread !== null && g.spread !== undefined && !Number.isNaN(g.spread)) {
        hasVegas = true;
        const vegasMargin = -g.spread;
        edge = (mixM ?? blendMargin) - vegasMargin;
        const edgeEpa = epaMargin - vegasMargin;
        const edgeSuccess = successMargin - vegasMargin;
        modelsAgreeATS = Math.sign(edgeEpa) === Math.sign(edgeSuccess);
        atsPick = edge >= 0 ? g.home : g.away;
        if ((Math.abs(edgeSuccess) >= 3.0 && Math.abs(edgeEpa) < 1.5) ||
            (Math.abs(edgeEpa) >= 3.0 && Math.abs(edgeSuccess) < 1.5)) {
          isStrongSignal = true;
        }
      }
    }

    const awayLogo = miniLogo(a);
    const homeLogo = miniLogo(h);
    const awayRk = a ? rk(a) : '';
    const homeRk = h ? rk(h) : '';
    const sep = g.neutral ? 'vs' : '@';
    const matchup_name = `${g.away} ${sep} ${g.home}`;
    const matchup_html = `<span class="matchup-link" data-home="${g.home}" data-away="${g.away}" data-neutral="${g.neutral}" title="Click to view in Matchup Predictor">${awayLogo}${awayRk ? `<span class="sub">${awayRk}</span> ` : ''}${g.away} ` +
      `<span class="sub">${sep}</span> ` +
      `${homeLogo}${homeRk ? `<span class="sub">${homeRk}</span> ` : ''}${g.home}</span>`;

    let result_html = '';
    if (g.completed && g.home_points !== null && g.away_points !== null) {
      result_html = `${g.away_points}–${g.home_points}`;
      if (hasVegas) {
        const coverMargin = (g.home_points - g.away_points) - (-g.spread);
        if (Math.abs(coverMargin) < 0.05) {
          result_html += ' <span class="sub">Push</span>';
        } else {
          const homeCovered = coverMargin > 0;
          const modelPickHome = edge >= 0;
          const covered = (homeCovered && modelPickHome) || (!homeCovered && !modelPickHome);
          result_html += covered ? ' <span class="pos">✓ Cover</span>' : ' <span class="neg">✗ Miss</span>';
        }
      }
    }

    const signal_sort = isStrongSignal ? 3 : (modelsAgreeATS || modelsAgreeSU) ? 2 : 1;

    return {
      game_id: g.game_id,
      home: g.home,
      away: g.away,
      neutral: g.neutral,
      kickoff_sort: `${g.date || ''} ${g.time || ''}`,
      date: g.date,
      time: g.time,
      matchup_name,
      matchup_html,
      epa_margin: epaMargin,
      epa_p: epaP,
      success_margin: successMargin,
      success_p: successP,
      blend_margin: blendMargin,
      blend_p: blendP,
      mix_margin: mixM,
      win_margin: winMargin,
      win_p: winP,
      win_pick: winPick,
      win_sort: winP === null ? null : Math.max(winP, 1 - winP),
      spread: g.spread,
      edge,
      hasVegas,
      modelsAgreeATS,
      isStrongSignal,
      atsPick,
      modelsAgreeSU,
      suPick,
      signal_sort,
      completed: g.completed,
      result_html,
    };
  });

  if (!state.sort.weekly) state.sort.weekly = { key: 'kickoff_sort', dir: 1 };
  renderTable($('weekly-table'), rows, weeklyColumns, 'weekly');

  const total = rows.length;
  const unplayed = rows.filter((r) => !r.completed).length;
  const weekLabel = targetWeek === null ? 'All Weeks' : targetWeek === 0 ? 'Week 0' : `Week ${targetWeek}`;
  weeklyLabel = `${weekLabel} · ${total} game${total === 1 ? '' : 's'} (${unplayed} upcoming)`;
  // whatever the budget left unplayed is filled in now that the browser has drawn this pass
  if (unsimulated.length) scheduleScriptFill(unsimulated);
  $('weekly-note').textContent = weeklyLabel +
    (unsimulated.length ? ` · simulating ${unsimulated.length} more…` : '.') + ` ` +
    `Click any matchup to open in the Matchup Predictor. Two different mixes: To win is the composite, weighted by ` +
    `week to pick winners, while Model line and Edge use the mix fitted to be most accurate on the margin itself ` +
    `(37% game script, 31% success Elo, 26% score Elo, 6% EPA). Margins indicate predicted points for the favorite. ` +
    `On the 1,550 FBS-vs-FBS games from 2024-25 that carry a closing line, nothing here beat it: the margin mix went ` +
    `52.8% against the spread where 52.4% breaks even at -110, no two models were separable from each other, and ` +
    `Vegas predicted margins more accurately than every one of them (11.9 points of error against 12.4). ` +
    `Treat the badges as a description of the models, not a betting edge.`;
}

// ---------------------------------------------------------------- players

const playerTables = {
  passing: {
    min: { key: 'dropbacks', label: 'dropbacks', perGame: 15 },
    columns: [
      { key: 'player', label: 'Player', text: true, cls: 'team' },
      { key: 'team', label: 'Team', text: true },
      { key: 'dropbacks', label: 'Dropbacks' },
      { key: 'completions', label: 'Cmp' },
      { key: 'attempts', label: 'Att' },
      { key: 'completion_pct', label: 'Cmp%', pct: true },
      { key: 'yards', label: 'Yds' },
      { key: 'touchdowns', label: 'TD' },
      { key: 'interceptions', label: 'Int' },
      { key: 'sacks', label: 'Sacked' },
      { key: 'epa_per_dropback', label: 'EPA/db', signed: true, digits: 3, defaultSort: true },
      { key: 'epa', label: 'Total EPA', signed: true, digits: 1 },
    ],
  },
  rushing: {
    min: { key: 'carries', label: 'carries', perGame: 7 },
    columns: [
      { key: 'player', label: 'Player', text: true, cls: 'team' },
      { key: 'team', label: 'Team', text: true },
      { key: 'carries', label: 'Car' },
      { key: 'yards', label: 'Yds' },
      { key: 'yards_per_carry', label: 'Y/C', digits: 2 },
      { key: 'touchdowns', label: 'TD' },
      { key: 'epa_per_carry', label: 'EPA/car', signed: true, digits: 3, defaultSort: true },
      { key: 'epa', label: 'Total EPA', signed: true, digits: 1 },
    ],
  },
  receiving: {
    min: { key: 'targets', label: 'targets', perGame: 3 },
    columns: [
      { key: 'player', label: 'Player', text: true, cls: 'team' },
      { key: 'team', label: 'Team', text: true },
      { key: 'targets', label: 'Tgt' },
      { key: 'receptions', label: 'Rec' },
      { key: 'yards', label: 'Yds' },
      { key: 'touchdowns', label: 'TD' },
      { key: 'epa_per_target', label: 'EPA/tgt', signed: true, digits: 3, defaultSort: true },
      { key: 'epa', label: 'Total EPA', signed: true, digits: 1 },
    ],
  },
  defense: {
    min: { key: 'tackles', label: 'tackles', perGame: 0 },
    columns: [
      { key: 'player', label: 'Player', text: true, cls: 'team' },
      { key: 'team', label: 'Team', text: true },
      { key: 'tackles', label: 'Tackles', digits: 1, title: 'Scrimmage plays; shared tackles split evenly' },
      { key: 'sacks', label: 'Sacks', digits: 1, defaultSort: true, title: 'Shared sacks split evenly' },
      { key: 'hurries', label: 'Hurries' },
      { key: 'interceptions', label: 'Int' },
      { key: 'pass_breakups', label: 'PBU' },
      { key: 'forced_fumbles', label: 'FF' },
      { key: 'blocks', label: 'Blk' },
    ],
  },
};

function setPlayerMinimum() {
  // players.json covers games with an FBS team, so size the minimum on FBS schedules
  const games = Math.max(1, ...state.teams.filter((t) => division(t) === 'FBS').map((t) => t.games));
  const config = playerTables[state.kind];
  $('player-min').value = config.min.perGame * games;
  $('player-min-label').textContent = config.min.label;
}

function showPlayers() {
  const config = playerTables[state.kind];
  const query = $('player-search').value.trim().toLowerCase();
  const minimum = Number($('player-min').value) || 0;
  const rows = state.players[state.kind]
    .filter((r) => (r[config.min.key] || 0) >= minimum)
    .filter((r) => !query || r.player.toLowerCase().includes(query) || r.team.toLowerCase().includes(query))
    .map((r) => Object.fromEntries(config.columns.map((c) => [c.key, r[c.key] ?? (c.text ? r[c.key] : 0)])));
  renderTable($('players-table'), rows.slice(0, 2000), config.columns, `players-${state.kind}`);
}

// ---------------------------------------------------------------- wiring

async function loadSeason(season) {
  state.season = season;
  const base = `data/${season}`;
  [state.teams, state.model, state.players] = await Promise.all([
    getJSON(`${base}/teams.json`), getJSON(`${base}/model.json`), getJSON(`${base}/players.json`),
  ]);
  state.schedule = await getJSON(`${base}/schedule.json`).catch(() => []);
  // projected scores are simulated in the browser; older seasons may not have the parameters
  state.score = await getJSON(`${base}/score.json`).catch(() => null);
  state.script = await getJSON(`${base}/script.json`).catch(() => null);
  scriptCache.clear();
  fillConferences();
  fillTeamSelects();
  setPlayerMinimum();
  fillWeeks();
  showRankings();
  showWeeklyPredictions();
  showPrediction();
  showPlayers();
}

function showView(view) {
  document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== view; });
  drawCharts();      // a hidden chart has no width to draw itself at, so it waits until it is shown
  try {
    localStorage.setItem('cfb-view', view);
    history.replaceState(null, '', `#${view}`);
  } catch (_) { /* storage unavailable */ }
}

async function init() {
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  document.querySelectorAll('#player-kind button').forEach((b) => b.addEventListener('click', () => {
    state.kind = b.dataset.kind;
    document.querySelectorAll('#player-kind button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    setPlayerMinimum();
    showPlayers();
  }));
  $('team-search').addEventListener('input', showRankings);
  $('conference').addEventListener('change', showRankings);
  $('division').addEventListener('change', () => { fillConferences(); showRankings(); });
  $('weekly-week').addEventListener('change', showWeeklyPredictions);
  $('weekly-division').addEventListener('change', showWeeklyPredictions);
  $('weekly-search').addEventListener('input', showWeeklyPredictions);
  $('weekly-table').addEventListener('click', (e) => {
    const link = e.target.closest('[data-home]');
    if (link) {
      goToMatchup(link.dataset.home, link.dataset.away, link.dataset.neutral === 'true' ? 'neutral' : 'a');
    }
  });
  ['team-a', 'team-b'].forEach(setupCombo);
  $('site').addEventListener('change', showPrediction);
  $('player-search').addEventListener('input', showPlayers);
  $('player-min').addEventListener('input', showPlayers);
  $('season').addEventListener('change', (e) => loadSeason(Number(e.target.value)));
  let resizing = null;
  window.addEventListener('resize', () => { clearTimeout(resizing); resizing = setTimeout(drawCharts, 150); });

  const hash = window.location.hash.replace('#', '');
  let saved = (hash && $(hash)) ? hash : null;
  if (!saved) {
    try { saved = localStorage.getItem('cfb-view'); } catch (_) { /* storage unavailable */ }
  }
  if (saved && $(saved)) showView(saved);

  try {
    const seasons = await getJSON('data/seasons.json');
    state.seasons = seasons;
    state.scales = await getJSON('data/scales.json').catch(() => null);
    $('season').innerHTML = seasons.slice().reverse().map((s) => `<option>${s}</option>`).join('');
    await loadSeason(seasons[seasons.length - 1]);
  } catch (error) {
    document.querySelector('main').innerHTML = `<p class="note">Couldn't load data (${error.message}). Run <code>python3 build_dashboard_data.py</code>, then serve this folder with <code>python3 -m http.server</code>.</p>`;
  }
}

init();
