// The game-script model in the browser: plays a matchup out snap by snap, the same way
// game_script.py does, from data/<season>/script.json. Downs, penalties, turnovers, 4th-down
// decisions, kicking and kickoffs, with each team's own modifiers applied to the league's rates.
//
// Keep this in step with game_script.py. The Python is the reference; this is the port.

const SCRIPT_SIMS = 1000;                // enough that its histogram is smooth, at about 0.2s
const LAST_KICK_TO_GOAL = 40;            // a 57-yard try: as far out as a team kicks to tie or win
const DEFENSIVE_TDS = new Set(['punt_td', 'int_td', 'fumble_td']);

// logistic() comes from score.js, which the page loads first
const logit = (p) => Math.log(p / (1 - p));

// Box-Muller with the second value kept
let sparePair = null;
function gauss() {
  if (sparePair !== null) { const v = sparePair; sparePair = null; return v; }
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const r = Math.sqrt(-2 * Math.log(u));
  sparePair = r * Math.sin(2 * Math.PI * v);
  return r * Math.cos(2 * Math.PI * v);
}

// Acklam's inverse normal, for moving a draw along the league's distribution
function inverseNormal(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -inverseNormal(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
function normalCdfLocal(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

// [[value, count], ...] -> draw one value
function sampler(counts) {
  const values = counts.map((c) => c[0]);
  const cumulative = [];
  let total = 0;
  for (const [, n] of counts) { total += n; cumulative.push(total); }
  return () => {
    const target = Math.random() * total;
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] <= target) lo = mid + 1; else hi = mid; }
    return values[lo];
  };
}

// [values, probabilities] -> draw, with the normal-score shift and spread the team terms ask for
function table(pair) {
  const [values, probs] = pair;
  const cumulative = [];
  let total = 0;
  for (const p of probs) { total += p; cumulative.push(total); }
  return (shift, spread) => {
    let u = Math.random();
    if (shift || spread) u = normalCdfLocal(inverseNormal(Math.min(Math.max(u, 1e-6), 1 - 1e-6)) * Math.exp(spread) + shift);
    const target = u * total;
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] <= target) lo = mid + 1; else hi = mid; }
    return values[lo];
  };
}

// numpy's searchsorted(edges, value, side='left') - 1, which is what game_script.py uses: a
// value sitting exactly on a boundary belongs to the band below it, and 1st and 10 is the most
// common situation there is
const band = (value, edges) => {
  let i = edges.findIndex((e) => e >= value);
  if (i < 0) i = edges.length;
  return Math.min(Math.max(i - 1, 0), edges.length - 2);
};

// {band: [[value, count], ...]} -> {band: draw}, a band with under 50 outcomes taking the
// nearest one that has enough (almost nobody punts from inside the opponent's 10)
function filledBands(byBand) {
  const total = {};
  for (const [k, v] of Object.entries(byBand)) total[k] = v.reduce((s, c) => s + c[1], 0);
  const full = Object.keys(byBand).filter((k) => total[k] >= 50).map(Number);
  const out = {};
  for (const k of Object.keys(byBand)) {
    let use = Number(k);
    if (total[k] < 50 && full.length) {
      use = full.reduce((best, c) => (Math.abs(c - Number(k)) < Math.abs(best - Number(k)) ? c : best), full[0]);
    }
    out[k] = byBand[use] && byBand[use].length ? sampler(byBand[use]) : null;
  }
  return out;
}

function scriptTeam(data, name) {
  const row = data.teams[name];
  if (!row) return null;
  const out = {};
  data.fields.forEach((f, i) => { out[f] = row[i]; });
  return out;
}

// the situational part of the pass logit, and the whole of it
function aggression(L, down, toGo, margin, quarter) {
  const w = L.pass_aggression;
  const b = band(Math.max(toGo, 1), L.bins.pass);
  const byBand = { 0: w[0], 1: w[1], 2: w[2], 4: w[3], 5: w[4] };
  let a = byBand[b] ?? 0;
  if (down >= 3 && toGo <= 2) a += w[5];
  // Trailing and leading carry their own weights, and a ramp past two scores down carries what
  // tanh cannot: it is saturated by then, so on its own it reads a two-score deficit and a
  // five-score one the same way and keeps throwing in both.
  const t = Math.tanh(-margin / L.bins.margin_scale);
  const [deepStart, deepFull] = L.bins.deep;
  const deep = Math.min(Math.max((-margin - deepStart) / (deepFull - deepStart), 0), 1);
  return a + w[6 + quarter - 1] * Math.max(t, 0) + w[10 + quarter - 1] * Math.min(t, 0)
           + w[14 + quarter - 1] * deep;
}
// Offences run far more with the goal line in reach, and on 3rd or 4th and a yard, than the fitted
// pass model knows: it has distance bands but no field position, so it called the same mix at the
// opponent's 2 as at midfield. Zero on average over a season, so the overall pass share is the same.
function callShift(L, down, toGo, toGoal, margin, quarter) {
  const c = L.call;
  if (!c) return 0;
  let g = toGoal == null ? 0 : c.goal[Math.min(Math.max(Math.trunc(toGoal), 1), 99)];
  const row = c.cell[String(Math.trunc(down))];
  g += row ? row[Math.min(Math.max(Math.trunc(toGo), 1), row.length) - 1] : 0;
  // the score-margin block: tanh(-margin/MARGIN_SCALE) in aggression() is nearly saturated by a
  // single score, so the bands carry what it cannot - chiefly a team 4 to 8 down in the fourth,
  // and a late lead being protected harder than the fitted model protects it
  if (c.margin && c.bands && c.groups) {
    let band = 0;
    // strictly greater: numpy's searchsorted(side='left') - 1 makes the bands right-closed, so a
    // margin sitting exactly on an edge belongs to the band BELOW it
    for (let i = 0; i < c.bands.length - 1; i++) if (margin > c.bands[i + 1]) band = i + 1;
    band = Math.min(band, c.bands.length - 2);
    for (let gi = 0; gi < c.groups.length; gi++) {
      if (c.groups[gi].includes(Math.trunc(quarter))) { g += c.margin[String(gi)][band]; break; }
    }
  }
  return g;
}

