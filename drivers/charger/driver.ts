'use strict';

import Homey from 'homey';
import { CentralSystem } from '../../lib/ocpp/CentralSystem';

interface ChargeIQApp extends Homey.App {
  getCentralSystem(): CentralSystem;
}

module.exports = class ChargerDriver extends Homey.Driver {

  async onInit() {
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
