// Turning a price into an expected return, using what the models actually did against closing
// lines rather than what their disagreement with the line claims.
//
// The two bet types sit on very different footings, so they are answered differently.
//
// Against the spread there is no measured edge. Fitted on the 1,550 FBS-vs-FBS games of 2024-25
// that carry a closing line, the chance of covering rises 0.0198 in log-odds per point of
// disagreement with the line, and that slope's 95% interval, +0.0004 to +0.0391, only just clears
// zero. Every honest answer here is therefore an interval, and at any realistic edge that interval
// straddles break-even. A single number would be reporting noise as a forecast.
//
// The moneyline is firmer. Over 3,348 games the composite is the sharper forecast by some way -
// Brier 0.1655 against the old EPA + success-Elo blend's 0.1869 - and it is now calibrated: the
// raw pool was underconfident at a slope of 1.188, because averaging win chances drags them
// towards 50%, so app.js pools in log-odds and stretches the result (see WIN_STRETCH). Held out
// on the season it was not fitted on that lands at 1.007, which is as close to honest as this
// sample can measure. The probability can therefore be priced directly.

// Refitted on the margin mix, which is what the page now disagrees with the line by. The slope is
// all but unchanged from the old EPA + success-Elo fit (0.0198 against 0.0202 per point), but the
// intercept comes back to zero: the old basis leaned about three quarters of a point towards the
// home side at a zero edge, and this one does not.
const ATS_FIT = {
  intercept: -0.00558,
  slope: 0.019760,
  cov: [[0.00258852, 0.00001014], [0.00001014, 0.00009709]],
  games: 1550,
  seasons: '2024-25',
  // half the fitted games sit inside 2.8 points of the line and 95% inside 9.8. Past that the
  // curve is extrapolating, and its interval understates the doubt because it assumes the
  // logistic shape keeps holding out there.
  p95: 9.8,
  beyondP95: 78,
};

// Totals, tested over 2,767 games by predicting each season with the PREVIOUS season's parameters
// - the only honest way, since a season's own parameters are fitted on the games being predicted.
// Scored in-sample the same model looks like 60%, which is the trap.
//
// Two things the test found. First, the simulated over/under probability carries almost no
// information: across the whole range of predictions, reality moves about four points. Second,
// what is visible is concordance - whether the two models pick the same side - and even that does
// not clear the vig.
//
// The numbers are split by game type, because they differ. The line is sharpest on cross-division
// blowouts (11.58) and the models are furthest behind there; on the 70 FCS-vs-FCS games the game
// script is the only model anywhere that beats the line (12.41 against 12.66), and the market sets
// those totals 2.7 points low. But 70 games calibrates nothing, so an FCS-vs-FCS matchup borrows
// the pooled figures and says so.
const TOTALS_FIT = {
  minKindGames: 300,        // below this a game type has no figures of its own
  minBucketGames: 100,      // below this one bucket within a type falls back to pooled
  all: {
    games: 2767, lineMae: 12.41, modelMae: 13.78, scriptMae: 14.23,
    lineBias: -1.1, modelBias: -1.0, scriptBias: 5.0, hit: 0.516, agreeShare: 0.69,
    bothOver: { games: 1416, hit: 0.524 }, bothUnder: { games: 481, hit: 0.538 },
    split: { games: 870, hit: 0.490 },
    calibration: [[0, 35, 50.7], [35, 50, 48.0], [50, 65, 52.4], [65, 100, 52.4]],
  },
  byKind: {
    'FBS vs FBS': {
      games: 2336, lineMae: 12.53, modelMae: 13.96, scriptMae: 14.37,
      lineBias: -1.1, modelBias: -0.6, scriptBias: 4.9, hit: 0.515, agreeShare: 0.71,
      bothOver: { games: 1232, hit: 0.519 }, bothUnder: { games: 436, hit: 0.541 },
      split: { games: 668, hit: 0.490 },
      calibration: [[0, 35, 50.1], [35, 50, 48.1], [50, 65, 52.3], [65, 100, 51.8]],
    },
    'cross-division': {
      games: 360, lineMae: 11.58, modelMae: 12.80, scriptMae: 13.67,
      lineBias: -1.4, modelBias: -2.7, scriptBias: 5.9, hit: 0.522, agreeShare: 0.52,
      bothOver: { games: 153, hit: 0.549 },
      bothUnder: { games: 34, hit: 0.471 },      // too few; falls back
      split: { games: 173, hit: 0.509 },
      calibration: null,                          // buckets of 47-116, too thin to quote
    },
    'FCS vs FCS': {
      games: 70, lineMae: 12.66, modelMae: 13.07, scriptMae: 12.41,
      lineBias: -2.7, modelBias: -2.5, scriptBias: 2.7,
    },
  },
};

/**
 * The totals figures for one game type, falling back to the pooled set field by field wherever a
 * sample is too small to stand on its own. `pooled` lists what had to be borrowed, so the page can
 * say which numbers are not really about the game in front of the reader.
 */