function passChance(L, mods, down, toGo, margin, quarter, homeSign, homeTerms, toGoal, endPass = 0, dmods = null) {
  const base = L.pass_intercept + (down >= 2 ? L.pass_base[down - 2] : 0) + (quarter >= 2 ? L.pass_base[quarter + 1] : 0);
  // the red zone runs more than the free field does; see GOAL_PASS_SHIFT in game_script.py
  const goalMax = (L.bins && L.bins.goal_max) || 20;
  const near = toGoal != null && toGoal <= goalMax;
  // the red-zone call answers to the defence: -(run_d + completion_d), bigger meaning a better
  // defence, which real offences respond to by throwing MORE. See GOAL_PASS_DEFENSE.
  const goalPass = near
    ? GOAL_PASS_SHIFT - GOAL_PASS_DEFENSE * ((dmods?.run_d ?? 0) + (dmods?.completion_d ?? 0)
                                             + (mods?.run_o ?? 0) + (mods?.completion_o ?? 0))
    : 0;
  return logistic(base + aggression(L, down, toGo, margin, quarter) + (mods.pass ?? 0)
                  + homeSign * (homeTerms.pass ?? 0) + callShift(L, down, toGo, toGoal, margin, quarter)
                  + goalPass + endPass);
}

function fourthProbabilities(L, toGoal, toGo, margin, quarter) {
  const knots = L.bins.fourth_knots;
  const hats = knots.map((_, i) => {
    // linear interpolation basis: 1 at this knot, 0 at the others
    if (toGoal <= knots[0]) return i === 0 ? 1 : 0;
    if (toGoal >= knots[knots.length - 1]) return i === knots.length - 1 ? 1 : 0;
    const j = knots.findIndex((k) => k > toGoal);
    const t = (toGoal - knots[j - 1]) / (knots[j] - knots[j - 1]);
    return i === j - 1 ? 1 - t : (i === j ? t : 0);
  });
  const trail = -margin, q4 = quarter === 4 ? 1 : 0;
  const row = hats.concat([
    Math.log(Math.max(toGo, 1)), toGo <= 1 ? 1 : 0, toGo <= 3 ? 1 : 0,
    quarter === 2 ? 1 : 0, quarter === 3 ? 1 : 0, q4,
    (1 - q4) * Math.tanh(trail / 7),
    q4 * (trail >= 1 && trail <= 8 ? 1 : 0), q4 * (trail >= 9 && trail <= 16 ? 1 : 0), q4 * (trail >= 17 ? 1 : 0),
    q4 * (trail <= -1 && trail >= -8 ? 1 : 0), q4 * (trail <= -9 ? 1 : 0),
    q4 * (trail >= 1 ? 1 : 0) * (1 - toGoal / 100)]);
  const eta = L.fourth_coef.map((coef, k) => coef.reduce((sum, c, i) => sum + c * row[i], L.fourth_intercept[k]));
  const top = Math.max(...eta);
  const exp = eta.map((e) => Math.exp(e - top));
  const total = exp.reduce((a, b) => a + b, 0);
  return exp.map((e) => e / total);                       // punt, field goal, go
}

function onsideChance(L, margin, quarter) {
  const r = L.onside.rates;
  if (quarter < 4) return r.early;
  const trailing = -margin;
  if (trailing < 1) return r.q4_other;
  return trailing <= 8 ? r.q4_1 : (trailing <= 16 ? r.q4_9 : r.q4_17);
}

// WEATHER. Mirrors game_script.py and must be kept in step with it. Each term applies only when
// the dashboard data actually carries that field for the game: schedule.json gets temp, wind and
// wet from the line table, which holds observed weather for played games and a forecast about a
// week past whenever the file was fetched. A game with no entry is simulated with no weather
// adjustment at all rather than a league-average one.
//
// Temperature's 3/5-2/5 defence/offence shares collapse to their sum here, because both teams play
// in the same weather - see the note at TEMP_DEF_SHARE in game_script.py - so what is left is a
// single shift per degree. Same for precipitation, which is an added defensive term rather than a
// multiplier (the multiplier was tested and is not in the data), and is a wet/dry step with no
// depth. Wind is split by channel instead: a measured field-goal slope and a calibrated
// incompletion slope.
const TEMPERATURE = true;
const TEMP_REFERENCE_F = 66.1;
const TEMP_TERMS_PER_DEGREE = 0.0008;
const TEMP_MODELS = ['run', 'completion'];

const WIND = true;
const WIND_REFERENCE_MPH = 7.7;
const WIND_FG_LOGIT_PER_MPH = -0.01001;   // measured on 11,164 attempts, holding kick distance
const WIND_INCOMPLETE_PER_MPH = 0.00957;  // calibrated so the pair totals -0.1626 points a mph

const PRECIPITATION = true;
const PRECIP_MODELS = ['run', 'completion'];
// Calibrated by calibrate_precip() to the -2.057 combined points a wet game was fitted at; the
// response is linear in the scale (-80.5, -82.4, -80.7 points per unit across three trials).
const PRECIP_DEF_TERMS = 0.02536;

// TRAVEL. Door-to-door hours the visitor spent getting there, 3/5 of the effect on its defence and
// 2/5 on its offence. Unlike the weather terms these shares DO bite, because only one side travels
// (both do at a neutral site), so the two land on different teams and oppose each other in the
// differential - see the note at TRAVEL_DEF_SHARE in game_script.py.
//
// The hours are precomputed into schedule.json by build_dashboard_data.travel_map, which calls
// game_script's own travel_hours and _great_circle. The trip model has a coach/flight switch in it
// and a second copy here could drift from the Python without failing loudly, so only the answer
// crosses over. A game whose venue could not be placed carries no travel field and gets no term.
//
// The gradient was retargeted from 0.409 to 0.290 points an hour once the home term was fitted
// net of travel: 0.409 came from home-field-OFF residuals and carried home advantage inside it.
// 0.00568 is verified against the model, delivering 0.2922.
const TRAVEL_HOURS = true;
const TRAVEL_DEF_SHARE = 0.60;
const TRAVEL_OFF_SHARE = 0.40;
const TRAVEL_TERMS_PER_HOUR = 0.00568;
const TRAVEL_MODELS = ['run', 'completion'];

