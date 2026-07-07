'use strict';

/**
 * Pure presentation logic for the power-flow widget, shared between the browser
 * widget (window.PowerFlow) and the Node test suite (module.exports).
 */
(function (root) {

  function fmtW(w) {
    if (w == null || isNaN(w)) return '–';
    var a = Math.abs(w);
    return a >= 1000 ? (w / 1000).toFixed(a >= 10000 ? 0 : 1) + ' kW' : Math.round(w) + ' W';
  }

  function cap(s) {
    return s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '';
  }

  // Returns { mag, dir: 'up'|'down'|null } — up = energy into the home/bus.
  function flow(kind, s) {
    s = s || {};
    var w;
    if (kind === 'solar') { w = s.solarW || 0; return { mag: w, dir: w > 10 ? 'up' : null }; }
    if (kind === 'house') { w = s.houseW || 0; return { mag: w, dir: w > 10 ? 'down' : null }; }
    if (kind === 'battery') { w = s.batteryW || 0; return { mag: Math.abs(w), dir: w > 10 ? 'down' : (w < -10 ? 'up' : null) }; }
    if (kind === 'grid') { w = s.gridW || 0; return { mag: Math.abs(w), dir: w > 10 ? 'up' : (w < -10 ? 'down' : null) }; }
    return { mag: 0, dir: null };
  }

  // Bus is red (importing) when net grid draw is positive, else green.
  function busImporting(s) {
    return ((s && s.gridW) || 0) > 10;
  }

  function socLabel(s) {
    var v = s && s.batterySoc;
    return (v != null && !isNaN(v)) ? Math.round(v) + '%' : '';
  }

  function statusLabel(c) {
    if (!c || !c.available) return 'No charger paired';
    var map = {
      Charging: 'Charging', SuspendedEV: 'Paused (vehicle)', SuspendedEVSE: 'Paused',
      Preparing: 'Plugged in', Finishing: 'Finishing', Available: 'Unplugged', Faulted: 'Fault',
      Reserved: 'Reserved', Unavailable: 'Unavailable',
    };
    var s = map[c.status] || cap(c.status) || 'Idle';
    return c.mode ? s + ' · ' + cap(c.mode) : s;
  }

  var api = { fmtW: fmtW, cap: cap, flow: flow, busImporting: busImporting, socLabel: socLabel, statusLabel: statusLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PowerFlow = api;

})(typeof window !== 'undefined' ? window : null);
