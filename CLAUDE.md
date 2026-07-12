# ChargeIQ — Homey Pro EV charging app

Self-contained Homey Pro app (SDK v3, TypeScript, CommonJS output) that is the **OCPP 1.6J
Central System** for one **Wallbox Pulsar Max** (single-phase, 230 V, 6–32 A) and orchestrates
charging across three derived modes, plus a live power-flow dashboard widget. App id
`family.bothe.chargeiq`, compatibility `>=12.4.5`, platform `local`.

## Commands
- `npm run build` — `tsc` → `.homeybuild/` (the run/publish output).
- `npm test` — `tsc && node --test .homeybuild/test/*.test.js` (node:test; no framework dep).
- `npm run lint` — `eslint --ext .js,.ts .`; must be 0 problems, not just 0 errors (fix warnings too,
  don't suppress).
- `homey app validate --level publish` — must pass (only the expected `homey:manager:api`
  review notice is allowed). Also run `--level debug` for quick checks.
- `homey app run` — run on the user's Homey (LAN). This is the only real integration env.
- Do **not** hand-edit `app.json` — it is generated from `.homeycompose/`. Edit compose files.
- Before **any** commit: build, test, and lint must all be clean, and `homey app validate --level
  publish` must pass. Run all four - a green `npm test` does not imply lint is clean or vice versa.

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
  10 s (`startWidgetBroadcast`). This is the widget's data channel — the widget/app **api-fetch
  routing never worked reliably on-device, so don't reintroduce it**.

`drivers/charger/` — an `evcharger`-class device. `device.ts` is a thin adapter: it implements
`ControllerHost` and forwards capability-listener/Flow calls to the controller.

`lib/control/ChargeController.ts` — the brain (one per charger). Binds to the `ChargePoint`,
mirrors OCPP state onto capabilities, and each tick resolves a **derived mode**. The 15s timer
(`TICK_MS`) is a backstop, not a fixed-schedule poll: every `tick()` (from any trigger) reschedules
it another 15s out via `scheduleNextTick()`, so it only actually fires if nothing else has ticked in
that window - "at least once every 15s", not "every 15s regardless". 15s (not 10s) is deliberately
offset from SolarEdge's ~10s report cadence so the backstop and solar-driven ticks don't routinely
land at nearly the same moment.

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

The **shared-circuit cap** (`sharedCircuitA`/`sharedCircuitBufferA`, both default 0/disabled) is a
second, independent hard ceiling for a physical circuit shared with other equipment (e.g. a home
battery inverter on the same breaker as the charger) — `sharedCircuitA + pv − battery − buffer`
(amps), reading live `pvW`/`batteryW` off the solar feed. It applies in every mode alongside the
household cap. A schedule window can opt in to **boosting** above its `currentA` up to this cap via
`ScheduleWindow.boostToCap` — `currentA` becomes a floor, not a fixed target, so solar (or the
battery simply not charging as hard as assumed) can push the current higher. Battery **discharge**
is deliberately excluded from the boost calc (`ChargeController.scheduledAmpsDetail`) even though it
legitimately raises the safety-cap ceiling — the home battery must never fund extra EV current
beyond the configured floor, only genuine spare circuit capacity may.

### Key invariants / gotchas
- **Amps are always floored** (never rounded up) when converting W→A, in `SolarLoop`, the
  household cap, and `clampAmps` — a target must never exceed available surplus/limit.
- Homey fires `registerCapabilityListener` only for *external* (user/Flow) sets, not for the app's
  own `setCapabilityValue`. That's how manual actions are distinguished from the solar loop's own
  slider updates — rely on it; don't add manual-vs-auto flags.
- **`Device.onSettings()` fires *before* Homey persists the new values** — `this.getSetting(key)`
  during that call still returns the *old* settings, only the callback's `newSettings` argument has
  the fresh ones. `device.ts`'s `onSettings` caches `newSettings` into `pendingSettings` for the
  duration of the `refreshConfig()` call it triggers (`buildHost().getSetting` checks that cache
  first) — without this, any settings change (`sharedCircuitA` included) would silently apply one
  generation late, only taking effect on the *next* settings save or app restart.
- `SetChargingProfile` uses a **stable** `chargingProfileId`/`stackLevel` so each write replaces the
  last; writes are throttled (`writeThrottleMs`). `TxProfile` while a transaction is live, else
  `TxDefaultProfile`. `limit: 0` = pause (keep the session). **A hard cap (`householdCapAmps()` /
  `sharedCircuitCapAmps()`) getting tighter than it was on the previous tick jumps this throttle** -
  found via a real-hardware log where the shared-circuit cap tightened twice in ~20s as a home
  battery ramped its charge rate, but the flat 15s-per-write throttle left the charger running under
  the previous, now-too-high limit for several seconds each time (confirmed: 22.5A actually flowing
  ~9.5s after the true cap had already dropped to 16A). `tick()` tracks each cap's own value
  tick-over-tick (`lastHouseholdCapAmps`/`lastSharedCircuitCapAmps`) - regardless of which code path
  ends up applying it, including the schedule boost-to-cap in `scheduledAmpsDetail()`, which uses the
  same `sharedCircuitCapAmps()` internally - and `ensureCharging()` only treats the resulting write as
  urgent (bypass/preempt any pending throttled write) when that tightening also means less current
  than was previously requested (`target < this.desiredAmps`). Routine decreases with no cap
  involved - `SolarLoop` backing off on lower surplus, a schedule's own floor stepping down, a manual
  amps decrease - are deliberately **not** urgent and stay on the normal throttled cadence; only a
  hard safety ceiling actually shrinking justifies skipping it.
- **A charge point can be genuinely mid-session without ever granting a `transactionId`** - confirmed
  on real hardware: a Wallbox already `Charging` (e.g. across an app restart) rejects a redundant
  `RemoteStartTransaction` outright and never sends `StartTransaction`, so waiting for one can leave
  `transactionId` null forever. `ensureCharging()` therefore writes via `TxDefaultProfile` (no
  `transactionId`) whenever the charger's own reported status is plugged-in (not just `TxProfile` when
  a transaction id happens to be known), and only attempts `RemoteStartTransaction` while `Preparing`
  (genuinely awaiting one) - not once already `Charging`/`SuspendedEV`/`SuspendedEVSE`. It also writes
  on newly *becoming* eligible (transaction id gained, or charger newly reporting plugged) even if the
  target amps value itself didn't change across that transition - a write is otherwise only triggered
  by `desiredAmps` changing, which would silently skip the charger if the decision happened not to
  move at that exact moment. `isCharging()` (`transactionId != null`) is **not** a reliable "is power
  actually flowing" signal for this reason - `ChargeController.isDeliveringPower()` (`lastStatusValue
  === 'Charging'`) is used instead everywhere `chargerPowerW`/`lastPowerW` needs netting out (solar
  surplus calc, household cap) - otherwise the charger's own draw reads as 0 forever in exactly the
  same stuck-transactionId scenario, making household-cap headroom look far tighter than reality.
  **`lastPowerW` itself defaults to `null` ("no `MeterValues` yet this connection"), not `0`** - found
  via a real restart-onto-an-already-charging-session log: a fresh `ChargePoint` instance has no
  cached reading to replay on `bind()`, so for the few real seconds until the triggered-`MeterValues`
  round trip returns, `isDeliveringPower()` can be `true` with no reading yet at all. Netting that gap
  as `0` (confirmed-zero) rather than unknown makes the exact same "charger's draw reads as 0" mistake
  the paragraph above describes, just via a different path - `nettedChargerW()` returns `null` for
  this genuinely-unknown case, and both call sites treat `null` as "don't guess": `householdCapAmps()`
  returns `null` (cap unavailable, trust the configured ceiling - the existing convention for stale
  data) and `onSolarSample()` skips that sample's surplus evaluation entirely (leaving
  `solarTargetAmps`/`measure_solar_surplus` as they were) rather than crediting/debiting an unknown
  amount - both self-resolve within moments once a real reading lands. **The same "don't guess" gap
  exists one layer earlier too: `lastStatusValue === null`** (no `StatusNotification` received *at
  all* yet this connection, e.g. immediately after an app restart before OCPP has even reconnected -
  confirmed to lag SolarFeed's first sample by several more seconds on real hardware) **also isn't
  the same as confirmed-not-charging**, since `isDeliveringPower()` (`lastStatusValue === 'Charging'`)
  evaluates `false` for null exactly like it does for a genuine non-charging status. This one bit even
  though nothing could be written to a still-disconnected charger during that window: the wrongly-low
  `desiredAmps` it computes gets recorded regardless, and if it doesn't happen to change again once
  the connection *does* come up, `ensureCharging()`'s change-triggered write never fires to correct
  it - so a stale wrong pause from before `bind()` can end up being exactly what a newly-connected,
  already-charging session sees applied. `nettedChargerW()` treats `lastStatusValue == null` as
  unknown too, but **only when a `transactionId` is already known** (persisted from store at
  `init()` - the actual signal a session may be live) - without one, a null status is trusted as "no
  session, nothing to net out" (confirmed `0`), since a charger that's simply never connected
  otherwise leaves every solar/household calc permanently unavailable for no reason. **A third
  variant of the same gap: a single, *confirmed* `Available` report right after reconnect isn't
  reliable either** - this is the identical transient-`Available`-on-reconnect quirk described two
  bullets down (`onStatus()` already debounces it via `IDLE_RECONCILE_DELAY_MS` before trusting it to
  end a still-tracked transaction), just not previously applied to the power-netting side too.
  Confirmed on real hardware: a lone `Available` flipped back to `Charging` ~1.3s later, but in that
  window `nettedChargerW()` still trusted it as confirmed-`0`, driving a real (accepted)
  artificially-low `SetChargingProfile` write - and because *recovering* from a too-tight cap is a
  plain increase, not a cap tightening, it wasn't eligible for the urgent-write bypass either, so the
  wrong value sat in effect for a full `writeThrottleMs` (confirmed: correction landed exactly
  15.006s later) before self-correcting. `nettedChargerW()` now treats `lastStatusValue === 'Available'`
  as unknown too, but again only while `transactionId` is still on record (not yet reconciled away) -
  once `applyIdleReconciliation()` actually clears it (or there was never a transaction to begin
  with), a subsequent `Available` nets as a normal confirmed `0` rather than being stuck "unavailable"
  forever.
- **The controller never issues `RemoteStopTransaction`.** Every "don't charge" decision (manual
  off, no schedule/solar target, stale solar feed, disconnected latch) resolves to `amps: 0` (pause)
  in `ChargeController.resolve()`/`tick()`, never a hard stop. The Wallbox holds `Finishing` until a
  physical unplug/replug once a transaction actually ends, which would strand charging until someone
  walks out to the car — not worth it for any in-app reason. `SolarLoop`'s `target: null` (never
  started) and `target: 0` (paused) are both treated identically as "hold at 0A" by the controller.
- **A Wallbox Pulsar Max can report a transient `Available` on OCPP reconnect** (e.g. after an app
  restart) even while a vehicle is still plugged in and actively charging, flipping back to the real
  status (`Charging`) within well under a second - confirmed on real hardware (~600ms gap). Treating
  a single `Available` as authoritative would wipe a still-live `transactionId`, permanently blocking
  `SetChargingProfile` (only sent while `transactionId != null`) - the app would then only be able to
  retry `RemoteStartTransaction`, which a charger already mid-session may just accept as a no-op
  without ever sending a fresh `StartTransaction`, leaving the current stuck forever. `onStatus()`
  debounces the transaction-reconciliation side of an `Available` report by `IDLE_RECONCILE_DELAY_MS`
  (5s), cancelling it if a plugged status supersedes it first. `prevPlugged` (fresh-plug-in / manual
  latch clearing) is deliberately **not** debounced the same way - it needs to flip promptly for a
  genuine plug-in, and is a separate, lower-stakes concern from transaction bookkeeping.
- **Homey Pro's underlying OS clock runs in UTC**, independent of the timezone configured in the
  Homey app/mobile UI. Any wall-clock comparison (schedule windows, displayed times) must go through
  `this.homey.clock.getTimezone()` (`ControllerHost.getTimezone()` → `Scheduler.setTimezone()` /
  `fmtTime()`), never `Date`'s own local getters (`getHours()`/`getDay()`/`toLocaleTimeString()`
  without an explicit `timeZone`) — those reflect UTC on-device, not the user's local time.
- Grid sign convention: **import positive / export negative**. Surplus = `chargerPower − gridSigned −
  margin − batteryDischargeW` (see next bullet for the last term).
- Battery sign convention: **charge positive / discharge negative** (matches `SolarEdge` battery
  device). The shared-circuit cap uses this directly (no grid-based proxy), which is *why* the
  schedule-boost feature can gate cleanly on `batteryW < 0` instead of guessing. **`SolarLoop` also
  subtracts battery discharge out of its surplus calc** (`max(0, -batteryW)`, confirmed as a real
  hardware incident: PV alone couldn't cover house load, the battery was discharging to fund an
  apparent export, and standalone Solar mode started charging off it) - the grid meter alone can't
  tell real PV export apart from the battery propping up that same export, so a discharging battery
  would otherwise get mistaken for solar surplus. This is a *continuous* subtraction (genuine export
  on top of a discharging battery still counts), unlike the schedule-boost's binary gate - solar mode
  has no independent floor to fall back on, so zeroing out the entire target over any discharge at
  all would be needlessly conservative there.
- Controller diagnostics log via the **app** logger (`this.homey.app.log`) for a short
  `[ChargeIQApp]` prefix; tags are `[charger]`, `[solar]`, `[decision:<trigger>]`, `[mode]`,
  `[config]` (the full resolved config, logged on every `refreshConfig()` - boot and every settings
  save - to make a settings change's actual effect confirmable rather than assumed).
  `[decision:<trigger>]` is logged on **every** `tick()` call, unconditionally (not just on change) -
  one line covering what triggered it (`timer`, `init`, `bind`, `status:<OcppStatus>`, `solar`,
  `manual-toggle`, `manual-current`, `schedule-updated`), the resolved mode and *why*
  (`ChargeController.resolveDetailed`), then both hard caps' effect, then the final amps actually
  sent. This is deliberately more verbose than change-only logging so the log is a self-contained
  trail of every decision, not just the transitions. `tick()` itself is called far more often than
  the 15s backstop timer alone: every solar sample calls it directly, as does every OCPP
  `StatusNotification` that actually **changes** status (a repeat of the same status - e.g. the real
  charger echoing back what `bind()`'s cache replay + `requestFreshState()` already produced - is
  deliberately not treated as new information and does not re-tick).
  `[charger] power=…` is also currently unthrottled (every `MeterValues`, not just >=100W changes) -
  both this and the solar log's verbosity are marked `TEMP debugging` in the source pending real
  hardware verification; see git history to restore the throttled versions once that's done.
- Settings pages must include `<script src="/homey.js" data-origin="settings">`; widgets get their
  runtime injected automatically (no include, and keep widget JS **inline/single-file**).

## Widget
`widgets/power-flow/public/index.html` is self-contained. Its presentation logic lives between the
`POWERFLOW-LOGIC-START/END` markers; `test/powerflow.test.ts` extracts and evaluates that exact
block, so keep it dependency-free (no imports). It renders live even when the charger is unplugged;
dims (`.stale`) after ~50 s (5 missed 10s broadcasts) without a realtime update and auto-recovers.

## Testing
Pure logic is unit-tested (`SolarLoop`, `Scheduler`, controller mode/latch/cap resolution, solar
merge, widget presentation, `parseMeterValues()`). `test/sim-charger.ts` is an `ocpp-rpc` `RPCClient`
simulator used by `test/ocpp-integration.test.ts` to exercise the real CentralSystem end-to-end
without hardware. Controllers/CentralSystem are Homey-independent (host is an interface), so they run
in plain Node. Two other classes that wrap an external API are made testable the same way, via a
constructor-injected fake rather than mocking the module: `SolarFeed` takes an optional `apiOverride`
(`HomeyApiClient`) so `discover()`'s matching/subscription logic runs against a fake device set
instead of the real `HomeyAPI.createAppAPI()`; `ChargePoint`'s inbound OCPP handlers are exercised via
a `FakeRpcClient` (`test/charge-point.test.ts`) that captures whatever `attach()` registers via
`handle()`, so a test can dispatch a synthetic inbound call directly without a real WebSocket round
trip - complementary to, not a replacement for, the full `ocpp-integration.test.ts` coverage.
When adding behaviour, prefer a pure function + a node:test over needing the Homey runtime.

Keep unit test coverage high on everything in `lib/**` - new branches/methods there should land with a
test in the same commit, not as a follow-up. Check with `node --test --experimental-test-coverage
.homeybuild/test/*.test.js` after `npm test`. `app.ts`/`api.ts`/`drivers/**/device.ts`/`driver.ts` are
the deliberate exception - they're thin Homey-runtime adapters with no seam to fake the SDK, so low
coverage there is by design, not a gap. A handful of pure-logging lines (single-line OCPP event
handlers with no branching) and one third-party-library catch branch (`CentralSystem.stop()`'s
`server.close()`) are knowingly left uncovered - not worth a dedicated test or a DI seam added solely
to reach one log line.

## Not yet verified on hardware
`SetChargingProfile` behaviour at exactly 6A (as opposed to 0A, confirmed below), and a live schedule
window actually *starting* a charge from cold (`Preparing` → accepted `RemoteStartTransaction` →
`StartTransaction`) — plausibly untestable on this charger at all, see below. Confirmed on-device:
OCPP port bind (`:9000`), charger connect/bind, SolarFeed discovery, realtime widget,
**`TxDefaultProfile` writes (no transaction id known) are genuinely obeyed** - a real Wallbox with no
known transaction id went `Charging` → `SuspendedEVSE` → `0A` within ~1.2s of a `limit: 0`
`TxDefaultProfile` write being accepted, so OCPP profile precedence was not the blocker it might have
been - and that a Wallbox already `Charging` rejects a redundant `RemoteStartTransaction` without ever
sending `StartTransaction` - *why* it never grants one for a session it's already running remains
unconfirmed (idTag mismatch? `AuthorizeRemoteTxRequests` config? firmware quirk?), but is no longer
load-bearing since `TxDefaultProfile` writes work regardless.

On a plain unplug→replug (no schedule/solar target active), the same Wallbox went straight
`Available` → `SuspendedEV`, never reporting `Preparing` at all - confirmed on real hardware. It
self-authorized and started a transaction on its own (`StartTransaction` idTag `NoAuthorization`)
without the app ever issuing `RemoteStartTransaction` (gated on `lastStatusValue === 'Preparing'`,
which never occurred). Harmless here since `TxDefaultProfile` already had it pinned to the desired
current before the transaction existed, but it means this charger may just never route through the
app's `RemoteStartTransaction` call in practice - the schedule-starts-a-charge-from-cold path above
may be unverifiable on this hardware in its current local-auth config, not merely untested.

## Conventions
- Match the surrounding style. `'use strict'` + `import` + `module.exports = class …` for
  App/Driver/Device (Homey template); plain `export`/classes in `lib/`.
- Commit per logical change; see Commands above for the pre-commit checklist (build/test/lint/validate).
- User's global tooling prefs apply (`rg`/`fd`/`jq` etc.).
