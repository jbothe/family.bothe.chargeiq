'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { CentralSystem } from '../lib/ocpp/CentralSystem';
import { ChargePoint } from '../lib/ocpp/ChargePoint';
import { Readings, StatusNotificationReq } from '../lib/ocpp/types';
import { SimCharger } from './sim-charger';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('OCPP 1.6J: connect, boot, transaction, MeterValues, commands', async () => {
  const PORT = 9931;
  const IDENTITY = 'WBIT01';
  let txCounter = 0;
  const cs = new CentralSystem({
    port: PORT,
    authorize: () => true,
    allocateTransactionId: () => ++txCounter,
    logger: () => {},
  });
  await cs.start();

  const events = {
    boot: false, statuses: [] as string[], meter: [] as Readings[], startId: 0, stopped: false,
  };
  let cp: ChargePoint | undefined;
  cs.on('chargePoint', (c: ChargePoint) => {
    cp = c;
    c.on('boot', () => {
      events.boot = true;
    });
    c.on('status', (s: StatusNotificationReq) => events.statuses.push(s.status));
    c.on('meterValues', (r: Readings) => events.meter.push(r));
    c.on('startTransaction', (id: number) => {
      events.startId = id;
    });
    c.on('stopTransaction', () => {
      events.stopped = true;
    });
  });

  const sim = new SimCharger({ url: `ws://localhost:${PORT}/${IDENTITY}`, identity: IDENTITY });

  try {
    await sim.connect();
    await sleep(80);
    assert.ok(cp, 'charge point registered');
    assert.ok(cs.listIdentities().includes(IDENTITY));
    assert.equal(cs.getChargePoint(IDENTITY), cp);
    assert.equal(cs.getChargePoint('NOT-CONNECTED'), undefined);

    const boot = await sim.boot();
    await sleep(40);
    assert.equal(boot.status, 'Accepted');
    assert.equal(typeof boot.interval, 'number');
    assert.ok(events.boot);

    await sim.status('Available');
    await sim.status('Preparing');
    await sleep(40);
    assert.ok(events.statuses.includes('Available') && events.statuses.includes('Preparing'));

    assert.equal(await cp!.remoteStartTransaction('SIMTAG'), true);
    await sleep(150);
    assert.equal(events.startId, 1);

    assert.equal(await cp!.setChargingProfile({
      limitAmps: 10, connectorId: 1, transactionId: events.startId, numberPhases: 1, chargingProfileId: 1, stackLevel: 1,
    }), true);
    await sim.sendMeterValues();
    await sleep(60);
    const last = events.meter[events.meter.length - 1];
    assert.equal(last.power, 2300, '10A * 230V');
    assert.equal(last.current, 10);
    assert.equal(last.voltage, 230);
    assert.equal(typeof last.energyKwh, 'number');

    assert.equal(await cp!.remoteStopTransaction(events.startId), true);
    await sleep(150);
    assert.ok(events.stopped);

    const cfg = await cp!.getConfiguration(['MeterValueSampleInterval']);
    assert.ok(Array.isArray(cfg.configurationKey));
    assert.equal(await cp!.changeConfiguration('MeterValueSampleInterval', '10'), 'Accepted');
  } finally {
    await sim.close();
    await sleep(30);
    await cs.stop();
  }
});

test('stop() releases the charge points, not just the listening socket', async () => {
  const PORT = 9932;
  const IDENTITY = 'WBIT02';
  const cs = new CentralSystem({
    port: PORT,
    authorize: () => true,
    allocateTransactionId: () => 1,
    logger: () => {},
  });
  await cs.start();

  const sim = new SimCharger({ url: `ws://localhost:${PORT}/${IDENTITY}`, identity: IDENTITY });
  let disconnects = 0;
  cs.on('disconnect', () => {
    disconnects += 1;
  });

  try {
    await sim.connect();
    await sleep(80);
    const cp = cs.getChargePoint(IDENTITY);
    assert.ok(cp, 'charge point registered');
    assert.equal(cp!.connected, true);

    // Stop while the charger is still attached - the case where the ChargePoint
    // is holding a live socket and an armed liveness timer.
    await cs.stop();

    assert.equal(cp!.connected, false, 'the charge point was detached, not left holding a dead socket');
    assert.deepEqual(cs.listIdentities(), [], 'and the registry was emptied rather than handing back stale instances');
    assert.equal(disconnects, 0,
      'a deliberate shutdown must not report an outage - that would mark the device unavailable '
      + 'and fire charger_offline on every app stop');
  } finally {
    await sim.close();
    await sleep(30);
    await cs.stop(); // already stopped - must be a no-op
  }
});
