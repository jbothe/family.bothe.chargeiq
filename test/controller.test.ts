'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { ChargeController, ControllerHost } from '../lib/control/ChargeController';
import { CentralSystem } from '../lib/ocpp/CentralSystem';
import { ChargePoint, RpcClient } from '../lib/ocpp/ChargePoint';
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
  assert.deepEqual(c.resolve(at(0, 12, 0)), { mode: 'solar', amps: 10 });
  c.setSolarTarget(null);
  assert.deepEqual(c.resolve(at(0, 12, 0)), { mode: 'solar', amps: 0 });
});

test('inside a schedule (no manual) is Scheduled; schedule beats solar', () => {
  const { c } = makeController(SCHED);
  c.setSolarTarget(10);
  assert.deepEqual(c.resolve(at(1, 10, 0)), { mode: 'scheduled', amps: 20 });
  assert.equal(c.resolve(at(1, 20, 0)).mode, 'solar', 'outside window -> solar');
});

test('manual start latches Manual until cleared; overrides schedule', async () => {
  const { c } = makeController(SCHED);
  await c.startManual(16);
  assert.deepEqual(c.resolve(at(1, 10, 0)), { mode: 'manual', amps: 16 });
  assert.deepEqual(c.resolve(at(1, 20, 0)), { mode: 'manual', amps: 16 });
});

test('manual stop cancels an active schedule (Manual, paused at 0A not a hard stop)', async () => {
  const { c } = makeController(SCHED);
  await c.stop();
  assert.deepEqual(c.resolve(at(1, 10, 0)), { mode: 'manual', amps: 0 });
});

test('a disabled schedule window is not applied', () => {
  const disabled: ScheduleWindow[] = [{ ...SCHED[0], enabled: false }];
  const { c } = makeController(disabled);
  c.setSolarTarget(10);
  assert.equal(c.resolve(at(1, 10, 0)).mode, 'solar', 'disabled window does not count as scheduled');
});

test('setSchedule rejects overlapping enabled windows', async () => {
  const { c } = makeController([]);
  const overlapping: ScheduleWindow[] = [
    { days: [1], start: '09:00', end: '17:00' },
    { days: [1], start: '16:00', end: '20:00' },
  ];
  await assert.rejects(() => c.setSchedule(overlapping), /overlap/i);
  assert.deepEqual(c.getSchedule(), [], 'rejected schedule must not be applied');
});

test('setSchedule allows overlapping windows when one is disabled', async () => {
  const { c, store } = makeController([]);
  const windows: ScheduleWindow[] = [
    { days: [1], start: '09:00', end: '17:00' },
    { days: [1], start: '16:00', end: '20:00', enabled: false },
  ];
  await c.setSchedule(windows);
  assert.deepEqual(c.getSchedule(), windows);
  assert.deepEqual(store.schedule, windows);
});

test('moving the current slider switches to Manual at that current', async () => {
  const { c } = makeController([]);
  c.setSolarTarget(12); // solar would charge at 12A
  await c.setCurrentLimit(8);
  assert.deepEqual(c.resolve(at(0, 12, 0)), { mode: 'manual', amps: 8 });
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

test('EV-initiated Finishing (no StopTransaction) clears the stale transaction and re-arms starting', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      calls.push(method);
      if (method === 'RemoteStartTransaction') return { status: 'Accepted' };
      return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [], transactionId: 5 };
  const settings: Record<string, unknown> = { minAmps: 6, maxAmps: 31, phases: 1, voltage: 230, maxHouseholdW: 14000 };
  const caps: Record<string, unknown> = {};
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => { caps[k] = v; },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => { store[k] = v; },
    setAvailable: () => {}, setUnavailable: () => {}, setWarning: () => {},
    log: () => {}, error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  await c.startManual(16); // manual latch: always try to charge

  assert.ok(c.isCharging(), 'restored transaction id from store looks like a live session');

  // The Wallbox stalls in Finishing without ever sending StopTransaction.
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Finishing' });

  assert.equal(c.isCharging(), false, 'stale transaction cleared on Finishing');
  assert.equal(caps.evcharger_charging, false);
  assert.ok(!calls.includes('RemoteStartTransaction'), 'must not retry starting while still Finishing');

  // Physically unplugged and replugged: Available then Preparing.
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Preparing' });

  assert.ok(calls.includes('RemoteStartTransaction'), 'a new session can be started after replug');
});

test('manual off pauses at 0A (keeps the transaction) instead of hard-stopping', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => { calls.push(method); return { status: 'Accepted' }; },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [], transactionId: 7 };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000, writeThrottleMs: 0,
  };
  const caps: Record<string, unknown> = {};
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => { caps[k] = v; },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => { store[k] = v; },
    setAvailable: () => {}, setUnavailable: () => {}, setWarning: () => {},
    log: () => {}, error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  await c.startManual(16);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });

  await c.stop(); // manual "off" while a transaction is live

  assert.ok(!calls.includes('RemoteStopTransaction'), 'must not end the transaction on manual off');
  assert.ok(c.isCharging(), 'transaction stays open (paused), so it can resume without a replug');

  const callsBeforeResume = calls.length;
  await c.startManual(10); // turn back on - must not require Finishing/replug to resume
  assert.ok(calls.slice(callsBeforeResume).includes('SetChargingProfile'),
    'resumes by writing a new profile on the still-open transaction');
  assert.ok(!calls.includes('RemoteStartTransaction'), 'no new session needed - it was never stopped');
  assert.ok(!calls.includes('RemoteStopTransaction'), 'still no hard stop anywhere in this flow');
});

test('manual latch set while unplugged is cleared by the fresh plug-in (never defaults to Manual)', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => { calls.push(method); return { status: 'Accepted' }; },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = { minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000 };
  const caps: Record<string, unknown> = {};
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => { caps[k] = v; },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => { store[k] = v; },
    setAvailable: () => {}, setUnavailable: () => {}, setWarning: () => {},
    log: () => {}, error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();

  // Charger idle (unplugged) before the manual latch is ever set.
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
  await c.startManual(6); // manual latch, still unplugged
  assert.equal(c.resolve(new Date()).mode, 'manual', 'latch is active while still unplugged');

  // A fresh plug-in (no schedule window, no prior replug) must clear the
  // latch and fall through to Solar - never stay Manual.
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'SuspendedEV' });
  assert.equal(c.resolve(new Date()).mode, 'solar', 'a fresh plug-in clears the latch -> Solar (no schedule)');
});

test('a transactionId restored from store at boot is never hard-stopped, confirmed or not', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => { calls.push(method); return { status: 'Accepted' }; },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient); // connected, but no StatusNotification has been seen yet

  // Solar target null (below excess threshold) -> controller wants to be idle.
  const store: Record<string, unknown> = { schedule: [], transactionId: 42 };
  const settings: Record<string, unknown> = { minAmps: 6, maxAmps: 31, phases: 1, voltage: 230, maxHouseholdW: 14000 };
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => { store[k] = v; },
    setAvailable: () => {}, setUnavailable: () => {}, setWarning: () => {},
    log: () => {}, error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init(); // fires an initial tick synchronously; transactionId=42 was restored from store
  c.setSolarTarget(null);

  assert.ok(!calls.includes('RemoteStopTransaction'),
    'idle (no target) pauses at 0A, it must never hard-stop an unconfirmed restored transaction');

  // A real status now arrives (e.g. TriggerMessage response, or a genuine change).
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Preparing' });

  assert.ok(!calls.includes('RemoteStopTransaction'),
    'still no hard stop once a real status confirms the charger is live - pause only, never end the transaction');
});
