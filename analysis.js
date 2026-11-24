// The game analysis tab: one fixture played out thousands of times by the game-script simulator
// (script.js), with each simulation's box score kept, so the reader can see what a game's stat
// lines look like and which of them move together - not only who wins.
//
// The top half of this file is pure arithmetic and runs in node as well as the page (GameLab and
// the statistics); the rest renders the tab. It reads app.js's state and helpers only when called.
//
// WHAT IS AND IS NOT ADJUSTED. The margin gain scriptProjection applies (see marginGain in
// script.js) is applied here too, as the same constant shift, so the mean margin matches the
// matchup page's game-script line. It moves every simulation by the same amount, so it changes no
// correlation and no other stat. The composite line on the matchup page is a blend of four models
// and is NOT what this tab shows; this is the simulator alone.

const LAB_STATS = [
  // per team; `d` is decimals, `pct` shows a share as a percentage
  { key: 'points', label: 'Points', d: 1 },
  { key: 'total_yds', label: 'Total yards', d: 0, title: 'Rushing + passing + sack yards' },
  { key: 'plays', label: 'Plays', d: 1, title: 'Scrimmage snaps: runs, passes and sacks; penalties that wipe out the snap are not counted' },
  { key: 'ypp', label: 'Yards per play', d: 2 },
  { key: 'rush_att', label: 'Rushes', d: 1, title: 'Sacks are NOT counted as rushes here (the NCAA counts them); see Sacks' },
  { key: 'rush_yds', label: 'Rushing yards', d: 0, title: 'Excluding sacks' },
  { key: 'ypc', label: 'Yards per rush', d: 2 },
  { key: 'pass_att', label: 'Pass attempts', d: 1 },
  { key: 'comp', label: 'Completions', d: 1 },
  { key: 'comp_pct', label: 'Completion rate', pct: true },
  { key: 'pass_yds', label: 'Passing yards', d: 0, title: 'Gross: sack yardage is its own line' },
  { key: 'ypa', label: 'Yards per pass attempt', d: 2 },
  { key: 'sacks', label: 'Sacks taken', d: 2 },
  { key: 'sack_yds', label: 'Sack yards', d: 1 },
  { key: 'explosive', label: 'Explosive plays', d: 2, title: 'Runs of 10+ yards and completions of 20+' },
  { key: 'first_downs', label: 'First downs', d: 1, title: 'Including touchdowns and penalty first downs' },
  { key: 'third_pct', label: 'Third-down conversion', pct: true },
  { key: 'fourth_att', label: 'Fourth-down tries', d: 2, title: 'Snaps run on fourth down - punts and field goals are not tries' },
  { key: 'turnovers', label: 'Turnovers', d: 2 },
  { key: 'ints', label: 'Interceptions thrown', d: 2 },
  { key: 'fumbles', label: 'Fumbles lost', d: 2 },
  { key: 'tds', label: 'Offensive touchdowns', d: 2 },
  { key: 'fg_made', label: 'Field goals made', d: 2 },
  { key: 'fg_att', label: 'Field goal attempts', d: 2 },
  { key: 'punts', label: 'Punts', d: 2 },
  { key: 'drives', label: 'Possessions', d: 1 },
  { key: 'top', label: 'Time of possession (min)', d: 1, title: 'Each side\'s share of the clock spent on its drives, scaled to 60 minutes' },
  { key: 'pen', label: 'Penalties', d: 2, title: 'Charged by which way the yards went; this engine has no per-team flag rate' },
  { key: 'pen_yds', label: 'Penalty yards', d: 1 },
  { key: 'h1', label: 'First-half points', d: 1 },
  { key: 'h2', label: 'Second-half points', d: 1, title: 'Regulation only; overtime is not in either half' },
  { key: 'q1', label: '1st-quarter points', d: 1 },
  { key: 'q2', label: '2nd-quarter points', d: 1 },
  { key: 'q3', label: '3rd-quarter points', d: 1 },
  { key: 'q4', label: '4th-quarter points', d: 1 },
];
// game-level columns, all from team A's side where a side is involved
const LAB_GAME = [
  { key: 'margin', label: 'Margin', d: 1, signed: true },
  { key: 'total', label: 'Total points', d: 1 },
  { key: 'h1_margin', label: 'First-half margin', d: 1, signed: true },
  { key: 'to_margin', label: 'Turnover margin', d: 2, signed: true, title: 'Takeaways minus giveaways' },
  { key: 'yds_margin', label: 'Yardage margin', d: 0, signed: true },
  { key: 'ot', label: 'Overtime', pct: true },
];
const LAB_CHUNK_MS = 40;            // simulation slice between repaints: the page stays live

class GameLab {
  constructor(data, teamA, teamB, site, sims, week, conditions) {
    this.data = data; this.names = [teamA, teamB]; this.site = site;
    this.sims = sims; this.week = week; this.conditions = conditions;
    this.mods = [scriptTeam(data, teamA), scriptTeam(data, teamB)];
    this.home = site === 'a' ? 0 : (site === 'b' ? 1 : null);
    this.done = 0;
    this.raw = { a: [], b: [], box: [] };
  }

  get ok() { return Boolean(this.mods[0] && this.mods[1]); }

  // plays simulations until the time budget is spent; true once all of them are in
  step(budget = LAB_CHUNK_MS) {
    const stop = performance.now() + budget;
    while (this.done < this.sims && performance.now() < stop) {
      const g = new ScriptGame(this.data, this.mods, this.home, this.conditions).track();
      const [x, y] = g.playGame();
      this.raw.a.push(x); this.raw.b.push(y); this.raw.box.push(g.box);
      this.done++;
    }
    return this.done >= this.sims;
  }

