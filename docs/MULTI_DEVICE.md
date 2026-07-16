# Multi-charger support — status and gaps

**Current state: ChargeIQ enforces a single paired charger.** The OCPP/control
plumbing is per-identity and would already run several chargers side by side, but
the *shared electrical limits* are enforced per-controller with **no cross-charger
coordination**, so pairing a second charger would silently give uncoordinated
grid/breaker limits. Pairing is therefore capped at one device
(`lib/pairing.ts` → `resolvePairList`, called from `drivers/charger/driver.ts`'s
`list_devices` pair handler). This document records what would be required to lift
that cap, so the decision doesn't have to be re-derived later.

## What is already multi-charger (needs no change)

Everything keyed by OCPP identity:

- **`lib/ocpp/CentralSystem.ts`** — `Map<identity, ChargePoint>`, emits
  `chargePoint`/`connect`/`disconnect` per identity.
- **`lib/ocpp/ChargePoint.ts`** — one instance per identity, survives reconnects.
- **`lib/control/ChargeController.ts`** — one per device; binds only to its own
  `host.identity` and ignores other identities' connect/disconnect events.
- **Pairing** — `list_devices` already enumerates every connected identity (the
  single-charger cap is the only thing stopping more than one being added).
- **`drivers/charger/device.ts`** — each device builds its own controller and
  solar subscription.
- **`lib/solar/SolarFeed.ts`** — a single app-level feed shared by all devices
  (correct; sharing it is fine).
- **Transaction IDs** — allocated from one monotonic app counter (`app.ts`).

## What must change to support multiple chargers

### Bucket A — app→widget→schedule glue (cosmetic, ~half a day)

The app addresses only the first device:

- `app.ts` `getChargerDevice()` returns `devices[0]`. A second charger is
  **invisible in the widget** (`getWidgetState`) and its **schedule is
  un-editable** via the settings page (`app.ts` `getSchedule`/`setSchedule` →
  `api.ts` → `settings/index.html`).
- The **Power Flow widget is a single app-level instance** (`widgets/power-flow/`,
  no device binding, one `realtime('powerflow', …)` broadcast). Needs per-device
  widget instances or a device picker, and the broadcast keyed by device.
- The **schedule editor** in `settings/index.html` needs a device selector.

### Bucket B — shared electrical limits (hard, and safety-relevant)

This is the real blocker. Three shared resources are each consumed by every
controller **independently, with no arbitration**:

1. **Household grid cap** (`maxHouseholdA`/`householdPhases`, derived internally into
   `maxHouseholdW`, `ChargeController.householdCapAmps`).
   Each controller computes headroom as `maxHouseholdW − (grid − ownDraw)` — it
   nets out only its *own* draw (`nettedChargerW()` has no concept of siblings)
   and treats a sibling's draw as fixed base load. Two chargers independently see
   the same spare headroom on a tick and both ramp into it → oscillation and
   transient breaches of the import limit, worsened by the 15s write throttle.

2. **Charger-circuit cap** (`sharedCircuitA`, `ChargeController.sharedCircuitCapAmps`).
   Same structure, but this protects a **physical breaker**. Two chargers each
   believing they own the full circuit rating can genuinely overload the shared
   conductor — a safety regression, not just jitter.

3. **Solar surplus** (`SolarLoop`). Both loops read the same grid-export figure
   and each nets out only its own draw → both claim the same surplus,
   double-allocating export.

Doing this correctly needs a new **site-level load allocator**: one component
that knows total site import, total charger-circuit current, and total surplus,
and *divides* the budget across the N active chargers (by priority / proportion /
round-robin), handing each its slice as a ceiling. The per-charger caps then
consume their allocated slice instead of the whole limit.

It also forces a **settings model change**: `maxHouseholdA`, `householdPhases`, `sharedCircuitA`,
and `sharedCircuitBufferA` are currently **per-device settings**
(`drivers/charger/driver.settings.compose.json`). They describe one physical
house / one physical circuit — with two devices you'd have two conflicting copies
of a single real-world limit. They must move to app-level config, plus a model of
*which chargers share which circuit* (chargers on separate circuits don't
contend; chargers on the same one do).

## Effort summary

| Path | Work | Risk |
|---|---|---|
| **Enforce single** (chosen) | Cap pairing at 1 device + test + this doc | Low |
| **Proper multi** | Site load-coordinator + allocation policy (the bulk); move caps to app-level config + circuit-grouping model; per-device widget/broadcast; device-selecting schedule editor; replace every `devices[0]`; N-charger test matrix | High — safety-critical caps |

If revisiting: start with Bucket B (the allocator and the cap/settings model) —
it's the load-bearing part. Bucket A is glue that only matters once more than one
charger can actually be added.
