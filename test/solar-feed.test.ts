'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { mergeSample } from '../lib/solar/SolarFeed';

test('derives house load: pv + gridSigned - batterySigned', () => {
  // Exporting 2.1kW, PV 4.2kW, battery charging 0.6kW -> house = 4200 + (-2100) - 600 = 1500
  const s = mergeSample({ inverter: 4200, meter: -2100, battery: 600 }, true, 82);
  assert.equal(s.pvW, 4200);
  assert.equal(s.gridSignedW, -2100);
  assert.equal(s.batteryW, 600);
  assert.equal(s.houseW, 1500);
});

test('house load with grid import and battery discharge', () => {
  // Importing 1.2kW, no PV, battery discharging 0.8kW -> house = 0 + 1200 - (-800) = 2000
  const s = mergeSample({ inverter: 0, meter: 1200, battery: -800 }, true, 40);
  assert.equal(s.houseW, 2000);
});

test('battery SoC reported only when a battery is present', () => {
  assert.equal(mergeSample({ inverter: 0, meter: 0, battery: 0 }, true, 55).batterySoc, 55);
  assert.equal(mergeSample({ inverter: 0, meter: 0, battery: 0 }, false, 55).batterySoc, null);
  assert.equal(mergeSample({ inverter: 0, meter: 0, battery: 0 }, true, null).batterySoc, null);
});