// REST, as a differential and capped at 14 days. Same shape as travel: the offence is hurt by its
// own deficit and helped by its opponent's, so two equally rested teams cancel exactly - which is
// what the data shows (every matched-rest group produces the same total to within 0.02 points).
//
// The deficit is days SHORT of the cap, computed per team before any differencing, so a 30-day
// bowl layoff and a 15-day one are both zero and read as identical. Capping the difference instead
// of each side would hand 30-versus-25 a five-day advantage out of nothing.
//
// Shares are measured, not assumed: 0.0663 points a day scored against 0.0698 conceded, so 49/51.
// They are not distinguishable from even, nor from travel's 40/60.
// KICKING BY LEVEL. fg_good applied one league curve to everyone, so the simulator made 70.9% of
// its kicks whoever kicked, against a real range of 0.683 for FCS to 0.756 for Power. The attempt
// side is separate - the fourth-down choice reads a league model and never consults fg_good - so
// weak kicking teams were also sent out too often and from too far.
//
// Fitted on 2021-2025 only: a curve on 2014-2020 makes 0.540 from 45 yards against 0.590 since,
// and mean attempt distance rose 34.4 -> 36.1 yards, so the eras are different games.
//
// By LEVEL rather than by team, which is measured: distance-adjusted field goals over expected
// persist year to year at r = +0.19 across teams, but only r = +0.090 once the level mean is
// removed. A per-team kicker term would be fitting noise.
//
// Centred on the attempt-weighted mean, so the league rate is unchanged and only its split moves.
const FG_SKILL = { fbs: 0.2014, fcs: -0.2580, other: -0.5754 };
const FG_ATTEMPT_SKILL = { fbs: 0.1697, fcs: -0.1740, other: -0.7969 };

const REST = true;
const REST_CAP_DAYS = 14.0;
const REST_OFF_SHARE = 0.49;
const REST_DEF_SHARE = 0.51;
const REST_TERMS_PER_DAY = 0.00272;
const REST_MODELS = ['run', 'completion'];

class ScriptGame {
  constructor(data, mods, home, conditions) {
    this.L = data.league;
    this.homeTerms = data.home || {};
    // a per-game, per-side draw on the two yardage shifts: an offence that simply has a good day.
    // Without it the model is short of real between-game spread - a team's yards in a game scatter
    // with sd 108.0 real against 100.1 - and win probability reads that spread directly.
    const shockSd = this.L.game_shock ?? 0;
    this.shock = shockSd ? [gauss() * shockSd, gauss() * shockSd] : null;
    // only the two fitted as a residual from a table the simulator samples; see INTERCEPT_MODELS
    // in game_script.py - the per-play models already carry their baseline and applying theirs hurt
    this.intercepts = {};
    for (const k of ['punt', 'kickoff']) if (data.intercepts && data.intercepts[k] != null) this.intercepts[k] = data.intercepts[k];
    this.mods = mods;                                      // [team A, team B]
    this.home = home;                                      // 0, 1 or null
    this.score = [0, 0];
    // A half is clock.half seconds by rule, so pace is a multiplier on what a snap costs rather
    // than a budget of snaps handed out in advance. See CLOCK_PACE_SNAPS in game_script.py.
    //
    // This arithmetic is deliberately UNCHANGED now that the pace is per season. Python writes
    // CLOCK_PACE_SNAPS / snaps_per_game into clock.pace, and ref IS snaps_per_game, so
    // (pace * ref) / want is CLOCK_PACE_SNAPS / want - the same number python uses. Do not
    // "simplify" it to drop ref, and do not read a season-independent constant into clock.pace.
    this.C = this.L.clock || null;
    const ref = this.L.snaps_per_game;
    const want = ref + (mods[0].pace ?? 0) + (mods[1].pace ?? 0);
    this.pace = this.C ? (this.C.pace * ref) / Math.max(want, 40) : 1;
    this.timeouts = [3, 3];
    this.run = table(this.L.run_yards);
    this.completion = table(this.L.completion_yards);
    this.kickoffTo = sampler(this.L.kickoff_to);
    this.kept = sampler(this.L.onside.kept_to);
    this.failed = sampler(this.L.onside.failed_to);
    // a thin band borrows the nearest well-filled one, as the Python does
    this.punts = filledBands(this.L.punt_to);
    this.ints = filledBands(this.L.int_to);
    // one sampler per field-position bin; see PENALTY_FIELD_BINS in game_script.py
    this.penalty = { noplay: this.L.penalties.noplay.map(sampler), add: this.L.penalties.add.map(sampler) };
    // both teams shift the penalty rate and neither changes during the game, so shift it once
    const penShift = (this.mods[0].penalty ?? 0) + (this.mods[1].penalty ?? 0);
    this.pen = penShift
      ? { noplay: logistic(logit(this.L.pen_noplay) + penShift), add: logistic(logit(this.L.pen_add) + penShift) }
      : { noplay: this.L.pen_noplay, add: this.L.pen_add };
    // null when the dashboard has no value for this game, which is how a future game beyond the
    // forecast horizon ends up with no weather effect rather than a guessed one.
    const wx = conditions || {};
    this.chill = (TEMPERATURE && wx.temp != null) ? TEMP_REFERENCE_F - wx.temp : null;
    this.gust = (WIND && wx.wind != null) ? wx.wind - WIND_REFERENCE_MPH : null;
    this.wet = (PRECIPITATION && wx.wet != null) ? wx.wet : null;
    // [hours team 0 travelled, hours team 1 travelled], already oriented to mods by the caller
    this.travel = (TRAVEL_HOURS && Array.isArray(wx.travel) && wx.travel.length === 2
                   && wx.travel.some((h) => h)) ? wx.travel : null;
    // [team 0 deficit, team 1 deficit] in days, already oriented to mods by the caller. Unlike
    // travel a pair of zeros is meaningful (both fully rested), but it also has no effect, so
    // gating on "some non-zero" costs nothing and skips the arithmetic.
    this.rest = (REST && Array.isArray(wx.rest) && wx.rest.length === 2
                 && wx.rest.some((v) => v)) ? wx.rest : null;
    this.off = 0; this.def = 1;
  }

  // One place for the field-goal chance so the wind term cannot reach one kick site and miss the
  // other - the fourth-down choice and the end-of-half attempt both come through here.
  // fbs, fcs or other for one side; script.json carries it as a team field
  level(team) {
    const m = this.mods[team];
    return m ? m.level : null;
  }

  fgChance(toGoal) {
    // quadratic in kick length about 40 yards; a cache written before PARAMS_VERSION 45 holds
    // two coefficients and is read as a straight line. See fit() in game_script.py.
    const c = this.L.fg_logit, length = toGoal + 17;
    let z = c[0] + c[1] * length + (c.length > 2 ? c[2] * (length - 40) ** 2 : 0)
            + (FG_SKILL[this.level(this.off)] ?? 0);
    if (WIND && this.gust !== null && WIND_FG_LOGIT_PER_MPH) z += WIND_FG_LOGIT_PER_MPH * this.gust;
    return logistic(z);
  }

  // mph above the reference, or 0 when this game has no wind reading
  windInc() {
    return (WIND && this.gust !== null && WIND_INCOMPLETE_PER_MPH)
      ? WIND_INCOMPLETE_PER_MPH * this.gust : 0;
  }

  sign(team) { return this.home === null ? 0 : (team === this.home ? 1 : -1); }

