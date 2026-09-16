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

## Behavior specification (rev 14)

States: `IDLE → RUNNING → COOLDOWN → IDLE`, plus `FAULT`. **No press-count gestures, no modes** — what the paddle does depends only on how long it's held and what the lift is doing:

| Control                                              | Result                                                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Press** (tap, released < 1 s)                      | Latched full run that direction, energized immediately                                                                                       |
| **Push** (hold ≥ 1 s)                                | Runs while held; **release stops it** (hold-to-run / jog)                                                                                     |
| **Same-direction press during a run**                | **STOP**                                                                                                                                     |
| **Opposite press during a run**                      | **REVERSE**: immediate stop, dead-time, then run the other way (tap = latched; keep holding = push rules apply to the reversed run)          |
| Run reaches a limit (Auto-Off / dead reckoning / S3) | Floor declared                                                                                                                               |
| **External `Switch.Set` ON** (management UI / RPC)   | **ADOPTED as a governed run** — stop/reverse rules all apply; conflicting or unexplained outputs still FAULT                                 |
| External `Switch.Set` OFF mid-run                    | Treated as a stop, **not** a floor declaration (aborts calibration)                                                                          |
| **Hold either paddle 3 s during FAULT/calibration**  | **Hard reset / lockout escape** (keeps position)                                                                                             |

**Calibration is remote-only** (`?cmd=calibrate`): full-UP ride, paddle IGNORED until Auto-Off → top / 100%, exits to normal automatically. Escapes during the locked ride: hold either paddle 3 s, `?cmd=stop`, `?cmd=reset`.

The physical control is a rocker — one person cannot press UP+DOWN together (that gesture still exists in code and would require two stations pressed simultaneously). The single-paddle hold is the practical lockout escape.

HTTP/HomeKit `?dir=` requests are always latched full runs (they participate in stop/reverse like any other source).

### Deferred declarations (rev 13 field-crash lesson)

Even memory-only work crashes mJS if the CALL CHAIN is deep: handler → `onSwitchStatus` → `onOutputOff` → `declareFloorFromEstimate` → `atTerminal` blew the stack in the field (reverse racing Auto-Off at a terminal). Floor/terminal declarations are now **deferred**: handlers set pending flags; the IO tick executes them at call depth ~3. Delay ≤ 25 ms.

### Plumbing rule (hard-won, three field crashes)

mJS has a tiny call stack, fw 2.0.0 clobbers params of `Shelly.call`s dispatched in the same tick, and caps ~5 concurrent calls. Therefore: **handlers and helpers only mutate memory; ALL RPC I/O is emitted by one flat repeating 25 ms tick**, at most one call per pass — relay FIFO first (order sacred, ≤4 in flight), then KVS/webhook syncs from dirty flags (≤2 in flight). Relay commands retry twice; KVS syncs re-dirty on failure; the blackbox write coalesces naturally.

### Invariants

1. O1 and O2 never ON simultaneously — verified before every trip _and_ watched via status handler.
2. State transitions to RUNNING **before** the relay is commanded ON (no accept-both race).
3. `Switch.Set` only; never `Switch.Toggle`.
4. COOLDOWN → IDLE is promoted by the IO tick only when the dead-time (currently 0 ms) has passed AND the relay queue is empty AND both outputs are physically OFF — "zero cooldown" really means "as soon as the hardware confirms quiescent".
5. Boot: both outputs forced OFF, state IDLE.
6. Trip refused if the opposite input is currently held (stuck button / welded Phoenix contact); a failed reverse auto-start is logged, never silent.
7. Command-intent tracking (`commandedOn[]` + 2 s OFF grace): queue lag never false-FAULTs, but a genuinely rogue output (welded relay, unexplained source) forces both OFF and enters **FAULT lockout** (cleared only by `cmd=reset`, the paddle-hold escapes, or script restart). A _deliberate_ external ON (UI/RPC source) from IDLE/COOLDOWN is instead adopted as a governed run.

### Race handling

