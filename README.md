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

## Behavior specification (simplified gestures, rev 5)

States: `IDLE → PENDING → RUNNING → COOLDOWN → IDLE`, plus `FAULT`. A `jog` mode flag overlays them. **The second press of a gesture must land within 1 s of the first.**

### Normal mode

| Gesture                                  | Result                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Single press                             | Latched full trip, starting after the 1 s gesture window (Auto-Off ends it) |
| **Two quick presses**                    | **Jog mode ON** — trip cancelled, no motion                                 |
| Opposite press within the pending window | Trip cancelled, neither output fires, cooldown                              |
| **Any** press during a running trip      | **STOP** (never reverse) — press again = full run that direction            |

### Jog mode (fine positioning)

| Gesture                                              | Result                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Press and **hold**                                   | Output on while held (75 ms arbitration); release = stop                    |
| Quick **tap** (< 400 ms), then **press** within 1 s  | **Jog mode OFF + immediate latched full travel in that direction**          |
| Run reaches a limit (Auto-Off / dead reckoning / S3) | Floor declared; jog persists until the tap+press exit                       |

HTTP/HomeKit requests are always latched full trips in either mode (75 ms window only); `?cmd=jog` toggles jog mode remotely. Hold UP+DOWN 3 s = hard reset from any state.

### Invariants

1. O1 and O2 never ON simultaneously — verified before every trip _and_ watched via status handler.
2. State transitions to RUNNING **before** the relay is commanded ON (no accept-both race).
3. `Switch.Set` only; never `Switch.Toggle`.
4. 400 ms cooldown after any stop before re-arm.
5. Boot: both outputs forced OFF, state IDLE, jog cleared.
6. Trip refused if the opposite input is currently held (stuck button / welded Phoenix contact).
7. If both outputs are ever observed ON, or an output is ON when the arbiter believes it shouldn't be: force both OFF and enter **FAULT lockout** (cleared only by `cmd=reset`, the UP+DOWN hold, or script restart).

### Race handling

- **Near-simultaneous UP+DOWN:** first press → PENDING (1 s normal / 75 ms jog+HTTP). Opposite press inside the window cancels; neither output fires.
- **Event-order ambiguity at trip start:** state becomes RUNNING before `Switch.Set on`, so a press arriving between decision and relay closure is handled as "press during trip" (stop), never as a second acceptance.
- **Stop racing our own ON echo:** the commanded-ON status event may arrive after a stop already landed; tracked via `onPending` so it is never mistaken for a rogue output (was a real fuzzer-found bug).
- **Stop racing Auto-Off:** `stopping` is only armed if an output is actually on, so a swallowed off-event can't strand the flag.
- **Double-press:** the 2nd press cancels the trip while it is still PENDING — motion never starts mid-gesture; the jog-exit press deliberately starts travel (that IS the gesture).
- **Held past Auto-Off in jog mode:** firmware kills the output; release afterwards is ignored (edge-triggered inputs mean the button must be released and re-pressed for a new request).

## Remote control endpoint

The script registers an HTTP endpoint (Gen2 scripts cannot register RPC methods; `HTTPServer.registerEndpoint` is the supported mechanism):

```
http://192.168.40.105/script/1/lift             → status JSON {result, state, dir, jog, pos}
http://192.168.40.105/script/1/lift?dir=up      → request UP (same arbiter path as buttons)
http://192.168.40.105/script/1/lift?dir=down    → request DOWN
http://192.168.40.105/script/1/lift?cmd=stop    → stop a running trip (enters jog mode)
http://192.168.40.105/script/1/lift?cmd=reset   → hard state reset (any state incl. FAULT; keeps position)
http://192.168.40.105/script/1/lift?cmd=hist    → status + last 15 log lines (diagnostics)
http://192.168.40.105/script/1/lift?set=top|bottom|mid → manual position calibration (IDLE only)
```

