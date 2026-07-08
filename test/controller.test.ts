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
  c: ChargeController; caps: Record<string, unknown>; store: Record<string, unknown>; logs: string[];
} {
  const store: Record<string, unknown> = { schedule };
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
  const cs = { getChargePoint: () => undefined, on: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  return { c, caps, store, logs };
}

test('default outside a schedule is Solar; follows excess', () => {
  const { c } = makeController([]);
  c.setSolarTarget(10);
  assert.deepEqual(c.resolve(at(0, 12, 0)), { mode: 'solar', charge: true, amps: 10 });
  c.setSolarTarget(null);
  assert.deepEqual(c.resolve(at(0, 12, 0)), { mode: 'solar', charge: false });
});

test('inside a schedule (no manual) is Scheduled; schedule beats solar', () => {
  const { c } = makeController(SCHED);
  c.setSolarTarget(10);
  assert.deepEqual(c.resolve(at(1, 10, 0)), { mode: 'scheduled', charge: true, amps: 20 });
  assert.equal(c.resolve(at(1, 20, 0)).mode, 'solar', 'outside window -> solar');
});

test('manual start latches Manual until cleared; overrides schedule', async () => {
  const { c } = makeController(SCHED);
  await c.startManual(16);
  assert.deepEqual(c.resolve(at(1, 10, 0)), { mode: 'manual', charge: true, amps: 16 });
  assert.deepEqual(c.resolve(at(1, 20, 0)), { mode: 'manual', charge: true, amps: 16 });
});

test('manual stop cancels an active schedule (Manual, not charging)', async () => {
  const { c } = makeController(SCHED);
  await c.stop();
  assert.deepEqual(c.resolve(at(1, 10, 0)), { mode: 'manual', charge: false });
});

test('moving the current slider switches to Manual at that current', async () => {
  const { c } = makeController([]);
  c.setSolarTarget(12); // solar would charge at 12A
  await c.setCurrentLimit(8);
  assert.deepEqual(c.resolve(at(0, 12, 0)), { mode: 'manual', charge: true, amps: 8 });
});

test('a schedule window starting clears the manual latch', async () => {
  const { c } = makeController(SCHED);
  await c.stop();                    // manual-off outside a window
  c.tick(at(1, 8, 59));              // just before window
  assert.equal(c.getMode(), 'manual');
  c.tick(at(1, 9, 0));               // window starts -> clears latch
  assert.equal(c.resolve(at(1, 9, 0)).mode, 'scheduled');
});

test('manual latch persists across restart (restored from store)', async () => {
  const { c, store } = makeController([]);
  await c.startManual(16);
  assert.ok(store.manualLatch, 'latch persisted');
  // New controller instance with the same store -> latch restored.
  const caps2: Record<string, unknown> = {};
  const host2: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => { caps2[k] = v; },
    getSetting: () => undefined,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => { store[k] = v; },
    setAvailable: () => {}, setUnavailable: () => {}, setWarning: () => {},
    log: () => {}, error: () => {},
  };
  const cs = { getChargePoint: () => undefined, on: () => {} } as unknown as CentralSystem;
  const c2 = new ChargeController(host2, cs);
  c2.init();
  assert.equal(c2.resolve(new Date()).mode, 'manual');
});

test('household grid cap throttles the charger in any mode', async () => {
  const { c, caps } = makeController([]);
  await c.startManual(31);
  c.onSolarSample({ gridSignedW: 11700 }, Date.now());
  assert.equal(caps.charge_current_limit, 10, 'capped to 10A under household ceiling');
  c.onSolarSample({ gridSignedW: -2000 }, Date.now());
  assert.equal(caps.charge_current_limit, 31, 'uncapped when grid has headroom');
  assert.equal(caps.measure_solar_surplus, 2000, 'excess solar metric set');
});

test('excess floored at 0 and logged with all components', () => {
  const { c, caps, logs } = makeController([]);
  c.onSolarSample({ gridSignedW: 40, pvW: 100, batteryW: -50, houseW: 190 }, Date.now());
  assert.equal(caps.measure_solar_surplus, 0, 'excess floored at 0');
  const line = logs.find((l) => l.includes('[solar]')) || '';
  assert.ok(line.includes('solar=100W') && line.includes('battery=-50W') && line.includes('excess=0W'));
});

test('mode metric + getModeInfo reflect the derived mode', () => {
  const { c, caps } = makeController(SCHED);
  c.tick(at(1, 10, 0));
  assert.equal(caps.charge_mode, 'scheduled');
  assert.equal(c.getModeInfo().mode, 'scheduled');
});
