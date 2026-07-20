'use strict';

// Logged once so `homey app run`'s terminal confirms this endpoint is actually being hit -
// the original attempt at this (see CLAUDE.md's Widget section) failed silently with no
// visibility into whether the call ever landed at all.
let firstHitLogged = false;

/**
 * Pull-based fallback for the widget's realtime subscription (both are used - see
 * CLAUDE.md's Widget section). Single-charger app, so unlike dexcom's per-device
 * lookup this just returns the one merged state the realtime broadcast also sends.
 */
module.exports = {

  async getState({ homey }) {
    if (!firstHitLogged) {
      firstHitLogged = true;
      homey.app.log('[widget-api] getState hit');
    }
    return homey.app.getWidgetState();
  },

};