  // The intercept belongs here too. Every team term is measured against a league baseline drawn
  // from all divisions while the FBS group indicator is zero, so an average FBS pairing carries the
  // intercept alone. Python dropped it for years; punt is -1.47 yards of it, kickoff -0.44.
  shift(model) {
    const o = this.mods[this.off], d = this.mods[this.def];
    const shock = (this.shock && (model === 'run' || model === 'completion')) ? this.shock[this.off] : 0;
    let value = (o[`${model}_o`] ?? 0) + (d[`${model}_d`] ?? 0) + (this.intercepts[model] ?? 0)
                + shock + this.sign(this.off) * (this.homeTerms[model] ?? 0);
    // both shares act on the same chill and add, so only their sum (1.0) reaches the simulation
    if (this.chill !== null && TEMP_TERMS_PER_DEGREE && TEMP_MODELS.includes(model)) {
      value -= TEMP_TERMS_PER_DEGREE * this.chill;
    }
    if (this.wet && PRECIP_DEF_TERMS && PRECIP_MODELS.includes(model)) {
      value -= PRECIP_DEF_TERMS;
    }
    // the offence is hurt by its own trip and helped by its opponent's, so only the difference
    // tells and a neutral site where both sides travel needs no special case
    if (this.travel && TRAVEL_TERMS_PER_HOUR && TRAVEL_MODELS.includes(model)) {
      value += TRAVEL_TERMS_PER_HOUR * (TRAVEL_DEF_SHARE * this.travel[this.def]
                                        - TRAVEL_OFF_SHARE * this.travel[this.off]);
    }
    if (this.rest && REST_TERMS_PER_DAY && REST_MODELS.includes(model)) {
      value += REST_TERMS_PER_DAY * (REST_DEF_SHARE * this.rest[this.def]
                                     - REST_OFF_SHARE * this.rest[this.off]);
    }
    return value;
  }

  fromBand(map, toGoal) {
    const b = band(toGoal, this.L.bins.yardline);
    for (let step = 0; step < this.L.bins.yardline.length; step++) {
      for (const k of [b - step, b + step]) if (map[k]) return map[k];
    }
    return null;
  }

  play(down, toGo, margin, quarter, toGoal, left) {
    const L = this.L;
    const spread = this.shift('run_spread');
    const [goalRun, goalSack] = this.goalShift(toGoal);
    // the two goal-line corrections game_script.py fits by simulation: interceptions do not fall
    // near the end zone in reality even though aggression does, and a completion reaches the end
    // zone slightly less often than the free-field yardage draw implies
    const goalMax = (L.bins && L.bins.goal_max) || 20;   // GOAL_MAX, as goalShift reads it
    const near = toGoal != null && toGoal <= goalMax;
    const goalInt = near ? GOAL_INT_LOGIT : 0;
    const goalComp = near ? GOAL_COMPLETION_SHIFT : 0;
    const [fieldShift, fieldSpread, fieldInc] = this.passFieldShift(toGoal);
    if (Math.random() >= passChance(L, this.mods[this.off], down, toGo, margin, quarter,
                                    this.sign(this.off), this.homeTerms, toGoal, this.endShift(left, 'pass'),
                                    this.mods[this.def])) {
      return ['run', this.atMarker(down, toGo, toGoal, this.shortLoss(toGo,
                                   this.run(this.shift('run') + this.runShift(down, toGo) + goalRun, spread)))];
    }
    // second and third down each carry their own curve in the distance to gain - sacks roughly
    // double from a yard to ten, completions fall, and a catch gains more. First and fourth get
    // zeros; see DOWN_PASS_KEY in game_script.py for why first down has none.
    const [incShift, sackShift, gainShift] = this.thirdShift(down, toGo);
    const u = Math.random();
    const incomplete = logistic(logit(L.incomplete) + this.shift('incomplete') + incShift
                                + fieldInc + this.windInc());
    if (u < incomplete) return ['incomplete', 0];
    const [ia, ik] = L.turnover_logit.interception;
    const intercept = logistic(ia + ik * aggression(L, down, toGo, margin, quarter) + this.shift('interception')
                               + INTERCEPTION_LOGIT + goalInt);
    if (u < incomplete + intercept) return ['interception', 0];
    if (Math.random() < logistic(logit(L.sack) + this.shift('sack') + sackShift + goalSack)) {
      // the matchup moves the sack's yardage as well as its rate; see the sack_yards note in
      // game_script.py's GAP_MODELS. Mean only - the spread stays league-wide.
      return ['sack', Math.round(L.sack_mean + this.shift('sack_yards') + gauss() * L.sack_sd)];
    }
    return ['complete', this.atMarker(down, toGo, toGoal,
                                      this.completion(this.shift('completion') + gainShift + fieldShift + goalComp, fieldSpread))];
  }

  // A run's yardage moves with the down and the distance, and the league curve on its own made
  // short yardage far too easy: 4th-and-1 converted 83% against the 70% the game manages, because
  // a defence that only has to stop one yard sells out to stop it. Zero where none was fitted.
  runShift(down, toGo) {
    const g = this.L.run_gap;
    if (!g) return 0;
    const row = g[String(Math.trunc(down))];
    if (!row) return 0;
    return row[Math.min(Math.max(Math.trunc(toGo), 1), row.length) - 1];
  }

  // With the goal line in reach a defence has no deep field to defend and commits to the line of
  // scrimmage. Without this the simulator converted runs at the opponent's 2 at 73% against the
  // 50% the game manages. Confined to the last GOAL_MAX yards; zero beyond them. Incompletions are
  // not here - their gradient runs the whole field, so passFieldShift carries them.
  // Offences throw deeper the closer they are to scoring: 20+ yard gains run 11.7% of pass plays
  // in the opponent's half against 9.3% backed up, and one flat table gave 9.85% everywhere. Needs
  // the spread as well as the shift - the gradient is not a pure location move.
  passFieldShift(toGoal) {
    const f = this.L.pass_field;
    if (!f || toGoal == null) return [0, 0, 0];
    const i = Math.min(Math.max(Math.trunc(toGoal), 1), 99);
    return [f.shift[i], f.spread[i], f.incomplete ? f.incomplete[i] : 0];
  }

  // The closing seconds of a half, banded. Under two minutes real pass share jumps to 64.6% from
  // a baseline near 48%, and 41% of second-quarter field goals come in that minute.
  endShift(left, which) {
    // Band width 1 without a clock in the payload: `left` is then snaps, as it used to be, so an
    // older script.json keeps reading the cells it was fitted on rather than 15 of them at a time.
    const e = this.L.endhalf, n = this.L.end_snaps ?? 8;
    const w = this.C ? (this.L.end_band ?? 15) : 1;
    if (!e || left == null || left < 0 || left >= n * w) return 0;
    return e[which][Math.trunc(left / w)] ?? 0;
  }

