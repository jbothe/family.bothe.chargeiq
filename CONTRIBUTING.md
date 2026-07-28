# Contributing to ChargeIQ

ChargeIQ is a personal Homey Pro app: an OCPP 1.6J Central System for a single
Wallbox Pulsar Max, wired into a SolarEdge feed. It is shared in case it is
useful, and issues and pull requests are welcome — but it is shaped around one
household's hardware, so please read the scope note below before filing.

## Before you file an issue

Most of this app's behaviour is a response to something a real charger actually
did, and those reasons are written down. [CLAUDE.md](CLAUDE.md) documents the
design invariants and the hardware quirks behind them — why the controller never
issues `RemoteStopTransaction`, why a lone `Available` report is debounced, why
amps are always floored, and so on. If something looks wrong, check there first:
it may be deliberate, with the incident that caused it recorded next to it.

A useful bug report includes:

- What you expected, and what happened instead.
- Your charger make/model and firmware, since almost all of the hard-won
  behaviour here is charge-point-specific.
- The relevant `homey app run` log lines. `[decision:<trigger>]` is logged on
  every controller tick and spells out the resolved mode, both hard caps, and
  the final current — usually the fastest way to see what the app thought it was
  doing.

## Hardware scope

The app is deliberately single-charger. The OCPP and control layers are
per-identity and would run several, but the shared electrical limits (household
grid cap, charger-circuit cap, solar surplus) are enforced per-controller with no
cross-charger coordination, so pairing is capped at one device. Read
[docs/MULTI_DEVICE.md](docs/MULTI_DEVICE.md) before proposing multi-charger
support — the gaps there are safety-relevant, not cosmetic.

Support for other chargers, or a different solar source, is not something this
repo can test. A PR adding either is likelier to land if it leaves the existing
path untouched and is explicit about what was and wasn't verified on real
hardware.

## Pull requests

Before any commit, all four of these must be clean — a green `npm test` does not
imply the others:

```bash
npm run build && npm test && npm run lint && homey app validate --level publish
```

`npm run lint` must report zero *problems*, not just zero errors; fix warnings
rather than suppressing them. `homey app validate` should show only the expected
`homey:manager:api` review notice.

Beyond that:

- Don't hand-edit `app.json` — it is generated from `.homeycompose/`.
- New behaviour in `lib/**` should land with a test in the same commit. Prefer a
  pure function plus a `node:test` over anything needing the Homey runtime; the
  controller and Central System take injected hosts and fakes precisely so they
  run in plain Node. `app.ts`, `api.ts` and the driver/device adapters are the
  deliberate exception — they have no seam to fake the SDK.
- Match the surrounding style, and keep each commit to one logical change.
- If you hit a real hardware quirk, write it into CLAUDE.md next to the code that
  works around it. That file is the reason this app behaves sanely.
