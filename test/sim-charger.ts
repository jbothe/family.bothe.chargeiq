'use strict';

/**
 * Simulated OCPP 1.6J charge point built on ocpp-rpc's RPCClient. Lets the app
 * be developed and tested without the physical Wallbox. It:
 *  - connects to the app's Central System and sends Boot/Status/Heartbeat,
 *  - answers RemoteStart/Stop, SetChargingProfile, Clear, Get/ChangeConfiguration,
 *    TriggerMessage,
 *  - emits synthetic MeterValues whose power tracks the applied current limit.
 *
 * Run standalone:  node .homeybuild/test/sim-charger.js [ws://host:port] [identity]
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RPCClient } = require('ocpp-rpc');

export interface SimOptions {
  url: string;
  identity: string;
  voltage?: number;
  phases?: number;
  /** Emit MeterValues every N ms once charging (0 = manual only). */
  meterIntervalMs?: number;
}

export class SimCharger {

  private opts: Required<SimOptions>;

  private client: any = null;

  private txId: number | null = null;

  private meterWh = 0;

  private limitA: number; // applied current limit

  private meterTimer: NodeJS.Timeout | null = null;

  private connectorStatus = 'Available';

  constructor(opts: SimOptions) {
    this.opts = {
      voltage: 230,
      phases: 1,
      meterIntervalMs: 0,
      ...opts,
    };
    this.limitA = 16;
  }

  async connect(): Promise<void> {
    const client = new RPCClient({
      endpoint: this.opts.url,
      identity: this.opts.identity,
      protocols: ['ocpp1.6'],
    });

    client.handle('RemoteStartTransaction', async ({ params }: any) => {
      setTimeout(() => this.startTransaction(params.idTag ?? 'SIMTAG').catch(() => {}), 50);
      return { status: 'Accepted' };
    });
    client.handle('RemoteStopTransaction', async () => {
      setTimeout(() => this.stopTransaction().catch(() => {}), 50);
      return { status: 'Accepted' };
    });
    client.handle('SetChargingProfile', ({ params }: any) => {
      const period = params?.csChargingProfiles?.chargingSchedule?.chargingSchedulePeriod?.[0];
      if (period && typeof period.limit === 'number') {
        this.limitA = period.limit;
      }
      return { status: 'Accepted' };
    });
    client.handle('ClearChargingProfile', () => ({ status: 'Accepted' }));
    client.handle('GetConfiguration', () => ({
      configurationKey: [
        { key: 'MeterValueSampleInterval', readonly: false, value: '10' },
      ],
      unknownKey: [],
    }));
    client.handle('ChangeConfiguration', () => ({ status: 'Accepted' }));
    client.handle('TriggerMessage', ({ params }: any) => {
      if (params?.requestedMessage === 'MeterValues') {
        setTimeout(() => this.sendMeterValues().catch(() => {}), 20);
      }
      return { status: 'Accepted' };
    });
    // Catch-all so unexpected calls do not crash the sim.
    client.handle(({ method }: any) => {
      throw new Error(`Unsupported: ${method}`);
    });

    this.client = client;
    await client.connect();
  }

  async boot(): Promise<any> {
    return this.client.call('BootNotification', {
      chargePointVendor: 'Wallbox',
      chargePointModel: 'Pulsar Max',
      firmwareVersion: 'sim-1.0',
    });
  }

  async heartbeat(): Promise<void> {
    await this.client.call('Heartbeat', {});
  }

  async status(status: string, errorCode = 'NoError'): Promise<void> {
    this.connectorStatus = status;
    await this.client.call('StatusNotification', { connectorId: 1, errorCode, status });
  }

  async startTransaction(idTag = 'SIMTAG'): Promise<number> {
    const res = await this.client.call('StartTransaction', {
      connectorId: 1,
      idTag,
      meterStart: Math.round(this.meterWh),
      timestamp: new Date().toISOString(),
    });
    this.txId = res.transactionId;
    await this.status('Charging');
    if (this.opts.meterIntervalMs > 0) this.startMeterLoop();
    return this.txId as number;
  }

  async stopTransaction(): Promise<void> {
    this.stopMeterLoop();
    if (this.txId != null) {
      await this.client.call('StopTransaction', {
        transactionId: this.txId,
        meterStop: Math.round(this.meterWh),
        timestamp: new Date().toISOString(),
        reason: 'Remote',
      });
    }
    this.txId = null;
    await this.status('Finishing');
    await this.status('Available');
  }

  /** Current simulated power (W) from the applied limit while charging. */
  get powerW(): number {
    if (this.connectorStatus !== 'Charging' || this.limitA <= 0) return 0;
    return this.limitA * this.opts.voltage * this.opts.phases;
  }

  async sendMeterValues(): Promise<void> {
    const power = this.powerW;
    const current = power > 0 ? this.limitA : 0;
    this.meterWh += power * (Math.max(this.opts.meterIntervalMs, 1000) / 3600000);
    await this.client.call('MeterValues', {
      connectorId: 1,
      transactionId: this.txId ?? undefined,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [
          { measurand: 'Power.Active.Import', unit: 'W', value: String(Math.round(power)) },
          { measurand: 'Current.Import', unit: 'A', value: String(current) },
          { measurand: 'Voltage', unit: 'V', value: String(this.opts.voltage) },
          { measurand: 'Energy.Active.Import.Register', unit: 'Wh', value: String(Math.round(this.meterWh)) },
        ],
      }],
    });
  }

  private startMeterLoop(): void {
    this.stopMeterLoop();
    this.meterTimer = setInterval(() => this.sendMeterValues().catch(() => {}), this.opts.meterIntervalMs);
  }

  private stopMeterLoop(): void {
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
  }

  async close(): Promise<void> {
    this.stopMeterLoop();
    await this.client?.close();
  }

}

async function main() {
  const url = process.argv[2] || 'ws://localhost:9000';
  const identity = process.argv[3] || 'SIM01';
  const sim = new SimCharger({ url: `${url}/${identity}`, identity, meterIntervalMs: 2000 });
  await sim.connect();
  await sim.boot();
  await sim.status('Available');
  await sim.status('Preparing');
  await sim.startTransaction();
  // eslint-disable-next-line no-console
  console.log(`Sim charger ${identity} connected and charging. Ctrl-C to stop.`);
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