  runAll() { while (!this.step(1e9)); return this.finish(); }

  // columns keyed 'A:points', 'B:rush_yds', 'margin' and so on, one value per simulation
  finish() {
    const n = this.done, cols = {};
    const col = (k) => (cols[k] = new Float64Array(n));
    for (const side of ['A', 'B']) for (const s of LAB_STATS) col(`${side}:${s.key}`);
    for (const s of LAB_GAME) col(s.key);
    const ratio = (x, y) => (y > 0 ? x / y : NaN);
    for (let i = 0; i < n; i++) {
      const pts = [this.raw.a[i], this.raw.b[i]], box = this.raw.box[i];
      const topSum = box[0].top + box[1].top;
      const derived = box.map((b, t) => {
        const yds = b.rush_yds + b.pass_yds + b.sack_yds;
        const snaps = b.rush_att + b.pass_att + b.sacks;
        return {
          points: pts[t], total_yds: yds, plays: snaps, ypp: ratio(yds, snaps),
          rush_att: b.rush_att, rush_yds: b.rush_yds, ypc: ratio(b.rush_yds, b.rush_att),
          pass_att: b.pass_att, comp: b.comp, comp_pct: ratio(b.comp, b.pass_att), pass_yds: b.pass_yds,
          ypa: ratio(b.pass_yds, b.pass_att), sacks: b.sacks, sack_yds: b.sack_yds, explosive: b.explosive,
          first_downs: b.first_downs, third_pct: ratio(b.third_conv, b.third_att), fourth_att: b.fourth_att,
          turnovers: b.ints + b.fumbles, ints: b.ints, fumbles: b.fumbles, tds: b.rush_td + b.pass_td,
          fg_made: b.fg_made, fg_att: b.fg_att, punts: b.punts, drives: b.drives,
          top: topSum > 0 ? 60 * b.top / topSum : NaN, pen: b.pen, pen_yds: b.pen_yds,
          h1: b.q1 + b.q2, h2: b.q3 + b.q4, q1: b.q1, q2: b.q2, q3: b.q3, q4: b.q4,
        };
      });
      ['A', 'B'].forEach((side, t) => { for (const s of LAB_STATS) cols[`${side}:${s.key}`][i] = derived[t][s.key]; });
      cols.margin[i] = pts[0] - pts[1];
      cols.total[i] = pts[0] + pts[1];
      cols.h1_margin[i] = derived[0].h1 - derived[1].h1;
      cols.to_margin[i] = derived[1].turnovers - derived[0].turnovers;
      cols.yds_margin[i] = derived[0].total_yds - derived[1].total_yds;
      cols.ot[i] = box[0].ot + box[1].ot > 0 ? 1 : 0;
    }
    // the same shift scriptProjection makes, so the mean margin is the matchup page's game-script
    // line: points move, margins move by twice as much, nothing else does
    const rawMargin = labMean(cols.margin);
    this.gain = marginGain(this.week);
    this.shift = (this.gain - 1) * rawMargin / 2;
    if (this.shift) {
      for (let i = 0; i < n; i++) {
        cols['A:points'][i] += this.shift; cols['B:points'][i] -= this.shift; cols.margin[i] += 2 * this.shift;
      }
    }
    this.cols = cols;
    return this;
  }
}

// ---------------------------------------------------------------- statistics over the columns

function labMean(v) {
  let s = 0, n = 0;
  for (const x of v) if (Number.isFinite(x)) { s += x; n++; }
  return n ? s / n : NaN;
}

function labQuantiles(v, qs) {
  const sorted = Float64Array.from([...v].filter(Number.isFinite)).sort();
  return qs.map((q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : NaN));
}

// Pearson, over the simulations where both are defined (a rate with no attempts is not)
function labCorr(x, y) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i], b = y[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    n++; sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
  }
  if (n < 3) return NaN;
  const vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
  return vx > 0 && vy > 0 ? (sxy - sx * sy / n) / Math.sqrt(vx * vy) : NaN;
}

// Every column the tab can talk about, with a label naming the team where there is one
function labVariables(lab) {
  const [a, b] = lab.names;
  const out = LAB_GAME.map((s) => ({ ...s, id: s.key,
    label: s.key === 'total' || s.key === 'ot' ? s.label : `${s.label} (${a})` }));
  for (const [side, name] of [['A', a], ['B', b]]) {
    for (const s of LAB_STATS) out.push({ ...s, id: `${side}:${s.key}`, side, label: `${name} ${s.label.charAt(0).toLowerCase()}${s.label.slice(1)}` });
  }
  return out;
}

