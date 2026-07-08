# ChargeIQ

A [Homey Pro](https://homey.app) app that turns Homey into the **OCPP 1.6J Central
System** for a single [Wallbox Pulsar Max](https://wallbox.com) EV charger
(single-phase, 230 V, 6–32 A), and orchestrates charging across three
automatically-derived modes — **Manual**, **Scheduled**, and **Solar** — plus a
live power-flow dashboard widget.

App id: `family.bothe.chargeiq` · SDK v3, TypeScript · platform: `local`.

## What it does

- **Runs its own OCPP 1.6J Central System** on the LAN (default port `9000`) that
  the Wallbox connects to directly — no cloud, no vendor app required.
- **Derives a charging mode every tick**, in priority order:
  1. **Manual** — you've taken a hands-on action (toggle, current slider, or a
     Flow action). Sticky until a schedule window starts or the cable is
     unplugged and replugged.
  2. **Scheduled** — a configured weekly window is active (schedule beats solar).
  3. **Solar** — the default the rest of the time; follows real-time solar
     export/surplus so the car only draws power you'd otherwise send to the
     grid.
- **Applies a household grid-import cap** on top of whatever mode is active, so
  total home import never exceeds a configured ceiling (default 14 kW).
- **Never hard-stops a charging session.** Every "don't charge right now"
  decision pauses at 0 A instead of ending the OCPP transaction — some
  chargers (including the Pulsar) won't accept a new session again until the
  cable is physically unplugged and reinserted, so a real stop is avoided
  everywhere in the app.
- **Reads live solar production** from a paired SolarEdge integration
  (inverter/meter/battery power + battery SoC) to compute available surplus.
- **Pushes live state to a power-flow widget** — charger, solar, battery,
  house, and grid, with directional flow indicators and battery SoC.
- Exposes weekly schedule editing via the device settings page, and Manual
  start/stop/set-current, mode, and "is charging" as Flow cards.

## Requirements

- Homey Pro, firmware `>=12.4.5`.
- A Wallbox Pulsar Max (or another OCPP 1.6J charge point) able to reach
  Homey's LAN IP on the configured port.
- Optional: a paired SolarEdge Homey app/integration for solar-surplus mode
  and the widget's solar/battery/house readings. The charger and schedules
  work without it — solar mode just won't have anything to follow.
- Homey's configured timezone (Settings → General) should be correct — the
  underlying OS clock runs in UTC regardless, and schedule windows are
  evaluated against the Homey-configured timezone, not the system clock.

## Getting started

1. Install the app on your Homey Pro and add an **EV Charger** device.
2. Point your Wallbox's OCPP backend URL at `ws://<homey-ip>:9000/<identity>`
   (the identity Homey assigns during pairing).
3. Configure electrical limits (phases/voltage/min-max current) and load
   management in the device's advanced settings if the defaults don't match
   your install.
4. Add weekly charging windows from the device's settings page.
5. Optionally pair a SolarEdge integration for Solar mode.

## Development

```bash
npm run build                       # tsc -> .homeybuild/
npm test                            # tsc && node --test .homeybuild/test/*.test.js
homey app validate --level debug    # quick structural check
homey app validate --level publish  # full check (must pass before release)
homey app run                       # run on your Homey over LAN
```

`app.json` is generated from the `.homeycompose/` sources (capabilities, Flow
cards, driver settings) — edit those, then run `homey app build` to
regenerate it. Don't hand-edit `app.json` directly.

### Architecture

- `lib/ocpp/` — `CentralSystem` (the `ocpp-rpc` `RPCServer` wrapper) and
  `ChargePoint` (per-charger inbound handlers + outbound command wrappers,
  survives reconnects).
- `lib/control/ChargeController.ts` — the brain: binds to a `ChargePoint`,
  mirrors OCPP state onto Homey capabilities, and resolves the derived mode
  every 10 s tick.
- `lib/control/Scheduler.ts` — pure weekly-window evaluation (overlap
  detection, overnight wraparound, timezone-aware).
- `lib/control/SolarLoop.ts` — stateful PV-surplus follower with deadband,
  ramp limiting, and minimum on/off dwell times.
- `lib/solar/SolarFeed.ts` — reads the SolarEdge integration over the Homey
  API and emits merged power samples; best-effort, the charger works without
  it.
- `drivers/charger/` — the Homey device/driver; a thin adapter forwarding
  capability listeners and Flow calls into `ChargeController`.
- `widgets/power-flow/` — a self-contained, dependency-free dashboard widget
  driven by realtime pushes from the app (no widget/app API-fetch path).

Controllers and the Central System are Homey-independent (the host is a small
interface), so most logic runs and is tested in plain Node without the Homey
runtime. `test/sim-charger.ts` is an `ocpp-rpc` client simulator used to
exercise the real `CentralSystem` end-to-end without physical hardware.

See [CLAUDE.md](CLAUDE.md) for the full set of design invariants and gotchas
(mode-resolution rules, amp-flooring, OCPP write-throttling, etc.) if you're
working on the controller logic.

## Status

Core flows (OCPP connect/bind, capability mirroring, scheduling, solar
following, the widget) are built and tested. Some behaviors — exact
`SetChargingProfile` handling at 6 A/0 A, `TxProfile` vs `TxDefaultProfile`,
and RemoteStart idTag auth — are still being verified against real Wallbox
hardware; see [CLAUDE.md](CLAUDE.md) for the current list.

## License

GPL-3.0 — see [LICENSE](LICENSE).
