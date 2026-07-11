'use strict';

/** Minimal surface this file needs from the homey object passed into api handlers. */
interface ApiHomey {
  app: {
    getSchedule(): unknown[];
    setSchedule(windows: unknown[]): Promise<void>;
  };
}

/**
 * App API endpoints, callable from the widget and the settings page via
 * Homey.api('GET'|'POST', '/<name>', body). The widget stays thin: it only
 * reads merged state the app already owns.
 */
module.exports = {

  async getSchedule({ homey }: { homey: ApiHomey }) {
    return homey.app.getSchedule();
  },

  async setSchedule({ homey, body }: { homey: ApiHomey; body: { windows?: unknown[] } }) {
    await homey.app.setSchedule(Array.isArray(body?.windows) ? body.windows : []);
    return { ok: true };
  },

};
