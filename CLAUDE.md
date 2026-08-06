# ChargeIQ — Homey Pro EV charging app

Self-contained Homey Pro app (SDK v3, TypeScript, CommonJS output) that is the **OCPP 1.6J
Central System** for one **Wallbox Pulsar Max** (single-phase, 230 V, 6–32 A) and orchestrates
charging across three derived modes, plus a live power-flow dashboard widget. App id
`family.bothe.chargeiq`, compatibility `>=12.4.5`, platform `local`.

**Single-charger by design (for now).** The OCPP/control layers are per-identity and would run
several chargers, but the shared electrical limits (household grid cap, charger-circuit cap, solar
surplus) are enforced per-controller with no cross-charger coordination, so pairing is capped at one
device (`lib/pairing.ts` → `resolvePairList`, enforced in `drivers/charger/driver.ts`'s `list_devices`
pair handler). The app→widget→schedule glue also assumes `devices[0]`. See `docs/MULTI_DEVICE.md` for
the full gap analysis and what lifting the cap would require — don't add a second driver/device path
without reading it.

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
  and the `parseMeterValues` → W/A/V/kWh helper. `ChargePoint` also owns the **liveness
  watchdog** — see the OCPP connectivity section below.
  `leanValidators.ts` **must be called before the `ocpp-rpc` require** in `CentralSystem.ts`
  (it is, on the line above it) and owns `OCPP_SUBPROTOCOL`, the one protocol the `RPCServer`
  advertises. `ocpp-rpc`'s `lib/standard-validators` eagerly builds Ajv validators for
  ocpp1.6 **and 2.0.1 and 2.1** at require time, from the top of its own `server.js`, with no
  option to narrow it (`strictModeValidators` only *adds*) — ~1.5MB of schema JSON parsed into
  retained object graphs for protocols this app can never negotiate. Seeding `require.cache`
  with a 1.6-only list is the only lever, since the offending require runs before any option
  could be passed. Measured on the compiled app (3 runs, ±0.5MB): **89.6 → 74.5MB RSS,
  13.93 → 11.87MB heap** — the largest single line item in this app's footprint, and Homey
  reports RSS. Full ocpp1.6 schema validation is untouched. Going further is not possible:
  with an empty list `RPCServer` throws `Missing strictMode validator for subprotocol
  'ocpp1.6'` at construction, so dropping Ajv would mean hand-rolling OCPP validation. It
  reaches into `ocpp-rpc`'s internal file layout, so it fails soft (ocpp-rpc just loads
  normally) and `test/lean-validators.test.ts` asserts it actually took effect — that test
  is what turns an ocpp-rpc upgrade moving those paths into a visible failure rather than a
  silently surrendered 15MB. **Don't "simplify" the ordering, the constant, or that test.**
- `lib/solar/SolarFeed.ts` — reads the user's SolarEdge app (`bothe.family.solaredge`) over the
  HomeyAPI: `measure_power` on inverter/meter/battery + `measure_battery` SoC. Emits a merged
  `SolarSample`; **house load is derived** (`pv + gridSigned − batterySigned`). Best-effort —
  the charger still works without it. See `memory/solaredge-feed-contract.md`.
  **Discovery is not one-shot.** A `RESCAN_INTERVAL_MS` (5 min) timer calls `checkAndRecover()`,
  which rebuilds the subscriptions when the feed looks dead — nothing useful discovered, or nothing
  received for `FEED_SILENT_MS` (30 min, deliberately generous since Homey only fires a capability
  listener on an actual *change*, so a healthy feed can legitimately be quiet). It's armed
  *before* the first discovery, so a discovery that fails outright (HomeyAPI not up, SolarEdge app
  still starting) is retried instead of being the only attempt — previously either of those left
  solar mode silently dead for the app's whole lifetime, since `discover()` ran once from `start()`
  and nothing ever re-looked. `discover()` rebuilds `present` from what it actually finds, but only
  *after* `getDevices()` succeeds, so a failed rescan doesn't blank known-good state.
  `checkAndRecover(now?)` is public purely so tests can drive it without waiting on real time.
