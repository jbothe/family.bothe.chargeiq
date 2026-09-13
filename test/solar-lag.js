'use strict';

/**
 * Measures the dead time in ChargeIQ's solar-surplus control loop.
 *
 * Dev-only, never shipped (.homeyignore excludes test/). A standalone CLI, not
 * a node:test file - `npm test` only runs .homeybuild/test/*.test.js, so this
 * is not picked up by it. It reports to stdout and exits on Ctrl-C, hence the
 * no-console/no-process-exit override for this one file in .eslintrc.json.
 *
 * Pipe `homey app run` through it, then step the current limit in Manual mode.
 * For each step it reports when the charger's own draw (OCPP MeterValues) and
 * the grid reading (SolarEdge) each caught up:
 *
 *   t_dec  [decision:...] -> NA          the loop decided
 *   t_wr   [charger] setting profile     write actually sent (after writeThrottleMs)
 *   t_ev   [charger] power=              OCPP observed the new draw
 *   t_gr   [solar] ... grid=             SolarEdge observed the same event
 *
 *   tau_rel  = t_gr - t_ev   relative observation lag -> the double-count term
 *   tau_loop = t_gr - t_dec  full loop dead time      -> settleMs must exceed this
 *
 * Usage:
 *   homey app run 2>&1 | node test/solar-lag.js [--volts 230] [--phases 1] [--out FILE]
 *   node test/solar-lag.js --analyze FILE   # re-run against an earlier capture
 */

