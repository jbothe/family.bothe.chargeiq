'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load the widget's actual presentation logic by extracting the marked block
 * from index.html and evaluating it. This tests the exact code the widget runs
 * (the logic is inlined so the widget stays self-contained on Homey).
 */
function loadPF(): Record<string, (...args: unknown[]) => unknown> {
  const html = readFileSync(
    join(__dirname, '../../widgets/power-flow/public/index.html'), 'utf8',
  );
  const m = html.match(/POWERFLOW-LOGIC-START[\s\S]*?===\s*([\s\S]*?)\/\/ === POWERFLOW-LOGIC-END/);
  if (!m) throw new Error('PowerFlow logic block not found in index.html');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn PF;`)();
}

const PF = loadPF();

test('fmtW formats W / kW, always keeping exactly one decimal place on kW', () => {
  assert.equal(PF.fmtW(0), '0 W');
  assert.equal(PF.fmtW(850), '850 W');
  assert.equal(PF.fmtW(2300), '2.3 kW');
  assert.equal(PF.fmtW(14000), '14.0 kW');
  assert.equal(PF.fmtW(13800), '13.8 kW');
  assert.equal(PF.fmtW(null), '–');
});

test('valHtml: wraps the unit in a span with a leading &nbsp;, so the space picks up the unit\'s smaller size', () => {
  // A plain " " gets silently trimmed here - .val is a flex container, and a leading
  // collapsible space at the start of a flex item's own content is dropped just like at
  // the start of a block box. &nbsp; isn't collapsible, so it's what actually renders.
  assert.equal(PF.valHtml(850), '850<span class="unit homey-text-small-light">&nbsp;W</span>');
  assert.equal(PF.valHtml(2300), '2.3<span class="unit homey-text-small-light">&nbsp;kW</span>');
});

test('valHtml: no separator string is left between the number and the unit span', () => {
  // The split point (str.lastIndexOf(' ')) drops the original fmtW() space entirely -
  // confirms the space in the output comes only from the one added inside <span class="unit">.
  const html = PF.valHtml(850) as string;
  assert.equal(html.indexOf('850 '), -1, 'no bare space directly after the number');
  assert.ok(html.startsWith('850<span'), 'the number is immediately followed by the unit span, no gap');
});

test('valHtml: passes through unchanged when fmtW has no unit to split off (e.g. the dash placeholder)', () => {
  assert.equal(PF.valHtml(null), '–');
});

test('valHtml: stacked=true (header row) omits the separating &nbsp; - the unit already renders on its own line', () => {
  assert.equal(PF.valHtml(850, true), '850<span class="unit homey-text-small-light">W</span>');
  assert.equal(PF.valHtml(2300, true), '2.3<span class="unit homey-text-small-light">kW</span>');
});

test('flow: ev reads charger.powerW, 0 when no charger paired', () => {
  assert.deepEqual(PF.flow('ev', { charger: { available: true, powerW: 2100 } }), { mag: 2100, dir: 'up' });
  assert.deepEqual(PF.flow('ev', { charger: { available: true, powerW: 0 } }), { mag: 0, dir: null });
  assert.deepEqual(PF.flow('ev', { charger: { available: false, powerW: 5000 } }), { mag: 0, dir: null });
});

test('flow: solar and house always flow down (into the bus) when active', () => {
  assert.deepEqual(PF.flow('solar', { solarW: 4200 }), { mag: 4200, dir: 'down' });
  assert.deepEqual(PF.flow('solar', { solarW: 0 }), { mag: 0, dir: null });
  assert.deepEqual(PF.flow('house', { houseW: 1500 }), { mag: 1500, dir: 'down' });
  assert.deepEqual(PF.flow('house', { houseW: 5 }), { mag: 5, dir: null });
});

test('flow: battery down when charging, up when discharging', () => {
  assert.deepEqual(PF.flow('battery', { batteryW: 600 }), { mag: 600, dir: 'down' });
  assert.deepEqual(PF.flow('battery', { batteryW: -600 }), { mag: 600, dir: 'up' });
  assert.deepEqual(PF.flow('battery', { batteryW: 0 }), { mag: 0, dir: null });
});

test('flow: grid up when importing, down when exporting', () => {
  assert.deepEqual(PF.flow('grid', { gridW: 1200 }), { mag: 1200, dir: 'up' });
  assert.deepEqual(PF.flow('grid', { gridW: -2100 }), { mag: 2100, dir: 'down' });
  assert.deepEqual(PF.flow('grid', { gridW: 0 }), { mag: 0, dir: null });
});

test('busState: import / export / neutral by grid sign, with a +-10W deadband', () => {
  assert.equal(PF.busState(1200), 'import');
  assert.equal(PF.busState(-1200), 'export');
  assert.equal(PF.busState(0), 'neutral');
  assert.equal(PF.busState(5), 'neutral');
  assert.equal(PF.busState(-5), 'neutral');
  assert.equal(PF.busState(null), 'neutral');
});

test('batteryVisual: color/fill tiers by charge percent', () => {
  assert.deepEqual(PF.batteryVisual(5), { color: 'var(--homey-color-red)', fillHeight: 2, fillY: 17 });
  assert.deepEqual(PF.batteryVisual(20), { color: 'var(--homey-color-orange)', fillHeight: 3.25, fillY: 15.75 });
  assert.deepEqual(
    PF.batteryVisual(50),
    { color: 'color-mix(in srgb, var(--homey-color-red), var(--homey-color-green))', fillHeight: 6.5, fillY: 12.5 },
  );
  assert.deepEqual(PF.batteryVisual(75), { color: 'var(--homey-color-orange)', fillHeight: 9.75, fillY: 9.25 });
  assert.deepEqual(PF.batteryVisual(100), { color: 'var(--homey-color-green)', fillHeight: 13, fillY: 6 });
  assert.deepEqual(PF.batteryVisual(null), { color: 'var(--homey-color-mono-500)', fillHeight: 2, fillY: 17 });
});

test('evChip: label + style class from evcharger_charging_state, null when no charger paired', () => {
  assert.deepEqual(
    PF.evChip({ charger: { available: true, chargingState: 'plugged_in_charging' } }),
    { cls: 'charging' },
    'charging carries no label - render() fills it with a "CHARGING" label + live amps instead',
  );
  assert.deepEqual(
    PF.evChip({ charger: { available: true, chargingState: 'plugged_in' } }),
    { label: 'READY', cls: 'ready' },
  );
  assert.deepEqual(
    PF.evChip({ charger: { available: true, chargingState: 'plugged_out' } }),
    { label: 'UNPLUGGED', cls: 'unplugged' },
  );
  assert.equal(PF.evChip({ charger: { available: false, chargingState: 'plugged_out' } }), null);
});

test('chargeAmps: shows the commanded limit while actively charging, 0A otherwise', () => {
  assert.equal(
    PF.chargeAmps({ charger: { available: true, chargingState: 'plugged_in_charging', limitA: 16 } }),
    16,
  );
  assert.equal(
    PF.chargeAmps({ charger: { available: true, chargingState: 'plugged_in', limitA: 16 } }),
    0,
  );
  assert.equal(
    PF.chargeAmps({ charger: { available: true, chargingState: 'plugged_out', limitA: 16 } }),
    0,
  );
  assert.equal(
    PF.chargeAmps({ charger: { available: false, chargingState: 'plugged_in_charging', limitA: 16 } }),
    0,
  );
  assert.equal(
    PF.chargeAmps({ charger: { available: true, chargingState: 'plugged_in_charging', limitA: null } }),
    0,
  );
});

test('modeIconKey: scheduled/manual are literal, solar splits on solarEnough', () => {
  assert.equal(PF.modeIconKey({ mode: 'scheduled' }), 'scheduled');
  assert.equal(PF.modeIconKey({ mode: 'manual' }), 'manual');
  assert.equal(PF.modeIconKey({ mode: 'solar', solarEnough: true }), 'solar-enough');
  assert.equal(PF.modeIconKey({ mode: 'solar', solarEnough: false }), 'solar-low');
  assert.equal(PF.modeIconKey({ mode: 'idle' }), 'idle');
  assert.equal(PF.modeIconKey({ mode: null }), null);
});

test('modeStatusText: -> window end while scheduled, -> next schedule start otherwise, empty with nothing to point to', () => {
  // Constructed from local Date components (not an ISO literal) so the round-trip through
  // toISOString()/new Date() and back to toLocaleTimeString() lands on the same wall-clock
  // time regardless of which timezone this test happens to run in.
  const end = new Date(2024, 0, 1, 14, 0);
  const nextStart = new Date(2024, 0, 1, 9, 0);
  // Matches modeStatusText's own formatting: lowercase, no space before am/pm.
  const fmt = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(' ', '').toLowerCase();

  assert.equal(
    PF.modeStatusText({ mode: 'scheduled', scheduleEndAt: end.toISOString(), nextScheduleStartAt: null }),
    `→ ${fmt(end)}`,
  );
  assert.equal(
    PF.modeStatusText({ mode: 'manual', scheduleEndAt: null, nextScheduleStartAt: nextStart.toISOString() }),
    `→ ${fmt(nextStart)}`,
  );
  assert.equal(
    PF.modeStatusText({ mode: 'solar', scheduleEndAt: null, nextScheduleStartAt: nextStart.toISOString() }),
    `→ ${fmt(nextStart)}`,
  );
  assert.equal(
    PF.modeStatusText({ mode: 'solar', scheduleEndAt: null, nextScheduleStartAt: null }),
    '',
    'no schedule configured at all - nothing to point to',
  );
});

test('showBoost: true only in scheduled mode with boostActive set', () => {
  assert.equal(PF.showBoost({ mode: 'scheduled', boostActive: true }), true);
  assert.equal(PF.showBoost({ mode: 'scheduled', boostActive: false }), false);
  assert.equal(PF.showBoost({ mode: 'manual', boostActive: true }), false, 'boost only applies to scheduled mode');
});

test('meter: ev uses live charger power against chargerMaxW, hidden when no charger or no cap', () => {
  const limits = {
    chargerMaxW: 7360, gridMaxW: 14000, batteryChargePeakW: 3000, batteryDischargePeakW: 2600, solarPeakW: 6000,
  };
  assert.deepEqual(
    PF.meter('ev', { charger: { available: true, powerW: 3680 }, limits }),
    { pct: 0.5, color: 'var(--homey-color-green)' },
  );
  assert.equal(
    PF.meter('ev', { charger: { available: false, powerW: 3680 }, limits }), null,
    'no charger paired',
  );
  assert.equal(
    PF.meter('ev', { charger: { available: true, powerW: 3680 }, limits: { ...limits, chargerMaxW: 0 } }), null,
    'cap disabled',
  );
});

test('meter: solar against solarPeakW, hidden when no peak configured', () => {
  const limits = {
    chargerMaxW: 7360, gridMaxW: 14000, batteryChargePeakW: 3000, batteryDischargePeakW: 2600, solarPeakW: 6000,
  };
  assert.deepEqual(PF.meter('solar', { solarW: 3000, limits }), { pct: 0.5, color: 'var(--homey-color-green)' });
  assert.equal(PF.meter('solar', { solarW: 3000, limits: { ...limits, solarPeakW: 0 } }), null);
});

test('meter: battery picks charge peak when charging, discharge peak when discharging', () => {
  const limits = {
    chargerMaxW: 7360, gridMaxW: 14000, batteryChargePeakW: 3000, batteryDischargePeakW: 2600, solarPeakW: 6000,
  };
  assert.deepEqual(
    PF.meter('battery', { batteryW: 1500, limits }), { pct: 0.5, color: 'var(--icon-blue)' },
    'charging (positive) uses batteryChargePeakW',
  );
  assert.deepEqual(
    PF.meter('battery', { batteryW: -1300, limits }), { pct: 0.5, color: 'var(--icon-blue)' },
    'discharging (negative) uses batteryDischargePeakW',
  );
  assert.equal(
    PF.meter('battery', { batteryW: -1300, limits: { ...limits, batteryDischargePeakW: 0 } }), null,
    'hidden when the relevant peak is 0, even if the other direction has one configured',
  );
});

test('meter: grid turns red within 5% of gridMaxW, icon-blue below, hidden when cap disabled', () => {
  const limits = {
    chargerMaxW: 7360, gridMaxW: 14000, batteryChargePeakW: 3000, batteryDischargePeakW: 2600, solarPeakW: 6000,
  };
  assert.deepEqual(PF.meter('grid', { gridW: 1400, limits }), { pct: 0.1, color: 'var(--icon-blue)' });
  assert.deepEqual(PF.meter('grid', { gridW: -13300, limits }), { pct: 0.95, color: 'var(--homey-text-color-danger)' }, 'exactly at threshold');
  assert.deepEqual(PF.meter('grid', { gridW: 13000, limits }), { pct: 13000 / 14000, color: 'var(--icon-blue)' });
  assert.equal(PF.meter('grid', { gridW: 1000, limits: { ...limits, gridMaxW: 0 } }), null);
});

test('meter: pct clamps at 1 when current exceeds the configured peak', () => {
  const limits = {
    chargerMaxW: 7360, gridMaxW: 14000, batteryChargePeakW: 3000, batteryDischargePeakW: 2600, solarPeakW: 6000,
  };
  assert.deepEqual(PF.meter('solar', { solarW: 9000, limits }), { pct: 1, color: 'var(--homey-color-green)' });
  assert.deepEqual(PF.meter('grid', { gridW: 20000, limits }), { pct: 1, color: 'var(--homey-text-color-danger)' });
});

test('meter: null/missing state and unknown kind both yield null', () => {
  assert.equal(PF.meter('ev', undefined), null);
  assert.equal(PF.meter('solar', {}), null, 'no limits object at all');
  assert.equal(PF.meter('house', { limits: { gridMaxW: 14000 } }), null, 'house is never metered');
});

test('meter: a missing/zero reading is a real 0% fill, not treated as absent', () => {
  const limits = {
    chargerMaxW: 7360, gridMaxW: 14000, batteryChargePeakW: 3000, batteryDischargePeakW: 2600, solarPeakW: 6000,
  };
  assert.deepEqual(PF.meter('ev', { charger: { available: true }, limits }), { pct: 0, color: 'var(--homey-color-green)' });
  assert.deepEqual(PF.meter('solar', { limits }), { pct: 0, color: 'var(--homey-color-green)' });
  assert.deepEqual(PF.meter('grid', { limits }), { pct: 0, color: 'var(--icon-blue)' });
  assert.deepEqual(
    PF.meter('battery', { limits }), { pct: 0, color: 'var(--icon-blue)' },
    'batteryW defaults to 0, which is >=0 so it reads against the charge peak',
  );
});

test('meter: pct never goes negative even for an out-of-range negative reading', () => {
  const limits = {
    chargerMaxW: 7360, gridMaxW: 14000, batteryChargePeakW: 3000, batteryDischargePeakW: 2600, solarPeakW: 6000,
  };
  assert.deepEqual(PF.meter('solar', { solarW: -500, limits }), { pct: 0, color: 'var(--homey-color-green)' });
});

test('connSpeed: solar+grid each producing 1kW into a 2kW house each run slower than the house, by POWER\'s ratio', () => {
  const s = { solarW: 1000, gridW: 1000, houseW: 2000 };
  const houseSpeed = PF.connSpeed('house', s) as number;
  const solarSpeed = PF.connSpeed('solar', s) as number;
  const gridSpeed = PF.connSpeed('grid', s) as number;
  // FAST_S / share^POWER, with POWER derived from FAST_S/SLOW_S/MIN_RATE (not a
  // directly-set 50%-share duration - see the comment on connSpeed()), so the ratio at
  // share 0.5 is a golden value tied to the current tuning (recompute if FAST_S/SLOW_S/
  // MIN_RATE change), not a clean hand-picked multiplier like the old 2x/3x/4x versions.
  const expectedRatio = 2.1128366700967725;
  assert.ok(Math.abs(solarSpeed / houseSpeed - expectedRatio) < 1e-9);
  assert.ok(Math.abs(gridSpeed / houseSpeed - expectedRatio) < 1e-9);
});

test('connSpeed: the busiest connector on the diagram always animates at FAST_S (0.25s)', () => {
  assert.equal(PF.connSpeed('house', { houseW: 4000, solarW: 4000, gridW: 500 }), 0.25);
  // Ties: more than one connector can simultaneously be "the" max.
  assert.equal(PF.connSpeed('solar', { houseW: 4000, solarW: 4000, gridW: 500 }), 0.25);
});

test('connSpeed: the share floor caps the crawl - a connector far below the busiest one animates at the same bounded duration', () => {
  const s = { houseW: 10000, gridW: 10 };
  // 10/10000 = 0.1%, well under MIN_RATE (10%, a direct literal now - see the comment on
  // connSpeed()) - clamped to the same floor duration (SLOW_S = 3s) rather than crawling
  // ever slower toward zero.
  assert.equal(PF.connSpeed('grid', s), 3.0);
  assert.equal(PF.connSpeed('grid', { houseW: 10000, gridW: 1 }), 3.0);
});

test('connSpeed: scales monotonically - duration shrinks (speed rises) as a connector\'s share of the busiest flow rises', () => {
  // Only one point (5%) below MIN_RATE (10%) - two floored points would tie instead of
  // strictly decreasing, which is what this test is asserting.
  const durations = [5, 25, 50, 75, 90, 100].map(
    (pct) => PF.connSpeed('grid', { houseW: 10000, gridW: pct * 100 }) as number,
  );
  for (let i = 1; i < durations.length; i += 1) {
    assert.ok(durations[i] < durations[i - 1], `duration must strictly decrease as share rises: ${durations}`);
  }
});

test('connSpeed: with nothing flowing, computes a defined (if unused) duration rather than dividing by zero', () => {
  assert.equal(PF.connSpeed('house', {}), 3.0);
});

test('meterHtml: renders "" for a null (hidden) meter', () => {
  assert.equal(PF.meterHtml(null, 'top'), '');
});

test('meterHtml: exactly 0% renders a real 0px fill - genuinely empty, not a floored sliver', () => {
  const html = PF.meterHtml({ pct: 0, color: 'var(--homey-color-blue-600)' }, 'top') as string;
  assert.match(html, /class="meter top"/);
  assert.match(html, /width:0px/);
});

test('meterHtml: exactly 100% renders the tile\'s full 48px width, flush into the corner', () => {
  const html = PF.meterHtml({ pct: 1, color: '#ef4444' }, 'top') as string;
  assert.match(html, /width:48px/);
});

test('meterHtml: a low nonzero reading is rescaled up to a visible floor, without overstating it', () => {
  // Regression: confirmed on real hardware that a ~6.3% grid reading (900W / 14200W)
  // rendered as fully invisible - .tile's overflow:hidden clips the meter strip to its
  // corner radius, and a fill under the corner's own dead-zone threshold is entirely
  // swallowed by that curve at every row of the strip, not just thinned out. EDGE_PX is
  // deliberately just past that geometric threshold (not a much bigger round number), so a
  // low reading is visible without inflating it toward a disproportionately large bar.
  const html = PF.meterHtml({ pct: 900 / 14200, color: 'var(--homey-color-blue-600)' }, 'top') as string;
  // EDGE_PX(5) + pct*(48-2*EDGE_PX) = 5 + 0.0634*38 = 7.41 -> rounds to 7px.
  assert.match(html, /width:7px/);
});

test('meterHtml: a high-but-not-full reading is rescaled down, staying visibly short of 100%', () => {
  // Regression: confirmed on real hardware that both 92% and 96% readings were visually
  // indistinguishable from a full 100% fill, because all three extended past the same
  // corner-clip boundary.
  const html92 = PF.meterHtml({ pct: 0.92, color: '#ef4444' }, 'top') as string;
  // 5 + 0.92*38 = 39.96 -> 40px, clearly short of the true 48px full width.
  assert.match(html92, /width:40px/);

  const html96 = PF.meterHtml({ pct: 0.96, color: '#ef4444' }, 'top') as string;
  // 5 + 0.96*38 = 41.48 -> 41px - distinct from both 92% (40px) and 100% (48px), not
  // collapsed into the same rendered width as either.
  assert.match(html96, /width:41px/);
});

test('meterHtml: the rescale is monotonic and reaches both true endpoints only at 0 and 1', () => {
  const widths = [0, 0.063, 0.5, 0.92, 0.96, 1].map((pct) => {
    const html = PF.meterHtml({ pct, color: 'var(--homey-color-blue-600)' }, 'top') as string;
    return Number(/width:(\d+)px/.exec(html)![1]);
  });
  for (let i = 1; i < widths.length; i += 1) {
    assert.ok(widths[i] > widths[i - 1], `width must strictly increase: ${widths}`);
  }
  assert.equal(widths[0], 0);
  assert.equal(widths[widths.length - 1], 48);
});

test('meterHtml: edge class selects which tile side the strip bleeds to', () => {
  assert.match(PF.meterHtml({ pct: 0.5, color: 'var(--homey-color-green)' }, 'bottom') as string, /class="meter bottom"/);
  assert.match(PF.meterHtml({ pct: 0.5, color: 'var(--homey-color-green)' }, 'top') as string, /class="meter top"/);
});

// ---------------------------------------------------------------------------
// OCPP offline reporting
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-07-26T12:00:00Z');
const offlineState = (hoursAgo: number) => ({
  charger: {
    available: true,
    online: false,
    chargingState: 'plugged_in',
    limitA: 16,
    powerW: 7200,
    offlineSince: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
  },
});

test('isOffline only reports an outage on an explicit false, never on an unresolved link', () => {
  assert.equal(PF.isOffline({ charger: { available: true, online: false } }), true);
  assert.equal(PF.isOffline({ charger: { available: true, online: true } }), false);
  assert.equal(
    PF.isOffline({ charger: { available: true, online: null } }), false,
    'null is the app\'s startup grace window - not yet known, so not an outage',
  );
  assert.equal(
    PF.isOffline({ charger: { available: true } }), false,
    'an older state payload with no online field must not suddenly read as offline',
  );
  assert.equal(PF.isOffline({ charger: { available: false, online: false } }), false);
  assert.equal(PF.isOffline({}), false);
});

test('fmtAge renders a compact duration, matching fmtDuration() in ChargeController', () => {
  assert.equal(PF.fmtAge(45_000), '45s');
  assert.equal(PF.fmtAge(12 * 60_000), '12m');
  assert.equal(PF.fmtAge(12 * 3_600_000), '12h');
  assert.equal(PF.fmtAge(5 * 86_400_000), '5d');
  assert.equal(PF.fmtAge(null), '');
});

test('offlineForMs measures from offlineSince, and is null whenever there is nothing to measure', () => {
  assert.equal(PF.offlineForMs(offlineState(12), NOW), 12 * 3_600_000);
  assert.equal(PF.offlineForMs({ charger: { available: true, online: true, offlineSince: null } }, NOW), null);
  assert.equal(
    PF.offlineForMs({ charger: { available: true, online: false } }, NOW), null,
    'offline but never seen - the chip still says OFFLINE, just without an age',
  );
  assert.equal(PF.offlineForMs({ charger: { available: true, online: false, offlineSince: 'nonsense' } }, NOW), null);
});

test('evChip reports OFFLINE with the outage age, outranking any cached charging state', () => {
  // The exact bug this exists for: a charger dark for 12 hours whose last
  // StatusNotification said plugged_in, which rendered as READY indefinitely.
  assert.deepEqual(PF.evChip(offlineState(12), NOW), { label: 'OFFLINE 12h', cls: 'offline' });
  // Even a cached *charging* state loses to the link being down.
  assert.deepEqual(
    PF.evChip({ charger: { ...offlineState(2).charger, chargingState: 'plugged_in_charging' } }, NOW),
    { label: 'OFFLINE 2h', cls: 'offline' },
  );
  assert.deepEqual(
    PF.evChip({ charger: { available: true, online: false, chargingState: 'plugged_in' } }, NOW),
    { label: 'OFFLINE', cls: 'offline' },
    'no last-contact time to show, but still honestly labelled offline',
  );
  assert.deepEqual(
    PF.evChip({ charger: { available: true, online: true, chargingState: 'plugged_in' } }, NOW),
    { label: 'READY', cls: 'ready' },
    'an online charger is unaffected',
  );
});

test('an offline charger reports unknown EV power and no commanded amps, not the last reading before it vanished', () => {
  assert.deepEqual(PF.flow('ev', offlineState(12)), { mag: null, dir: null });
  assert.equal(PF.fmtW((PF.flow('ev', offlineState(12)) as { mag: number | null }).mag), '–');
  assert.equal(PF.chargeAmps({ charger: { ...offlineState(12).charger, chargingState: 'plugged_in_charging' } }), 0);
  // Unchanged while the link is up.
  assert.deepEqual(
    PF.flow('ev', { charger: { available: true, online: true, powerW: 7200 } }),
    { mag: 7200, dir: 'up' },
  );
});

// ---------------------------------------------------------------------------
// A stale solar feed must not be drawn as the live state of the house
// ---------------------------------------------------------------------------

const STALE_STATE = {
  solarW: 4440,
  houseW: 1200,
  gridW: -3000,
  batteryW: 800,
  batterySoc: 64,
  solarStale: true,
  solarAgeMs: 3 * 24 * 3600_000,
  limits: {
    chargerMaxW: 7360, gridMaxW: 14490, batteryChargePeakW: 3300, batteryDischargePeakW: 3300, solarPeakW: 5720,
  },
  charger: {
    available: true, online: true, powerW: 2691, chargingState: 'plugged_in_charging', limitA: 12,
  },
};

test('isSolarStale: only an explicit true counts, so an older payload never reads as stale', () => {
  assert.equal(PF.isSolarStale({ solarStale: true }), true);
  assert.equal(PF.isSolarStale({ solarStale: false }), false);
  assert.equal(PF.isSolarStale({}), false, 'a state payload predating the field is not an outage');
  assert.equal(PF.isSolarStale(null), false);
});

test('a stale solar feed renders every feed-derived figure as unknown, not as the last one seen', () => {
  // A three-day-old reading must not be drawn as the live state of the house.
  for (const kind of ['solar', 'house', 'battery', 'grid']) {
    assert.deepEqual(PF.flow(kind, STALE_STATE), { mag: null, dir: null }, `${kind} is unknown while stale`);
    assert.equal(PF.fmtW((PF.flow(kind, STALE_STATE) as { mag: number | null }).mag), '–',
      `${kind} renders as a dash`);
    assert.equal(PF.meter(kind, STALE_STATE), null, `${kind}'s capacity strip is hidden rather than frozen`);
  }
  // The charger's own readings come from its MeterValues, not the solar feed.
  assert.deepEqual(PF.flow('ev', STALE_STATE), { mag: 2691, dir: 'up' }, 'EV is unaffected by a stale solar feed');
  assert.notEqual(PF.meter('ev', STALE_STATE), null, "and so is the EV tile's own capacity strip");

  assert.equal(PF.busState(STALE_STATE.gridW, STALE_STATE), 'neutral',
    'the bus stops claiming an export it can no longer see');
  assert.equal(PF.busState(-3000), 'export', 'the bare-gridW form is unchanged');
  assert.equal(PF.batterySoc(STALE_STATE), null, 'the battery gauge falls back to no-data');
  assert.equal(PF.batterySoc({ batterySoc: 64 }), 64, 'and is untouched on a healthy feed');
});

