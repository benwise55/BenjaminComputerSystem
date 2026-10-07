// Projected scores: the same Monte Carlo as score_model.py, run in the browser from
// data/<season>/score.json. Two simulations per matchup, each used for what it was best at over
// 2018-2025 (5,939 games): normal draws set the margin and win chance, success draws (the Elo
// says how often a play works, the league's own play values say by how much) set the total.
// Each team's score is then (total +/- margin) / 2, about 9.6 points of error per team.

const SIMS = 2000;
const MOMENTUM = 0.05;          // success chance after a success, minus it after a failure
const BIG_NEGATIVE = -2.0;      // a play this bad is usually a turnover ...
const DEF_SCORE_RATE = 0.063;   // ... and this share are returned for a touchdown
const TOUCHDOWN = 6.96;
const CROSS_DIVISION_PLAYS = [22.2, -16.4];

// Box-Muller, with the second value cached
let spare = null;
function normal() {
  if (spare !== null) { const v = spare; spare = null; return v; }
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const r = Math.sqrt(-2 * Math.log(u));
  spare = r * Math.sin(2 * Math.PI * v);
  return r * Math.cos(2 * Math.PI * v);
}

const pick = (pool) => pool[(Math.random() * pool.length) | 0];
const logistic = (x) => 1 / (1 + Math.exp(-x));
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

// the pace ratings' fitted home term is left out on purpose: it puts the home team +1.3 plays
// ahead when the real edge is +0.1
function playCount(score, team, opponent) {
  const t = score.teams[team], o = score.teams[opponent];
  return clamp(Math.round(score.pace.base + (t?.pace_off ?? 0) + (o?.pace_def ?? 0)), 40, 100);
}

// binomial draws, for the touchdowns a defence returns
function binomial(n, p) {
  let hits = 0;
  for (let i = 0; i < n; i++) if (Math.random() < p) hits++;
  return hits;
}

// One team's points in each simulation, both ways of drawing a play's EPA, plus the touchdowns
// its opponent's defence returns off it
function teamPoints(score, team, opponent, site, plays, sims) {
  const L = score.league, t = score.teams[team] || {}, o = score.teams[opponent] || {};
  const [a, b, c, d] = L.epa;
  const [base, perPlay, beta, perSpecial] = L.points.coefficients;
  // The points map's own residuals, drawn from their real shape. A team's score is right-skewed,
  // but the sum of ~68 play draws is near normal, so a normal residual on top left the simulated
  // total symmetric when the real one is not. An older score.json has no pool; fall back to the
  // normal it always used.
  const residuals = L.points.residuals;
  const error = () => (residuals ? pick(residuals) : L.points.spread * normal());
  const mean = a + b * (t.o ?? 0) + c * (o.d ?? 0) + d * site;
  const p = successChance(score, team, opponent, site);
  const posSize = (t.offense_pos ?? 1) * (o.defense_pos ?? 1);
  const negSize = (t.offense_neg ?? 1) * (o.defense_neg ?? 1);
  const drift = base + perPlay * plays;
  const spreadOfSum = L.sd * Math.sqrt(plays);          // the sum of `plays` normal draws
  const fromNormal = new Float64Array(sims);
  const fromSuccess = new Float64Array(sims);
  const conceded = new Float64Array(sims);              // points the other team's defence scores
  for (let i = 0; i < sims; i++) {
    const special = perSpecial * pick(L.special_teams);
    fromNormal[i] = drift + beta * (mean * plays + spreadOfSum * normal()) + special + error();
    let epa = 0, disasters = 0, bump = 0;
    for (let j = 0; j < plays; j++) {
      // a play is likelier to succeed after a success and to fail after a failure, as real
      // drives do; this is what gives a simulated game its true spread
      const success = Math.random() < clamp(p + bump, 0.01, 0.99);
      const value = success ? pick(L.pools.positive) * posSize : pick(L.pools.negative) * negSize;
      if (value <= BIG_NEGATIVE) disasters++;
      epa += value;
      bump = success ? MOMENTUM : -MOMENTUM;
    }
    // an offense cannot score less than nothing; the margin draw above is left unfloored on
    // purpose, since flooring it only narrows the margin for the same Brier
    fromSuccess[i] = Math.max(0, drift + beta * epa + special + error());
    conceded[i] = TOUCHDOWN * binomial(disasters, DEF_SCORE_RATE);
  }
  return { fromNormal, fromSuccess, conceded };
}