const fs = require('fs');
const readline = require('readline');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const VOLTS = Number(arg('volts', 230));
const PHASES = Number(arg('phases', 1));
const ANALYZE = arg('analyze', null);
const OUT = arg('out', `solar-lag-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
/** Give up on a step that never resolves (ms). */
const EVENT_TIMEOUT_MS = 240000;

const RE = {
  // Our own prefix on a captured line: "2026-08-13T09:12:33.418Z | ..."
  stamped: /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \| (.*)$/,
  // A decision line carries several "->" arrows: each cap note has one
  // ("shared circuit cap 32A -> 24A"), and the *final* resolved target is the
  // last. Matched globally and taken from the end, since nothing appended after
  // it (OFFLINE / NOT SENT) contains an arrow.
  decision: /\[decision:([^\]]+)\]/,
  target: /-> (paused|(\d+)A)/g,
  write: /\[charger\] setting profile: (\d+)A/,
  power: /\[charger\] power=(-?\d+)W current=([\d.]+|\?)A/,
  solar: /\[solar\] solar=(-?\d+|\?)W battery=(-?\d+|\?)W house=(-?\d+|\?)W grid=(-?\d+|\?)W charger=(-?\d+|\?)W/,
};

const num = (s) => (s === '?' || s == null ? null : Number(s));
const secs = (ms) => (ms == null ? '  --  ' : `${(ms / 1000).toFixed(1)}s`.padStart(6));

/** Rolling state across the whole capture. */
const state = {
  lastTarget: null,
  lastPowerW: null,
  lastGridW: null,
  lastBatteryW: null,
  open: null,
  events: [],
};

/** Has `value` covered at least `frac` of the expected move, in the expected direction? */
function crossed(value, base, expectedDeltaW, frac) {
  if (value == null) return false;
  const moved = value - base;
  return expectedDeltaW >= 0
    ? moved >= expectedDeltaW * frac
    : moved <= expectedDeltaW * frac;
}

function report(e) {
  const rel50 = e.tGr50 != null && e.tEv50 != null ? e.tGr50 - e.tEv50 : null;
  const rel90 = e.tGr90 != null && e.tEv90 != null ? e.tGr90 - e.tEv90 : null;
  const loop50 = e.tGr50 != null ? e.tGr50 - e.t0 : null;
  const loop90 = e.tGr90 != null ? e.tGr90 - e.t0 : null;

  console.log(`--- step ${e.fromA}A -> ${e.toA}A  (${e.closedBecause}) ---`);
  console.log(`  write sent (throttle)   ${secs(e.tWrite != null ? e.tWrite - e.t0 : null)}`);
  console.log(`  charger seen  50% / 90% ${secs(e.tEv50 != null ? e.tEv50 - e.t0 : null)} / ${secs(e.tEv90 != null ? e.tEv90 - e.t0 : null)}`);
  console.log(`  grid    seen  50% / 90% ${secs(e.tGr50 != null ? e.tGr50 - e.t0 : null)} / ${secs(e.tGr90 != null ? e.tGr90 - e.t0 : null)}`);
  console.log(`  tau_rel  (grid - charger) ${secs(rel50)} / ${secs(rel90)}`);
  console.log(`  tau_loop (grid - decide)  ${secs(loop50)} / ${secs(loop90)}`);

  if (e.tEv50 == null) {
    console.log('  !! charger never reached 50% of the step - car tapering, at its own limit,');
    console.log('     or a cap overrode the target. Discard this step.');
  } else if (e.tGr50 == null) {
    console.log('  !! grid never reached 50% - battery likely absorbed the step, or household');
    console.log('     load moved against it. Check battery= in the series below. Discard.');
  } else if (e.tGr90 == null) {
    console.log('  ~~ grid reached 50% but not 90%: something absorbed part of it (battery?).');
    console.log('     The 50% figure is still usable; treat the 90% column as missing.');
  }

  console.log('  series (s after decision):');
  for (const s of e.series) {
    const dt = `+${((s.t - e.t0) / 1000).toFixed(1)}s`.padStart(8);
    if (s.kind === 'power') {
      console.log(`   ${dt}  charger ${String(s.powerW).padStart(6)}W  (${s.powerW - e.basePowerW >= 0 ? '+' : ''}${s.powerW - e.basePowerW})`);
    } else {
      console.log(`   ${dt}  grid    ${String(s.gridW).padStart(6)}W  (${s.gridW - e.baseGridW >= 0 ? '+' : ''}${s.gridW - e.baseGridW})   battery ${s.batteryW}W  pv ${s.pvW}W`);
    }
  }
}

function closeEvent(reason) {
  const e = state.open;
  if (!e) return;
  state.open = null;
  e.closedBecause = reason;
  state.events.push(e);
  report(e);
}

function startEvent(t, trigger, targetA) {
  const fromA = state.lastTarget;
  state.lastTarget = targetA;
  // Need a baseline on both series, and a real change, or there is nothing to time.
  if (fromA == null || fromA === targetA) return;
  if (state.lastPowerW == null || state.lastGridW == null) return;

  const expectedDeltaW = (targetA - fromA) * VOLTS * PHASES;
  closeEvent('superseded');
  state.open = {
    t0: t,
    trigger,
    fromA,
    toA: targetA,
    expectedDeltaW,
    basePowerW: state.lastPowerW,
    baseGridW: state.lastGridW,
    baseBatteryW: state.lastBatteryW,
    tWrite: null,
    tEv50: null,
    tEv90: null,
    tGr50: null,
    tGr90: null,
    series: [],
  };
  console.log(`\n=== step ${fromA}A -> ${targetA}A (${trigger}), expect ${expectedDeltaW >= 0 ? '+' : ''}${expectedDeltaW}W ===`);
}

function onLine(t, line) {
  const e = state.open;
  if (e && t - e.t0 > EVENT_TIMEOUT_MS) closeEvent('timed out');

  let m = line.match(RE.write);
  if (m && state.open && state.open.tWrite == null) state.open.tWrite = t;

  m = line.match(RE.power);
  if (m) {
    const powerW = num(m[1]);
    if (state.open) {
      const o = state.open;
      o.series.push({ t, kind: 'power', powerW });
      if (o.tEv50 == null && crossed(powerW, o.basePowerW, o.expectedDeltaW, 0.5)) o.tEv50 = t;
      if (o.tEv90 == null && crossed(powerW, o.basePowerW, o.expectedDeltaW, 0.9)) o.tEv90 = t;
    }
    state.lastPowerW = powerW;
  }

  m = line.match(RE.solar);
  if (m) {
    const pvW = num(m[1]);
    const batteryW = num(m[2]);
    const gridW = num(m[4]);
    if (state.open && gridW != null) {
      const o = state.open;
      o.series.push({
        t, kind: 'solar', gridW, batteryW, pvW,
      });
      if (o.tGr50 == null && crossed(gridW, o.baseGridW, o.expectedDeltaW, 0.5)) o.tGr50 = t;
      if (o.tGr90 == null && crossed(gridW, o.baseGridW, o.expectedDeltaW, 0.9)) o.tGr90 = t;
      if (o.tGr90 != null && o.tEv90 != null) closeEvent('complete');
    }
    if (gridW != null) state.lastGridW = gridW;
    if (batteryW != null) state.lastBatteryW = batteryW;
  }

  m = line.match(RE.decision);
  if (m) {
    const arrows = [...line.matchAll(RE.target)];
    if (arrows.length) {
      const last = arrows[arrows.length - 1];
      startEvent(t, m[1], last[2] != null ? Number(last[2]) : 0);
    }
  }
}

function summarise() {
  const usable = state.events.filter((e) => e.tGr50 != null && e.tEv50 != null);
  console.log(`\n${'='.repeat(64)}`);
  console.log(`captured ${state.events.length} step(s), ${usable.length} usable`);
  if (usable.length === 0) {
    console.log('Nothing usable. See the per-step notes above.');
    return;
  }
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const rel = usable.map((e) => e.tGr50 - e.tEv50);
  const loop = usable.map((e) => e.tGr50 - e.t0);
  console.log(`  tau_rel  median ${secs(median(rel))}   (range ${secs(Math.min(...rel))} .. ${secs(Math.max(...rel))})`);
  console.log(`  tau_loop median ${secs(median(loop))}   (range ${secs(Math.min(...loop))} .. ${secs(Math.max(...loop))})`);
  const settle = Math.ceil((median(loop) * 1.5) / 1000);
  console.log(`\n  => suggested solarSettleSec ~= ${settle}   (1.5 x median tau_loop)`);
  console.log(`  => measured grid lag (tau_rel) ~= ${Math.round(median(rel))}ms`);
}

async function main() {
  if (ANALYZE) {
    const rl = readline.createInterface({ input: fs.createReadStream(ANALYZE), crlfDelay: Infinity });
    for await (const raw of rl) {
      const m = raw.match(RE.stamped);
      if (!m) continue;
      onLine(Date.parse(m[1]), m[2]);
    }
    closeEvent('end of file');
    summarise();
    return;
  }

  const out = fs.createWriteStream(OUT, { flags: 'a' });
  console.log(`capturing to ${OUT} - Ctrl-C when done\n`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  const finish = () => {
    closeEvent('capture ended');
    summarise();
    console.log(`\nraw capture: ${OUT}`);
    console.log(`re-analyse:  node ${__filename} --analyze ${OUT}`);
    process.exit(0);
  };
  process.on('SIGINT', finish);

  for await (const line of rl) {
    const t = Date.now();
    out.write(`${new Date(t).toISOString()} | ${line}\n`);
    onLine(t, line);
  }
  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