  // What a snap costs the clock. A play that stops it costs only its own action; one that leaves
  // it running costs that plus the runoff, and the runoff is what the two sides fight over.
  // Mirrors Game.clock_used / Game.runoff in game_script.py.
  clockUsed(kind, margin, left, scored = false) {
    const C = this.C;
    if (!C) return 1;
    let mean, sd;
    if (scored || C.stop[kind] !== undefined) {
      mean = scored ? C.stop.score : C.stop[kind];
      sd = C.stop_sd;
    } else {
      mean = this.runoff(margin, left);
      sd = C.run_sd;
    }
    let cost = Math.max(mean * this.pace * (1 + sd * gauss()), 1);
    // The clock stops at the end of a quarter, so a snap cannot spend time its quarter does not
    // have: a play starting with a second left in the first costs a second, not a full runoff.
    // Mirrors the cap in Game.clock_used. Overtime passes left <= 0, where a cap would ADD time.
    if (left > 0) cost = Math.min(cost, left - (left > C.half / 2 ? C.half / 2 : 0));
    return cost;
  }

  runoff(margin, left) {
    const C = this.C;
    if (this.halfNo === 0) return left <= C.hurry_left ? C.hurry_h1 : C.run;
    if (margin >= C.stall_margin) return left <= C.stall_left ? C.stall : C.lead;
    if (left > C.stall_left) return C.run;
    const base = left <= C.hurry_left ? C.hurry : C.chase;
    const [g0, g1] = C.giveup;
    let f = (-margin - g0) / (g1 - g0);
    f = f < 0 ? 0 : (f > 1 ? 1 : f);
    return base + (C.run - base) * f;
  }

  // Whether a side stops the clock here, and takes one off its own stock. Before halftime it is
  // whoever has the ball; after it, mostly the side that is behind - but only 70% of the time, and
  // charging every one to the trailing side drains its stock twice as fast as the real thing.
  spendTimeout(team, margin, left) {
    const C = this.C;
    if (!C || left > C.to_left) return 0;
    const chance = left <= C.hurry_left
      ? (Math.abs(margin) <= C.to_close ? C.to_close_chance : C.to_chance)
      : C.to_mid;
    if (Math.random() >= chance) return 0;
    let who;
    if (this.halfNo === 0 || margin === 0) who = team;
    else {
      const behind = margin < 0 ? team : 1 - team;
      who = Math.random() < C.to_trailing ? behind : 1 - behind;
    }
    if (this.timeouts[who] <= 0) return 0;
    this.timeouts[who] -= 1;
    return C.to_saves * this.pace;
  }

  burnTimeout(team) {
    const C = this.C;
    if (C && Math.random() < C.to_early && this.timeouts[team] > 0) this.timeouts[team] -= 1;
  }

  goalShift(toGoal) {
    const g = this.L.goal;
    const max = (this.L.bins && this.L.bins.goal_max) || 20;
    if (!g || toGoal == null || toGoal > max) return [0, 0];
    const i = Math.min(Math.max(Math.trunc(toGoal), 1), max) - 1;
    return [g.run[i], g.sack[i]];
  }

  thirdShift(down, toGo) {
    const t = this.L[DOWN_PASS_KEY[String(Math.trunc(down))]];
    if (!t) return [0, 0, 0];
    const i = Math.min(Math.max(Math.trunc(toGo), 1), t.incomplete.length) - 1;
    return [t.incomplete[i], t.sack[i], t.gain[i]];
  }

  shortLoss(toGo, yards) {
    if (!SHORT_LOSS_SCALE || toGo > SHORT_LOSS_TO_GO || yards >= 0) return yards;
    const v = yards * SHORT_LOSS_SCALE, low = Math.floor(v);
    return low + (Math.random() < v - low ? 1 : 0);
  }

  atMarker(down, toGo, toGoal, yards) {
    const mix = markerMix(down, toGo);
    if (mix && toGoal != null && toGoal >= toGo + MARKER_CLEAR && Math.random() < mix) {
      // MARKER_WEIGHTS were measured off RECORDED yardage, so the dip at the sticks is already
      // inside them and atSticks would count it a second time.
      const u = Math.random();
      let i = 0;
      while (i < MARKER_CUM.length - 1 && MARKER_CUM[i] < u) i++;
      return Math.trunc(toGo) + MARKER_BAND[i];
    }
    return this.atSticks(toGo, toGoal, yards);
  }

  // A gain landing exactly on the line to gain is written a yard short or a yard long more often
  // than it is written where it fell - a scoring convention, present on every down at every
  // distance. See STICKS_SHORT in game_script.py for the measurement and why it matters.
  atSticks(toGo, toGoal, yards) {
    if ((!STICKS_SHORT && !STICKS_LONG) || yards !== Math.trunc(toGo)
        || toGoal == null || toGoal < toGo + STICKS_CLEAR) return yards;
    const u = Math.random();
    if (u < STICKS_SHORT) return yards - 1;
    if (u < STICKS_SHORT + STICKS_LONG) return yards + 1;
    return yards;
  }

  drawPenalty(kind, toGoal) {
    // NO HALF-DISTANCE CAP, matching game_script.Game.penalty. pen_events holds the REALIZED net
    // of real penalties, so the real half-distance rule is already inside every number; capping
    // again truncates an already-truncated distribution and can only shrink it - 6.4% of mean
    // yardage at a typical field position, where the simulator was only 7.6% short to begin with.
    // This file carried the old cap for the whole life of the python fix, so the dashboard threw
    // shorter penalties than every backtest measured. What remains is the physical bound: the
    // ball cannot cross either goal line.
    // The event carries P(automatic first down) rather than the flag; see _penalty_events in
    // game_script.py. Draw it per play, and redraw a net that will not fit instead of clipping -
    // clipping truncates an already-truncated distribution and cost 3.25% of the yardage.
    const spot = Math.min(Math.max(Math.trunc(toGoal), 1), 99);
    let b = 0;
    while (b < PENALTY_FIELD_BINS.length && PENALTY_FIELD_BINS[b] < spot) b++;
    const draw = this.penalty[kind][b];
    const fits = (v) => (v > 0 ? v <= toGoal - 1 : v >= -(99 - toGoal));
    let net = 0, pAuto = 0;
    for (let i = 0; i < PENALTY_DRAW_TRIES; i++) {
      [net, pAuto] = draw();
      if (fits(net)) break;
    }
    if (!fits(net)) net = net > 0 ? Math.min(net, toGoal - 1) : Math.max(net, -(99 - toGoal));
    return [net, Math.random() < pAuto];
  }