- **Event-order ambiguity at trip start:** state becomes RUNNING before `Switch.Set on`, so a press arriving between decision and relay closure is handled by the run rules (stop/reverse), never as a second acceptance.
- **Stop racing our own ON echo:** the commanded-ON status event may arrive after a stop already landed; tracked via `expectedOnEcho` so it is never mistaken for a rogue output (was a real fuzzer-found bug).
- **Stop racing Auto-Off:** `expectingOffEcho` is only armed if an output is actually on, so a swallowed off-event can't strand the flag.
- **Auto-Off vs external stop:** the off-event's `source` disambiguates — `timer` = drove onto the limit (declare floor); anything else = an external stop (no floor declaration, calibration aborted).
- **Held past Auto-Off:** firmware kills the output; release afterwards is ignored (edge-triggered inputs mean the button must be released and re-pressed for a new request).

## Remote control endpoint

The script registers an HTTP endpoint (Gen2 scripts cannot register RPC methods; `HTTPServer.registerEndpoint` is the supported mechanism):

```
http://192.168.40.105/script/1/lift             → status JSON {result, state, dir, calib, pos, pct, est}
http://192.168.40.105/script/1/lift?dir=up      → request UP (same arbiter path as buttons)
http://192.168.40.105/script/1/lift?dir=down    → request DOWN
http://192.168.40.105/script/1/lift?cmd=stop    → stop a running trip (also aborts calibration)
http://192.168.40.105/script/1/lift?cmd=calibrate → full-UP calibration ride (paddle locked until done)
http://192.168.40.105/script/1/lift?cmd=reset   → hard state reset (any state incl. FAULT; keeps position)
http://192.168.40.105/script/1/lift?cmd=hist    → status + last 15 log lines (diagnostics)
http://192.168.40.105/script/1/lift?set=top|bottom|mid → manual position calibration (IDLE only)
```

HTTP requests are always latched full trips — hold semantics are physical-only. The management UI at `https://lift.westerfield.cloud:8443` proxies the full device (Caddy, VLAN 10/40 allowlist); its switch toggles are **adopted** by the arbiter rather than fighting it.

**Physical reset gesture:** hold UP + DOWN together ≥ 3 s → same hard reset (outputs off, timers cleared, FAULT cleared, position kept). Works from any state.

## Position tracking (script inference, no sensors)

`pos ∈ top | bottom | mid | unknown` plus a dead-reckoning travel estimate `est ∈ [0..1]` (0 = bottom, 1 = top); both persisted in device KVS (`lift.pos`, `lift.est`):

- Trip start writes `mid` to KVS **before** energizing — power loss mid-trip can never restore a stale floor.
- A run ending via **firmware Auto-Off** drove to that direction's limit → `top` / `bottom`, `est` = 1/0. (Auto-Off ≥ travel time, Harmar limits stop motion — valid even for trips started mid-shaft.)
- **Dead reckoning:** every energized interval is integrated into `est` (55 s up / 45 s down full scale). A stop or hold-release that brings `est` within 3% of an end declares that floor — so holding onto a limit is recognized without waiting for Auto-Off.
- Other stops → `mid`.
- Boot restores from KVS; `unknown`/`est=null` only before first-ever calibration or completed trip.
- Calibrate anytime while IDLE with `?set=top|bottom` (also sets `est`).

### S3 hardware limit feedback (planned, NOT yet wired)

Script support exists but is dormant until `input:2` is enabled. Wiring plan: both travel-limit indications in parallel → third Phoenix interposing relay → S3 = "platform at a terminal"; last commanded direction disambiguates top vs bottom. When S3 fires mid-run the script ends the command early and declares the floor — authoritative over dead reckoning. ⚠️ Tap the directional limit indications only; never the safety chain / final limits / safety pan. Enable: set `input:2` type=switch + enable=true, restart script, confirm boot log says `S3 limit feedback: ACTIVE`.

Every position change is pushed to Homebridge (`homebridge-http-webhooks` listener, default `http://192.168.10.175:51828`, overridable via KVS key `lift.hbwebhook`; accessory IDs `lift-top` / `lift-bottom`) — no polling. FAULTs (and watchdog revivals) push `lift-fault` true; a hard reset or healthy boot clears it.

### HomeKit (deployed 2026-09-15)

ShellyDS9 platform **removed** from Homebridge (its direct `Switch.Set` bypassed the arbiter). Replaced by `HttpWebHooks` platform (setup script: homebridge repo `scripts/setup-lift-webhooks.sh`):

