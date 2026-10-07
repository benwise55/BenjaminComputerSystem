// Small-multiple histograms of what each model expects from a matchup: one row per model, every
// row on the same axis and the same height scale, so the rows can be read against each other.
// The two simulated models are binned from their own samples; the rating models are normal
// curves, binned straight from the normal CDF instead of being sampled, so they carry no
// simulation wobble of their own.

const CHART_WIDTH = 520;          // a viewBox, set to the rendered width so text stays 12px
const CHART_RIGHT = 10;
const CHART_ROW = 44;
const CHART_GAP = 14;
const CHART_AXIS = 26;
const CHART_ENDS = 20;            // the band naming which side of zero belongs to which team
const CHART_BAR_GAP = 2;          // surface showing between neighbouring bars

const chartEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function chartSd(values, mean) {
  let sum = 0;
  for (const v of values) sum += (v - mean) ** 2;
  return Math.sqrt(sum / values.length);
}

// The bins every row shares: wide enough for all of them, and always with a boundary on 0 so no
// single bar can mix a win with a loss
function chartEdges(models, width) {
  let lo = Infinity, hi = -Infinity;
  for (const m of models) {
    const mean = m.mean ?? 0;
    const sd = m.sd ?? chartSd(m.samples, mean);
    lo = Math.min(lo, mean - 3 * sd);
    hi = Math.max(hi, mean + 3 * sd);
  }
  lo = Math.floor(lo / width) * width;
  hi = Math.ceil(hi / width) * width;
  const edges = [];
  for (let v = lo; v <= hi + 1e-9; v += width) edges.push(Math.round(v));
  return edges;
}

// One model's share of games in each bin. Samples are counted (anything past the ends falls in
// the end bin, which is under a percent of them); a normal gets the exact probability instead.
function chartHeights(model, edges) {
  const bins = edges.length - 1;
  const out = new Array(bins).fill(0);
  if (model.samples) {
    const width = edges[1] - edges[0];
    for (const v of model.samples) {
      const i = Math.min(Math.max(Math.floor((v - edges[0]) / width), 0), bins - 1);
      out[i]++;
    }
    return out.map((n) => n / model.samples.length);
  }
  for (let i = 0; i < bins; i++) {
    out[i] = normalCdf((edges[i + 1] - model.mean) / model.sd) - normalCdf((edges[i] - model.mean) / model.sd);
  }
  return out;
}

// a bar with its top corners rounded, sitting on the baseline
function chartBar(x, y, w, base, fill, title) {
  const h = base - y;
  if (h <= 0.2) return '';
  const r = Math.min(3, w / 2, h);
  const d = `M${x} ${base}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${base}Z`;
  return `<path d="${d}" fill="${fill}"><title>${chartEscape(title)}</title></path>`;
}