// Bins for the explorer: one per value when the stat takes few values (turnovers, sacks), quantile
// bins otherwise, so each bar stands on a comparable number of simulations.
function labBins(x, maxBins = 10) {
  const finite = [...x].filter(Number.isFinite);
  const distinct = [...new Set(finite)].sort((p, q) => p - q);
  if (distinct.length <= 12 && distinct.every(Number.isInteger)) {
    // fold a thin tail into its neighbour so no bar rests on a handful of games
    const counts = new Map(distinct.map((v) => [v, 0]));
    for (const v of finite) counts.set(v, counts.get(v) + 1);
    const bins = [];
    for (const v of distinct) {
      const last = bins[bins.length - 1];
      if (last && (counts.get(v) < finite.length * 0.01 || last.n < finite.length * 0.01)) { last.hi = v; last.n += counts.get(v); }
      else bins.push({ lo: v, hi: v, n: counts.get(v) });
    }
    return bins.map((bn) => ({ lo: bn.lo, hi: bn.hi, test: (v) => v >= bn.lo && v <= bn.hi,
                               label: bn.lo === bn.hi ? String(bn.lo) : `${bn.lo}–${bn.hi}` }));
  }
  const qs = labQuantiles(x, Array.from({ length: maxBins + 1 }, (_, i) => i / maxBins));
  const edges = [...new Set(qs.map((v) => +v.toFixed(3)))];
  const bins = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1], first = i === 0;
    bins.push({ lo, hi, test: (v) => (first ? v >= lo : v > lo) && v <= hi, label: '' });
  }
  return bins;
}

// what happens to the headline outcomes inside a slice of the simulations
function labSlice(lab, keep, line) {
  const c = lab.cols, n = c.margin.length;
  let k = 0, win = 0, cover = 0, over = 0, m = 0, t = 0;
  for (let i = 0; i < n; i++) {
    if (!keep(i)) continue;
    k++; m += c.margin[i]; t += c.total[i];
    if (c.margin[i] > 0) win++;
    if (line && line.spreadA != null && c.margin[i] + line.spreadA > 0) cover++;
    if (line && line.total != null && c.total[i] > line.total) over++;
  }
  return { n: k, share: k / n, win: k ? win / k : NaN, cover: k ? cover / k : NaN,
           over: k ? over / k : NaN, margin: k ? m / k : NaN, total: k ? t / k : NaN };
}

if (typeof module !== 'undefined') module.exports = { GameLab, LAB_STATS, LAB_GAME, labMean, labQuantiles, labCorr, labVariables, labBins, labSlice };

// ---------------------------------------------------------------- the tab

const lab = { current: null, running: null, spec: null, mode: 'margin', x: 'A:turnovers', y: 'margin' };

// "visitor at host", or "A vs B" on a neutral field - team A is not always the host
function labTitle(spec) {
  if (spec.site === 'neutral') return `${spec.a} vs ${spec.b}`;
  return spec.site === 'b' ? `${spec.a} at ${spec.b}` : `${spec.b} at ${spec.a}`;
}

function labEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function labFormat(s, v) {
  if (!Number.isFinite(v)) return '–';
  if (s.pct) return `${(100 * v).toFixed(1)}%`;
  const text = v.toFixed(s.d ?? 1);
  return s.signed && v > 0 ? `+${text}` : text;
}

// scheduleLines speaks of the first-named team; this tab calls it team A
function labLine(first, second) {
  const l = scheduleLines(first, second);
  return l ? { spreadA: l.spreadFirst, total: l.total } : {};
}

// The game the tab is looking at. `spec` is {a, b, site, week, conditions, line, gameId}.
function labSpecFromGame(g) {
  return { a: g.home, b: g.away, site: g.neutral ? 'neutral' : 'a', week: g.week, gameId: g.game_id,
           conditions: scriptConditions(g), line: labLine(g.home, g.away), completed: g.completed,
           result: g.completed ? [g.home_points, g.away_points] : null };
}

// From the matchup page: any pair, scheduled or not, oriented the way the reader named them
function goToAnalysis(teamA, teamB, site) {
  const g = state.schedule.find((x) => (x.home === teamA && x.away === teamB) || (x.home === teamB && x.away === teamA));
  lab.spec = { a: teamA, b: teamB, site, week: g ? g.week : currentWeek(), gameId: g ? g.game_id : null,
               conditions: scheduleConditions(teamA, teamB), line: labLine(teamA, teamB),
               completed: g ? g.completed : false,
               result: g && g.completed ? (g.home === teamA ? [g.home_points, g.away_points] : [g.away_points, g.home_points]) : null };
  showView('analysis');
  labRun();
}

function labWeeks() {
  return [...new Set(state.schedule.map((g) => g.week).filter((w) => w !== null && w !== undefined))].sort((p, q) => p - q);
}

function labFillPickers() {
  const weeks = labWeeks();
  const weekSel = $('lab-week'), gameSel = $('lab-game');
  if (!weeks.length) { weekSel.innerHTML = ''; gameSel.innerHTML = ''; return; }
  const want = lab.spec?.week ?? currentWeek();
  weekSel.innerHTML = weeks.map((w) => `<option value="${w}">Week ${w}</option>`).join('');
  weekSel.value = String(weeks.includes(want) ? want : weeks[weeks.length - 1]);
  labFillGames();
}

function labFillGames() {
  const week = Number($('lab-week').value);
  const games = state.schedule.filter((g) => g.week === week && scriptTeam(state.script, g.home) && scriptTeam(state.script, g.away))
    .sort((p, q) => `${p.date}${p.time}${p.away}`.localeCompare(`${q.date}${q.time}${q.away}`));
  const custom = lab.spec && !lab.spec.gameId ? `<option value="custom">${labEsc(lab.spec.a)} vs ${labEsc(lab.spec.b)} (from Matchup)</option>` : '';
  $('lab-game').innerHTML = custom + games.map((g) =>
    `<option value="${g.game_id}">${labEsc(g.away)} ${g.neutral ? 'vs' : 'at'} ${labEsc(g.home)}${g.completed ? ' (final)' : ''}</option>`).join('');
  if (lab.spec?.gameId && games.some((g) => g.game_id === lab.spec.gameId)) $('lab-game').value = String(lab.spec.gameId);
  else if (custom) $('lab-game').value = 'custom';
}