HTTP requests are always treated as taps (latched trips) — hold semantics are physical-only.

**Physical reset gesture:** hold UP + DOWN together ≥ 3 s → same hard reset (outputs off, timers cleared, jog/FAULT cleared, position kept). Works from any state.

## Position tracking (script inference, no sensors)

`pos ∈ top | bottom | mid | unknown` plus a dead-reckoning travel estimate `est ∈ [0..1]` (0 = bottom, 1 = top); both persisted in device KVS (`lift.pos`, `lift.est`):

- Trip start writes `mid` to KVS **before** energizing — power loss mid-trip can never restore a stale floor.
- A run ending via **firmware Auto-Off** drove to that direction's limit → `top` / `bottom`, `est` = 1/0. (Auto-Off ≥ travel time, Harmar limits stop motion — valid even for trips started mid-shaft.)
- **Dead reckoning:** every energized interval is integrated into `est` (55 s up / 45 s down full scale). A manual stop or jog release that brings `est` within 3% of an end declares that floor and **exits jog mode** — so jogging onto a limit is recognized without waiting for Auto-Off.
- Other manual stops / jog releases → `mid`.
- Boot restores from KVS; `unknown`/`est=null` only before first-ever calibration or completed trip.
- Calibrate anytime while IDLE with `?set=top|bottom` (also sets `est`).

### S3 hardware limit feedback (planned, NOT yet wired)

Script support exists but is dormant until `input:2` is enabled. Wiring plan: both travel-limit indications in parallel → third Phoenix interposing relay → S3 = "platform at a terminal"; last commanded direction disambiguates top vs bottom. When S3 fires mid-run the script ends the command early and declares the floor — authoritative over dead reckoning. ⚠️ Tap the directional limit indications only; never the safety chain / final limits / safety pan. Enable: set `input:2` type=switch + enable=true, restart script, confirm boot log says `S3 limit feedback: ACTIVE`.

Every position change is pushed to Homebridge (`homebridge-http-webhooks` listener at `http://192.168.10.175:51828`, accessory IDs `lift-top` / `lift-bottom`) — no polling.

### HomeKit (deployed 2026-09-15)

ShellyDS9 platform **removed** from Homebridge (its direct `Switch.Set` bypassed the arbiter). Replaced by `HttpWebHooks` platform (setup script: homebridge repo `scripts/setup-lift-webhooks.sh`):

| Accessory                       | Type             | Behavior                                                               |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| Lift Up / Lift Down             | pushbutton       | fires `?dir=up` / `?dir=down` through the arbiter                      |
| Lift Upstairs / Lift Downstairs | occupancy sensor | "Detected" = lift at that floor; both clear = mid-shaft/moving/unknown |

For Siri phrasing, wrap the pushbuttons in Home-app scenes ("Lift up" / "Lift down") — must be done in the Home app.

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
11. Position: full trip up → "Lift Upstairs" detected in HomeKit; interrupt a trip → both sensors clear; reboot → position survives.
12. Dead reckoning: interrupt a trip, jog onto a limit, release → floor declared, jog mode exits (check `est` via status).
13. Reset gesture: hold UP+DOWN 3 s → outputs off, state IDLE, jog cleared.

## Files

- [scripts/lift-arbiter.js](scripts/lift-arbiter.js) — the Shelly script (single `request()` entry point for all sources).
- [test/shelly-mock.js](test/shelly-mock.js) — Shelly script-environment emulator: virtual clock/timers, async RPC + status-event echoes, relay Auto-Off, enforces the firmware ~5-concurrent-call limit.
- [test/run-tests.js](test/run-tests.js) — unit + fuzz suite (`node test/run-tests.js`): every gesture, race cases (stop vs Auto-Off, stop vs ON-echo), FAULT/recovery, RPC-burst limit, 250 seeded random button-mash sequences with a recoverability check, and the literal Konami code. Run before every deploy.