| Accessory                       | Type             | Behavior                                                               |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| Lift Up / Lift Down             | pushbutton       | fires `?dir=up` / `?dir=down` through the arbiter                      |
| Lift Upstairs / Lift Downstairs | occupancy sensor | "Detected" = lift at that floor; both clear = mid-shaft/moving/unknown |
| Lift Fault                      | occupancy sensor | "Detected" = FAULT lockout or watchdog revived a crashed script        |

For Siri phrasing, wrap the pushbuttons in Home-app scenes ("Lift up" / "Lift down") — must be done in the Home app.

## Watchdog

[src/watchdog.ts](src/watchdog.ts) → script slot 2 (`lift-watchdog`, run-on-startup): checks script 1 every 10 s and restarts it if halted — with detached inputs a crashed arbiter means dead paddles. A revival also raises the Lift Fault sensor; the arbiter's healthy boot clears it. The 3 s paddle hold clears FSM lockouts but cannot revive a crashed _script_; the watchdog closes that gap.

## Deploy

`.\deploy.ps1 [-DeviceIp 192.168.40.105] [-SkipTests]` — builds, runs the full test suite, then uploads with watchdog-safe ordering: **stop watchdog first** (or it restarts the arbiter mid-upload with partial code), stop arbiter, chunked `Script.PutCode` upload, start arbiter, upload + start watchdog, verify the boot banner via `?cmd=hist`.

## Test plan

Automated coverage lives in [test/run-tests.js](test/run-tests.js) (25 tests incl. fuzzing) and runs on every deploy. Manual field checks — use short Auto-Off values (e.g., 5 s) for steps 1–6, restore 55/45 after:

1. Single press UP, single press DOWN → latched trip each; Auto-Off ends the command and declares the floor.
2. Same-direction press mid-run → stop. Opposite press mid-run → stop, then automatic full run the other way.
3. Push (hold ≥ 1 s) → runs while held, stops on release. A push on the opposite paddle mid-run reverses, and the reversed run also stops when you let go.
4. Calibration: `?cmd=calibrate` only → ride UP, paddle dead until the top; exits to normal. No paddle combination can trigger it.
5. Stuck input: hold one button, press the other from IDLE → refused (`conflict` in hist).
6. FAULT: toggle an output from the management UI while a run is active in the _opposite_ direction → both OFF, lockout; hold either paddle 3 s clears. A UI toggle while idle should be **adopted**, not fault.
7. Reboot mid-trip → both outputs OFF at boot, state IDLE, position/est restored from KVS.
8. Stop the script mid-trip → firmware Auto-Off still ends the trip; watchdog restarts the script ≤ 12 s (Lift Fault sensor blips).
9. Throughout: confirm O1 and O2 are never ON together (watch both channel LEDs / status).
10. Position: full trip up → "Lift Upstairs" detected in HomeKit; interrupt a trip → both sensors clear; reboot → position survives.

## Files

- [src/lift-arbiter.ts](src/lift-arbiter.ts) — **source of truth** (TypeScript, strict). Build: `npm run build` → emits mJS-safe ES5 (no modules, no helpers) into scripts/.
- [src/watchdog.ts](src/watchdog.ts) — watchdog source (script slot 2).
- [src/shelly.d.ts](src/shelly.d.ts) — ambient declarations for the Shelly Gen2 script environment.
- [scripts/lift-arbiter.js](scripts/lift-arbiter.js), [scripts/watchdog.js](scripts/watchdog.js) — **generated** deploy artifacts; do not edit by hand. Tests and deploy consume these exact files.
- [deploy.ps1](deploy.ps1) — build + test + watchdog-safe deploy + boot-banner verification.
- [test/shelly-mock.js](test/shelly-mock.js) — Shelly script-environment emulator: virtual clock/timers, async RPC + status-event echoes with `source` attribution, relay Auto-Off, external `Switch.Set` injection, KVS persistence across simulated restarts, the firmware ~5-concurrent-call limit, AND the same-tick params-clobber quirk.
- [test/run-tests.js](test/run-tests.js) — unit + fuzz suite (`npm test` = build + run): tap/push/stop/reverse semantics, calibration, adoption, S3 feedback, restart restore, races, FAULT/recovery, the Auto-Off-race crash regression, RPC-burst limit, 250 seeded random button-mash sequences with a recoverability check, and the literal Konami code. Run before every deploy (deploy.ps1 enforces it).
