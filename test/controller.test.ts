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

function makeController(schedule: ScheduleWindow[]): ChargeController {
  const store: Record<string, unknown> = { schedule, mode: 'off' };
  const settings: Record<string, unknown> = { minAmps: 6, maxAmps: 31, phases: 1, voltage: 230 };
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => { /* noop */ },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => { store[k] = v; },
    setAvailable: () => {}, setUnavailable: () => {}, setWarning: () => {},
    log: () => {}, error: () => {},
  };
  // Fake CentralSystem: no charge point present.
  const cs = { getChargePoint: () => undefined, on: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  return c;
}

test('scheduled mode charges only within a window', async () => {
  const c = makeController(SCHED);
  await c.setMode('scheduled');
  assert.deepEqual(c.resolve(at(1, 10, 0)), { charge: true, amps: 20 });
  assert.equal(c.resolve(at(1, 20, 0)).charge, false);
});

test('schedule beats solar; solar follows outside a window', async () => {
  const c = makeController(SCHED);
  await c.setMode('solar');
  c.setSolarTarget(10);
  assert.deepEqual(c.resolve(at(1, 10, 0)), { charge: true, amps: 20 }, 'schedule wins');
  assert.deepEqual(c.resolve(at(1, 20, 0)), { charge: true, amps: 10 }, 'solar follows');
  c.setSolarTarget(null);
  assert.equal(c.resolve(at(1, 20, 0)).charge, false, 'no solar target -> idle');
});

test('manual override starts when mode is off, cleared by mode change', async () => {
  const c = makeController([]); // no schedule -> override persists
  await c.setMode('off');
  await c.startManual(16);
  assert.deepEqual(c.resolve(new Date()), { charge: true, amps: 16 });
  await c.setMode('off');
  assert.equal(c.resolve(new Date()).charge, false, 'mode change clears override');
});

test('manual stop overrides an active schedule window', async () => {
  const c = makeController(SCHED);
  await c.setMode('scheduled');
  await c.stop();
  assert.equal(c.resolve(new Date()).charge, false);
});