  // one possession: returns [outcome, the other team's own yard line or null, seconds left]
  possession(team, ownLine, left, overtime = 0) {
    const L = this.L;
    let down = 1, toGoal = 100 - ownLine, toGo = Math.min(10, toGoal);
    this.off = team; this.def = 1 - team;
    while (overtime || left > 0) {
      const margin = this.score[team] - this.score[1 - team];
      const half = this.C ? this.C.half : this.halfLength;
      const quarter = overtime ? 4 : 2 * this.halfNo + (left > half / 2 ? 1 : 2);
      if (down === 4) {
        let [punt, fg, go] = fourthProbabilities(L, toGoal, toGo, margin, quarter);
        const kick = toGoal <= LAST_KICK_TO_GOAL ? this.endShift(left, 'fg') : 0;
        if (kick && fg > 0 && fg < 1) {
          const now = logistic(logit(fg) + kick);
          punt *= (1 - now) / (1 - fg); go *= (1 - now) / (1 - fg); fg = now;
        }
        // The kicking team's level, taken FROM PUNT FIRST rather than proportionally out of punt
        // and go together: only punt is over-predicted. See FG_ATTEMPT_SKILL in game_script.py
        // for the measurement. Punt covers what it can and go covers the rest, which only binds
        // near the goal line where there is no punt left to take.
        const skill = FG_ATTEMPT_SKILL[this.level(team)] ?? 0;
        if (skill && fg > 0 && fg < 1) {
          const now = logistic(logit(fg) + skill);
          const take = now - fg;
          const fromPunt = take > 0 ? Math.min(take, punt) : 0;
          punt -= fromPunt; go -= take - fromPunt; fg = now;
        }
        const lean = this.mods[team].go ?? 0;
        if (lean && go > 0 && go < 1) {
          const now = logistic(logit(go) + lean);
          punt *= (1 - now) / (1 - go); fg *= (1 - now) / (1 - go); go = now;
        }
        let choice = Math.random();
        choice = choice < punt ? 'punt' : (choice < punt + fg ? 'fg' : 'go');
        if (overtime) {
          const trailing = this.score[1 - team] - this.score[team];
          if (choice === 'punt' || (choice === 'fg' && trailing > 3)) choice = (toGoal <= LAST_KICK_TO_GOAL && trailing <= 3) ? 'fg' : 'go';
        }
        if (choice === 'punt') {
          const draw = this.fromBand(this.punts, toGoal);
          let spot = draw ? draw() : 30;
          left -= this.clockUsed('punt', margin, left);
          if (spot < 0) return ['punt_td', null, left];
          spot = Math.min(Math.max(Math.round(spot + this.shift('punt')), 1), 99);
          return ['punt', spot, left];
        }
        if (choice === 'fg') {
          const good = Math.random() < this.fgChance(toGoal);
          left -= this.clockUsed(good ? 'fg' : 'missed_fg', margin, left);
          if (good) return ['fg', 25, left];
          return ['missed_fg', Math.max(20, toGoal), left];
        }
      }

      // WHAT THIS DOES NOT CARRY. python charges every flag to the side that gave the yards and
      // keeps a per-side rate: the host is flagged less (home_terms.penalty), and the side that is
      // WINNING is flagged more (pen_state, a shift per margin band per quarter group per role).
      // Neither is mirrored here, and neither can be - this model has no side to charge, it only
      // moves the drive, and it keeps no per-team penalty count for either to show up in. Both are
      // redistributions between the two sides that leave the game's own flag rate alone, which is
      // the only thing this loop reads, so leaving them out costs the drive nothing at first order.
      //
      // pen_yard_tilt, which reweights the SIZE of a flag the same way, is a closer call: this
      // model does know the net's sign, which is the role, and it has the margin and the quarter,
      // so it could apply it. It is left out because the tilt is levelled within each role to
      // leave that role's own mean yardage alone, so what it changes is the correlation between a
      // penalty's size and the score - which this model keeps no statistic for. The drive still
      // feels it in python, through bigger flags against a defence protecting a lead, so this is a
      // real divergence; it is of the same order as the 0.26% the state table moved total points.
      if (Math.random() < this.pen.noplay) {               // the snap doesn't count
        const [net, auto] = this.drawPenalty('noplay', toGoal);
        // a no-play penalty replaces the snap but not the time it took; see game_script.py
        left -= this.clockUsed('penalty', margin, left);
        toGoal -= net;
        if (net >= toGo || auto) { down = 1; toGo = Math.min(10, toGoal); } else { toGo -= net; }
        continue;
      }

      let [kind, yards] = this.play(down, toGo, margin, quarter, toGoal, left);
      // The clock is charged once the outcome is settled: a turnover or a score stops it, a tackle
      // in the field does not, so the turnover draws come first and each pays its own cost.
      if (kind === 'interception') {
        left -= this.clockUsed('interception', margin, left);
        const draw = this.fromBand(this.ints, toGoal);
        const spot = draw ? draw() : 30;
        return spot < 0 ? ['int_td', null, left] : ['interception', spot, left];
      }
      const fumbleShare = L.fumble_td_share[kind];
      if (fumbleShare !== undefined && yards > -(100 - toGoal) && yards < toGoal) {
        const [fa, fk] = L.turnover_logit[kind];
        // The fumble term, which did not exist on either side until fit_teams started fitting one:
        // the rate was the league average in every matchup, here and in python alike.
        if (Math.random() < logistic(fa + fk * aggression(L, down, toGo, margin, quarter)
                                     + this.shift('fumble'))) {
          left -= this.clockUsed('fumble', margin, left);
          return Math.random() < fumbleShare ? ['fumble_td', null, left] : ['fumble', toGoal - yards, left];
        }
      }
      let auto = false;
      // divide out the share of snaps this gate skips; see pen_add_eligible in game_script.py
      if (yards > -(100 - toGoal) && yards < toGoal && Math.random() < this.pen.add / (1 - this.pen.noplay) / (this.L.pen_add_eligible || 1)) {
        const drawn = this.drawPenalty('add', toGoal - yards);
        yards += drawn[0]; auto = drawn[1];
      }
      const scored = yards >= toGoal || yards <= -(100 - toGoal);
      left -= this.clockUsed(kind, margin, left, scored);
      if (!scored && (!this.C || this.C.stop[kind] === undefined)) {
        left += this.spendTimeout(team, margin, left);
      }
      const gainedFirst = yards >= toGo || auto;
      if (yards >= toGoal) return ['td', 25, left];
      if (yards <= -(100 - toGoal)) return ['safety', null, left];
      toGoal -= yards;
      if (gainedFirst) { down = 1; toGo = Math.min(10, toGoal); }
      else if (down === 4) return ['downs', toGoal, left];
      else { down += 1; toGo -= yards; }
    }
    // Out of snaps. A team in range at the end of regulation kicks rather than letting the game
    // expire, when the three points would tie it or win it. The fitted 4th-down model cannot
    // express this: it sees the down, the distance, the score and the quarter, but never how much
    // of the quarter is left, so it has no way to know this is the last snap.
    if (!overtime) {
      // Before halftime any kick in range is free - there is no field position to give up. At the
      // end of the game it is only worth taking if the three points tie it or win it.
      const trailing = this.score[1 - team] - this.score[team];
      const halftime = this.halfNo === 0;
      if ((halftime || (trailing >= 0 && trailing <= 3)) && toGoal <= LAST_KICK_TO_GOAL) {
        if (Math.random() < this.fgChance(toGoal)) return ['fg', 25, left];
        return ['missed_fg', Math.max(20, toGoal), left];
      }
    }
    return ['end', null, left];
  }