function labPicked() {
  const v = $('lab-game').value;
  if (v === 'custom') return lab.spec;
  const g = state.schedule.find((x) => String(x.game_id) === v);
  return g ? labSpecFromGame(g) : null;
}

// called by showView whenever the tab is shown, and by loadSeason
function labShow() {
  if (!state.schedule || !state.schedule.length || !state.script) {
    $('lab-note').textContent = state.script === null ? 'This season has no simulator parameters, so there is nothing to run.' : 'Loading…';
    return;
  }
  // a new season empties the tab; the first visit only records which season it is
  if (lab.season !== undefined && lab.season !== state.season) {
    lab.current = null; lab.spec = null;
    $('lab-out').innerHTML = '';
  }
  lab.season = state.season;
  labFillPickers();
  if (!lab.current && !lab.running) $('lab-note').textContent = 'Pick a game and press Run. 10,000 simulations take 10-20 seconds; the page stays usable while they run.';
}

// Yields to the page between slices. Not setTimeout: a chain of zero-delay timers is clamped,
// and in a tab the browser counts as backgrounded it is held to one wake-up a second, which ran
// 10,000 simulations at under 300 a second against 5,000 straight through. A message posted on a
// channel is an ordinary task, so the page still repaints between slices but nothing throttles it.
const labChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
let labNext = null;
if (labChannel) labChannel.port1.onmessage = () => { const fn = labNext; labNext = null; if (fn) fn(); };
function labYield(fn) {
  if (!labChannel) { setTimeout(fn, 0); return; }
  labNext = fn;
  labChannel.port2.postMessage(null);
}

function labRun() {
  // the spec the matchup page handed over keeps its orientation while its game is still selected
  const picked = $('lab-game').value;
  const spec = lab.spec && (picked === 'custom' || (lab.spec.gameId != null && String(lab.spec.gameId) === picked))
    ? lab.spec : labPicked();
  if (!spec) return;
  lab.spec = spec;
  labFillPickers();
  const sims = Number($('lab-sims').value) || 10000;
  const run = new GameLab(state.script, spec.a, spec.b, spec.site, sims, spec.week, spec.conditions);
  if (!run.ok) { $('lab-note').textContent = `The simulator has no ratings for ${spec.a} or ${spec.b}.`; return; }
  lab.running = run;
  $('lab-run').disabled = true; $('lab-csv').disabled = true;
  const tick = () => {
    if (lab.running !== run) return;              // a newer run took over
    const finished = run.step();
    $('lab-note').textContent = `Simulating ${labTitle(spec)}: ${run.done.toLocaleString()} of ${sims.toLocaleString()}…`;
    if (!finished) { labYield(tick); return; }
    lab.running = null;
    lab.current = run.finish();
    lab.current.spec = spec;
    $('lab-run').disabled = false; $('lab-csv').disabled = false;
    labRender();
  };
  labYield(tick);
}

function labColors() {
  const byName = Object.fromEntries(state.teams.map((t) => [t.team, t]));
  const ta = byName[lab.current.spec.a] || {}, tb = byName[lab.current.spec.b] || {};
  const c = matchupColors(ta, tb, lab.current.spec.site);
  return { a: c.a || 'var(--accent)', b: c.b || '#8a8a93', ta, tb };
}

