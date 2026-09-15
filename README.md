# lift

Supervisory motion-arbitration logic for the **Harmar Highlander II** platform lift, running on a **Shelly Pro 3** ("Lift", `shellypro3-8c4f008f5a18`, 192.168.40.105, Gen2, fw 2.0.0, no auth).

> **This is convenience logic, not a safety controller.** The Harmar factory controller retains full responsibility for gate locks, landing sensors, safety pan, final limits, E-stop, contactors, and brake. Nothing here alters or interacts with those circuits.

## Hardware reality

```
Physical UP buttons ──► Phoenix 24VDC relay ──► 120VAC ──► Shelly S1 (input:0)
Physical DOWN buttons ─► Phoenix 24VDC relay ──► 120VAC ──► Shelly S2 (input:1)

Shelly O1 (switch:0, dry) ──► Highlander J6 UP   (~25 VDC command)
Shelly O2 (switch:1, dry) ──► Highlander J6 DOWN (~25 VDC command)
O3/S3 unused/reserved
```

- All physical buttons are electrically disconnected from the lift; the Shelly is the sole arbiter between requests and J6.
- The Highlander sees the Shelly outputs as ordinary switch closures (effectively "top landing station" commands).
- Full travel ≈ 55 s under load, both directions.

## Firmware configuration (required)

| Setting                    | Value              | Why                                                                                                                                                           |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| switch:0 `auto_off`        | enabled, **55 s**  | Hard maximum UP command duration. Harmar limits stop motion; this just ends the command. Script never refreshes it.                                           |
| switch:1 `auto_off`        | enabled, **45 s**  | Same, DOWN.                                                                                                                                                   |
| switch:0/1 `initial_state` | **`off`**          | Fail-safe boot. ⚠️ Was `match_input` — with that, restoring power while a Phoenix relay is energized (stuck/welded button) would re-energize a motion output. |
| switch:0/1 `in_mode`       | **`detached`**     | Only the script commands O1/O2. ⚠️ Was Activation Switch.                                                                                                     |
| input:0/1 `type`           | `switch`           | Momentary press seen as level; script acts on `toggle` events.                                                                                                |
| Script                     | **Run on startup** | Buttons are dead without it once inputs are detached.                                                                                                         |

**Migration order matters:** upload script → enable run-on-startup → confirm running → _then_ set `in_mode: detached`. Detaching first leaves the lift with no working buttons.

Firmware Auto-Off is the backstop: if the script crashes or is stopped mid-trip, the active output still turns off at 55/45 s. The script must never re-issue `Switch.Set on` to extend a trip.

## Behavior specification (Model B)

States: `IDLE → PENDING → RUNNING → COOLDOWN → IDLE`, plus `FAULT`. A `jog` mode flag overlays them.

### Normal mode (tap = trip)

| Event                                      | Result                                                              |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Press UP or DOWN while IDLE                | 75 ms arbitration window, then latched full trip (Auto-Off ends it) |
| Same-direction press while pending/running | Ignored                                                             |
| Opposite press within arbitration window   | Trip cancelled, neither output fires, cooldown                      |
| **Any** press during a running trip        | **STOP** (never reverse), enter **jog mode**, cooldown              |
| Trip ends via firmware Auto-Off            | Reached a limit → cooldown → IDLE, stay in normal mode              |

### Jog mode (entered by interrupting a trip = platform mid-shaft)

| Event                                   | Result                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Press and **hold** (≥ 1 s)              | Output on while held; release = stop (fine positioning), stay in jog mode |
| Quick **tap** (< 1 s)                   | Latched full trip                                                         |
| Any run that ends via firmware Auto-Off | Drove to a limit → **exit jog mode**, back to tap-=-trip                  |
| Any press during a latched trip         | STOP, stay in jog mode                                                    |

### Invariants

1. O1 and O2 never ON simultaneously — verified before every trip _and_ watched via status handler.
2. State transitions to RUNNING **before** the relay is commanded ON (no accept-both race).
3. `Switch.Set` only; never `Switch.Toggle`.
4. 400 ms cooldown after any stop before re-arm.
5. Boot: both outputs forced OFF, state IDLE, jog cleared.
6. Trip refused if the opposite input is currently held (stuck button / welded Phoenix contact).
7. If both outputs are ever observed ON, or an output is ON when the arbiter believes it shouldn't be: force both OFF and enter **FAULT lockout** (cleared only by `cmd=reset` or script restart).

### Race handling

- **Near-simultaneous UP+DOWN:** first press → PENDING + 75 ms timer. Opposite press inside the window cancels; neither output fires. Same-direction duplicates ignored.
- **Event-order ambiguity at trip start:** state becomes RUNNING before `Switch.Set on`, so a press arriving between decision and relay closure is handled as "press during trip" (stop), never as a second acceptance.
- **Tap released before the arbitration window closes:** counted as a tap → latched trip (no orphaned hold-state).
- **Held past Auto-Off in jog mode:** firmware kills the output; release afterwards is ignored (edge-triggered inputs mean the button must be released and re-pressed for a new request).

## Remote control endpoint

The script registers an HTTP endpoint (Gen2 scripts cannot register RPC methods; `HTTPServer.registerEndpoint` is the supported mechanism):

```
http://192.168.40.105/script/<id>/lift            → status JSON
http://192.168.40.105/script/<id>/lift?dir=up     → request UP (same arbiter path as buttons)
http://192.168.40.105/script/<id>/lift?dir=down   → request DOWN
http://192.168.40.105/script/<id>/lift?cmd=stop   → stop a running trip (enters jog mode)
http://192.168.40.105/script/<id>/lift?cmd=reset  → clear FAULT lockout
```

HTTP requests are always treated as taps (latched trips) — hold semantics are physical-only.

### HomeKit plan (phase 2)

1. **Remove** the shelly-ds9 "Lift Switch" accessories from Homebridge — they issue direct `Switch.Set` and bypass the arbiter.
2. Add two momentary stateless switches in Homebridge (e.g., `homebridge-http-switch`) hitting `?dir=up` / `?dir=down`.
3. Wrap each in a HomeKit scene ("Lift up" / "Lift down") for natural Siri phrasing.

No call queuing: with no floor-position feedback wired to the Shelly, "elevator behavior" = mutual exclusion + Model B, not stored calls.

## Test plan

Use short Auto-Off values (e.g., 5 s) for steps 1–7, restore 55/45 for 8–9.

1. UP alone, DOWN alone → single latched trip each; Auto-Off ends command.
2. Repeated same-direction presses during a trip → first press stops (Model B); verify jog mode entered.
3. Opposite press during a trip → stop, **no reversal**, jog mode.
4. Near-simultaneous UP+DOWN from IDLE → neither output fires.
5. Jog mode: hold ≥ 1 s → runs while held, stops on release; tap < 1 s → full trip; trip to Auto-Off exits jog mode.
6. Stuck input: hold one button, press the other from IDLE → refused.
7. FAULT: manually `Switch.Set` an output ON via RPC while IDLE, then press a button → both forced OFF, lockout; `cmd=reset` clears.
8. Reboot mid-trip → both outputs OFF at boot, state IDLE.
9. Stop the script mid-trip → firmware Auto-Off still ends the trip.
10. Throughout: confirm O1 and O2 are never ON together (watch both channel LEDs / status).

## Files

- [scripts/lift-arbiter.js](scripts/lift-arbiter.js) — the Shelly script (single `request()` entry point for all sources).