  kickoff(kicking, receiving, margin, quarter) {
    const L = this.L;
    let chance = onsideChance(L, margin, quarter);
    chance = logistic(logit(Math.min(Math.max(chance, 1e-4), 1 - 1e-4)) + (this.mods[kicking].onside ?? 0));
    if (Math.random() < chance) {
      return Math.random() < L.onside.recover ? [kicking, this.kept(), 0] : [receiving, this.failed(), 0];
    }
    if (Math.random() < L.kickoff_td) return [receiving, 25, 7];
    const shift = (this.mods[receiving].kickoff_o ?? 0) + (this.mods[kicking].kickoff_d ?? 0) +
                  this.sign(receiving) * (this.homeTerms.kickoff ?? 0);
    return [receiving, Math.min(Math.max(Math.round(this.kickoffTo() + shift), 1), 99), 0];
  }

  receive(kicking, receiving, margin, quarter) {
    for (let i = 0; i < 4; i++) {
      const [team, start, points] = this.kickoff(kicking, receiving, margin, quarter);
      if (!points) return [team, start];
      this.score[receiving] += points;
      [kicking, receiving] = [receiving, kicking];
      margin = -margin;
    }
    return [receiving, 25];
  }

  half(receiving) {
    this.halfNo = this.halfNo === undefined ? 0 : this.halfNo + 1;
    // Thirty minutes, by rule. How many snaps fit in them is the game's business.
    this.halfLength = this.C ? this.C.half : 66;
    let left = this.halfLength;
    this.timeouts = [this.C ? this.C.to_per_half : 3, this.C ? this.C.to_per_half : 3];
    let [team, start] = this.receive(1 - receiving, receiving, this.score[receiving] - this.score[1 - receiving], 2 * this.halfNo + 1);
    if (this.C) left -= this.clockUsed('kickoff', 0, left);
    while (left > 0) {
      if (this.C && left > this.C.to_left) { this.burnTimeout(team); this.burnTimeout(1 - team); }
      const [outcome, next, remaining] = this.possession(team, start, left);
      left = remaining;
      const other = 1 - team;
      if (outcome === 'td') this.score[team] += 7;
      else if (outcome === 'fg') this.score[team] += 3;
      else if (outcome === 'safety') this.score[other] += 2;
      else if (DEFENSIVE_TDS.has(outcome)) this.score[other] += 7;
      // Nothing is added back here any more. The snap bonus after a score and the blowout burn
      // were both standing in for a clock: a score stops it and brings a kickoff, and a side
      // sitting on a lead spends clock.stall a snap against a chaser's clock.hurry, so both
      // gradients now come out of the clock itself. See Game.half in game_script.py.
      if (outcome === 'end') break;
      if (['td', 'fg', 'safety'].includes(outcome) || DEFENSIVE_TDS.has(outcome)) {
        const kicking = DEFENSIVE_TDS.has(outcome) ? other : team;
        left -= this.clockUsed('kickoff', this.score[team] - this.score[other], left);
        const quarter = 2 * this.halfNo + (left > this.halfLength / 2 ? 1 : 2);
        [team, start] = this.receive(kicking, 1 - kicking, this.score[kicking] - this.score[1 - kicking], quarter);
      } else {
        team = other; start = next === null ? 25 : next;
      }
    }
  }

  overtime() {
    let period = 0;
    while (this.score[0] === this.score[1] && period < 12) {
      period += 1;
      const first = (period + 1) % 2;
      for (const team of [first, 1 - first]) {
        const [outcome] = this.possession(team, 75, 0, period);
        if (DEFENSIVE_TDS.has(outcome)) { this.score[1 - team] += 6; return period; }
        if (outcome === 'td') {
          if (period >= 3) {
            const [, yards] = this.play(3, 3, this.score[team] - this.score[1 - team], 4, 3);
            this.score[team] += 6 + (yards >= 3 ? 2 : 0);
          } else this.score[team] += 7;
        } else if (outcome === 'fg') this.score[team] += 3;
        else if (outcome === 'safety') this.score[1 - team] += 2;
      }
    }
    return period;
  }

  playGame() {
    const first = Math.random() < 0.5 ? 1 : 0;
    this.half(first);
    this.half(1 - first);
    if (this.score[0] === this.score[1]) this.overtime();
    return this.score;
  }
}

