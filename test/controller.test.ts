'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { ChargeController, ControllerHost } from '../lib/control/ChargeController';
import { CentralSystem } from '../lib/ocpp/CentralSystem';
import { ScheduleWindow } from '../lib/control/Scheduler';

function at(day: number, hh: number, mm: number): Date {
  const d = new Date(2024, 0, 7);
  d.setDate(d.getDate() + day);
  d.setHours(hh, mm, 0, 0);
  return d;
}

const SCHED: ScheduleWindow[] = [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', currentA: 20 }];

function makeController(schedule: ScheduleWindow[]): {
  c: ChargeController; caps: Record<string, unknown>; logs: string[];
} {
  const store: Record<string, unknown> = { schedule, mode: 'off' };
  const settings: Record<string, unknown> = { minAmps: 6, maxAmps: 31, phases: 1, voltage: 230, maxHouseholdW: 14000 };
  const caps: Record<string, unknown> = {};
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => { caps[k] = v; },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => { store[k] = v; },
    setAvailable: () => {}, setUnavailable: () => {}, setWarning: () => {},
    log: (...a) => { logs.push(a.join(' ')); }, error: () => {},
  };
  // Fake CentralSystem: no charge point present.
  const cs = { getChargePoint: () => undefined, on: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  return { c, caps, logs };
}

test('scheduled mode charges only within a window', async () => {
  const { c } = makeController(SCHED);
  await c.setMode('scheduled');
  assert.deepEqual(c.resolve(at(1, 10, 0)), { charge: true, amps: 20 });
  assert.equal(c.resolve(at(1, 20, 0)).charge, false);
});

test('schedule beats solar; solar follows outside a window', async () => {
  const { c } = makeController(SCHED);
  await c.setMode('solar');
  c.setSolarTarget(10);
  assert.deepEqual(c.resolve(at(1, 10, 0)), { charge: true, amps: 20 }, 'schedule wins');
  assert.deepEqual(c.resolve(at(1, 20, 0)), { charge: true, amps: 10 }, 'solar follows');
  c.setSolarTarget(null);
  assert.equal(c.resolve(at(1, 20, 0)).charge, false, 'no solar target -> idle');
});

test('manual override starts when mode is off, cleared by mode change', async () => {
  const { c } = makeController([]); // no schedule -> override persists
  await c.setMode('off');
  await c.startManual(16);
  assert.deepEqual(c.resolve(new Date()), { charge: true, amps: 16 });
  await c.setMode('off');
  assert.equal(c.resolve(new Date()).charge, false, 'mode change clears override');
});

test('manual stop overrides an active schedule window', async () => {
  const { c } = makeController(SCHED);
  await c.setMode('scheduled');
  await c.stop();
  assert.equal(c.resolve(new Date()).charge, false);
});

test('household grid cap throttles the charger in any mode', async () => {
  const { c, caps } = makeController([]);
  await c.startManual(31); // manual request for full 31A

  // High non-charger grid load: 11,700W import. Cap = (14000-11700)/230 = 10A.
  c.onSolarSample(11700, Date.now());
  assert.equal(caps.charge_current_limit, 10, 'capped to 10A under household ceiling');

  // Plenty of headroom (exporting): cap no longer constrains -> full 31A.
  c.onSolarSample(-2000, Date.now());
  assert.equal(caps.charge_current_limit, 31, 'uncapped when grid has headroom');
  // Excess solar surfaced as a metric (2000W export, not charging -> 2000W surplus).
  assert.equal(caps.measure_solar_surplus, 2000, 'excess solar metric set');
});

test('household cap pauses charging when even the minimum would breach the limit', async () => {
  const { c, logs } = makeController([]);
  await c.startManual(16);
  // Non-charger load 13,900W: max charger = 100W -> below 6A minimum -> pause.
  c.onSolarSample(13900, Date.now());
  assert.ok(logs.some((l) => l.includes('[cap]') && l.includes('paused')),
    'logs a household-cap pause');
});