function labRender() {
  const L = lab.current, spec = L.spec, c = L.cols, n = c.margin.length;
  const [a, b] = L.names;
  const colors = labColors();
  const line = spec.line || {};
  const all = labSlice(L, () => true, line);
  const meanA = labMean(c['A:points']), meanB = labMean(c['B:points']);
  const [m10, m50, m90] = labQuantiles(c.margin, [0.1, 0.5, 0.9]);
  const [t10, t50, t90] = labQuantiles(c.total, [0.1, 0.5, 0.9]);
  const where = spec.site === 'neutral' ? 'neutral site' : `at ${spec.site === 'a' ? a : b}`;
  const cond = spec.conditions || {};
  const wx = [cond.temp != null && `${Math.round(cond.temp)}°F`, cond.wind != null && `wind ${cond.wind.toFixed(0)} mph`, cond.wet ? 'rain' : null].filter(Boolean).join(', ');
  const fav = all.margin >= 0 ? a : b;
  const fmtLine = (v) => (v > 0 ? `+${v}` : `${v}`);
  const by = (m) => (Math.round(m) === 0 ? 'a tie' : `${m > 0 ? a : b} by ${Math.abs(m).toFixed(0)}`);
  const tiles = [
    { big: `${fmt.pct(all.win)}`, small: `${a} wins`, note: `${fmt.pct(1 - all.win)} ${b}` },
    { big: `${meanA.toFixed(1)}–${meanB.toFixed(1)}`, small: 'Mean score', note: `median: ${by(m50)}` },
    { big: `${fav} by ${Math.abs(all.margin).toFixed(1)}`, small: 'Simulator line',
      note: line.spreadA != null ? `book: ${a} ${fmtLine(line.spreadA)}` : 'no book line' },
    line.spreadA != null && { big: fmt.pct(all.cover), small: `${a} covers ${fmtLine(line.spreadA)}`, note: `${fmt.pct(1 - all.cover)} ${b} ${fmtLine(-line.spreadA)}` },
    { big: all.total.toFixed(1), small: 'Total points', note: line.total != null ? `over ${line.total}: ${fmt.pct(all.over)}` : `middle 80%: ${t10.toFixed(0)}–${t90.toFixed(0)}` },
    { big: fmt.pct(labMean(c.ot)), small: 'Overtime', note: `middle 80%: ${by(m10)} to ${by(m90)}` },
  ].filter(Boolean);
  const result = spec.result ? `<p class="subline">Final: <strong>${a} ${spec.result[0]} – ${b} ${spec.result[1]}</strong> (margin ${spec.result[0] - spec.result[1] > 0 ? '+' : ''}${spec.result[0] - spec.result[1]}, total ${spec.result[0] + spec.result[1]}). ` +
    `The simulator had ${a} at or above that margin in ${fmt.pct(labSlice(L, (i) => c.margin[i] >= spec.result[0] - spec.result[1]).share)} of games.</p>` : '';

  $('lab-out').innerHTML = `
    <div class="lab-card">
      <p class="headline">${labEsc(labTitle(spec))}</p>
      <p class="subline">Week ${spec.week ?? '–'} · ${where}${wx ? ` · ${wx}` : ''} · ${n.toLocaleString()} simulations of the game-script model alone (not the matchup page's blend)</p>
      ${result}
      <div class="probability">
        <div class="a" style="${barStyle(colors.a)};width:${(100 * all.win).toFixed(1)}%">${all.win >= 0.12 ? `${labEsc(a)} ${fmt.pct(all.win)}` : ''}</div>
        <div class="b" style="${barStyle(colors.b)};width:${(100 * (1 - all.win)).toFixed(1)}%">${1 - all.win >= 0.12 ? `${fmt.pct(1 - all.win)} ${labEsc(b)}` : ''}</div>
      </div>
      <div class="lab-tiles">${tiles.map((t) => `<div class="lab-tile"><div class="big">${labEsc(t.big)}</div><div class="small">${labEsc(t.small)}</div><div class="tile-note">${labEsc(t.note)}</div></div>`).join('')}</div>
      <div class="charts lab-charts">
        <figure class="chart"><figcaption>Margin <span>left of zero is ${labEsc(a)}; bars are 3-point bands</span></figcaption><div class="plot" data-lab="margin"></div></figure>
        <figure class="chart"><figcaption>Total points <span>3-point bands${line.total != null ? `; the book's total is ${line.total}` : ''}</span></figcaption><div class="plot" data-lab="total"></div></figure>
      </div>
    </div>

    <div class="lab-card">
      <h3>Box score projection</h3>
      <p class="subline">Mean, with the middle 80% of simulations beneath it. Click a row to explore it below.</p>
      <div class="table-wrap"><table class="lab-box">
        <thead><tr><th class="text">Stat</th><th>${labEsc(a)}</th><th>10th–90th</th><th>${labEsc(b)}</th><th>10th–90th</th></tr></thead>
        <tbody>${LAB_STATS.map((s) => {
          const cell = (side) => {
            const v = c[`${side}:${s.key}`];
            const [lo, hi] = labQuantiles(v, [0.1, 0.9]);
            return `<td data-var="${side}:${s.key}">${labFormat(s, labMean(v))}</td><td class="range">${labFormat(s, lo)}–${labFormat(s, hi)}</td>`;
          };
          return `<tr${s.title ? ` title="${labEsc(s.title)}"` : ''}><td class="text">${labEsc(s.label)}</td>${cell('A')}${cell('B')}</tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>

    <div class="lab-card">
      <h3>What moves with the result</h3>
      <div class="controls">
        <div class="segmented" id="lab-mode">
          <button data-mode="margin" aria-pressed="${lab.mode === 'margin'}">Margin</button>
          <button data-mode="total" aria-pressed="${lab.mode === 'total'}">Total points</button>
        </div>
      </div>
      <p class="subline" id="lab-drivers-note"></p>
      <div id="lab-drivers"></div>
    </div>

    <div class="lab-card">
      <h3>Correlation matrix</h3>
      <p class="subline">Correlation between stat lines across the ${n.toLocaleString()} simulations: <span class="swatch pos"></span> move together, <span class="swatch neg"></span> move apart. Hover a cell for the number; click it to explore the pair.</p>
      <div class="table-wrap" id="lab-matrix"></div>
    </div>

    <div class="lab-card">
      <h3>Explore a pair</h3>
      <div class="controls">
        <label>Across <select id="lab-x"></select></label>
        <label>Show <select id="lab-y"></select></label>
      </div>
      <div id="lab-explore"></div>
      <div class="lab-condition">
        <h4>If…</h4>
        <div class="controls">
          <select id="lab-cond-var"></select>
          <select id="lab-cond-op"><option value="ge">is at least</option><option value="le">is at most</option></select>
          <input id="lab-cond-val" type="number" step="any">
        </div>
        <div id="lab-cond-out"></div>
      </div>
    </div>`;

  labDrawCharts();
  labDrivers();
  labMatrix();
  const vars = labVariables(L);
  const options = vars.map((v) => `<option value="${v.id}">${labEsc(v.label)}</option>`).join('');
  for (const id of ['lab-x', 'lab-y', 'lab-cond-var']) $(id).innerHTML = options;
  $('lab-x').value = lab.x; $('lab-y').value = lab.y; $('lab-cond-var').value = lab.x;
  labSetConditionDefault();
  labExplore();
  labCondition();

  document.querySelectorAll('#lab-mode button').forEach((btn) => btn.addEventListener('click', () => {
    lab.mode = btn.dataset.mode;
    document.querySelectorAll('#lab-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
    labDrivers();
  }));
  $('lab-x').addEventListener('change', () => { lab.x = $('lab-x').value; labExplore(); });
  $('lab-y').addEventListener('change', () => { lab.y = $('lab-y').value; labExplore(); });
  $('lab-cond-var').addEventListener('change', () => { labSetConditionDefault(); labCondition(); });
  $('lab-cond-op').addEventListener('change', labCondition);
  $('lab-cond-val').addEventListener('input', labCondition);
  $('lab-out').querySelector('.lab-box').addEventListener('click', (e) => {
    const td = e.target.closest('tr')?.querySelector('[data-var]');
    if (!td) return;
    const row = e.target.closest('tr');
    const cells = [...row.querySelectorAll('[data-var]')];
    const hit = e.target.closest('[data-var]') || cells[0];
    labPick(hit.dataset.var);
  });
  $('lab-note').textContent = `${n.toLocaleString()} simulations.${L.shift ? ` The margin carries the week-${spec.week} gain (×${L.gain.toFixed(3)}, ${L.shift > 0 ? '+' : ''}${(2 * L.shift).toFixed(2)} points), as the matchup page's game-script line does; correlations are unaffected.` : ''} ` +
    `Box-score conventions: sacks are not rushes, penalties are charged by which way the yards went, explosive plays are runs of 10+ and completions of 20+.`;
}

function labPick(id) {
  lab.x = id;
  $('lab-x').value = id; $('lab-cond-var').value = id;
  labSetConditionDefault();
  labExplore(); labCondition();
  document.querySelector('#lab-x').closest('.lab-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function labDrawCharts() {
  const L = lab.current;
  if (!L) return;
  const colors = labColors();
  const [a, b] = L.names;
  const line = L.spec.line || {};
  document.querySelectorAll('#lab-out .plot[data-lab]').forEach((plot) => {
    const width = plot.clientWidth;
    if (!(width > 0)) return;
    if (plot.dataset.lab === 'margin') {
      const samples = Array.from(L.cols.margin, (v) => -v);
      plot.innerHTML = distributionChart([{ label: 'Simulator', samples, mean: labMean(samples),
        sub: line.spreadA != null ? `book ${a} ${line.spreadA > 0 ? '+' : ''}${line.spreadA}` : '' }], {
        width, binWidth: 3, zero: true,
        colors: { neg: colors.a, pos: colors.b },
        ends: { left: { label: a, color: colors.a }, right: { label: b, color: colors.b } },
        format: (v) => Math.abs(v).toFixed(0),
        marks: line.spreadA != null ? [{ value: line.spreadA, label: 'book' }] : [],
        describe: (low, high) => `${high <= 0 ? a : b} by ${Math.min(Math.abs(low), Math.abs(high))}-${Math.max(Math.abs(low), Math.abs(high))}`,
        label: `How often each margin comes up, ${a} against ${b}` });
    } else {
      const samples = Array.from(L.cols.total);
      plot.innerHTML = distributionChart([{ label: 'Simulator', samples, mean: labMean(samples),
        sub: line.total != null ? `book ${line.total}` : '' }], {
        width, binWidth: 3, format: (v) => v.toFixed(0), unit: 'points',
        marks: line.total != null ? [{ value: line.total, label: 'book' }] : [],
        label: `How often each total comes up, ${a} against ${b}` });
    }
  });
}

// every stat's correlation with the margin (or the total), strongest first, as bars either side
// of zero in the colour of the team each direction favours
function labDrivers() {
  const L = lab.current, colors = labColors();
  const [a, b] = L.names;
  const target = L.cols[lab.mode];
  const skip = new Set(['margin', 'total', 'A:points', 'B:points']);
  const rows = labVariables(L).filter((v) => !skip.has(v.id) && !/:(q\d|h1|h2)$/.test(v.id) && v.id !== 'h1_margin')
    .map((v) => ({ v, r: labCorr(L.cols[v.id], target) }))
    .filter((x) => Number.isFinite(x.r))
    .sort((p, q) => Math.abs(q.r) - Math.abs(p.r)).slice(0, 18);
  const posColor = lab.mode === 'margin' ? colors.a : 'var(--accent)';
  const negColor = lab.mode === 'margin' ? colors.b : '#8a8a93';
  $('lab-drivers-note').textContent = lab.mode === 'margin'
    ? `Correlation of each stat line with ${a}'s margin, the 18 strongest. A bar toward ${a}'s side means more of that stat goes with ${a} doing better. Quarter and half scores are left out - they are pieces of the margin itself. These are associations, not causes: a team that is ahead runs the ball to drain the clock, so its rushes follow the margin as much as they make it.`
    : 'Correlation of each stat line with total points, the 18 strongest. Quarter and half scores are left out - they are pieces of the total itself. These are associations, not causes.';
  $('lab-drivers').innerHTML = `<div class="lab-bars">${rows.map(({ v, r }) => {
    const w = (Math.abs(r) * 50).toFixed(1);
    const style = r >= 0 ? `left:50%;width:${w}%;background:${posColor}` : `right:50%;width:${w}%;background:${negColor}`;
    return `<div class="lab-bar-row" data-var="${v.id}" title="r = ${r.toFixed(3)} - click to explore"><div class="lab-bar-label">${labEsc(v.label)}</div>` +
      `<div class="lab-bar-track"><div class="lab-bar-mid"></div><div class="lab-bar" style="${style}"></div></div><div class="lab-bar-val">${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}</div></div>`;
  }).join('')}</div>`;
  document.querySelectorAll('#lab-drivers .lab-bar-row').forEach((row) => row.addEventListener('click', () => {
    lab.y = lab.mode; $('lab-y').value = lab.mode; labPick(row.dataset.var);
  }));
}

const LAB_MATRIX = ['margin', 'total', 'A:points', 'B:points', 'A:total_yds', 'B:total_yds', 'A:rush_yds', 'B:rush_yds',
  'A:pass_yds', 'B:pass_yds', 'A:turnovers', 'B:turnovers', 'A:sacks', 'B:sacks', 'A:explosive', 'B:explosive',
  'A:plays', 'B:plays', 'A:top', 'A:third_pct', 'B:third_pct', 'A:punts', 'B:punts'];

// a diverging scale resolved to real colours, so each cell's text can be picked for contrast
function labCellColor(r) {
  const css = getComputedStyle(document.documentElement);
  const hex = (name, fallback) => hexToRgb((css.getPropertyValue(name) || '').trim()) || hexToRgb(fallback);
  const mid = hex('--surface', '#ffffff'), pos = hex('--accent', '#1f5fbf'), neg = hex('--bad', '#b3261e');
  const end = r >= 0 ? pos : neg, f = Math.min(Math.abs(r), 1);
  const rgb = mid.map((v, i) => Math.round(v + (end[i] - v) * f));
  return { bg: `rgb(${rgb.join(',')})`, fg: luminance(rgb) > 0.55 ? '#1d1d1f' : '#ffffff' };
}

function labMatrix() {
  const L = lab.current;
  const vars = Object.fromEntries(labVariables(L).map((v) => [v.id, v]));
  const ids = LAB_MATRIX.filter((id) => vars[id]);
  const [a, b] = L.names;
  const short = (id) => {
    const v = vars[id];
    if (!v.side) return v.key === 'margin' ? `Margin (${a})` : v.label.replace(` (${a})`, '');
    return `${v.side === 'A' ? a : b} ${LAB_STATS.find((s) => s.key === v.key).label.toLowerCase()}`;
  };
  const head = ids.map((id) => `<th class="rot"><div><span>${labEsc(short(id))}</span></div></th>`).join('');
  const body = ids.map((row) => `<tr><th class="text">${labEsc(short(row))}</th>${ids.map((col) => {
    if (row === col) return '<td class="diag"></td>';
    const r = labCorr(L.cols[row], L.cols[col]);
    const { bg, fg } = labCellColor(Number.isFinite(r) ? r : 0);
    return `<td style="background:${bg};color:${fg}" data-x="${col}" data-y="${row}" title="${labEsc(short(row))} vs ${labEsc(short(col))}: r = ${Number.isFinite(r) ? r.toFixed(3) : '–'}">${Number.isFinite(r) ? (r < 0 ? '−' : '') + Math.abs(r).toFixed(2).replace(/^0/, '') : ''}</td>`;
  }).join('')}</tr>`).join('');
  $('lab-matrix').innerHTML = `<table class="lab-matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
  $('lab-matrix').querySelector('table').addEventListener('click', (e) => {
    const td = e.target.closest('td[data-x]');
    if (!td) return;
    lab.y = td.dataset.y; $('lab-y').value = td.dataset.y;
    labPick(td.dataset.x);
  });
}

// mean of Y in each bin of X, with the middle 80% of Y as a whisker and the win share when Y is
// the margin
function labExplore() {
  const L = lab.current;
  const vars = Object.fromEntries(labVariables(L).map((v) => [v.id, v]));
  const vx = vars[lab.x], vy = vars[lab.y];
  if (!vx || !vy) return;
  const x = L.cols[lab.x], y = L.cols[lab.y];
  const bins = labBins(x).map((bn) => {
    const ys = [];
    for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i]) && Number.isFinite(y[i]) && bn.test(x[i])) ys.push(y[i]);
    const [lo, hi] = labQuantiles(ys, [0.1, 0.9]);
    const wins = lab.y === 'margin' ? ys.filter((v) => v > 0).length / (ys.length || 1) : null;
    const label = bn.label || `${labFormat(vx, bn.lo)}–${labFormat(vx, bn.hi)}`;
    return { label, n: ys.length, mean: labMean(ys), lo, hi, wins };
  }).filter((bn) => bn.n > 0);
  const r = labCorr(x, y);
  // least-squares slope, so the reader gets "each extra X is worth this much Y"
  let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0;
  for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i]) && Number.isFinite(y[i])) { k++; sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const slope = (sxy - sx * sy / k) / (sxx - sx * sx / k);
  const lo = Math.min(...bins.map((bn) => bn.lo)), hi = Math.max(...bins.map((bn) => bn.hi));
  const span = hi - lo || 1;
  const W = 100, pos = (v) => ((v - lo) / span) * W;
  const zero = lo < 0 && hi > 0 ? `<div class="lab-ex-zero" style="left:${pos(0).toFixed(2)}%"></div>` : '';
  const unit = vx.pct ? 'percentage point' : 'unit';
  const per = vx.pct ? slope / 100 : slope;
  $('lab-explore').innerHTML = `
    <p class="subline">r = ${Number.isFinite(r) ? r.toFixed(3) : '–'} · each extra ${unit} of ${labEsc(vx.label)} goes with ${per >= 0 ? '+' : '−'}${Math.abs(per).toFixed(vy.pct ? 4 : 2)} of ${labEsc(vy.label)} on average.</p>
    <div class="lab-ex">
      <div class="lab-ex-head"><span>${labEsc(vx.label)}</span><span>${labEsc(vy.label)}: mean, with the middle 80%</span><span>Sims</span>${lab.y === 'margin' ? `<span>${labEsc(L.names[0])} wins</span>` : ''}</div>
      ${bins.map((bn) => `<div class="lab-ex-row">
        <span class="lab-ex-x">${labEsc(bn.label)}</span>
        <span class="lab-ex-track">${zero}<span class="lab-ex-range" style="left:${pos(bn.lo).toFixed(2)}%;width:${Math.max(pos(bn.hi) - pos(bn.lo), 0.5).toFixed(2)}%"></span><span class="lab-ex-dot" style="left:${pos(bn.mean).toFixed(2)}%" title="${labFormat(vy, bn.mean)}"></span></span>
        <span class="lab-ex-n">${labFormat(vy, bn.mean)} <span class="sub">${bn.n.toLocaleString()}</span></span>
        ${lab.y === 'margin' ? `<span class="lab-ex-w">${fmt.pct(bn.wins)}</span>` : ''}
      </div>`).join('')}
    </div>`;
}

function labSetConditionDefault() {
  const id = $('lab-cond-var').value, v = lab.current.cols[id];
  const vars = Object.fromEntries(labVariables(lab.current).map((x) => [x.id, x]));
  let [q] = labQuantiles(v, [0.75]);
  if (vars[id]?.pct) q = Math.round(q * 100) / 100;
  else if (Math.abs(q) >= 20) q = Math.round(q / 5) * 5;
  else q = Math.round(q);
  $('lab-cond-val').value = String(q);
}

function labCondition() {
  const L = lab.current, id = $('lab-cond-var').value, op = $('lab-cond-op').value;
  const t = Number($('lab-cond-val').value);
  const vars = Object.fromEntries(labVariables(L).map((x) => [x.id, x]));
  const v = L.cols[id], line = L.spec.line || {};
  if (!Number.isFinite(t) || !v) { $('lab-cond-out').innerHTML = ''; return; }
  const keep = op === 'ge' ? (i) => v[i] >= t : (i) => v[i] <= t;
  const inside = labSlice(L, keep, line), all = labSlice(L, () => true, line);
  const outside = labSlice(L, (i) => Number.isFinite(v[i]) && !keep(i), line);
  const [a, b] = L.names;
  const fmtLine = (x) => (x > 0 ? `+${x}` : `${x}`);
  const row = (label, f, d) => `<tr><td class="text">${label}</td><td>${f(inside)}</td><td>${f(outside)}</td><td>${f(all)}</td></tr>`;
  const pts = (s) => (Number.isFinite(s.margin) ? `${s.margin > 0 ? '+' : ''}${s.margin.toFixed(1)}` : '–');
  $('lab-cond-out').innerHTML = inside.n === 0
    ? `<p class="subline">No simulation has ${labEsc(vars[id].label.toLowerCase())} ${op === 'ge' ? 'that high' : 'that low'}.</p>`
    : `<p class="subline">${labEsc(vars[id].label)} ${op === 'ge' ? '≥' : '≤'} ${labEsc(vars[id].pct ? `${(100 * t).toFixed(0)}%` : String(t))} in ${fmt.pct(inside.share)} of simulations (${inside.n.toLocaleString()}).${vars[id].pct ? ' Rates are entered as fractions: 0.45 is 45%.' : ''}</p>
      <div class="table-wrap"><table class="lab-cond">
        <thead><tr><th class="text"></th><th>When it happens</th><th>When it doesn't</th><th>All games</th></tr></thead>
        <tbody>
          ${row(`${labEsc(a)} wins`, (s) => fmt.pct(s.win))}
          ${row(`Mean margin (${labEsc(a)})`, pts)}
          ${line.spreadA != null ? row(`${labEsc(a)} covers ${fmtLine(line.spreadA)}`, (s) => fmt.pct(s.cover)) : ''}
          ${row('Mean total', (s) => (Number.isFinite(s.total) ? s.total.toFixed(1) : '–'))}
          ${line.total != null ? row(`Over ${line.total}`, (s) => fmt.pct(s.over)) : ''}
        </tbody>
      </table></div>`;
}

// one row per simulation, every column, for anyone who wants to take it elsewhere
function labDownload() {
  const L = lab.current;
  if (!L) return;
  const vars = labVariables(L);
  const head = ['sim', ...vars.map((v) => v.id.replace('A:', `${L.names[0]}:`).replace('B:', `${L.names[1]}:`))];
  const lines = [head.map((h) => `"${h.replace(/"/g, '""')}"`).join(',')];
  for (let i = 0; i < L.cols.margin.length; i++) {
    lines.push([i + 1, ...vars.map((v) => { const x = L.cols[v.id][i]; return Number.isFinite(x) ? +x.toFixed(4) : ''; })].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `sim_${labTitle(L.spec)}_${L.cols.margin.length}.csv`.replace(/[^\w.-]+/g, '_');
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    $('lab-week')?.addEventListener('change', labFillGames);
    $('lab-run')?.addEventListener('click', labRun);
    $('lab-csv')?.addEventListener('click', labDownload);
    let resizing = null;
    window.addEventListener('resize', () => { clearTimeout(resizing); resizing = setTimeout(labDrawCharts, 150); });
    // the matrix resolves its colours once, so a theme change has to redraw it
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (lab.current) labMatrix(); });
  });
}
