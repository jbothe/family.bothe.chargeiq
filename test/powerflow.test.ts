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