function totalsFitFor(kind) {
  const all = TOTALS_FIT.all;
  const own = TOTALS_FIT.byKind[kind];
  const borrowed = [];
  if (!own || own.games < TOTALS_FIT.minKindGames) {
    // A type this small keeps its own error and bias - those are plain descriptive statistics,
    // noisy but about the right games - and borrows only the concordance and calibration figures,
    // which need a sample this does not have.
    return { ...all, ...(own || {}), kind, basis: 'all game types',
             borrowed: ['concordance', 'calibration'], ownGames: own?.games ?? 0, pooledGames: all.games };
  }
  const bucket = (key) => {
    const b = own[key];
    if (b && b.games >= TOTALS_FIT.minBucketGames) return b;
    borrowed.push(key === 'bothOver' ? 'both-over' : key === 'bothUnder' ? 'both-under' : 'split');
    return all[key];
  };
  // spread `all` first so a type's own numbers win, but keep the pooled count separately: it is
  // what a borrowed figure was measured on, and `games` has just been overwritten by the type's
  const out = { ...all, ...own, kind, basis: kind, ownGames: own.games, pooledGames: all.games };
  out.bothOver = bucket('bothOver');
  out.bothUnder = bucket('bothUnder');
  out.split = bucket('split');
  if (!own.calibration) { out.calibration = all.calibration; borrowed.push('calibration'); }
  out.borrowed = borrowed;
  return out;
}

const BREAK_EVEN = 110 / 210;          // a -110 bet needs this to break even

// A return multiplier is decimal odds: stake 1, get `d` back in total when it lands, so the
// expected return per unit staked is simply p * d - 1. 1.91 is the usual -110.
const evFromMultiplier = (chance, multiplier) =>
  (Number.isFinite(multiplier) && multiplier > 1 && Number.isFinite(chance) ? chance * multiplier - 1 : null);

// what a multiplier says the chance is, the book's cut included
const impliedFromMultiplier = (multiplier) =>
  (Number.isFinite(multiplier) && multiplier > 1 ? 1 / multiplier : null);

// American odds -> profit on a 1-unit stake. +150 pays 1.5, -200 pays 0.5.
function profitPerUnit(american) {
  if (!Number.isFinite(american) || american === 0) return null;
  return american > 0 ? american / 100 : 100 / -american;
}

// what the price says the chance is, vig included
const impliedChance = (american) => {
  const profit = profitPerUnit(american);
  return profit === null ? null : 1 / (profit + 1);
};

// expected return per unit staked, given a true chance and a price
function expectedReturn(chance, american) {
  const profit = profitPerUnit(american);
  if (profit === null || chance === null) return null;
  return chance * profit - (1 - chance);
}

/**
 * The measured chance of covering, for a model edge of `edge` points, with the 95% interval that
 * comes from the fit. `price` is the American price on the spread bet, -110 unless given.
 */
function spreadValue(edge, price = -110) {
  const e = Math.abs(edge);
  const { intercept, slope, cov } = ATS_FIT;
  const z = intercept + slope * e;
  const variance = cov[0][0] + e * e * cov[1][1] + 2 * e * cov[0][1];
  const halfWidth = 1.96 * Math.sqrt(Math.max(variance, 0));
  const chance = (t) => 1 / (1 + Math.exp(-t));
  const mid = chance(z), low = chance(z - halfWidth), high = chance(z + halfWidth);
  return {
    chance: mid, low, high,
    ev: expectedReturn(mid, price),
    evLow: expectedReturn(low, price),
    evHigh: expectedReturn(high, price),
    // does the interval clear the vig anywhere? if not, say so plainly
    beatsVig: low > BREAK_EVEN,
    couldBeatVig: high > BREAK_EVEN,
    extrapolating: e > ATS_FIT.p95,
  };
}

/**
 * Pricing the model's own win chance against a moneyline. `chance` is the blend's probability for
 * the side being backed, `american` the price offered on it.
 */
function moneylineValue(chance, american) {
  const implied = impliedChance(american);
  if (implied === null) return null;
  return {
    implied,
    model: chance,
    ev: expectedReturn(chance, american),
    profit: profitPerUnit(american),
    edge: chance - implied,
  };
}

// the overround, when both sides of a market are given: how much the book is holding
function overround(homeOdds, awayOdds) {
  const a = impliedChance(homeOdds), b = impliedChance(awayOdds);
  return a === null || b === null ? null : a + b - 1;
}

/**
 * The chance a particular side covers, rather than the chance the model's own pick does.
 * `edgeForSide` is the model's margin minus the market's, from that side's point of view: positive
 * means the model likes this side. The fit only knows how often its pick covered, so backing the
 * other side is its complement.
 */
function coverChanceFor(edgeForSide) {
  const v = spreadValue(edgeForSide);
  const backingModel = edgeForSide >= 0;
  return {
    chance: backingModel ? v.chance : 1 - v.chance,
    low: backingModel ? v.low : 1 - v.high,
    high: backingModel ? v.high : 1 - v.low,
    extrapolating: v.extrapolating,
    backingModel,
  };
}

window.evFromMultiplier = evFromMultiplier;
window.impliedFromMultiplier = impliedFromMultiplier;
window.coverChanceFor = coverChanceFor;
window.TOTALS_FIT = TOTALS_FIT;
window.totalsFitFor = totalsFitFor;
window.spreadValue = spreadValue;
window.moneylineValue = moneylineValue;
window.overround = overround;
window.ATS_FIT = ATS_FIT;
