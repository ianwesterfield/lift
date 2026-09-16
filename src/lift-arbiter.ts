// lift-arbiter.ts — Harmar Highlander II motion arbiter (Shelly Pro 3 "Lift")
// Source of truth. Build: `npm run build` -> scripts/lift-arbiter.js (ES5,
// script-mode, no modules, no emitted helpers — the device runs mJS).
//
// Supervisory convenience logic ONLY. The Harmar controller owns all safety,
// interlocks and travel limits. Firmware Auto-Off (UP 55s / DOWN 45s) is the
// hard command backstop and is never refreshed or extended by this script.
//
// O1 (switch:0) = J6 UP, O2 (switch:1) = J6 DOWN.
// S1 (input:0)  = any physical UP request, S2 (input:1) = any physical DOWN.
//
// GESTURES (rev 13) — press count within 3 s of the chain's first press,
// direction-agnostic:
//   idle press            -> latched full travel (energized immediately)
//   opposite press in run -> REVERSE: stop, dead-time, full travel other way
//   2nd press             -> toggle JOG MODE (stops the run on entry; entering
//                            fires a short confirmation burst in the pressed
//                            direction and cancels any pending reverse)
//   3rd press             -> CALIBRATION ride (full UP, paddle locked)
//   jog mode              -> hold-to-run; double-press exits back to normal
//   hold paddle 3 s       -> lockout escape (FAULT/calibration only)
//   external Switch.Set   -> ADOPTED as a governed run (UI/RPC = just another
//                            input); conflicts and unexplained outputs FAULT
//
// ARCHITECTURE RULE (hard-won): mJS has a tiny call stack and fw 2.0.0
// clobbers params of Shelly.call dispatched in the same tick. Handlers and
// helpers may ONLY mutate memory; ALL RPC I/O is emitted by ONE flat repeating
// timer (the IoQueue tick), at most one call per tick. No class inheritance,
// no accessors, no spread: those emit ES5 helpers the device cannot run.
// `const enum` only — it inlines to literals at compile time.

const enum Direction {
  Up = 0,
  Down = 1,
}

const enum MachineState {
  Idle = "IDLE",
  Running = "RUNNING",
  Cooldown = "COOLDOWN",
  Fault = "FAULT",
}

const enum Position {
  Top = "top",
  Bottom = "bottom",
  Mid = "mid",
  Unknown = "unknown",
}

const enum RequestSource {
  Input = "input",
  Http = "http",
  Calibration = "calib",
  Reverse = "reverse",
}

const enum GestureKind {
  Run = "run",
  JogToggle = "jogToggle",
  Calibrate = "calibrate",
}

const enum JobKind {
  Relay = "relay",
  OneShot = "job",
  PersistPosition = "pos",
  PersistEstimate = "est",
  PersistBlackbox = "bb",
  Webhook = "wh",
}

var DIRECTION_NAME = ["UP", "DOWN"];

