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

function passChance(L, mods, down, toGo, margin, quarter, homeSign, homeTerms, toGoal, endPass = 0) {
  const base = L.pass_intercept + (down >= 2 ? L.pass_base[down - 2] : 0) + (quarter >= 2 ? L.pass_base[quarter + 1] : 0);
  return logistic(base + aggression(L, down, toGo, margin, quarter) + (mods.pass ?? 0)
                  + homeSign * (homeTerms.pass ?? 0) + callShift(L, down, toGo, toGoal, margin, quarter)
                  + endPass);
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

class ScriptGame {
  constructor(data, mods, home) {
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
    this.halfSnaps = (this.L.snaps_per_game + (mods[0].pace ?? 0) + (mods[1].pace ?? 0)) / 2;
    this.run = table(this.L.run_yards);
    this.completion = table(this.L.completion_yards);
    this.kickoffTo = sampler(this.L.kickoff_to);
    this.kept = sampler(this.L.onside.kept_to);
    this.failed = sampler(this.L.onside.failed_to);
    // a thin band borrows the nearest well-filled one, as the Python does
    this.punts = filledBands(this.L.punt_to);
    this.ints = filledBands(this.L.int_to);
    this.penalty = { noplay: sampler(this.L.penalties.noplay), add: sampler(this.L.penalties.add) };
    // both teams shift the penalty rate and neither changes during the game, so shift it once
    const penShift = (this.mods[0].penalty ?? 0) + (this.mods[1].penalty ?? 0);
    this.pen = penShift
      ? { noplay: logistic(logit(this.L.pen_noplay) + penShift), add: logistic(logit(this.L.pen_add) + penShift) }
      : { noplay: this.L.pen_noplay, add: this.L.pen_add };
    this.off = 0; this.def = 1;
  }

  sign(team) { return this.home === null ? 0 : (team === this.home ? 1 : -1); }

  // The intercept belongs here too. Every team term is measured against a league baseline drawn
  // from all divisions while the FBS group indicator is zero, so an average FBS pairing carries the
  // intercept alone. Python dropped it for years; punt is -1.47 yards of it, kickoff -0.44.
  shift(model) {
    const o = this.mods[this.off], d = this.mods[this.def];
    const shock = (this.shock && (model === 'run' || model === 'completion')) ? this.shock[this.off] : 0;
    return (o[`${model}_o`] ?? 0) + (d[`${model}_d`] ?? 0) + (this.intercepts[model] ?? 0) + shock
           + this.sign(this.off) * (this.homeTerms[model] ?? 0);
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
    const [fieldShift, fieldSpread, fieldInc] = this.passFieldShift(toGoal);
    if (Math.random() >= passChance(L, this.mods[this.off], down, toGo, margin, quarter,
                                    this.sign(this.off), this.homeTerms, toGoal, this.endShift(left, 'pass'))) {
      return ['run', this.run(this.shift('run') + this.runShift(down, toGo) + goalRun, spread)];
    }
    // third down is the only down whose passing moves with the distance to gain: sacks roughly
    // double from a yard to ten, completions fall, and a catch gains more. Zeros anywhere else.
    const [incShift, sackShift, gainShift] = this.thirdShift(down, toGo);
    const u = Math.random();
    const incomplete = logistic(logit(L.incomplete) + this.shift('incomplete') + incShift + fieldInc);
    if (u < incomplete) return ['incomplete', 0];
    const [ia, ik] = L.turnover_logit.interception;
    const intercept = logistic(ia + ik * aggression(L, down, toGo, margin, quarter) + this.shift('interception'));
    if (u < incomplete + intercept) return ['interception', 0];
    if (Math.random() < logistic(logit(L.sack) + this.shift('sack') + sackShift + goalSack)) {
      return ['sack', Math.round(L.sack_mean + gauss() * L.sack_sd)];
    }
    return ['complete', this.completion(this.shift('completion') + gainShift + fieldShift, fieldSpread)];
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

  // The closing snaps of a half. The only clock here is the snap budget, so the hurry-up and the
  // kick it sets up are fitted on snaps remaining: under two minutes real pass share jumps to
  // 64.6% from a baseline near 48%, and 41% of second-quarter field goals come in that minute.
  endShift(left, which) {
    const e = this.L.endhalf, n = this.L.end_snaps ?? 8;
    if (!e || left == null || left >= n || left < 0) return 0;
    return e[which][Math.trunc(left)] ?? 0;
  }

  goalShift(toGoal) {
    const g = this.L.goal;
    const max = (this.L.bins && this.L.bins.goal_max) || 20;
    if (!g || toGoal == null || toGoal > max) return [0, 0];
    const i = Math.min(Math.max(Math.trunc(toGoal), 1), max) - 1;
    return [g.run[i], g.sack[i]];
  }

  thirdShift(down, toGo) {
    const t = this.L.third;
    if (down !== 3 || !t) return [0, 0, 0];
    const i = Math.min(Math.max(Math.trunc(toGo), 1), t.incomplete.length) - 1;
    return [t.incomplete[i], t.sack[i], t.gain[i]];
  }

  drawPenalty(kind, toGoal) {
    const [net, auto] = this.penalty[kind]();
    const capped = net > 0 ? Math.min(net, Math.floor(toGoal / 2)) : Math.max(net, -Math.floor((100 - toGoal) / 2));
    return [capped, !!auto];
  }

  // one possession: returns [outcome, the other team's own yard line or null, snaps left]
  possession(team, ownLine, left, overtime = 0) {
    const L = this.L;
    let down = 1, toGoal = 100 - ownLine, toGo = Math.min(10, toGoal);
    this.off = team; this.def = 1 - team;
    while (overtime || left > 0) {
      const margin = this.score[team] - this.score[1 - team];
      const quarter = overtime ? 4 : 2 * this.halfNo + (left > this.halfLength / 2 ? 1 : 2);
      if (down === 4) {
        let [punt, fg, go] = fourthProbabilities(L, toGoal, toGo, margin, quarter);
        const kick = toGoal <= LAST_KICK_TO_GOAL ? this.endShift(left, 'fg') : 0;
        if (kick && fg > 0 && fg < 1) {
          const now = logistic(logit(fg) + kick);
          punt *= (1 - now) / (1 - fg); go *= (1 - now) / (1 - fg); fg = now;
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
          if (spot < 0) return ['punt_td', null, left];
          spot = Math.min(Math.max(Math.round(spot + this.shift('punt')), 1), 99);
          return ['punt', spot, left];
        }
        if (choice === 'fg') {
          const [a, k] = L.fg_logit;
          if (Math.random() < logistic(a + k * (toGoal + 17))) return ['fg', 25, left];
          return ['missed_fg', Math.max(20, toGoal), left];
        }
      }

      if (Math.random() < this.pen.noplay) {               // the snap doesn't count
        const [net, auto] = this.drawPenalty('noplay', toGoal);
        toGoal -= net;
        if (net >= toGo || auto) { down = 1; toGo = Math.min(10, toGoal); } else { toGo -= net; }
        continue;
      }

      let [kind, yards] = this.play(down, toGo, margin, quarter, toGoal, left);
      left -= 1;
      if (kind === 'interception') {
        const draw = this.fromBand(this.ints, toGoal);
        const spot = draw ? draw() : 30;
        return spot < 0 ? ['int_td', null, left] : ['interception', spot, left];
      }
      const fumbleShare = L.fumble_td_share[kind];
      if (fumbleShare !== undefined && yards > -(100 - toGoal) && yards < toGoal) {
        const [fa, fk] = L.turnover_logit[kind];
        if (Math.random() < logistic(fa + fk * aggression(L, down, toGo, margin, quarter))) {
          return Math.random() < fumbleShare ? ['fumble_td', null, left] : ['fumble', toGoal - yards, left];
        }
      }
      let auto = false;
      if (yards > -(100 - toGoal) && yards < toGoal && Math.random() < this.pen.add / (1 - this.pen.noplay)) {
        const drawn = this.drawPenalty('add', toGoal - yards);
        yards += drawn[0]; auto = drawn[1];
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
        const [a, k] = L.fg_logit;
        if (Math.random() < logistic(a + k * (toGoal + 17))) return ['fg', 25, left];
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
    const whole = Math.floor(this.halfSnaps);
    this.halfLength = whole + (Math.random() < this.halfSnaps - whole ? 1 : 0);
    let left = this.halfLength;
    let [team, start] = this.receive(1 - receiving, receiving, this.score[receiving] - this.score[1 - receiving], 2 * this.halfNo + 1);
    while (left > 0) {
      const [outcome, next, remaining] = this.possession(team, start, left);
      left = remaining;
      const other = 1 - team;
      if (outcome === 'td') this.score[team] += 7;
      else if (outcome === 'fg') this.score[team] += 3;
      else if (outcome === 'safety') this.score[other] += 2;
      else if (DEFENSIVE_TDS.has(outcome)) this.score[other] += 7;
      // A side sitting on a big lead late lets the clock go, which costs snaps nobody runs. Late
      // in the final period only: keyed on the margin as it stands, it also fired in games that
      // tightened up, and those are the LONGEST real ones. The budget itself is fitted on close
      // FBS games, so without this blowouts came out a snap a team long.
      const bl = this.L.blowout;
      if (bl && bl[1] && this.halfNo >= 1 && left < this.halfLength / 2
          && Math.abs(this.score[0] - this.score[1]) >= bl[0] && Math.random() < bl[1]) {
        left = Math.max(0, left - 1);
      }
      if (outcome === 'end') break;
      if (['td', 'fg', 'safety'].includes(outcome) || DEFENSIVE_TDS.has(outcome)) {
        const kicking = DEFENSIVE_TDS.has(outcome) ? other : team;
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
// 1.272 in weeks 1-2 (t = 4.35), 1.119 in weeks 3-4 (5.28) and 1.063 from week 9 (3.08). Weeks 5-8
// are now 0.971 at t = -0.44 and bowls 0.955 at -0.67, so neither is corrected - a quarter of the
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
const MARGIN_GAIN_WEEKS = [[2, 1.272], [4, 1.119], [8, 1.000], [99, 1.063]];
const MARGIN_GAIN_POST = 1.0;
const MARGIN_GAIN_FIRST_POST_WEEK = 16;

function marginGain(week) {
  if (!MARGIN_GAIN || week === undefined || week === null) return 1;
  if (week >= MARGIN_GAIN_FIRST_POST_WEEK && week < 99) return MARGIN_GAIN_POST;
  for (const [upto, k] of MARGIN_GAIN_WEEKS) if (week <= upto) return k;
  return MARGIN_GAIN_WEEKS[MARGIN_GAIN_WEEKS.length - 1][1];
}

// One matchup: average score, win chance and the middle 80% of each team's points.
function scriptProjection(data, teamA, teamB, site, sims = SCRIPT_SIMS, week = undefined) {
  const a = scriptTeam(data, teamA), b = scriptTeam(data, teamB);
  if (!a || !b) return null;
  const home = site === 'a' ? 0 : (site === 'b' ? 1 : null);
  const homeA = [], awayB = [], margins = [], totals = [];
  for (let i = 0; i < sims; i++) {
    const [x, y] = new ScriptGame(data, [a, b], home).playGame();
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
