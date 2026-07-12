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

test('fmtW formats W / kW, always stripping a trailing .0', () => {
  assert.equal(PF.fmtW(0), '0 W');
  assert.equal(PF.fmtW(850), '850 W');
  assert.equal(PF.fmtW(2300), '2.3 kW');
  assert.equal(PF.fmtW(14000), '14 kW');
  assert.equal(PF.fmtW(13800), '13.8 kW');
  assert.equal(PF.fmtW(null), '–');
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
  assert.deepEqual(PF.batteryVisual(5), { color: '#ef4444', fillHeight: 2, fillY: 17 });
  assert.deepEqual(PF.batteryVisual(20), { color: '#f59e0b', fillHeight: 3.25, fillY: 15.75 });
  assert.deepEqual(PF.batteryVisual(50), { color: '#eab308', fillHeight: 6.5, fillY: 12.5 });
  assert.deepEqual(PF.batteryVisual(75), { color: '#f59e0b', fillHeight: 9.75, fillY: 9.25 });
  assert.deepEqual(PF.batteryVisual(100), { color: '#22c55e', fillHeight: 13, fillY: 6 });
  assert.deepEqual(PF.batteryVisual(null), { color: '#9aa1ad', fillHeight: 2, fillY: 17 });
});

test('evChip: label + style class from evcharger_charging_state, null when no charger paired', () => {
  assert.deepEqual(
    PF.evChip({ charger: { available: true, chargingState: 'plugged_in_charging' } }),
    { cls: 'charging' },
    'charging carries no label - render() fills it with a bolt icon + live amps instead',
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
    { pct: 0.5, color: 'var(--green)' },
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
  assert.deepEqual(PF.meter('solar', { solarW: 3000, limits }), { pct: 0.5, color: 'var(--green)' });
  assert.equal(PF.meter('solar', { solarW: 3000, limits: { ...limits, solarPeakW: 0 } }), null);
});

test('meter: battery picks charge peak when charging, discharge peak when discharging', () => {
  const limits = {
    chargerMaxW: 7360, gridMaxW: 14000, batteryChargePeakW: 3000, batteryDischargePeakW: 2600, solarPeakW: 6000,
  };
  assert.deepEqual(
    PF.meter('battery', { batteryW: 1500, limits }), { pct: 0.5, color: 'var(--purple)' },
    'charging (positive) uses batteryChargePeakW',
  );
  assert.deepEqual(
    PF.meter('battery', { batteryW: -1300, limits }), { pct: 0.5, color: 'var(--purple)' },
    'discharging (negative) uses batteryDischargePeakW',
  );
  assert.equal(
    PF.meter('battery', { batteryW: -1300, limits: { ...limits, batteryDischargePeakW: 0 } }), null,
    'hidden when the relevant peak is 0, even if the other direction has one configured',
  );
});

test('meter: grid turns red within 5% of gridMaxW, purple below, hidden when cap disabled', () => {
  const limits = {
    chargerMaxW: 7360, gridMaxW: 14000, batteryChargePeakW: 3000, batteryDischargePeakW: 2600, solarPeakW: 6000,
  };
  assert.deepEqual(PF.meter('grid', { gridW: 1400, limits }), { pct: 0.1, color: 'var(--purple)' });
  assert.deepEqual(PF.meter('grid', { gridW: -13300, limits }), { pct: 0.95, color: '#ef4444' }, 'exactly at threshold');
  assert.deepEqual(PF.meter('grid', { gridW: 13000, limits }), { pct: 13000 / 14000, color: 'var(--purple)' });
  assert.equal(PF.meter('grid', { gridW: 1000, limits: { ...limits, gridMaxW: 0 } }), null);
});

test('meter: pct clamps at 1 when current exceeds the configured peak', () => {
  const limits = {
    chargerMaxW: 7360, gridMaxW: 14000, batteryChargePeakW: 3000, batteryDischargePeakW: 2600, solarPeakW: 6000,
  };
  assert.deepEqual(PF.meter('solar', { solarW: 9000, limits }), { pct: 1, color: 'var(--green)' });
  assert.deepEqual(PF.meter('grid', { gridW: 20000, limits }), { pct: 1, color: '#ef4444' });
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
  assert.deepEqual(PF.meter('ev', { charger: { available: true }, limits }), { pct: 0, color: 'var(--green)' });
  assert.deepEqual(PF.meter('solar', { limits }), { pct: 0, color: 'var(--green)' });
  assert.deepEqual(PF.meter('grid', { limits }), { pct: 0, color: 'var(--purple)' });
  assert.deepEqual(
    PF.meter('battery', { limits }), { pct: 0, color: 'var(--purple)' },
    'batteryW defaults to 0, which is >=0 so it reads against the charge peak',
  );
});

test('meter: pct never goes negative even for an out-of-range negative reading', () => {
  const limits = {
    chargerMaxW: 7360, gridMaxW: 14000, batteryChargePeakW: 3000, batteryDischargePeakW: 2600, solarPeakW: 6000,
  };
  assert.deepEqual(PF.meter('solar', { solarW: -500, limits }), { pct: 0, color: 'var(--green)' });
});

test('meterHtml: renders "" for a null (hidden) meter', () => {
  assert.equal(PF.meterHtml(null, 'top'), '');
});

test('meterHtml: exactly 0% renders a real 0px fill - genuinely empty, not a floored sliver', () => {
  const html = PF.meterHtml({ pct: 0, color: 'var(--purple)' }, 'top') as string;
  assert.match(html, /class="meter top"/);
  assert.match(html, /width:0px/);
});

test('meterHtml: exactly 100% renders the tile\'s full 44px width, flush into the corner', () => {
  const html = PF.meterHtml({ pct: 1, color: '#ef4444' }, 'top') as string;
  assert.match(html, /width:44px/);
});

test('meterHtml: a low nonzero reading is rescaled up to a visible floor', () => {
  // Regression: confirmed on real hardware that a ~6.3% grid reading (900W / 14200W)
  // rendered as fully invisible - .tile's overflow:hidden clips the meter strip to its
  // corner radius, and a fill under the corner's own dead-zone threshold is entirely
  // swallowed by that curve at every row of the strip, not just thinned out.
  const html = PF.meterHtml({ pct: 900 / 14200, color: 'var(--purple)' }, 'top') as string;
  // EDGE_PX(8) + pct*(44-2*EDGE_PX) = 8 + 0.0634*28 = 9.77 -> rounds to 10px.
  assert.match(html, /width:10px/);
});

test('meterHtml: a high-but-not-full reading is rescaled down, staying visibly short of 100%', () => {
  // Regression: confirmed on real hardware that both 92% and 96% readings were visually
  // indistinguishable from a full 100% fill, because all three extended past the same
  // corner-clip boundary - a bigger EDGE_PX widens the margin so the gap before 100% reads
  // as unmistakable, not just technically present.
  const html92 = PF.meterHtml({ pct: 0.92, color: '#ef4444' }, 'top') as string;
  // 8 + 0.92*28 = 33.76 -> 34px, clearly short of the true 44px full width.
  assert.match(html92, /width:34px/);

  const html96 = PF.meterHtml({ pct: 0.96, color: '#ef4444' }, 'top') as string;
  // 8 + 0.96*28 = 34.88 -> 35px - distinct from both 92% (34px) and 100% (44px), not
  // collapsed into the same rendered width as either.
  assert.match(html96, /width:35px/);
});

test('meterHtml: the rescale is monotonic and reaches both true endpoints only at 0 and 1', () => {
  const widths = [0, 0.063, 0.5, 0.92, 0.96, 1].map((pct) => {
    const html = PF.meterHtml({ pct, color: 'var(--purple)' }, 'top') as string;
    return Number(/width:(\d+)px/.exec(html)![1]);
  });
  for (let i = 1; i < widths.length; i += 1) {
    assert.ok(widths[i] > widths[i - 1], `width must strictly increase: ${widths}`);
  }
  assert.equal(widths[0], 0);
  assert.equal(widths[widths.length - 1], 44);
});

test('meterHtml: edge class selects which tile side the strip bleeds to', () => {
  assert.match(PF.meterHtml({ pct: 0.5, color: 'var(--green)' }, 'bottom') as string, /class="meter bottom"/);
  assert.match(PF.meterHtml({ pct: 0.5, color: 'var(--green)' }, 'top') as string, /class="meter top"/);
});