// MARGIN GAIN - the same correction game_script.py applies, with the same factors. Keep the two
// in step: they are the same model and a divergence here shows up as the dashboard and the
// backtest disagreeing about the same matchup.
//
// What is left of the margin being too small once TEAM_PRIOR_PLAYS stopped over-shrinking it.
// Refitted at 100 sims on 9,307 FBS-vs-FBS walk-forward games, 2014-2026, with the prior at 70:
// 1.369 in weeks 1-2 (t = 6.23), 1.124 in weeks 3-4 (5.63) and 1.056 from week 9 (2.80). Weeks 5-8
// are now 0.966 at t = -0.83 and bowls 0.814 at -1.92, so neither is corrected - a quarter of the
// season needs no gain at all, which is the model being right rather than patched.
//
// These are fitted at 100 sims because predictor noise attenuates the slope and that noise depends
// on the sim count - the same model measures 1.255 in weeks 1-2 at 30 sims and 1.434 at 100. This
// file runs 400 and would strictly want about 2% more, which is inside the fit's standard error,
// so it uses the same numbers. Keep them in step with game_script.py: a divergence shows up as the
// dashboard and the backtest disagreeing about the same matchup.
//
// What it buys is calibration, not accuracy. See the long note in game_script.py for the rest,
// including why the correction is a shift rather than a multiply.
//
// Unlike game_script.py this file has no postseason flag to read, so week 16 and later stands in
// for it - the regular season can reach week 15. A game with no week at all is left uncorrected,
// which differs from blendWeights treating a missing week as late season; the predictions table
// always has one, so this only bites on a caller that does not.
const MARGIN_GAIN = true;
// refitted 2026-10-10 at PARAMS_VERSION 31, 100 sims, 9,310 FBS-vs-FBS games; see the table in
// game_script.py. Weeks 1-2 was overcorrecting at 1.369 and weeks 3-4 undercorrecting at 1.124.
const MARGIN_GAIN_WEEKS = [[2, 1.224], [4, 1.228], [8, 1.000], [99, 1.070]];
// a stuffed short-yardage run is compressed toward the line; see SHORT_LOSS_SCALE
// Which downs carry their own passing curve in the distance to gain, and the key each is stored
// under in the exported league params. Second down was added when its absence showed up in the
// drive count: see DOWN_PASS_KEY in game_script.py.
const DOWN_PASS_KEY = {"2": "second", "3": "third"};
const SHORT_LOSS_TO_GO = 2;
const SHORT_LOSS_SCALE = 0.70;
// short yardage on a late down resolves at the marker; see MARKER_MIX in game_script.py
const MARKER_CLEAR = 15;
const MARKER_BAND = [-1, 0, 1, 2];
const MARKER_WEIGHTS = [0.3201, 0.1616, 0.3056, 0.2127];
// per down and distance; see MARKER_MIX in game_script.py for how each cell was solved
const MARKER_MIX = {
  "2": [0.043, 0.034, 0.027, 0.012, 0.022, 0.008],
  "3": [0.183, 0.121, 0.037, 0.032, 0.029, 0.029],
  "4": [0.250, 0.095, 0.031, 0.001, 0.000, 0.000],
};
const markerMix = (down, toGo) => {
  const row = MARKER_MIX[String(Math.trunc(down))];
  return row && toGo >= 1 && toGo <= row.length ? row[Math.trunc(toGo) - 1] : 0;
};
const MARKER_CUM = MARKER_WEIGHTS.reduce((a, w) => [...a, (a[a.length - 1] ?? 0) + w], [])
                                 .map((v, _, c) => v / c[c.length - 1]);
// the same dip on every down, as a scoring convention; see STICKS_SHORT in game_script.py
const STICKS_SHORT = 0.20;
const STICKS_LONG = 0.10;
const STICKS_CLEAR = 3;
const GOAL_PASS_SHIFT = -0.081;      // pass log-odds inside GOAL_MAX; see game_script.py
const GOAL_PASS_DEFENSE = 0.1218;    // per unit of -(run_d + completion_d) inside GOAL_MAX
const INTERCEPTION_LOGIT = -0.038;   // interception log-odds everywhere; see game_script.py
const GOAL_INT_LOGIT = 0.188;        // interception log-odds inside GOAL_MAX; see game_script.py
const GOAL_COMPLETION_SHIFT = -0.075; // completion yardage normal score inside GOAL_MAX
const PENALTY_FIELD_BINS = [10, 20, 80];   // upper edges of toGoal; four bins of penalty events
const PENALTY_DRAW_TRIES = 8;   // redraws before a penalty is clipped to the goal line
const MARGIN_GAIN_POST = 1.0;
const MARGIN_GAIN_FIRST_POST_WEEK = 16;

function marginGain(week) {
  if (!MARGIN_GAIN || week === undefined || week === null) return 1;
  if (week >= MARGIN_GAIN_FIRST_POST_WEEK && week < 99) return MARGIN_GAIN_POST;
  for (const [upto, k] of MARGIN_GAIN_WEEKS) if (week <= upto) return k;
  return MARGIN_GAIN_WEEKS[MARGIN_GAIN_WEEKS.length - 1][1];
}

// One matchup: average score, win chance and the middle 80% of each team's points.
function scriptProjection(data, teamA, teamB, site, sims = SCRIPT_SIMS, week = undefined,
                          conditions = undefined) {
  const a = scriptTeam(data, teamA), b = scriptTeam(data, teamB);
  if (!a || !b) return null;
  const home = site === 'a' ? 0 : (site === 'b' ? 1 : null);
  const homeA = [], awayB = [], margins = [], totals = [];
  for (let i = 0; i < sims; i++) {
    const [x, y] = new ScriptGame(data, [a, b], home, conditions).playGame();
    homeA.push(x); awayB.push(y); margins.push(x - y); totals.push(x + y);
  }
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const sd = (v, m) => Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
  const pick = (v, q) => [...v].sort((p, r) => p - r)[Math.floor(q * (v.length - 1))];

  // The gain shifts every simulation by half of (k-1) times the mean margin, so the MEAN margin
  // comes out k times larger while the spread across simulations is untouched and each
  // simulation's total points are unchanged. Multiplying each margin by k instead would scale the
  // within-game spread as well, and that spread is not what is wrong - the slope is a statement
  // about the conditional mean, and scaling both overshoots it.
  // The win chance is taken BEFORE the gain and the margin after it. The gain is a correction to
  // the margin, which is what was measured; the win chance has its own calibration downstream
  // (WIN_STRETCH and the week-varying winner mix in app.js), fitted against the ungained
  // probabilities. Letting the gain through to p would quietly invalidate those fits, so the two
  // paths are kept apart until the winner mix is refitted.
  const rawMargin = mean(margins);
  const rawSpread = sd(margins, rawMargin);
  const p = rawSpread > 0 ? normalCdfLocal(rawMargin / rawSpread) : (rawMargin > 0 ? 1 : 0);

  const gain = marginGain(week);
  if (gain !== 1) {
    const shift = (gain - 1) * rawMargin / 2;
    for (let i = 0; i < margins.length; i++) {
      homeA[i] += shift;
      awayB[i] -= shift;
      margins[i] += 2 * shift;
    }
  }

  const margin = mean(margins);
  const spread = sd(margins, margin);
  return {
    a: mean(homeA), b: mean(awayB), margin, total: mean(homeA) + mean(awayB),
    p,
    range: { a: [pick(homeA, 0.1), pick(homeA, 0.9)], b: [pick(awayB, 0.1), pick(awayB, 0.9)] },
    samples: { margin: margins, total: totals },      // for the matchup page's histograms
  };
}