test('a healthy feed is rendered exactly as before the staleness gate existed', () => {
  const live = { ...STALE_STATE, solarStale: false, solarAgeMs: 4000 };
  assert.deepEqual(PF.flow('solar', live), { mag: 4440, dir: 'down' });
  assert.deepEqual(PF.flow('grid', live), { mag: 3000, dir: 'down' });
  assert.equal(PF.busState(live.gridW, live), 'export');
  assert.equal(PF.batterySoc(live), 64);
  assert.notEqual(PF.meter('solar', live), null);
});

// ---------------------------------------------------------------------------
// The charging chip shows what the charger accepted, not just the decision
// ---------------------------------------------------------------------------

test('chipAmps: a limit the charger has not accepted reads as pending, never as the charging figure', () => {
  const charging = (extra: Record<string, unknown>) => ({
    charger: {
      available: true, online: true, chargingState: 'plugged_in_charging', limitA: 32, ...extra,
    },
  });
  // The field report: chip read a confident "32A" while the car drew ~22A.
  assert.deepEqual(PF.chipAmps(charging({ appliedA: 22 })), { text: '22A→32A', pending: true });
  assert.deepEqual(PF.chipAmps(charging({ appliedA: null })), { text: '32A', pending: true },
    'not yet known (reconnect, new session) is pending too');
  assert.deepEqual(PF.chipAmps(charging({ appliedA: 32 })), { text: '32A', pending: false });
  assert.deepEqual(PF.chipAmps(charging({})), { text: '32A', pending: false },
    'an older payload with no appliedA field renders exactly as before');
  assert.deepEqual(PF.chipAmps(charging({ appliedA: 22, chargingState: 'plugged_in' })), { text: '', pending: false },
    'nothing to say when not charging');
  assert.deepEqual(PF.chipAmps(charging({ appliedA: 22, online: false })), { text: '', pending: false },
    'or when the charger is offline');
});