function chartTicks(lo, hi, step) {
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

/**
 * models: [{ label, note, mean, sd, samples }] - give either sd (a normal) or samples.
 * options: { binWidth, colors: {pos, neg}, zero, unit, format, describe, ends }
 *   colors.neg paints the bars left of zero, colors.pos the ones right of it; with no `zero`
 *   every bar is colours.pos. `ends` ({left, right}: {label, color}) names the two sides above
 *   the rows, and `describe(low, high)` writes a bin's hover text when a bare range will not do.
 */
function distributionChart(models, options = {}) {
  // the viewBox is drawn at the width it will be shown at, so 12px in here is 12px on screen
  const CHART_WIDTH = Math.round(options.width || 520);
  const CHART_LEFT = CHART_WIDTH < 430 ? 92 : 124;   // the gutter with each model's name and numbers
  const width = options.binWidth ?? 7;
  const edges = chartEdges(models, width);
  const bins = edges.length - 1;
  const rows = models.map((m) => ({ ...m, heights: chartHeights(m, edges) }));
  // a third line in the gutter needs the row to be taller, or it would sit on the baseline
  const ROW = rows.some((r) => r.sub) ? CHART_ROW + 14 : CHART_ROW;
  const tallest = Math.max(...rows.map((r) => Math.max(...r.heights)));
  const plotW = CHART_WIDTH - CHART_LEFT - CHART_RIGHT;
  const step = plotW / bins;
  const x = (v) => CHART_LEFT + ((v - edges[0]) / (edges[bins] - edges[0])) * plotW;
  const headroom = options.ends ? CHART_ENDS : 0;
  const height = headroom + rows.length * ROW + (rows.length - 1) * CHART_GAP + CHART_AXIS;
  const unit = options.unit ?? '';
  const fmtValue = options.format ?? ((v) => (v > 0 ? '+' : '') + v.toFixed(0));
  const colors = options.colors ?? {};
  const pos = colors.pos || 'var(--accent)';
  const neg = colors.neg || '#8a8a93';

  const parts = [];
  // gridlines first, so every bar sits on top of them
  const tickStep = width * Math.max(1, Math.round(bins / 6));
  const ticks = chartTicks(edges[0], edges[bins], tickStep);
  const bottom = height - CHART_AXIS;
  for (const t of ticks) {
    parts.push(`<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${headroom}" y2="${bottom}" stroke="var(--border)" stroke-width="1"/>`);
    parts.push(`<text x="${x(t).toFixed(1)}" y="${bottom + 16}" class="tick" text-anchor="middle">${fmtValue(t)}</text>`);
  }
  if (options.zero) {
    parts.push(`<line x1="${x(0).toFixed(1)}" x2="${x(0).toFixed(1)}" y1="${headroom}" y2="${bottom + 4}" stroke="var(--muted)" stroke-width="1.5"/>`);
  }
  // Which way is which, in each team's own colour and in words, right above the bars. Two long
  // names on a phone would run into each other there, so the left one then starts at the very
  // edge instead, over the gutter.
  if (options.ends) {
    const { left, right } = options.ends;
    const width = (text) => 6.2 * (text.length + 2);        // 11px semibold, near enough
    const rightEdge = CHART_WIDTH - CHART_RIGHT;
    const roomy = CHART_LEFT + width(left.label) < rightEdge - width(right.label);
    parts.push(`<text x="${roomy ? CHART_LEFT : 0}" y="12" class="end" fill="${left.color}">◀ ${chartEscape(left.label)}</text>`);
    parts.push(`<text x="${rightEdge}" y="12" class="end" fill="${right.color}" text-anchor="end">${chartEscape(right.label)} ▶</text>`);
  }

  rows.forEach((row, i) => {
    const top = headroom + i * (ROW + CHART_GAP);
    const base = top + ROW;
    parts.push(`<text x="0" y="${top + 15}" class="name">${chartEscape(row.label)}</text>`);
    // the weight it carries sits straight under the name, then where the model lands
    [row.sub && { text: row.sub, cls: 'weight' }, row.note && { text: row.note, cls: 'note' }]
      .filter(Boolean)
      .forEach((line, k) => parts.push(
        `<text x="0" y="${top + 31 + k * 14}" class="${line.cls}">${chartEscape(line.text)}</text>`));
    for (let b = 0; b < bins; b++) {
      const share = row.heights[b];
      const centre = (edges[b] + edges[b + 1]) / 2;
      const left = x(edges[b]) + CHART_BAR_GAP / 2;
      const y = base - (share / tallest) * (ROW - 3);
      const range = options.describe ? options.describe(edges[b], edges[b + 1])
        : `${fmtValue(edges[b])} to ${fmtValue(edges[b + 1])} ${unit}`;
      const title = `${row.label}: ${range} in ${(100 * share).toFixed(1)}% of games`;
      parts.push(chartBar(left, y, step - CHART_BAR_GAP, base, options.zero && centre < 0 ? neg : pos, title));
    }
    // where the model actually lands, so a shifted row is obvious next to the one above it
    parts.push(`<line x1="${x(row.mean).toFixed(1)}" x2="${x(row.mean).toFixed(1)}" y1="${top}" y2="${base}" ` +
      `stroke="var(--text)" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.5"/>`);
    parts.push(`<line x1="${CHART_LEFT}" x2="${CHART_WIDTH - CHART_RIGHT}" y1="${base}" y2="${base}" stroke="var(--border)" stroke-width="1"/>`);
  });

  const label = options.label ? ` role="img" aria-label="${chartEscape(options.label)}"` : '';
  // no height attribute: the viewBox's own ratio drives it, so a scaled chart is never letterboxed
  return `<svg class="dist" viewBox="0 0 ${CHART_WIDTH} ${height}"${label}>${parts.join('')}</svg>`;
}

window.distributionChart = distributionChart;
