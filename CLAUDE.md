# ChargeIQ — Homey Pro EV charging app

Self-contained Homey Pro app (SDK v3, TypeScript, CommonJS output) that is the **OCPP 1.6J
Central System** for one **Wallbox Pulsar Max** (single-phase, 230 V, 6–31 A) and orchestrates
charging across three derived modes, plus a live power-flow dashboard widget. App id
`family.bothe.chargeiq`, compatibility `>=12.4.5`, platform `local`.

## Commands
- `npm run build` — `tsc` → `.homeybuild/` (the run/publish output).
- `npm test` — `tsc && node --test .homeybuild/test/*.test.js` (node:test; no framework dep).
- `homey app validate --level publish` — must pass (only the expected `homey:manager:api`
  review notice is allowed). Also run `--level debug` for quick checks.
- `homey app run` — run on the user's Homey (LAN). This is the only real integration env.
- Do **not** hand-edit `app.json` — it is generated from `.homeycompose/`. Edit compose files.

## Architecture
The **App** (`app.ts`) owns the long-lived services and exposes them to the device via
`this.homey.app`:
- `lib/ocpp/CentralSystem.ts` — wraps the `ocpp-rpc` `RPCServer` (strictMode), one `ChargePoint`
  per OCPP identity. `ChargePoint.ts` holds inbound handlers + outbound command wrappers and
  survives reconnects (swap the underlying client via `attach`). `types.ts` has message shapes
  and the `parseMeterValues` → W/A/V/kWh helper.
- `lib/solar/SolarFeed.ts` — reads the user's SolarEdge app (`bothe.family.solaredge`) over the
  HomeyAPI: `measure_power` on inverter/meter/battery + `measure_battery` SoC. Emits a merged
  `SolarSample`; **house load is derived** (`pv + gridSigned − batterySigned`). Best-effort —
  the charger still works without it. See `memory/solaredge-feed-contract.md`.
- Widget state is **pushed** to the widget via `this.homey.api.realtime('powerflow', …)` every
  5 s (`startWidgetBroadcast`). This is the widget's data channel — the widget/app **api-fetch
  routing never worked reliably on-device, so don't reintroduce it**.

`drivers/charger/` — an `evcharger`-class device. `device.ts` is a thin adapter: it implements
`ControllerHost` and forwards capability-listener/Flow calls to the controller.

`lib/control/ChargeController.ts` — the brain (one per charger). Binds to the `ChargePoint`,
mirrors OCPP state onto capabilities, and each 10 s tick resolves a **derived mode**.

### Mode is a derived STATE, not user config
Priority **Manual > Scheduled > Solar**, recomputed every tick:
- **Manual** — a *manual latch* is set. Any hands-on action sets it: `evcharger_charging` toggle,
  `charge_current_limit` slider, or Flow start/stop/set-current (`on`/amps → charge, `off` → off).
  Persisted in device store; cleared **only** when a schedule window *starts* (rising edge) or the
  charger is *unplugged→replugged* (OCPP `Available` → plugged edge).
- **Scheduled** — no latch and inside a `Scheduler` window (schedule beats solar).
- **Solar** — default outside schedules with no latch; follows excess via `SolarLoop`.

The **household grid-import cap** (`maxHouseholdW`, default 14 kW) applies on top in every mode.
`charge_mode` is a **read-only** metric (manual/scheduled/solar). `getModeInfo()` → `{mode, detail}`
drives the widget's `Mode: X · detail` line.

### Key invariants / gotchas
- **Amps are always floored** (never rounded up) when converting W→A, in `SolarLoop`, the
  household cap, and `clampAmps` — a target must never exceed available surplus/limit.
- Homey fires `registerCapabilityListener` only for *external* (user/Flow) sets, not for the app's
  own `setCapabilityValue`. That's how manual actions are distinguished from the solar loop's own
  slider updates — rely on it; don't add manual-vs-auto flags.
- `SetChargingProfile` uses a **stable** `chargingProfileId`/`stackLevel` so each write replaces the
  last; writes are throttled (`writeThrottleMs`). `TxProfile` while a transaction is live, else
  `TxDefaultProfile`. `limit: 0` = pause (keep the session).
- Grid sign convention: **import positive / export negative**. Surplus = `chargerPower − gridSigned − margin`.
- Controller diagnostics log via the **app** logger (`this.homey.app.log`) for a short
  `[ChargeIQApp]` prefix; tags are `[charger]`, `[solar]`, `[cap]`, `[mode]`.
- Settings pages must include `<script src="/homey.js" data-origin="settings">`; widgets get their
  runtime injected automatically (no include, and keep widget JS **inline/single-file**).

## Widget
`widgets/power-flow/public/index.html` is self-contained. Its presentation logic lives between the
`POWERFLOW-LOGIC-START/END` markers; `test/powerflow.test.ts` extracts and evaluates that exact
block, so keep it dependency-free (no imports). It renders live even when the charger is unplugged;
dims (`.stale`) after ~25 s without a realtime update and auto-recovers.

## Testing
Pure logic is unit-tested (`SolarLoop`, `Scheduler`, controller mode/latch/cap resolution, solar
merge, widget presentation). `test/sim-charger.ts` is an `ocpp-rpc` `RPCClient` simulator used by
`test/ocpp-integration.test.ts` to exercise the real CentralSystem end-to-end without hardware.
Controllers/CentralSystem are Homey-independent (host is an interface), so they run in plain Node.
When adding behaviour, prefer a pure function + a node:test over needing the Homey runtime.

## Not yet verified on hardware
Wallbox `SetChargingProfile` behaviour at 6 A / 0 A, `TxProfile` vs `TxDefaultProfile`, RemoteStart
idTag auth, and a live schedule window actually starting a charge. Confirmed working on-device:
OCPP port bind (`:9000`), charger connect/bind, SolarFeed discovery, realtime widget.

## Conventions
- Match the surrounding style. `'use strict'` + `import` + `module.exports = class …` for
  App/Driver/Device (Homey template); plain `export`/classes in `lib/`.
- Commit per logical change; run build + test + validate before committing.
- User's global tooling prefs apply (`rg`/`fd`/`jq` etc.).