function successChance(score, team, opponent, site) {
  const L = score.league, t = score.teams[team] || {}, o = score.teams[opponent] || {};
  return logistic(L.mu + (t.o ?? 0) - (o.d ?? 0) + L.home_offset * site);
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, low = Math.floor(pos), high = Math.ceil(pos);
  return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
}

// site: 1 = at home, 0 = neutral, -1 = at away. `margin`, when given, replaces the simulated
// average margin with the page's own (the tested EPA + success Elo blend), keeping the simulated
// spread, so the projected score and the headline agree. Returns the scores and their spread.
function projectScore(score, home, away, site = 1, margin = null, crossDivision = false, sims = SIMS) {
  if (!score || !score.teams[home] || !score.teams[away]) return null;
  let playsHome = playCount(score, home, away);
  let playsAway = playCount(score, away, home);
  if (crossDivision) {
    // FBS vs FCS games really do split about 69 plays to 62, which pace ratings alone miss; in
    // same-division games the same rule invents a 3.7-play edge that isn't there
    const [own, opp] = CROSS_DIVISION_PLAYS;
    const average = logistic(score.league.mu);
    const pH = successChance(score, home, away, site), pA = successChance(score, away, home, -site);
    playsHome = clamp(Math.round(playsHome + own * (pH - average) + opp * (pA - average)), 40, 100);
    playsAway = clamp(Math.round(playsAway + own * (pA - average) + opp * (pH - average)), 40, 100);
  }
  const h = teamPoints(score, home, away, site, playsHome, sims);
  const a = teamPoints(score, away, home, -site, playsAway, sims);
  const margins = new Float64Array(sims), totals = new Float64Array(sims);
  const homeScores = new Float64Array(sims), awayScores = new Float64Array(sims);
  let simulatedSum = 0;
  for (let i = 0; i < sims; i++) simulatedSum += h.fromNormal[i] - a.fromNormal[i];
  const shift = margin === null ? 0 : margin - simulatedSum / sims;
  let homeWins = 0, homeSum = 0, awaySum = 0;
  for (let i = 0; i < sims; i++) {
    const m = h.fromNormal[i] - a.fromNormal[i] + shift;    // margin model, recentred if asked
    const total = h.fromSuccess[i] + a.fromSuccess[i] + h.conceded[i] + a.conceded[i];   // total model
    if (m > 0) homeWins++;                                  // the win chance uses the raw margin
    // a team cannot score less than nothing, which matters in lopsided games
    const scoreHome = Math.max(0, (total + m) / 2), scoreAway = Math.max(0, (total - m) / 2);
    homeScores[i] = scoreHome; awayScores[i] = scoreAway;
    margins[i] = scoreHome - scoreAway; totals[i] = scoreHome + scoreAway;
    homeSum += scoreHome; awaySum += scoreAway;
  }
  const sortedHome = Float64Array.from(homeScores).sort();
  const sortedAway = Float64Array.from(awayScores).sort();
  const sortedTotal = Float64Array.from(totals).sort();
  const sortedMargin = Float64Array.from(margins).sort();
  return {
    home: homeSum / sims,
    away: awaySum / sims,
    margin: (homeSum - awaySum) / sims,
    total: (homeSum + awaySum) / sims,
    homeWin: homeWins / sims,
    plays: { home: playsHome, away: playsAway },
    samples: { margin: margins, total: totals },      // for the matchup page's histograms
    range: {
      home: [quantile(sortedHome, 0.1), quantile(sortedHome, 0.9)],
      away: [quantile(sortedAway, 0.1), quantile(sortedAway, 0.9)],
      total: [quantile(sortedTotal, 0.1), quantile(sortedTotal, 0.9)],
      margin: [quantile(sortedMargin, 0.1), quantile(sortedMargin, 0.9)],
    },
  };
}

window.projectScore = projectScore;
