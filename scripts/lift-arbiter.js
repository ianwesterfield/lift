"use strict";
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
// CONTROLS (rev 14) — no press-count gestures, no modes:
//   press (tap, release < 1 s)  -> latched full travel (energized immediately)
//   push (hold >= 1 s)          -> runs while held; release stops it (jog)
//   same-direction press in run -> STOP
//   opposite press in run       -> REVERSE: stop, dead-time, run other way
//                                  (tap = latched; keep holding = push rules)
//   hold paddle 3 s             -> lockout escape (FAULT/calibration only)
//   calibration                 -> REMOTE ONLY: ?cmd=calibrate (full UP,
//                                  paddle locked until Auto-Off)
//   external Switch.Set         -> ADOPTED as a governed run (UI/RPC = just
//                                  another input); conflicts/unexplained FAULT
//
// CRASH LESSON (rev 13 field crash): even memory-only work dies if the CALL
// CHAIN is deep — handler -> onSwitchStatus -> onOutputOff -> declareFloor ->
// atTerminal blew the mJS stack. Floor/terminal declarations are therefore
// DEFERRED: handlers set pending flags; the tick (pump) executes them at
// depth ~3.
//
// ARCHITECTURE RULE (hard-won): mJS has a tiny call stack and fw 2.0.0
// clobbers params of Shelly.call dispatched in the same tick. Handlers and
// helpers may ONLY mutate memory; ALL RPC I/O is emitted by ONE flat repeating
// timer (the IoQueue tick), at most one call per tick. No class inheritance,
// no accessors, no spread: those emit ES5 helpers the device cannot run.
// `const enum` only — it inlines to literals at compile time.
var DIRECTION_NAME = ["UP", "DOWN"];
var CFG = {
    COOLDOWN_MS: 0, // stop -> reverse/re-arm dead-time (tick-confirmed re-arm)
    HOLD_JOG_MS: 1000, // held >= this at release -> the run was a push: stop it
    TICK_MS: 25, // I/O drain tick
    TRAVEL_UP_MS: 55000, // dead-reckoning scale; overwritten at init from auto_off_delay
    TRAVEL_DOWN_MS: 45000,
    ESTIMATE_EDGE: 0.03, // estimate within this of 0/1 counts as at that floor
    OFF_GRACE_MS: 2000, // commanded-OFF may lag this long before it's "rogue"
    RESET_HOLD_MS: 3000, // lockout-escape hold duration
    LIMIT_INPUT: 2, // S3: optional "at a terminal" feedback (active when input:2 enabled)
    POSITION_KEY: "lift.pos",
    ESTIMATE_KEY: "lift.est",
    BLACKBOX_KEY: "lift.blackbox",
    WEBHOOK_KEY: "lift.hbwebhook", // optional KVS override for the webhook base
    WEBHOOK_BASE: "http://192.168.10.175:51828", // homebridge-http-webhooks listener
};
// ---------------------------------------------------------------------------
// IoQueue — the ONLY place Shelly.call happens. Everything else raises
// signals: relay FIFO, one-shot jobs, dirty flags, webhook queue. The tick
// drains at most one call per pass (fw clobbers same-tick dispatches) with
// budget headroom under the ~5 concurrent-call cap.
// ---------------------------------------------------------------------------
var IoQueue = /** @class */ (function () {
    function IoQueue() {
        this.relayQueue = []; // FIFO — relay command order is sacred
        this.oneShotJobs = [];
        this.positionDirty = false;
        this.estimateDirty = false;
        this.blackboxDirty = false;
        this.webhookQueue = [];
        this.callsInFlight = 0;
        this.owner = null;
    }
    IoQueue.prototype.attach = function (owner) {
        var _this = this;
        this.owner = owner;
        Timer.set(CFG.TICK_MS, true, function () {
            _this.tick();
            _this.owner.pump(); // re-arm / pending auto-starts
        });
    };
    IoQueue.prototype.pushRelay = function (id, on) {
        this.relayQueue.push({ id: id, on: on, retries: 0 });
    };
    IoQueue.prototype.pushOneShot = function (method, params, callback) {
        this.oneShotJobs.push({ kind: "job" /* JobKind.OneShot */, method: method, params: params, callback: callback });
    };
    IoQueue.prototype.nextJob = function () {
        var owner = this.owner;
        if (this.relayQueue.length > 0 && this.callsInFlight < 4) {
            var relayCommand = this.relayQueue.splice(0, 1)[0];
            return {
                kind: "relay" /* JobKind.Relay */,
                method: "Switch.Set",
                params: { id: relayCommand.id, on: relayCommand.on },
                relay: relayCommand,
            };
        }
        if (this.callsInFlight >= 2)
            return null; // headroom below the fw call cap
        if (this.oneShotJobs.length > 0)
            return this.oneShotJobs.splice(0, 1)[0];
        if (this.positionDirty) {
            this.positionDirty = false;
            return {
                kind: "pos" /* JobKind.PersistPosition */,
                method: "KVS.Set",
                params: { key: CFG.POSITION_KEY, value: owner.position },
            };
        }
        if (this.estimateDirty) {
            this.estimateDirty = false;
            var serialized = "";
            if (owner.estimate !== null)
                serialized = JSON.stringify(owner.estimate);
            return {
                kind: "est" /* JobKind.PersistEstimate */,
                method: "KVS.Set",
                params: { key: CFG.ESTIMATE_KEY, value: serialized },
            };
        }
        if (this.webhookQueue.length > 0) {
            var url = this.webhookQueue.splice(0, 1)[0];
            return { kind: "wh" /* JobKind.Webhook */, method: "HTTP.GET", params: { url: url, timeout: 3 } };
        }
        if (this.blackboxDirty) {
            this.blackboxDirty = false;
            return {
                kind: "bb" /* JobKind.PersistBlackbox */,
                method: "KVS.Set",
                params: { key: CFG.BLACKBOX_KEY, value: owner.history.join(" | ").slice(-250) },
            };
        }
        return null;
    };
    IoQueue.prototype.tick = function () {
        var _this = this;
        var job = this.nextJob();
        if (job === null)
            return;
        this.callsInFlight++;
        try {
            Shelly.call(job.method, job.params, function (result, errorCode, errorMessage, userdata) {
                _this.callsInFlight--;
                var finished = userdata;
                if (errorCode !== 0) {
                    switch (finished.kind) {
                        case "relay" /* JobKind.Relay */:
                            finished.relay.retries++;
                            if (finished.relay.retries <= 2) {
                                _this.relayQueue.unshift(finished.relay); // idempotent retry
                            }
                            else {
                                _this.owner.log("relay failed: " + errorMessage + " id=" + finished.relay.id);
                            }
                            break;
                        case "pos" /* JobKind.PersistPosition */:
                            _this.positionDirty = true;
                            break;
                        case "est" /* JobKind.PersistEstimate */:
                            _this.estimateDirty = true;
                            break;
                        default:
                            break; // webhook/blackbox: the next state change re-sends
                    }
                }
                if (finished.kind === "job" /* JobKind.OneShot */ && finished.callback) {
                    finished.callback(result, errorCode, errorMessage);
                }
            }, job);
        }
        catch (error) {
            this.callsInFlight--;
            switch (job.kind) {
                case "relay" /* JobKind.Relay */:
                    this.relayQueue.unshift(job.relay);
                    break;
                case "job" /* JobKind.OneShot */:
                    this.oneShotJobs.unshift(job);
                    break;
                case "pos" /* JobKind.PersistPosition */:
                    this.positionDirty = true;
                    break;
                case "est" /* JobKind.PersistEstimate */:
                    this.estimateDirty = true;
                    break;
                case "bb" /* JobKind.PersistBlackbox */:
                    this.blackboxDirty = true;
                    break;
                case "wh" /* JobKind.Webhook */:
                    break; // dropped; the next position change re-sends
            }
        }
    };
    return IoQueue;
}());
// ---------------------------------------------------------------------------
// LiftArbiter — the state machine. Handlers mutate memory only; all I/O goes
// through the IoQueue.
// ---------------------------------------------------------------------------
var LiftArbiter = /** @class */ (function () {
    function LiftArbiter() {
        this.state = "IDLE" /* MachineState.Idle */;
        this.direction = null;
        this.calibrating = false; // calibration ride: paddle ignored until Auto-Off
        this.calibrationPending = false;
        this.reverseTo = null; // reversal target after cooldown
        this.pendingTerminal = null; // terminal reached; declared by pump
        this.pendingTerminalWhy = "";
        this.pendingFloorCheck = false; // dead-reckoning floor check; run by pump
        this.runStartedAt = 0;
        this.lastRunDirection = null;
        this.expectedOnEcho = null; // commanded-ON echo still in flight
        this.commandedOn = [false, false];
        this.offCommandedAt = [0, 0];
        this.estimate = null; // 0=bottom..1=top; null until known
        this.expectingOffEcho = false; // we commanded OFF; swallow the resulting event
        this.cooldownUntil = 0; // re-arm gate; the tick promotes COOLDOWN->IDLE
        this.bothHeldTimer = null;
        this.holdEscapeTimer = null;
        this.limitFeedbackActive = false;
        this.history = [];
        this.position = "unknown" /* Position.Unknown */;
        this.io = new IoQueue();
    }
    // ---- logging / persistence signals ----
    LiftArbiter.prototype.log = function (message) {
        print("[lift] " + message);
        this.history.push(Math.round(Date.now() / 1000) + " " + message);
        if (this.history.length > 15)
            this.history.splice(0, 1);
        this.io.blackboxDirty = true;
    };
    LiftArbiter.prototype.guard = function (name, handler) {
        var _this = this;
        return function (a, b, c, d) {
            try {
                handler(a, b, c, d);
            }
            catch (error) {
                try {
                    _this.fault("exception in " + name + ": " + error.message);
                }
                catch (secondaryError) {
                    _this.bothOff(); // last resort
                }
            }
        };
    };
    LiftArbiter.prototype.setOutput = function (id, on) {
        this.commandedOn[id] = on;
        if (!on)
            this.offCommandedAt[id] = Date.now();
        this.io.pushRelay(id, on);
    };
    LiftArbiter.prototype.bothOff = function () {
        this.setOutput(0 /* Direction.Up */, false);
        this.setOutput(1 /* Direction.Down */, false);
    };
    LiftArbiter.prototype.outputOn = function (id) {
        var status = Shelly.getComponentStatus("switch:" + id);
        return status !== null && status.output === true;
    };
    LiftArbiter.prototype.inputOn = function (id) {
        var status = Shelly.getComponentStatus("input:" + id);
        return status !== null && status.state === true;
    };
    LiftArbiter.prototype.opposite = function (id) {
        return id === 0 /* Direction.Up */ ? 1 /* Direction.Down */ : 0 /* Direction.Up */;
    };
    // physically ON with no command intent and no recent OFF still landing
    LiftArbiter.prototype.rogueOutputOn = function () {
        for (var id = 0 /* Direction.Up */; id <= 1 /* Direction.Down */; id++) {
            var direction = id;
            if (this.outputOn(direction) &&
                !this.commandedOn[direction] &&
                Date.now() - this.offCommandedAt[direction] > CFG.OFF_GRACE_MS) {
                return true;
            }
        }
        return false;
    };
    LiftArbiter.prototype.setPosition = function (position) {
        if (this.position === position)
            return;
        this.position = position;
        this.log("position: " + position);
        this.io.positionDirty = true;
        this.pushPositionSensors();
    };
    // append (not replace): a queued FAULT alert must never be dropped
    LiftArbiter.prototype.pushPositionSensors = function () {
        this.io.webhookQueue.push(CFG.WEBHOOK_BASE + "/?accessoryId=lift-top&state=" + (this.position === "top" /* Position.Top */), CFG.WEBHOOK_BASE + "/?accessoryId=lift-bottom&state=" + (this.position === "bottom" /* Position.Bottom */));
    };
    LiftArbiter.prototype.pushFaultAlert = function (on) {
        this.io.webhookQueue.push(CFG.WEBHOOK_BASE + "/?accessoryId=lift-fault&state=" + on);
    };
    LiftArbiter.prototype.setEstimate = function (estimate) {
        this.estimate = estimate;
        this.io.estimateDirty = true;
    };
    LiftArbiter.prototype.integrateRunTime = function (direction, elapsedMs) {
        if (this.estimate === null || elapsedMs <= 0)
            return;
        var delta = direction === 0 /* Direction.Up */
            ? elapsedMs / CFG.TRAVEL_UP_MS
            : -elapsedMs / CFG.TRAVEL_DOWN_MS;
        this.setEstimate(Math.min(1, Math.max(0, this.estimate + delta)));
    };
    // a run reached a terminal for certain (Auto-Off, S3 feedback)
    LiftArbiter.prototype.atTerminal = function (direction, why) {
        this.setEstimate(direction === 0 /* Direction.Up */ ? 1 : 0);
        this.setPosition(direction === 0 /* Direction.Up */ ? "top" /* Position.Top */ : "bottom" /* Position.Bottom */);
        this.log("at " + (direction === 0 /* Direction.Up */ ? "top" : "bottom") + " (" + why + ")");
    };
    // after a stop: dead reckoning may still conclude we reached a floor
    LiftArbiter.prototype.declareFloorFromEstimate = function () {
        if (this.estimate === null || this.position !== "mid" /* Position.Mid */)
            return;
        if (this.estimate >= 1 - CFG.ESTIMATE_EDGE)
            this.atTerminal(0 /* Direction.Up */, "dead reckoning");
        else if (this.estimate <= CFG.ESTIMATE_EDGE)
            this.atTerminal(1 /* Direction.Down */, "dead reckoning");
    };
    // ---- state transitions ----
    LiftArbiter.prototype.fault = function (reason) {
        this.log("FAULT: " + reason + " — both outputs OFF, lockout (cmd=reset to clear)");
        this.cooldownUntil = 0;
        this.bothOff();
        this.state = "FAULT" /* MachineState.Fault */;
        this.direction = null;
        this.calibrating = false;
        this.calibrationPending = false;
        this.reverseTo = null;
        this.pendingTerminal = null;
        this.pendingFloorCheck = false;
        this.runStartedAt = 0; // hygiene: no stale segment survives a fault
        this.pushFaultAlert(true); // HomeKit-visible alarm
    };
    // COOLDOWN ends when the dead-time (possibly 0) has passed AND the relays
    // are physically OFF with nothing in flight — promoted by the IO tick, so
    // "zero cooldown" is really "as soon as the hardware confirms quiescent".
    LiftArbiter.prototype.cooldown = function () {
        this.state = "COOLDOWN" /* MachineState.Cooldown */;
        this.direction = null;
        this.cooldownUntil = Date.now() + CFG.COOLDOWN_MS;
    };
    // called every IO tick: deferred declarations, re-arm, pending auto-starts.
    // Floor/terminal work runs HERE (depth ~3), never in handler chains — the
    // handler->onOutputOff->declareFloor->atTerminal chain blew the mJS stack.
    LiftArbiter.prototype.pump = function () {
        if (this.state !== "RUNNING" /* MachineState.Running */) {
            if (this.pendingTerminal !== null) {
                var terminalDirection = this.pendingTerminal;
                this.pendingTerminal = null;
                this.atTerminal(terminalDirection, this.pendingTerminalWhy);
            }
            if (this.pendingFloorCheck) {
                this.pendingFloorCheck = false;
                this.declareFloorFromEstimate();
            }
        }
        if (this.state !== "COOLDOWN" /* MachineState.Cooldown */)
            return;
        if (Date.now() < this.cooldownUntil)
            return;
        if (this.io.relayQueue.length > 0)
            return; // relay commands still queued
        if (this.outputOn(0 /* Direction.Up */) || this.outputOn(1 /* Direction.Down */))
            return;
        this.state = "IDLE" /* MachineState.Idle */;
        this.log("re-armed");
        if (this.calibrationPending) {
            if (this.inputOn(0 /* Direction.Up */) || this.inputOn(1 /* Direction.Down */)) {
                this.cooldown(); // the calibration press is still held: wait it out
                return;
            }
            this.calibrationPending = false;
            this.reverseTo = null;
            this.startCalibrationRun();
        }
        else if (this.reverseTo !== null) {
            var target = this.reverseTo;
            this.reverseTo = null;
            var outcome = this.request(target, "reverse" /* RequestSource.Reverse */);
            if (outcome !== "accepted")
                this.log("reverse did not start: " + outcome);
        }
    };
    LiftArbiter.prototype.stopRun = function (reason) {
        this.log("STOP (" + reason + ")");
        // only expect an off-event if something is actually on (a stop can race Auto-Off)
        this.expectingOffEcho = this.outputOn(0 /* Direction.Up */) || this.outputOn(1 /* Direction.Down */);
        this.bothOff();
        this.cooldown();
    };
    LiftArbiter.prototype.hardReset = function (source) {
        this.log("HARD RESET (" + source + ")");
        this.cooldownUntil = 0;
        this.bothOff();
        this.state = "IDLE" /* MachineState.Idle */;
        this.direction = null;
        this.calibrating = false;
        this.calibrationPending = false;
        this.reverseTo = null;
        this.pendingTerminal = null;
        this.pendingFloorCheck = false;
        this.expectingOffEcho = false;
        this.expectedOnEcho = null;
        this.runStartedAt = 0;
        this.pushFaultAlert(false); // clear the HomeKit alarm
    };
    LiftArbiter.prototype.armBothHeldReset = function () {
        var _this = this;
        if (this.bothHeldTimer !== null)
            return;
        this.bothHeldTimer = Timer.set(CFG.RESET_HOLD_MS, false, this.guard("bothHeldTimer", function () {
            _this.bothHeldTimer = null;
            if (_this.inputOn(0 /* Direction.Up */) && _this.inputOn(1 /* Direction.Down */)) {
                _this.hardReset("both buttons held");
            }
        }));
    };
    // Rocker paddle can't press both directions; lockout states get a one-button
    // escape. Never armed in normal states.
    LiftArbiter.prototype.armHoldEscape = function (direction) {
        var _this = this;
        if (this.holdEscapeTimer !== null)
            return;
        this.holdEscapeTimer = Timer.set(CFG.RESET_HOLD_MS, false, this.guard("holdEscapeTimer", function () {
            _this.holdEscapeTimer = null;
            if (_this.inputOn(direction) &&
                (_this.state === "FAULT" /* MachineState.Fault */ || _this.calibrating || _this.calibrationPending)) {
                _this.hardReset("paddle held in lockout");
            }
        }));
    };
    // ---- calibration (remote only: ?cmd=calibrate) ----
    LiftArbiter.prototype.startCalibration = function (source) {
        this.log("CALIBRATION (" + source + "): full UP, paddle locked until Auto-Off");
        this.calibrating = true;
        if (this.state === "RUNNING" /* MachineState.Running */) {
            if (this.direction === 0 /* Direction.Up */)
                return "calibrating"; // this run becomes the ride
            this.calibrationPending = true;
            this.stopRun("calibration: stop before UP ride");
            return "calibrating";
        }
        if (this.state === "COOLDOWN" /* MachineState.Cooldown */) {
            this.calibrationPending = true;
            return "calibrating";
        }
        this.startCalibrationRun();
        return "calibrating";
    };
    LiftArbiter.prototype.startCalibrationRun = function () {
        var outcome = this.request(0 /* Direction.Up */, "calib" /* RequestSource.Calibration */);
        if (outcome !== "accepted") {
            this.calibrating = false;
            this.calibrationPending = false;
            this.log("calibration failed to start: " + outcome);
        }
    };
    // ---- the single request entry point ----
    LiftArbiter.prototype.request = function (direction, source) {
        if (source === "input" /* RequestSource.Input */) {
            if (this.inputOn(0 /* Direction.Up */) && this.inputOn(1 /* Direction.Down */))
                this.armBothHeldReset();
            if (this.state === "FAULT" /* MachineState.Fault */ || this.calibrating || this.calibrationPending) {
                this.armHoldEscape(direction);
            }
        }
        if (this.calibrating && source === "input" /* RequestSource.Input */) {
            this.log("ignored " + DIRECTION_NAME[direction] + ": calibration in progress");
            return "calibrating";
        }
        if (source === "input" /* RequestSource.Input */) {
            this.log("press " + DIRECTION_NAME[direction] + " (" + this.state + ")");
        }
        switch (this.state) {
            case "FAULT" /* MachineState.Fault */:
                this.log("ignored " + DIRECTION_NAME[direction] + " (" + source + "): FAULT lockout");
                return "fault";
            case "RUNNING" /* MachineState.Running */:
                if (direction !== this.direction) {
                    // opposite press = immediate stop, dead-time, full travel the other way
                    this.reverseTo = direction;
                    this.stopRun("reverse to " + DIRECTION_NAME[direction] + " (" + source + ")");
                    return "reversing";
                }
                if (source !== "input" /* RequestSource.Input */)
                    return "already-running";
                // same-direction press during a run = deliberate stop
                this.reverseTo = null;
                this.stopRun("same-direction press");
                return "stopped";
            case "IDLE" /* MachineState.Idle */:
                if (this.rogueOutputOn()) {
                    this.fault("output ON while believed IDLE");
                    return "fault";
                }
                if (this.outputOn(0 /* Direction.Up */) || this.outputOn(1 /* Direction.Down */)) {
                    this.log("outputs settling — press again");
                    return "settling";
                }
                if (this.inputOn(this.opposite(direction))) {
                    this.log("opposite input held — refusing " + DIRECTION_NAME[direction]);
                    this.cooldown();
                    return "conflict";
                }
                this.direction = direction;
                return this.startRun() ? "accepted" : "aborted";
            default:
                return "busy"; // COOLDOWN settling
        }
    };
    // Firmware Auto-Off still backs up every run, latched or held.
    LiftArbiter.prototype.startRun = function () {
        if (this.outputOn(0 /* Direction.Up */) || this.outputOn(1 /* Direction.Down */)) {
            if (this.rogueOutputOn()) {
                this.fault("output ON at run start");
            }
            else {
                // our own OFF command hasn't landed yet (queue lag): abort quietly
                this.log("outputs still settling — run aborted, press again");
                this.cooldown();
            }
            return false;
        }
        // RUNNING before energizing: a press landing between decision and relay
        // closure is handled by the run rules, never as a second acceptance.
        this.state = "RUNNING" /* MachineState.Running */;
        this.runStartedAt = Date.now();
        this.lastRunDirection = this.direction;
        this.expectedOnEcho = this.direction;
        this.pendingTerminal = null; // new motion supersedes stale conclusions
        this.pendingFloorCheck = false;
        this.setPosition("mid" /* Position.Mid */); // persisted before energizing
        this.setOutput(this.direction, true);
        this.log("RUNNING " +
            DIRECTION_NAME[this.direction] +
            (this.calibrating ? " (calibration)" : ""));
        return true;
    };
    LiftArbiter.prototype.release = function (direction) {
        if (this.bothHeldTimer !== null) {
            Timer.clear(this.bothHeldTimer);
            this.bothHeldTimer = null;
        }
        if (this.holdEscapeTimer !== null) {
            Timer.clear(this.holdEscapeTimer);
            this.holdEscapeTimer = null;
        }
        // push semantics: a run whose paddle was held >= HOLD_JOG_MS stops on
        // release (a quick tap latches; releases can't touch a calibration ride)
        if (!this.calibrating &&
            this.state === "RUNNING" /* MachineState.Running */ &&
            direction === this.direction &&
            Date.now() - this.runStartedAt >= CFG.HOLD_JOG_MS) {
            this.stopRun("push release");
        }
    };
    // ---- hardware feedback ----
    // S3: platform physically reached a terminal; direction of travel disambiguates
    LiftArbiter.prototype.limitHit = function () {
        var direction = this.state === "RUNNING" /* MachineState.Running */ ? this.direction : this.lastRunDirection;
        if (direction === null) {
            this.log("limit feedback with no known direction — ignored");
            return;
        }
        this.pendingTerminal = direction; // declared by the pump (stack headroom)
        this.pendingTerminalWhy = "S3 feedback";
        if (this.calibrating) {
            this.calibrating = false;
            this.log("CALIBRATION complete — at top, 100%");
        }
        if (this.state === "RUNNING" /* MachineState.Running */) {
            this.expectingOffEcho = this.outputOn(0 /* Direction.Up */) || this.outputOn(1 /* Direction.Down */);
            this.bothOff(); // end the command; motion already ended at the Harmar limit
            this.cooldown();
        }
    };
    LiftArbiter.prototype.onSwitchStatus = function (status) {
        if (status.name !== "switch")
            return;
        if (status.id !== 0 /* Direction.Up */ && status.id !== 1 /* Direction.Down */)
            return;
        if (!status.delta || status.delta.output === undefined)
            return;
        var id = status.id;
        var source = status.delta.source ? status.delta.source : "?";
        if (this.outputOn(0 /* Direction.Up */) && this.outputOn(1 /* Direction.Down */)) {
            this.fault("both outputs ON");
            return;
        }
        if (status.delta.output === false) {
            this.onOutputOff(id, source);
        }
        else {
            this.onOutputOn(id, source);
        }
    };
    LiftArbiter.prototype.onOutputOff = function (id, source) {
        // integrate actual energized time regardless of why the run ended
        if (this.runStartedAt !== 0 && id === this.lastRunDirection) {
            this.integrateRunTime(id, Date.now() - this.runStartedAt);
            this.runStartedAt = 0;
        }
        if (this.expectingOffEcho) {
            this.expectingOffEcho = false;
            this.pendingFloorCheck = true; // pump declares (stack headroom)
            return;
        }
        if (this.state !== "RUNNING" /* MachineState.Running */ || id !== this.direction)
            return;
        if (source === "timer") {
            // firmware Auto-Off: the run drove onto its limit
            this.log("Auto-Off end of run");
            this.pendingTerminal = id;
            this.pendingTerminalWhy = "Auto-Off";
            if (this.calibrating) {
                this.calibrating = false;
                this.log("CALIBRATION complete — at top, 100%");
            }
        }
        else {
            // deliberate external OFF (UI/RPC): a stop, NOT a floor declaration
            this.log("external stop (source=" + source + ")");
            if (this.calibrating) {
                this.calibrating = false;
                this.calibrationPending = false;
                this.log("calibration aborted by external stop");
            }
            this.pendingFloorCheck = true;
        }
        this.cooldown();
    };
    LiftArbiter.prototype.onOutputOn = function (id, source) {
        if (id === this.expectedOnEcho) {
            this.expectedOnEcho = null; // our own commanded-ON echo
            return;
        }
        if (!this.outputOn(id))
            return; // stale event: already off again
        if (this.state === "RUNNING" /* MachineState.Running */ && id === this.direction)
            return; // duplicate echo
        // deliberate external ON (management UI / direct RPC): adopt it as a
        // governed run instead of faulting — Auto-Off is already armed by fw,
        // and every arbiter rule (stop/reverse/gestures) applies from here on
        var deliberate = source !== "?" && source !== "init" && source !== "timer" && source !== "loopback";
        if (deliberate &&
            !this.calibrating &&
            !this.calibrationPending &&
            (this.state === "IDLE" /* MachineState.Idle */ || this.state === "COOLDOWN" /* MachineState.Cooldown */) &&
            !this.outputOn(this.opposite(id))) {
            this.adoptRun(id, source);
            return;
        }
        this.fault("unexpected output ON: switch:" + id + " source=" + source);
    };
    // an external command turned an output on: take ownership of the run
    LiftArbiter.prototype.adoptRun = function (id, source) {
        this.log("ADOPTED external " + DIRECTION_NAME[id] + " run (source=" + source + ")");
        this.cooldownUntil = 0;
        this.state = "RUNNING" /* MachineState.Running */;
        this.direction = id;
        this.commandedOn[id] = true; // sync intent with reality
        this.reverseTo = null; // any pending reversal is superseded
        this.pendingTerminal = null;
        this.pendingFloorCheck = false;
        this.runStartedAt = Date.now();
        this.lastRunDirection = id;
        this.expectedOnEcho = null;
        this.setPosition("mid" /* Position.Mid */);
    };
    // ---- init ----
    LiftArbiter.prototype.init = function () {
        var _this = this;
        this.io.attach(this);
        this.bothOff(); // fail-safe regardless of pre-boot state
        // restore chain: webhook base -> position -> estimate (each depends on prior)
        this.io.pushOneShot("KVS.Get", { key: CFG.WEBHOOK_KEY }, function (result, errorCode) {
            var record = result;
            if (errorCode === 0 && record && typeof record.value === "string" && record.value !== "") {
                CFG.WEBHOOK_BASE = record.value;
                _this.log("webhook base from KVS: " + CFG.WEBHOOK_BASE);
            }
            _this.io.pushOneShot("KVS.Get", { key: CFG.POSITION_KEY }, function (posResult, posError) {
                var posRecord = posResult;
                if (posError === 0 && posRecord && typeof posRecord.value === "string") {
                    _this.position = posRecord.value;
                }
                _this.log("position restored: " + _this.position);
                _this.pushPositionSensors();
                _this.pushFaultAlert(false); // healthy boot clears any stale alarm
                _this.io.pushOneShot("KVS.Get", { key: CFG.ESTIMATE_KEY }, function (estResult, estError) {
                    var estRecord = estResult;
                    if (estError === 0 &&
                        estRecord &&
                        estRecord.value !== "" &&
                        typeof estRecord.value === "string") {
                        var parsed = JSON.parse(estRecord.value);
                        if (typeof parsed === "number")
                            _this.estimate = parsed;
                    }
                    if (_this.estimate === null) {
                        if (_this.position === "top" /* Position.Top */)
                            _this.estimate = 1;
                        else if (_this.position === "bottom" /* Position.Bottom */)
                            _this.estimate = 0;
                    }
                    _this.log("est restored: " + (_this.estimate === null ? "null" : _this.estimate));
                });
            });
        });
        var limitConfig = Shelly.getComponentConfig("input:" + CFG.LIMIT_INPUT);
        this.limitFeedbackActive = limitConfig !== null && limitConfig.enable === true;
        this.log("S3 limit feedback: " +
            (this.limitFeedbackActive ? "ACTIVE" : "not wired (input:2 disabled)"));
        for (var id = 0 /* Direction.Up */; id <= 1 /* Direction.Down */; id++) {
            var switchConfig = Shelly.getComponentConfig("switch:" + id);
            if (!switchConfig)
                continue;
            if (switchConfig.auto_off && typeof switchConfig.auto_off_delay === "number") {
                // Auto-Off >= travel time, so it doubles as the full-travel scale
                if (id === 0 /* Direction.Up */)
                    CFG.TRAVEL_UP_MS = switchConfig.auto_off_delay * 1000;
                else
                    CFG.TRAVEL_DOWN_MS = switchConfig.auto_off_delay * 1000;
            }
            if (switchConfig.initial_state !== "off") {
                this.log("WARN switch:" + id + " initial_state='" + switchConfig.initial_state + "'");
            }
            if (switchConfig.in_mode !== "detached") {
                this.log("WARN switch:" + id + " in_mode='" + switchConfig.in_mode + "'");
            }
            if (!switchConfig.auto_off)
                this.log("WARN switch:" + id + " auto_off DISABLED");
        }
        this.log("armed — rev14 push-jog, cooldown " +
            CFG.COOLDOWN_MS +
            "ms (tick-confirmed), hold-to-jog " +
            CFG.HOLD_JOG_MS +
            "ms, travel " +
            CFG.TRAVEL_UP_MS / 1000 +
            "s/" +
            CFG.TRAVEL_DOWN_MS / 1000 +
            "s");
    };
    return LiftArbiter;
}());
// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
var arbiter = new LiftArbiter();
Shelly.addEventHandler(arbiter.guard("eventHandler", function (event) {
    if (!event.info || event.info.event !== "toggle")
        return;
    if (event.component === "input:" + CFG.LIMIT_INPUT) {
        if (arbiter.limitFeedbackActive && event.info.state === true)
            arbiter.limitHit();
        return;
    }
    if (event.component !== "input:" + 0 /* Direction.Up */ &&
        event.component !== "input:" + 1 /* Direction.Down */) {
        return;
    }
    var id = event.info.id;
    if (event.info.state === true)
        arbiter.request(id, "input" /* RequestSource.Input */);
    else
        arbiter.release(id);
}));
Shelly.addStatusHandler(arbiter.guard("statusHandler", function (status) {
    arbiter.onSwitchStatus(status);
}));
// http://<ip>/script/<id>/lift?dir=up|down | ?cmd=stop|calibrate|reset|hist | ?set=top|bottom|mid
HTTPServer.registerEndpoint("lift", function (request, response) {
    var query = request.query ? request.query : "";
    var result = "status";
    try {
        if (query.indexOf("cmd=stop") !== -1) {
            arbiter.calibrating = false;
            arbiter.calibrationPending = false; // http stop is a calibration escape hatch
            arbiter.reverseTo = null;
            if (arbiter.state === "RUNNING" /* MachineState.Running */) {
                arbiter.stopRun("http stop");
                result = "stopped";
            }
            else {
                result = "not-running";
            }
        }
        else if (query.indexOf("cmd=calibrate") !== -1) {
            result = arbiter.calibrating ? "already-calibrating" : arbiter.startCalibration("http");
        }
        else if (query.indexOf("cmd=reset") !== -1) {
            arbiter.hardReset("http");
            result = "reset";
        }
        else if (query.indexOf("cmd=hist") !== -1) {
            result = "hist";
        }
        else if (query.indexOf("dir=up") !== -1) {
            result = arbiter.request(0 /* Direction.Up */, "http" /* RequestSource.Http */);
        }
        else if (query.indexOf("dir=down") !== -1) {
            result = arbiter.request(1 /* Direction.Down */, "http" /* RequestSource.Http */);
        }
        else if (query.indexOf("set=") !== -1) {
            // manual position calibration, only while stationary
            var requested = null;
            if (query.indexOf("set=top") !== -1)
                requested = "top" /* Position.Top */;
            else if (query.indexOf("set=bottom") !== -1)
                requested = "bottom" /* Position.Bottom */;
            else if (query.indexOf("set=mid") !== -1)
                requested = "mid" /* Position.Mid */;
            if (requested !== null && arbiter.state === "IDLE" /* MachineState.Idle */) {
                arbiter.setEstimate(requested === "top" /* Position.Top */ ? 1 : requested === "bottom" /* Position.Bottom */ ? 0 : null);
                arbiter.setPosition(requested);
                result = "calibrated";
            }
            else {
                result = "set-refused";
            }
        }
    }
    catch (error) {
        arbiter.fault("exception in http handler: " + error.message);
        result = "error";
    }
    var body = {
        result: result,
        state: arbiter.state,
        dir: arbiter.direction === null ? null : DIRECTION_NAME[arbiter.direction],
        calib: arbiter.calibrating || arbiter.calibrationPending,
        pos: arbiter.position,
        pct: arbiter.estimate === null ? null : Math.round(arbiter.estimate * 100),
        est: arbiter.estimate === null ? null : Math.round(arbiter.estimate * 100) / 100,
    };
    if (result === "hist")
        body.hist = arbiter.history;
    response.code = 200;
    response.body = JSON.stringify(body);
    response.send();
});
arbiter.init();