- Widget state is **pushed** to the widget via `this.homey.api.realtime('powerflow', …)` every
  10 s (`startWidgetBroadcast`). This is the widget's ongoing data channel. Immediate first paint
  on load goes through a **widget-scoped** pull endpoint (`widgets/power-flow/api.js`'s
  `getState`, declared in `widget.compose.json`'s own `api` block, calling `homey.app
  .getWidgetState()` — the same merged state the broadcast sends), not the app-level `api.ts`. See
  the Widget section below for the routing details.

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
Priority **Manual > Scheduled > Solar > Idle**, recomputed every tick:
- **Manual** — a *manual latch* is set. Any hands-on action sets it: `evcharger_charging` toggle,
  `charge_current_limit` slider, or Flow start/stop/set-current (`on`/amps → charge, `off` → off).
  Persisted in device store; cleared **only** when a schedule window *starts* (rising edge) or the
  charger is *unplugged→replugged* (OCPP `Available` → plugged edge).
- **Scheduled** — no latch and inside a `Scheduler` window (schedule beats solar).
- **Solar** — default outside schedules with no latch, when the `solarEnabled` device setting
  (default on) is true; follows excess via `SolarLoop`.
- **Idle** — no latch, not in a schedule window, and `solarEnabled` is false. Holds at 0A, same as
  a paused Solar session, but labelled honestly rather than as `solar` when nothing is actually
  being tracked. **`solarEnabled:false` only gates mode resolution** — `onSolarSample()`/`SolarLoop`
  keep running regardless, so `measure_solar_surplus`, the household cap, and the charger-circuit cap
  all stay live and re-enabling takes effect on the very next tick, not just the next solar sample.

The **household grid-import cap** is configured in amps, not watts, since main breakers/fuses are
amp-rated in practice: `maxHouseholdA` (per-phase main fuse rating, default 63A) and
`householdPhases` (the *household's own* supply phase count, default 1 - independent of the
charger's own `phases` setting, since a single-phase charger on a 3-phase household connection is
common). `refreshConfig()` derives the actual Watts ceiling used everywhere downstream
(`householdCapAmps()`, `getDiagnostics().limits.gridMaxW`, the `[decision:...]` log) as
`maxHouseholdA * voltage * householdPhases` into `ControllerConfig.maxHouseholdW` - only that
derived field is read internally; `maxHouseholdW` is no longer itself a settings id. Applies on top
in every mode.
`charge_mode` is a **read-only** metric (manual/scheduled/solar/idle). `getModeInfo()` →
`{mode, detail}` drives the widget's `Mode: X · detail` line.

The **charger-circuit cap** (`sharedCircuitA`/`sharedCircuitBufferA` in code and store, both default
0/disabled; labelled "Charger circuit rating/buffer" in the settings UI) is a second, independent
hard ceiling for the charger's own circuit/breaker when it's rated lower than the rest of the house
— whether dedicated to the charger alone (e.g. a standalone 32A breaker) or shared with other
equipment (e.g. a home battery inverter on the same breaker as the charger) — `sharedCircuitA + pv −
battery − buffer` (amps), reading live `pvW`/`batteryW` off the solar feed. Whether pv and battery
actually factor in is per-component config, not assumed: `sharedCircuitIncludeSolar`/
`sharedCircuitIncludeBattery` (both default **false**) opt each term in independently, since this
circuit doesn't necessarily involve solar or a battery at all. If **both** are off, the cap
collapses to a plain static `sharedCircuitA − buffer` with no dependency on the solar feed
whatsoever — no staleness gate either, so it works for a circuit with no solar/battery integration
at all (see `sharedCircuitCapAmps()`). It applies in every mode alongside the household cap. A
schedule window can opt in to **boosting** above its `currentA` up to this cap via
`ScheduleWindow.boostToCap` — `currentA` becomes a floor, not a fixed target, so solar (or the
battery simply not charging as hard as assumed) can push the current higher. Battery **discharge**
is deliberately excluded from the boost calc (`ChargeController.scheduledAmpsDetail`) even though it
legitimately raises the safety-cap ceiling — the home battery must never fund extra EV current
beyond the configured floor, only genuine spare circuit capacity may. This discharge-blocks-boost
rule itself only applies when `sharedCircuitIncludeBattery` is on — otherwise the battery isn't part
of this circuit and its state has no bearing on it.

### OCPP connectivity (offline detection + reporting)
The app is the OCPP *server*, so "is the charger there?" is only ever inferred — nothing polls it.
Three layers, because each covers a failure the others miss:
- **`ChargePoint`'s liveness watchdog.** Every inbound message goes through the `handle()` wrapper
  in `attach()` (register a handler on `client` directly and it silently stops counting as contact)
  which stamps `lastSeenAt` and restarts a `livenessTimeoutMs` countdown — `max(90s, heartbeat × 3)`,
  0 to disable. On expiry it emits `stale` + `disconnect`, drops `this.client` **first**, and only
  then force-terminates the socket. Order matters: a *half-open* socket is exactly the case where the
  close handshake never returns, and `ocpp-rpc`'s own ping/pong is answered by the peer's ws layer,
  so a charge point that has stopped participating in OCPP entirely can still look connected
  indefinitely with no `close` event to learn from. `force: true` skips awaiting pending calls, which
  on a dead link never settle. The existing close listener self-guards on `this.client === client`,
  so a late (or never-arriving) close can't double-fire `disconnect`.
- **`ChargeController`'s link state.** Tri-state on purpose: `online` is `null` until either a bind
  or `STARTUP_GRACE_MS` (120s) resolves it — "we haven't heard yet" is not the claim "it's offline",
  and without the grace window every app restart would report a spurious offline→online round trip
  and fire the Flow trigger for it. `null → true` is therefore silent; `null → false` (grace expired,
  nothing there) and `true → false` both report. `lastSeenAt` is **persisted** (`ocppLastSeenAt`
  store key, written through at most every `LAST_SEEN_PERSIST_MS`, forced on the disconnect edge) so
  an outage spanning an app restart is still measurable — without it a 12-hour-dark charger reads as
  freshly gone. In `bind()`, `setOnline(true)` must run **before** `noteLastSeen()`, or the recovery
  measures the outage against the reconnect it just made and always reports ~0s.
- **Reporting.** `setUnavailable()` on the device, `charger_offline`/`charger_online` Flow triggers
  (+ a `charger_is_online` condition, for "every hour, if offline, notify me"), `online`/`lastSeenAt`
  /`offlineSince` in the widget state, and an `OFFLINE <age>` note on every `[decision:…]` line.

`nettedChargerW()` treats offline-while-last-known-`Charging` as **unknown** (`null`), a fourth
variant of the same don't-guess rule as the three below: the charge point keeps running whatever
profile it was last given, so the car may well still be drawing, and `lastPowerW` is now as old as
the outage. A non-`Charging` last status still nets as a confirmed `0` — conservative, and it keeps a
never-connected charger from disabling every cap permanently.

The widget's own `.stale` dimming is **not** this: it only fires when the *app's* 10s broadcast stops,
which a charger outage doesn't affect at all. That is what let a 12-hour-old `plugged_in` render as a
live `READY` chip. `PF.isOffline()` gates strictly on `online === false` so `null`/absent (grace
window, or an older state payload) never reads as an outage, and offline outranks any cached
`chargingState`; EV power renders `–` (unknown), not the last figure before the charger vanished.

### A resolved target is not an applied one
`[decision:…]` logs what the controller *decided*; two separate things can stop that reaching the
charger, and both now say so on the same line rather than reading like a successful apply:
- `OFFLINE …(not sent)` — no OCPP link (see the connectivity section above).
- `NOT SENT (<reason>)` — connected, but `ensureCharging()` isn't write-eligible. `writeBlockedBecause()`
  mirrors that eligibility test purely to report it. The reason that matters is **`Finishing`**: it is
  in `PLUGGED` but explicitly excluded from `ensureCharging()`'s `plugged`, and `onStatus()`'s
  Finishing branch clears `transactionId`, so `eligible` is false *for as long as the charger sits
  there*. Confirmed on real hardware: a charger restart mid-schedule ended its session with
  `PowerLoss`, the Wallbox parked in `Finishing`, and the app then spent 3m14s resolving 21A → 22A →
  23A — updating `desiredAmps` and `charge_current_limit` each time — without attempting one write,
  while every log line still read `-> 23A`. Only a physical unplug/replug (`Finishing → Available →
  SuspendedEV`) cleared it, which is the documented Wallbox behaviour, not something the app can
  drive. So the app **reports** it (`needsReplug` → a device warning asking for the replug) rather
  than trying to force its way out. `Available`/"nothing plugged in" is logged the same way but
  deliberately raises **no** warning — that's an ordinary idle state, not something to nag about.
- `refreshWarning()` is the single owner of `setWarning`: a fault outranks the replug prompt, and
  neither can clobber the other. `onStatus()` previously wrote the banner directly on every status,
  which cleared anything set between reports.
- Becoming write-eligible again (`regained`) is **urgent** — it bypasses `writeThrottleMs` like a
  tightening cap does. The charger is running whatever profile predates the gap, and the target
  usually hasn't changed across the transition (it kept moving while blocked), so the write is
  triggered only by the eligibility edge; making it wait out the throttle would leave the charger
  wrong for up to 15s right after the user physically intervened.

### `transactionId` has two sources, and the charge point's wins
`ChargePoint`'s `StartTransaction` handler allocates the id and answers the charger **whether or not
a controller is listening** — a device still initialising while the OCPP connection is already up
misses the `startTransaction` event entirely, and nothing persists the id. Confirmed on real
hardware: the app held 48 while the charger's live session was 49, so every `TxProfile` write went to
a transaction that didn't exist and came back `rejected`. `ChargePoint` therefore records what it
handed out (`getLastTransactionId()`, same late-binder rationale as `getLastStatus()`/
`getLastReadings()`), and `bind()` → `adoptTransactionId()` takes it over the stored value. A **null**
on the charge point's side is never adopted — that just means no `StartTransaction` this connection,
which is exactly the restart-onto-a-live-session case the stored id exists for. `onStopTransaction()`
logs any surviving mismatch, and a rejected `TxProfile` now retries once as `TxDefaultProfile`
(no id needed, and already confirmed obeyed on this hardware) instead of waiting for the target to
next move.

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
  found via a real-hardware log where the charger-circuit cap tightened twice in ~20s as a home
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
  device). The charger-circuit cap uses this directly (no grid-based proxy), which is *why* the
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
  The two recurring-report logs are the deliberate exception to that verbosity, because they repeat
  for the lifetime of the app rather than per decision: `[charger] power=…` only logs on a >=100W
  move (`loggedPowerW`), and `[solar] …` is deduped on a rounded-to-50W fingerprint of its own
  fields plus `SolarLoop`'s state (`loggedSolar`). Both were briefly unthrottled under a `TEMP
  debugging` marker while the OCPP/solar paths were being confirmed on hardware; that's done, and
  the throttles are back. `SolarFeed`'s per-role `[solar] raw … update` lines existed only for that
  same exercise and are gone entirely - the merged `[solar]` line covers it.
- **`parseMeterValues()` reports what it drops.** Anything outside the four measurands it maps
  (`Power.Active.Import`/`Current.Import`/`Voltage`/`Energy.Active.Import.Register`) lands in
  `Readings.unhandled` as `measurand -> "value unit @phase"` - captured *before* the numeric check,
  so a non-numeric unknown counts too - and `ChargeController.logUnhandledMeasurands()` logs each
  name **once per app run** (`loggedMeasurands`, not cleared on rebind - a reconnect doesn't change
  what the charger sends). Purely diagnostic; nothing reads it. It exists because OCPP 1.6 carries
  almost nothing about the *vehicle* - `SoC` (the one real EV datum, and only over ISO 15118, not
  plain PWM), `Current.Offered`, `Temperature`, or a vendor measurand would otherwise be discarded
  in silence, so this makes what a real Wallbox actually sends discoverable from `homey app run`
  rather than assumed.
- Settings pages must include `<script src="/homey.js" data-origin="settings">`; widgets get their
  runtime injected automatically (no include, and keep widget JS **inline/single-file**).

## Widget
`widgets/power-flow/public/index.html` is self-contained. Its presentation logic lives between the
`POWERFLOW-LOGIC-START/END` markers; `test/powerflow.test.ts` extracts and evaluates that exact
block, so keep it dependency-free (no imports). It renders live even when the charger is unplugged;
dims (`.stale`) after ~50 s (5 missed 10s broadcasts) without a realtime update and auto-recovers.

**Immediate first paint on load pulls once via `widgets/power-flow/api.js`'s `getState`
endpoint** (declared in `widget.compose.json`'s own `api` block, not the app-level `api.ts`),
called with `Homey.api('GET', '/state', {}).then(onData)` in `onHomeyReady` before the realtime
subscription's first push can arrive - otherwise the widget sits on its empty initial `render({})`
for up to a full 10s broadcast-interval on every dashboard load. Modeled on
`family.bothe.dexcom`'s `glucose-dashboard` widget, which uses the same widget-scoped-`api.js` +
`widget.compose.json`-declared-`api` pattern. **Confirmed working on-device**: `homey app run`
shows `[widget-api] getState hit` on widget load. `test/widget-preview.html` cannot exercise this
transport (no `Homey` stub, so `onHomeyReady` never runs there) - it only covers the render path.

Almost every color/spacing/typography/border-radius value in the widget is a bare Homey CSS
variable or `.homey-*` class (`--homey-su-*`, `--homey-color-*`, `--homey-text-color*`,
`--homey-border-radius-*`, `--homey-icon-size-*`, `.homey-widget`, `.homey-text-*`) with **no
local fallback** - by design, to stay a good dashboard citizen (see
https://apps.developer.homey.app/the-basics/widgets/styling), but it means the widget renders
unstyled (default browser fonts/colors, square corners) anywhere those aren't injected, i.e.
outside the real Homey app. The handful of exceptions are genuinely bespoke tokens with no Homey
equivalent: `--flow`/`--bus-import/export/neutral-a/b` (decorative/status gradients, still
per-theme via their own `@media (prefers-color-scheme)` block), `--tile`/`--conn-static`/
`--meter-track` (derived via `color-mix()` off `--homey-text-color`/`--homey-background-color`,
not aliases of a single Homey var), and the battery gauge's 50%-tier color (`color-mix()` of
red/green - Homey has no yellow token) and its null/no-data gray.

For visual iteration without a real Homey device, `test/widget-preview.html` +
`test/homey-css/widgets/` (Homey's own real widget Style Library - see that folder's `README.md`)
are dev-only tooling (not part of `npm test`, never shipped - nothing in
`widget.compose.json`/`app.json` references `test/`). The preview page loads the real,
**unmodified** widget file in an iframe and links `homey.widgets.css` (the real manifest) into it
after load, so the shipped file is never touched or duplicated. Must be served over http(s) (e.g.
`python3 -m http.server` from the repo root) rather than opened via `file://`, since same-origin
iframe access is required to link the stylesheet and call the widget's own `render()` directly. It
has a Light/Dark toggle (no OS "Auto" - a real widget gets one pre-resolved theme's `--homey-*`
values injected server-side, same reasoning as the widget's own top-of-file comment, so there's no
media query to follow) and preset buttons that fill a JSON textarea rather than rendering
immediately, so a preset is a starting point to tweak before hitting "Apply state", not a one-shot
action. `_homey-variables.css` carries a `.homey-dark-mode` override block, and the toggle sets
that class on the iframe's `<html>` - a different mechanism from the pair/settings invert-filter
(same README, "Dark mode"). The harness's own CSS-completeness probe banner reports any missing
file live. Real on-device verification (exact fonts/colors, anything the fetched CSS doesn't
cover) still needs `homey app run`.

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

### Memory: audited, and the result is "load-time, not leaks"
Done 2026-08-06 against the compiled output, so it doesn't need redoing from scratch. Three soak
runs, all flat:
- **60 OCPP connect/disconnect cycles** (real `CentralSystem` + `SimCharger` over a live socket):
  heap 10.40 → 11.22MB, `ChargePoint` listeners pinned at `stale:1 disconnect:1`, one retained
  `ChargePoint`. `attach()`'s client swap and `CentralSystem`'s `isNew` guard both hold.
- **200 `ChargeController` `init()`/`destroy()` cycles** against a live `ChargePoint`: listener
  counts never moved off baseline — `csTeardowns`/`cpTeardowns` do their job.
- **200,000 solar samples → ticks** (~23 simulated days): heapUsed **10.01 → 10.30MB**. The hot
  path retains nothing.

So the footprint is essentially all `require`-time: `socket.io-client` ~18MB RSS (the price of
`HomeyAPI.createAppAPI()`, which `SolarFeed` needs — there is no other cross-app device access in
SDK v3), `ws` ~10MB, Ajv + the ocpp1.6 schema ~11MB. **Bundling/tree-shaking is the wrong lever
and was rejected on measurement, not taste**: Homey ships `node_modules` and runs plain CommonJS,
and the cost is *data* allocated at load (parsed schemas, Ajv structures, socket.io's prototype
graph), not dead code a bundler could drop — tree-shaking a 1MB JSON schema that is `require`d,
not imported, does nothing. The one genuinely removable item was the unused OCPP 2.x validators;
see `leanValidators.ts` in Architecture.

`SolarFeed.discover()` passes `$cache: false, $updateCache: false` to `getDevices()`. homey-api's
`ManagerDevices` otherwise caches a `getAll` by pinning a full `Device` for **every** device on the
Homey and marking the cache complete, retained for the app's lifetime, for the sake of the three
SolarEdge devices actually wanted. It happens not to fire today — caching is gated on the *manager*
namespace being connected to socket.io, and `makeCapabilityInstance` only ever connects each
`Device`'s own namespace — so that flag pins current behaviour rather than fixing a live leak.
`$cache: false` is load-bearing in its own right though: a rescan served the cached map wouldn't
re-look at all, which is the entire point of `checkAndRecover()`.

## Not yet verified on hardware
The **liveness watchdog** firing against a genuinely half-open link (the failure it exists for) —
`ChargePoint`'s unit tests drive it with a short `livenessTimeoutMs` and a fake client, which proves
the timer/teardown logic but not that a real wedged Wallbox link reaches it before `ocpp-rpc`'s own
ping timeout does. Whether the 12h outage that prompted this fired `disconnect` at all is unknown
(the old code logged nothing distinguishable); `[ocpp] offline (…)` now makes the next one legible
either way.

`SetChargingProfile` behaviour at exactly 6A (as opposed to 0A, confirmed below), and a live schedule
window actually *starting* a charge from cold (`Preparing` → accepted `RemoteStartTransaction` →
`StartTransaction`) — plausibly untestable on this charger at all, see below. Confirmed on-device:
OCPP port bind (`:9000`), charger connect/bind, SolarFeed discovery, realtime widget, the widget's
`getState` pull endpoint (Widget section above - `homey app run` shows `[widget-api] getState hit`),
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

**Whether a widget's WKWebView propagates Homey's resolved app theme (Settings > Appearance:
Light / Dark / System) as `prefers-color-scheme`, or instead leaves it tracking the raw OS/browser
state regardless of what Homey resolved to, is unconfirmed.** `widgets/power-flow/public/index.html`
asserts the latter (its top-of-file comment and the `--icon-blue` `@media` fallback comment near the
top of its `<style>` block) as the reason `--icon-blue` needs an `@media (prefers-color-scheme: dark)`
fallback rather than trusting the media query alone - but that assertion is this codebase's own,
not independently verified on a real device. `test/widget-preview.html`'s "OS only" theme button
exists to make this case previewable (clears the forced `.homey-dark-mode` override so only the
real OS/browser `prefers-color-scheme` drives that fallback), but it can only simulate the
disagreement, not confirm which way a real widget WKWebView actually behaves.

## Conventions
- Match the surrounding style. `'use strict'` + `import` + `module.exports = class …` for
  App/Driver/Device (Homey template); plain `export`/classes in `lib/`.
- Commit per logical change; see Commands above for the pre-commit checklist (build/test/lint/validate).
- `.homeyignore` excludes `test/` and `docs/`. The dev-only preview harnesses were being shipped
  despite nothing in `app.json`/`widget.compose.json` referencing them (`test/homey-css` alone is
  ~1.7MB of Homey's own Style Library). `npm test` is unaffected — it runs `tsc` against the source
  tree, not the Homey CLI's build, so `.homeybuild/test/*.test.js` is still produced. That is also
  why ~260KB of *compiled* test JS still lands in `.homeybuild`: `tsconfig.json` has no `exclude`,
  and adding one would break `npm test`. Not worth a second tsconfig for 260KB of disk.
- User's global tooling prefs apply (`rg`/`fd`/`jq` etc.).
