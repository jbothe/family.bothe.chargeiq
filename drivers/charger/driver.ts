'use strict';

import Homey from 'homey';
import { CentralSystem } from '../../lib/ocpp/CentralSystem';

interface ChargeIQApp extends Homey.App {
  getCentralSystem(): CentralSystem;
}

module.exports = class ChargerDriver extends Homey.Driver {

  async onInit() {
    const flow = this.homey.flow;

    flow.getActionCard('set_mode')
      .registerRunListener((args: any) => args.device.flowSetMode(args.mode));
    flow.getActionCard('start_charging')
      .registerRunListener((args: any) => args.device.flowStart(args.current));
    flow.getActionCard('stop_charging')
      .registerRunListener((args: any) => args.device.flowStop());
    flow.getActionCard('set_current_limit')
      .registerRunListener((args: any) => args.device.flowSetCurrent(args.current));

    flow.getConditionCard('is_charging')
      .registerRunListener((args: any) => args.device.flowIsCharging());
    flow.getConditionCard('mode_is')
      .registerRunListener((args: any) => args.device.flowModeIs(args.mode));
    flow.getConditionCard('within_schedule')
      .registerRunListener((args: any) => args.device.flowWithinSchedule());

    this.log('ChargerDriver initialised');
  }

  /**
   * List charge points that have connected to the Central System this session.
   * The charger must be pointed at ws://<homey-ip>:<port>/<identity> before pairing.
   */
  async onPairListDevices() {
    const app = this.homey.app as ChargeIQApp;
    const cs = app.getCentralSystem();
    return cs.listIdentities().map((identity) => ({
      name: `EV Charger (${identity})`,
      data: { id: identity },
    }));
  }

};