var CFG = {
  COOLDOWN_MS: 0, // stop -> reverse/re-arm dead-time (tick-confirmed re-arm)
  CHAIN_MS: 3000, // gesture chain: presses within 3 s of the chain's first press
  TICK_MS: 25, // I/O drain tick
  TRAVEL_UP_MS: 55000, // dead-reckoning scale; overwritten at init from auto_off_delay
  TRAVEL_DOWN_MS: 45000,
  ESTIMATE_EDGE: 0.03, // estimate within this of 0/1 counts as at that floor
  OFF_GRACE_MS: 2000, // commanded-OFF may lag this long before it's "rogue"
  RESET_HOLD_MS: 3000, // lockout-escape hold duration
  JOG_BURST_MS: 400, // jog-entry confirmation nudge duration
  LIMIT_INPUT: 2, // S3: optional "at a terminal" feedback (active when input:2 enabled)
  POSITION_KEY: "lift.pos",
  ESTIMATE_KEY: "lift.est",
  BLACKBOX_KEY: "lift.blackbox",
  WEBHOOK_KEY: "lift.hbwebhook", // optional KVS override for the webhook base
  WEBHOOK_BASE: "http://192.168.10.175:51828", // homebridge-http-webhooks listener
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (a?: any, b?: any, c?: any, d?: any) => void;

interface RelayCommand {
  id: Direction;
  on: boolean;
  retries: number;
}

type IoJob =
  | { kind: JobKind.Relay; method: "Switch.Set"; params: { id: Direction; on: boolean; }; relay: RelayCommand; }
  | { kind: JobKind.OneShot; method: string; params: object; callback?: (result: unknown, errorCode: number, errorMessage: string) => void; }
  | { kind: JobKind.PersistPosition | JobKind.PersistEstimate | JobKind.PersistBlackbox; method: "KVS.Set"; params: { key: string; value: string; }; }
  | { kind: JobKind.Webhook; method: "HTTP.GET"; params: { url: string; timeout: number; }; };

// ---------------------------------------------------------------------------
// IoQueue — the ONLY place Shelly.call happens. Everything else raises
// signals: relay FIFO, one-shot jobs, dirty flags, webhook queue. The tick
// drains at most one call per pass (fw clobbers same-tick dispatches) with
// budget headroom under the ~5 concurrent-call cap.
// ---------------------------------------------------------------------------

class IoQueue {
  relayQueue: RelayCommand[] = []; // FIFO — relay command order is sacred
  oneShotJobs: IoJob[] = [];
  positionDirty = false;
  estimateDirty = false;
  blackboxDirty = false;
  webhookQueue: string[] = [];
  callsInFlight = 0;

  private owner: LiftArbiter | null = null;

  attach(owner: LiftArbiter): void {
    this.owner = owner;

    Timer.set(CFG.TICK_MS, true, () => {
      this.tick();
      (this.owner as LiftArbiter).pump(); // re-arm / pending auto-starts
    });
  }

  pushRelay(id: Direction, on: boolean): void {
    this.relayQueue.push({ id: id, on: on, retries: 0 });
  }

  pushOneShot(
    method: string,
    params: object,
    callback?: (result: unknown, errorCode: number, errorMessage: string) => void,
  ): void {
    this.oneShotJobs.push({ kind: JobKind.OneShot, method: method, params: params, callback: callback });
  }

  private nextJob(): IoJob | null {
    var owner = this.owner as LiftArbiter;

    if (this.relayQueue.length > 0 && this.callsInFlight < 4) {
      var relayCommand = this.relayQueue.splice(0, 1)[0];
      return {
        kind: JobKind.Relay,
        method: "Switch.Set",
        params: { id: relayCommand.id, on: relayCommand.on },
        relay: relayCommand,
      };
    }

    if (this.callsInFlight >= 2) return null; // headroom below the fw call cap

    if (this.oneShotJobs.length > 0) return this.oneShotJobs.splice(0, 1)[0];

    if (this.positionDirty) {
      this.positionDirty = false;
      return {
        kind: JobKind.PersistPosition,
        method: "KVS.Set",
        params: { key: CFG.POSITION_KEY, value: owner.position },
      };
    }

    if (this.estimateDirty) {
      this.estimateDirty = false;
      var serialized = "";
      if (owner.estimate !== null) serialized = JSON.stringify(owner.estimate);
      return {
        kind: JobKind.PersistEstimate,
        method: "KVS.Set",
        params: { key: CFG.ESTIMATE_KEY, value: serialized },
      };
    }

    if (this.webhookQueue.length > 0) {
      var url = this.webhookQueue.splice(0, 1)[0];
      return { kind: JobKind.Webhook, method: "HTTP.GET", params: { url: url, timeout: 3 } };
    }

    if (this.blackboxDirty) {
      this.blackboxDirty = false;
      return {
        kind: JobKind.PersistBlackbox,
        method: "KVS.Set",
        params: { key: CFG.BLACKBOX_KEY, value: owner.history.join(" | ").slice(-250) },
      };
    }

    return null;
  }

  private tick(): void {
    var job = this.nextJob();

    if (job === null) return;

    this.callsInFlight++;

    try {
      Shelly.call(
        job.method,
        job.params,
        (result, errorCode, errorMessage, userdata) => {
          this.callsInFlight--;
          var finished = userdata as IoJob;

          if (errorCode !== 0) {
            switch (finished.kind) {
              case JobKind.Relay:
                finished.relay.retries++;

                if (finished.relay.retries <= 2) {
                  this.relayQueue.unshift(finished.relay); // idempotent retry
                } else {
                  (this.owner as LiftArbiter).log(
                    "relay failed: " + errorMessage + " id=" + finished.relay.id,
                  );
                }
                break;

              case JobKind.PersistPosition:
                this.positionDirty = true;
                break;

              case JobKind.PersistEstimate:
                this.estimateDirty = true;
                break;

              default:
                break; // webhook/blackbox: the next state change re-sends
            }
          }

          if (finished.kind === JobKind.OneShot && finished.callback) {
            finished.callback(result, errorCode, errorMessage);
          }
        },
        job,
      );
    } catch (error) {
      this.callsInFlight--;

      switch (job.kind) {
        case JobKind.Relay:
          this.relayQueue.unshift(job.relay);
          break;

        case JobKind.OneShot:
          this.oneShotJobs.unshift(job);
          break;

        case JobKind.PersistPosition:
          this.positionDirty = true;
          break;

        case JobKind.PersistEstimate:
          this.estimateDirty = true;
          break;

        case JobKind.PersistBlackbox:
          this.blackboxDirty = true;
          break;

        case JobKind.Webhook:
          break; // dropped; the next position change re-sends
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Gestures — classifies physical presses into intents. Direction-agnostic:
// only the NUMBER of presses within CHAIN_MS of the chain's first press counts.
// ---------------------------------------------------------------------------

class Gestures {
  private pressCount = 0;
  private chainStartedAt = 0;

  classify(): { gesture: GestureKind; pressCount: number; } {
    if (Date.now() - this.chainStartedAt <= CFG.CHAIN_MS) {
      this.pressCount++;
    } else {
      this.pressCount = 1;
      this.chainStartedAt = Date.now();
    }

    switch (this.pressCount) {
      case 3:
        this.reset();
        return { gesture: GestureKind.Calibrate, pressCount: 3 };

      case 2:
        return { gesture: GestureKind.JogToggle, pressCount: 2 };

      default:
        return { gesture: GestureKind.Run, pressCount: this.pressCount };
    }
  }

  reset(): void {
    this.pressCount = 0;
    this.chainStartedAt = 0;
  }
}

// ---------------------------------------------------------------------------
// LiftArbiter — the state machine. Handlers mutate memory only; all I/O goes
// through the IoQueue.
// ---------------------------------------------------------------------------

class LiftArbiter {
  state: MachineState = MachineState.Idle;
  direction: Direction | null = null;
  jogMode = false; // hold-to-run mode; toggled by double-press
  calibrating = false; // calibration ride: paddle ignored until Auto-Off
  calibrationPending = false;
  reverseTo: Direction | null = null; // reversal target after cooldown
  burstTo: Direction | null = null; // jog-entry confirmation nudge, fired by pump
  bursting = false; // burst is script-owned: paddle release must not stop it
  runStartedAt = 0;
  lastRunDirection: Direction | null = null;
  expectedOnEcho: Direction | null = null; // commanded-ON echo still in flight
  commandedOn: [boolean, boolean] = [false, false];
  offCommandedAt: [number, number] = [0, 0];
  estimate: number | null = null; // 0=bottom..1=top; null until known
  expectingOffEcho = false; // we commanded OFF; swallow the resulting event
  cooldownUntil = 0; // re-arm gate; the tick promotes COOLDOWN->IDLE
  bothHeldTimer: number | null = null;
  holdEscapeTimer: number | null = null;
  limitFeedbackActive = false;
  history: string[] = [];
  position: Position = Position.Unknown;

  io: IoQueue;
  gestures: Gestures;

  constructor() {
    this.io = new IoQueue();
    this.gestures = new Gestures();
  }

  // ---- logging / persistence signals ----

  log(message: string): void {
    print("[lift] " + message);
    this.history.push(Math.round(Date.now() / 1000) + " " + message);
    if (this.history.length > 15) this.history.splice(0, 1);
    this.io.blackboxDirty = true;
  }

  guard(name: string, handler: AnyFunction): AnyFunction {
    return (a?, b?, c?, d?) => {
      try {
        handler(a, b, c, d);
      } catch (error) {
        try {
          this.fault("exception in " + name + ": " + (error as Error).message);
        } catch (secondaryError) {
          this.bothOff(); // last resort
        }
      }
    };
  }

  setOutput(id: Direction, on: boolean): void {
    this.commandedOn[id] = on;

    if (!on) this.offCommandedAt[id] = Date.now();

    this.io.pushRelay(id, on);
  }

  bothOff(): void {
    this.setOutput(Direction.Up, false);
    this.setOutput(Direction.Down, false);
  }

  outputOn(id: Direction): boolean {
    var status = Shelly.getComponentStatus("switch:" + id);
    return status !== null && status.output === true;
  }

  inputOn(id: Direction | number): boolean {
    var status = Shelly.getComponentStatus("input:" + id);
    return status !== null && status.state === true;
  }

  opposite(id: Direction): Direction {
    return id === Direction.Up ? Direction.Down : Direction.Up;
  }

  // physically ON with no command intent and no recent OFF still landing
  rogueOutputOn(): boolean {
    for (var id = Direction.Up; id <= Direction.Down; id++) {
      var direction = id as Direction;

      if (
        this.outputOn(direction) &&
        !this.commandedOn[direction] &&
        Date.now() - this.offCommandedAt[direction] > CFG.OFF_GRACE_MS
      ) {
        return true;
      }
    }

    return false;
  }

  setPosition(position: Position): void {
    if (this.position === position) return;

    this.position = position;
    this.log("position: " + position);
    this.io.positionDirty = true;
    this.pushPositionSensors();
  }

  // append (not replace): a queued FAULT alert must never be dropped
  pushPositionSensors(): void {
    this.io.webhookQueue.push(
      CFG.WEBHOOK_BASE + "/?accessoryId=lift-top&state=" + (this.position === Position.Top),
      CFG.WEBHOOK_BASE + "/?accessoryId=lift-bottom&state=" + (this.position === Position.Bottom),
    );
  }

  pushFaultAlert(on: boolean): void {
    this.io.webhookQueue.push(CFG.WEBHOOK_BASE + "/?accessoryId=lift-fault&state=" + on);
  }

  setEstimate(estimate: number | null): void {
    this.estimate = estimate;
    this.io.estimateDirty = true;
  }

  integrateRunTime(direction: Direction, elapsedMs: number): void {
    if (this.estimate === null || elapsedMs <= 0) return;

    var delta =
      direction === Direction.Up
        ? elapsedMs / CFG.TRAVEL_UP_MS
        : -elapsedMs / CFG.TRAVEL_DOWN_MS;

    this.setEstimate(Math.min(1, Math.max(0, this.estimate + delta)));
  }

  // a run reached a terminal for certain (Auto-Off, S3 feedback)
  atTerminal(direction: Direction, why: string): void {
    this.setEstimate(direction === Direction.Up ? 1 : 0);
    this.setPosition(direction === Direction.Up ? Position.Top : Position.Bottom);
    this.log("at " + (direction === Direction.Up ? "top" : "bottom") + " (" + why + ")");
  }

  // after a stop: dead reckoning may still conclude we reached a floor
  declareFloorFromEstimate(): void {
    if (this.estimate === null || this.position !== Position.Mid) return;

    if (this.estimate >= 1 - CFG.ESTIMATE_EDGE) this.atTerminal(Direction.Up, "dead reckoning");
    else if (this.estimate <= CFG.ESTIMATE_EDGE) this.atTerminal(Direction.Down, "dead reckoning");
  }

  // ---- state transitions ----

  fault(reason: string): void {
    this.log("FAULT: " + reason + " — both outputs OFF, lockout (cmd=reset to clear)");
    this.cooldownUntil = 0;
    this.bothOff();
    this.state = MachineState.Fault;
    this.direction = null;
    this.calibrating = false;
    this.calibrationPending = false;
    this.reverseTo = null;
    this.burstTo = null;
    this.bursting = false;
    this.runStartedAt = 0; // hygiene: no stale segment survives a fault
    this.pushFaultAlert(true); // HomeKit-visible alarm
  }

  // COOLDOWN ends when the dead-time (possibly 0) has passed AND the relays
  // are physically OFF with nothing in flight — promoted by the IO tick, so
  // "zero cooldown" is really "as soon as the hardware confirms quiescent".
  cooldown(): void {
    this.state = MachineState.Cooldown;
    this.direction = null;
    this.bursting = false;
    this.cooldownUntil = Date.now() + CFG.COOLDOWN_MS;
  }

  // called every IO tick: re-arm and run any pending auto-start intents
  pump(): void {
    if (this.state !== MachineState.Cooldown) return;
    if (Date.now() < this.cooldownUntil) return;
    if (this.io.relayQueue.length > 0) return; // relay commands still queued
    if (this.outputOn(Direction.Up) || this.outputOn(Direction.Down)) return;

    this.state = MachineState.Idle;
    this.log("re-armed");

    if (this.calibrationPending) {
      if (this.inputOn(Direction.Up) || this.inputOn(Direction.Down)) {
        this.cooldown(); // the calibration press is still held: wait it out
        return;
      }

      this.calibrationPending = false;
      this.reverseTo = null;
      this.startCalibrationRun();
    } else if (this.reverseTo !== null) {
      var target = this.reverseTo;
      this.reverseTo = null;

      var outcome = this.request(target, RequestSource.Reverse);
      if (outcome !== "accepted") this.log("reverse did not start: " + outcome);
    } else if (this.jogMode && this.burstTo !== null) {
      this.startJogBurst();
    }
  }

  // brief nudge in the double-pressed direction: tactile "you are in jog now"
  startJogBurst(): void {
    var burstDirection = this.burstTo as Direction;
    this.burstTo = null;

    var outcome = this.jogPress(burstDirection);

    if (outcome !== "accepted") {
      this.log("jog burst skipped: " + outcome);
      return;
    }

    this.bursting = true; // the second tap's release event may still be inbound
    this.log("jog confirm burst " + DIRECTION_NAME[burstDirection]);

    Timer.set(
      CFG.JOG_BURST_MS,
      false,
      this.guard("jogBurstTimer", () => {
        if (
          this.state === MachineState.Running &&
          this.direction === burstDirection &&
          this.jogMode
        ) {
          this.stopRun("jog burst done");
        }
      }),
    );
  }

  stopRun(reason: string): void {
    this.log("STOP (" + reason + ")");
    // only expect an off-event if something is actually on (a stop can race Auto-Off)
    this.expectingOffEcho = this.outputOn(Direction.Up) || this.outputOn(Direction.Down);
    this.bothOff();
    this.cooldown();
  }

  hardReset(source: string): void {
    this.log("HARD RESET (" + source + ")");
    this.cooldownUntil = 0;
    this.bothOff();
    this.state = MachineState.Idle;
    this.direction = null;
    this.jogMode = false;
    this.calibrating = false;
    this.calibrationPending = false;
    this.reverseTo = null;
    this.burstTo = null;
    this.bursting = false;
    this.gestures.reset();
    this.expectingOffEcho = false;
    this.expectedOnEcho = null;
    this.runStartedAt = 0;
    this.pushFaultAlert(false); // clear the HomeKit alarm
  }

  armBothHeldReset(): void {
    if (this.bothHeldTimer !== null) return;

    this.bothHeldTimer = Timer.set(
      CFG.RESET_HOLD_MS,
      false,
      this.guard("bothHeldTimer", () => {
        this.bothHeldTimer = null;

        if (this.inputOn(Direction.Up) && this.inputOn(Direction.Down)) {
          this.hardReset("both buttons held");
        }
      }),
    );
  }

  // Rocker paddle can't press both directions; lockout states get a one-button
  // escape. Never armed in normal states.
  armHoldEscape(direction: Direction): void {
    if (this.holdEscapeTimer !== null) return;

    this.holdEscapeTimer = Timer.set(
      CFG.RESET_HOLD_MS,
      false,
      this.guard("holdEscapeTimer", () => {
        this.holdEscapeTimer = null;

        if (
          this.inputOn(direction) &&
          (this.state === MachineState.Fault || this.calibrating || this.calibrationPending)
        ) {
          this.hardReset("paddle held in lockout");
        }
      }),
    );
  }

  // ---- calibration ----

  startCalibration(source: string): string {
    this.log("CALIBRATION (" + source + "): full UP, paddle locked until Auto-Off");
    this.calibrating = true;
    this.jogMode = false; // calibration always exits to normal mode
    this.burstTo = null;

    if (this.state === MachineState.Running) {
      if (this.direction === Direction.Up) return "calibrating"; // this run becomes the ride

      this.calibrationPending = true;
      this.stopRun("calibration: stop before UP ride");
      return "calibrating";
    }

    if (this.state === MachineState.Cooldown) {
      this.calibrationPending = true;
      return "calibrating";
    }

    this.startCalibrationRun();
    return "calibrating";
  }

  startCalibrationRun(): void {
    var outcome = this.request(Direction.Up, RequestSource.Calibration);

    if (outcome !== "accepted") {
      this.calibrating = false;
      this.calibrationPending = false;
      this.log("calibration failed to start: " + outcome);
    }
  }

  // ---- the single request entry point ----

  request(direction: Direction, source: RequestSource): string {
    if (source === RequestSource.Input) {
      if (this.inputOn(Direction.Up) && this.inputOn(Direction.Down)) this.armBothHeldReset();

      if (this.state === MachineState.Fault || this.calibrating || this.calibrationPending) {
        this.armHoldEscape(direction);
      }
    }

    if (this.state === MachineState.Fault) {
      this.log("ignored " + DIRECTION_NAME[direction] + " (" + source + "): FAULT lockout");
      return "fault";
    }

    if (this.calibrating && source === RequestSource.Input) {
      this.log("ignored " + DIRECTION_NAME[direction] + ": calibration in progress");
      return "calibrating";
    }

    if (source === RequestSource.Input) {
      var classified = this.gestures.classify();
      this.log(
        "press " +
        DIRECTION_NAME[direction] +
        " " +
        classified.pressCount +
        " (" +
        this.state +
        (this.jogMode ? ",jog" : "") +
        ")",
      );

      if (classified.gesture === GestureKind.Calibrate) return this.startCalibration(source);

      if (classified.gesture === GestureKind.JogToggle) return this.toggleJogMode(direction);

      if (this.jogMode) return this.jogPress(direction);
    }

    if (this.state === MachineState.Running) {
      if (direction !== this.direction) {
        // opposite press = immediate stop, dead-time, full travel the other way
        this.reverseTo = direction;
        this.stopRun("reverse to " + DIRECTION_NAME[direction] + " (" + source + ")");
        return "reversing";
      }

      if (source !== RequestSource.Input) return "already-running";

      this.log("same-direction press during run ignored");
      return "ignored";
    }

    if (this.state !== MachineState.Idle) return "busy"; // COOLDOWN (chain counted above)

    if (this.rogueOutputOn()) {
      this.fault("output ON while believed IDLE");
      return "fault";
    }

    if (this.outputOn(Direction.Up) || this.outputOn(Direction.Down)) {
      this.log("outputs settling — press again");
      return "settling";
    }

    if (this.inputOn(this.opposite(direction))) {
      this.log("opposite input held — refusing " + DIRECTION_NAME[direction]);
      this.cooldown();
      return "conflict";
    }

    this.direction = direction;
    return this.startRun(false) ? "accepted" : "aborted";
  }

  // double-press: enter/exit jog mode (entering stops any run and cancels any
  // pending reverse — jog means "manual control now"). Entering queues a short
  // confirmation burst in the pressed direction so the rider gets feedback.
  toggleJogMode(direction: Direction | null): string {
    this.jogMode = !this.jogMode;
    this.log("jog mode " + (this.jogMode ? "ON (hold-to-run)" : "OFF"));

    if (this.jogMode) {
      this.reverseTo = null;
      this.burstTo = direction;
    } else {
      this.burstTo = null;
    }

    if (this.state === MachineState.Running) {
      this.stopRun(this.jogMode ? "jog entry" : "jog exit");
    } else if (this.jogMode && this.state === MachineState.Idle && direction !== null) {
      this.cooldown(); // route the burst through the pump's quiescence checks
    }

    return this.jogMode ? "jog-on" : "jog-off";
  }

  // jog mode press: run unlatched while held (release stops it)
  jogPress(direction: Direction): string {
    if (this.state === MachineState.Running) {
      if (direction !== this.direction) {
        this.reverseTo = null; // no auto-reverse in jog: just stop
        this.stopRun("jog: opposite press");
        return "stopped";
      }

      return "ignored";
    }

    if (this.state !== MachineState.Idle) return "busy";

    if (this.rogueOutputOn()) {
      this.fault("output ON while believed IDLE");
      return "fault";
    }

    if (this.outputOn(Direction.Up) || this.outputOn(Direction.Down)) return "settling";

    if (this.inputOn(this.opposite(direction))) return "conflict";

    this.direction = direction;
    return this.startRun(true) ? "accepted" : "aborted";
  }

  // holdToRun=true: jog (release stops); firmware Auto-Off still backs it up
  startRun(holdToRun: boolean): boolean {
    if (this.outputOn(Direction.Up) || this.outputOn(Direction.Down)) {
      if (this.rogueOutputOn()) {
        this.fault("output ON at run start");
      } else {
        // our own OFF command hasn't landed yet (queue lag): abort quietly
        this.log("outputs still settling — run aborted, press again");
        this.cooldown();
      }

      return false;
    }

    // RUNNING before energizing: a press landing between decision and relay
    // closure is handled by the run rules, never as a second acceptance.
    this.state = MachineState.Running;
    this.runStartedAt = Date.now();
    this.lastRunDirection = this.direction;
    this.expectedOnEcho = this.direction;
    this.setPosition(Position.Mid); // persisted before energizing
    this.setOutput(this.direction as Direction, true);
    this.log(
      "RUNNING " +
      DIRECTION_NAME[this.direction as Direction] +
      (this.calibrating ? " (calibration)" : holdToRun ? " (jog hold)" : ""),
    );

    return true;
  }

  release(direction: Direction): void {
    if (this.bothHeldTimer !== null) {
      Timer.clear(this.bothHeldTimer);
      this.bothHeldTimer = null;
    }

    if (this.holdEscapeTimer !== null) {
      Timer.clear(this.holdEscapeTimer);
      this.holdEscapeTimer = null;
    }

    // jog hold-to-run: release of the running direction stops the run
    // (except the confirmation burst, which is script-owned)
    if (
      this.jogMode &&
      !this.calibrating &&
      !this.bursting &&
      this.state === MachineState.Running &&
      direction === this.direction
    ) {
      this.stopRun("jog release");
    }
  }

  // ---- hardware feedback ----

  // S3: platform physically reached a terminal; direction of travel disambiguates
  limitHit(): void {
    var direction = this.state === MachineState.Running ? this.direction : this.lastRunDirection;

    if (direction === null) {
      this.log("limit feedback with no known direction — ignored");
      return;
    }

    this.atTerminal(direction, "S3 feedback");

    if (this.calibrating) {
      this.calibrating = false;
      this.log("CALIBRATION complete — at top, 100%");
    }

    if (this.state === MachineState.Running) {
      this.expectingOffEcho = this.outputOn(Direction.Up) || this.outputOn(Direction.Down);
      this.bothOff(); // end the command; motion already ended at the Harmar limit
      this.cooldown();
    }
  }

  onSwitchStatus(status: ShellyStatus): void {
    if (status.name !== "switch") return;
    if (status.id !== Direction.Up && status.id !== Direction.Down) return;
    if (!status.delta || status.delta.output === undefined) return;

    var id = status.id as Direction;
    var source = status.delta.source ? status.delta.source : "?";

    if (this.outputOn(Direction.Up) && this.outputOn(Direction.Down)) {
      this.fault("both outputs ON");
      return;
    }

    if (status.delta.output === false) {
      this.onOutputOff(id, source);
    } else {
      this.onOutputOn(id, source);
    }
  }

  private onOutputOff(id: Direction, source: string): void {
    // integrate actual energized time regardless of why the run ended
    if (this.runStartedAt !== 0 && id === this.lastRunDirection) {
      this.integrateRunTime(id, Date.now() - this.runStartedAt);
      this.runStartedAt = 0;
    }

    if (this.expectingOffEcho) {
      this.expectingOffEcho = false;
      this.declareFloorFromEstimate();
      return;
    }

    if (this.state !== MachineState.Running || id !== this.direction) return;

    if (source === "timer") {
      // firmware Auto-Off: the run drove onto its limit
      this.log("Auto-Off end of run");
      this.atTerminal(id, "Auto-Off");

      if (this.calibrating) {
        this.calibrating = false;
        this.log("CALIBRATION complete — at top, 100%");
      }
    } else {
      // deliberate external OFF (UI/RPC): a stop, NOT a floor declaration
      this.log("external stop (source=" + source + ")");

      if (this.calibrating) {
        this.calibrating = false;
        this.calibrationPending = false;
        this.log("calibration aborted by external stop");
      }

      this.declareFloorFromEstimate();
    }

    this.cooldown();
  }

  private onOutputOn(id: Direction, source: string): void {
    if (id === this.expectedOnEcho) {
      this.expectedOnEcho = null; // our own commanded-ON echo
      return;
    }

    if (!this.outputOn(id)) return; // stale event: already off again

    if (this.state === MachineState.Running && id === this.direction) return; // duplicate echo

    // deliberate external ON (management UI / direct RPC): adopt it as a
    // governed run instead of faulting — Auto-Off is already armed by fw,
    // and every arbiter rule (stop/reverse/gestures) applies from here on
    var deliberate =
      source !== "?" && source !== "init" && source !== "timer" && source !== "loopback";

    if (
      deliberate &&
      !this.calibrating &&
      !this.calibrationPending &&
      (this.state === MachineState.Idle || this.state === MachineState.Cooldown) &&
      !this.outputOn(this.opposite(id))
    ) {
      this.adoptRun(id, source);
      return;
    }

    this.fault("unexpected output ON: switch:" + id + " source=" + source);
  }

  // an external command turned an output on: take ownership of the run
  adoptRun(id: Direction, source: string): void {
    this.log("ADOPTED external " + DIRECTION_NAME[id] + " run (source=" + source + ")");
    this.cooldownUntil = 0;
    this.state = MachineState.Running;
    this.direction = id;
    this.commandedOn[id] = true; // sync intent with reality
    this.reverseTo = null; // any pending reversal is superseded
    this.runStartedAt = Date.now();
    this.lastRunDirection = id;
    this.expectedOnEcho = null;
    this.setPosition(Position.Mid);
  }

  // ---- init ----

  init(): void {
    this.io.attach(this);
    this.bothOff(); // fail-safe regardless of pre-boot state

    // restore chain: webhook base -> position -> estimate (each depends on prior)
    this.io.pushOneShot("KVS.Get", { key: CFG.WEBHOOK_KEY }, (result, errorCode) => {
      var record = result as { value?: unknown; } | null;

      if (errorCode === 0 && record && typeof record.value === "string" && record.value !== "") {
        CFG.WEBHOOK_BASE = record.value;
        this.log("webhook base from KVS: " + CFG.WEBHOOK_BASE);
      }

      this.io.pushOneShot("KVS.Get", { key: CFG.POSITION_KEY }, (posResult, posError) => {
        var posRecord = posResult as { value?: unknown; } | null;

        if (posError === 0 && posRecord && typeof posRecord.value === "string") {
          this.position = posRecord.value as Position;
        }

        this.log("position restored: " + this.position);
        this.pushPositionSensors();
        this.pushFaultAlert(false); // healthy boot clears any stale alarm

        this.io.pushOneShot("KVS.Get", { key: CFG.ESTIMATE_KEY }, (estResult, estError) => {
          var estRecord = estResult as { value?: unknown; } | null;

          if (
            estError === 0 &&
            estRecord &&
            estRecord.value !== "" &&
            typeof estRecord.value === "string"
          ) {
            var parsed = JSON.parse(estRecord.value);

            if (typeof parsed === "number") this.estimate = parsed;
          }

          if (this.estimate === null) {
            if (this.position === Position.Top) this.estimate = 1;
            else if (this.position === Position.Bottom) this.estimate = 0;
          }

          this.log("est restored: " + (this.estimate === null ? "null" : this.estimate));
        });
      });
    });

    var limitConfig = Shelly.getComponentConfig("input:" + CFG.LIMIT_INPUT);
    this.limitFeedbackActive = limitConfig !== null && limitConfig.enable === true;
    this.log(
      "S3 limit feedback: " +
      (this.limitFeedbackActive ? "ACTIVE" : "not wired (input:2 disabled)"),
    );

    for (var id = Direction.Up; id <= Direction.Down; id++) {
      var switchConfig = Shelly.getComponentConfig("switch:" + id);

      if (!switchConfig) continue;

      if (switchConfig.auto_off && typeof switchConfig.auto_off_delay === "number") {
        // Auto-Off >= travel time, so it doubles as the full-travel scale
        if (id === Direction.Up) CFG.TRAVEL_UP_MS = switchConfig.auto_off_delay * 1000;
        else CFG.TRAVEL_DOWN_MS = switchConfig.auto_off_delay * 1000;
      }

      if (switchConfig.initial_state !== "off") {
        this.log("WARN switch:" + id + " initial_state='" + switchConfig.initial_state + "'");
      }

      if (switchConfig.in_mode !== "detached") {
        this.log("WARN switch:" + id + " in_mode='" + switchConfig.in_mode + "'");
      }

      if (!switchConfig.auto_off) this.log("WARN switch:" + id + " auto_off DISABLED");
    }

    this.log(
      "armed — rev13 jog-burst, cooldown " +
      CFG.COOLDOWN_MS +
      "ms (tick-confirmed), chain " +
      CFG.CHAIN_MS +
      "ms, travel " +
      CFG.TRAVEL_UP_MS / 1000 +
      "s/" +
      CFG.TRAVEL_DOWN_MS / 1000 +
      "s",
    );
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

var arbiter = new LiftArbiter();

Shelly.addEventHandler(
  arbiter.guard("eventHandler", (event: ShellyEvent) => {
    if (!event.info || event.info.event !== "toggle") return;

    if (event.component === "input:" + CFG.LIMIT_INPUT) {
      if (arbiter.limitFeedbackActive && event.info.state === true) arbiter.limitHit();

      return;
    }

    if (
      event.component !== "input:" + Direction.Up &&
      event.component !== "input:" + Direction.Down
    ) {
      return;
    }

    var id = event.info.id as Direction;

    if (event.info.state === true) arbiter.request(id, RequestSource.Input);
    else arbiter.release(id);
  }),
);

Shelly.addStatusHandler(
  arbiter.guard("statusHandler", (status: ShellyStatus) => {
    arbiter.onSwitchStatus(status);
  }),
);

// http://<ip>/script/<id>/lift?dir=up|down | ?cmd=stop|calibrate|reset|jog|hist | ?set=top|bottom|mid
HTTPServer.registerEndpoint("lift", (request, response) => {
  var query = request.query ? request.query : "";
  var result = "status";

  try {
    if (query.indexOf("cmd=stop") !== -1) {
      arbiter.calibrating = false;
      arbiter.calibrationPending = false; // http stop is a calibration escape hatch
      arbiter.reverseTo = null;

      if (arbiter.state === MachineState.Running) {
        arbiter.stopRun("http stop");
        result = "stopped";
      } else {
        result = "not-running";
      }
    } else if (query.indexOf("cmd=calibrate") !== -1) {
      result = arbiter.calibrating ? "already-calibrating" : arbiter.startCalibration("http");
    } else if (query.indexOf("cmd=reset") !== -1) {
      arbiter.hardReset("http");
      result = "reset";
    } else if (query.indexOf("cmd=jog") !== -1) {
      result = arbiter.toggleJogMode(null); // no direction: no confirmation burst
    } else if (query.indexOf("cmd=hist") !== -1) {
      result = "hist";
    } else if (query.indexOf("dir=up") !== -1) {
      result = arbiter.request(Direction.Up, RequestSource.Http);
    } else if (query.indexOf("dir=down") !== -1) {
      result = arbiter.request(Direction.Down, RequestSource.Http);
    } else if (query.indexOf("set=") !== -1) {
      // manual position calibration, only while stationary
      var requested: Position | null = null;
      if (query.indexOf("set=top") !== -1) requested = Position.Top;
      else if (query.indexOf("set=bottom") !== -1) requested = Position.Bottom;
      else if (query.indexOf("set=mid") !== -1) requested = Position.Mid;

      if (requested !== null && arbiter.state === MachineState.Idle) {
        arbiter.setEstimate(
          requested === Position.Top ? 1 : requested === Position.Bottom ? 0 : null,
        );
        arbiter.setPosition(requested);
        result = "calibrated";
      } else {
        result = "set-refused";
      }
    }
  } catch (error) {
    arbiter.fault("exception in http handler: " + (error as Error).message);
    result = "error";
  }

  var body: {
    result: string;
    state: MachineState;
    dir: string | null;
    jog: boolean;
    calib: boolean;
    pos: Position;
    pct: number | null;
    est: number | null;
    hist?: string[];
  } = {
    result: result,
    state: arbiter.state,
    dir: arbiter.direction === null ? null : DIRECTION_NAME[arbiter.direction],
    jog: arbiter.jogMode,
    calib: arbiter.calibrating || arbiter.calibrationPending,
    pos: arbiter.position,
    pct: arbiter.estimate === null ? null : Math.round(arbiter.estimate * 100),
    est: arbiter.estimate === null ? null : Math.round(arbiter.estimate * 100) / 100,
  };
  if (result === "hist") body.hist = arbiter.history;

  response.code = 200;
  response.body = JSON.stringify(body);
  response.send();
});

arbiter.init();
