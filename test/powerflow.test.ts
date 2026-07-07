'use strict';

import test from 'node:test';
import assert from 'node:assert';

// Shared widget presentation logic (plain JS, loaded from the widget public dir).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PF = require('../../widgets/power-flow/public/flow.js');

test('fmtW formats W / kW', () => {
  assert.equal(PF.fmtW(0), '0 W');
  assert.equal(PF.fmtW(850), '850 W');
  assert.equal(PF.fmtW(2300), '2.3 kW');
  assert.equal(PF.fmtW(14000), '14 kW');
  assert.equal(PF.fmtW(null), '–');
});

test('flow direction: solar produces (up), house consumes (down)', () => {
  assert.deepEqual(PF.flow('solar', { solarW: 4200 }), { mag: 4200, dir: 'up' });
  assert.deepEqual(PF.flow('solar', { solarW: 0 }), { mag: 0, dir: null });
  assert.deepEqual(PF.flow('house', { houseW: 1500 }), { mag: 1500, dir: 'down' });
});

test('flow direction: battery charge=down / discharge=up', () => {
  assert.deepEqual(PF.flow('battery', { batteryW: 600 }), { mag: 600, dir: 'down' }); // charging
  assert.deepEqual(PF.flow('battery', { batteryW: -600 }), { mag: 600, dir: 'up' }); // discharging
  assert.deepEqual(PF.flow('battery', { batteryW: 0 }), { mag: 0, dir: null });
});

test('flow direction: grid import=up / export=down', () => {
  assert.deepEqual(PF.flow('grid', { gridW: 1200 }), { mag: 1200, dir: 'up' }); // importing
  assert.deepEqual(PF.flow('grid', { gridW: -2100 }), { mag: 2100, dir: 'down' }); // exporting
});

test('bus bar: importing when net grid positive', () => {
  assert.equal(PF.busImporting({ gridW: 1200 }), true);
  assert.equal(PF.busImporting({ gridW: -2100 }), false);
  assert.equal(PF.busImporting({ gridW: 0 }), false);
});

test('battery SoC label', () => {
  assert.equal(PF.socLabel({ batterySoc: 82 }), '82%');
  assert.equal(PF.socLabel({ batterySoc: 0 }), '0%');
  assert.equal(PF.socLabel({ batterySoc: null }), '');
  assert.equal(PF.socLabel({}), '');
});

test('charger status label maps OCPP states and appends mode', () => {
  assert.equal(PF.statusLabel({ available: true, status: 'Charging', mode: 'solar' }), 'Charging · Solar');
  assert.equal(PF.statusLabel({ available: true, status: 'Available', mode: 'off' }), 'Unplugged · Off');
  assert.equal(PF.statusLabel({ available: false }), 'No charger paired');
});
