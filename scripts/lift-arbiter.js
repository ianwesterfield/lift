"use strict";
// lift-arbiter.ts — Harmar Highlander II motion arbiter (Shelly Pro 3 "Lift")
// Source of truth: this TypeScript. Build with `npm run build` -> scripts/lift-arbiter.js
// (ES5, script-mode, no modules/helpers — the device runs mJS).
//
// Supervisory convenience logic ONLY. The Harmar controller owns all safety,
// interlocks and travel limits. Firmware Auto-Off (UP 55s / DOWN 45s) is the
// hard command backstop and is never refreshed or extended by this script.
//
// O1 (switch:0) = J6 UP, O2 (switch:1) = J6 DOWN.
// S1 (input:0)  = any physical UP request, S2 (input:1) = any physical DOWN.
// Inputs must be type "switch", in_mode "detached", initial_state "off".
//
// ARCHITECTURE RULE (hard-won): mJS has a tiny call stack and fw 2.0.0
// clobbers params of Shelly.call dispatched in the same tick. Handlers and
// helpers may ONLY mutate memory; ALL RPC I/O is emitted by ONE flat repeating
// timer (tick), at most one call per tick.
var CFG = {
    COOLDOWN_MS: 400, // dead-time after any stop before re-arm
    DBL_MS: 3000, // gesture chain: ALL presses within 3 s of the chain's first press
    TICK_MS: 25, // I/O drain tick
    TRAVEL_UP_MS: 55000, // dead-reckoning scale; overwritten at init from auto_off_delay
    TRAVEL_DOWN_MS: 45000,
    EST_EDGE: 0.03, // estimate within this of 0/1 counts as at that floor
    OFF_GRACE_MS: 2000, // commanded-OFF may lag this long before it's "rogue"
    RESET_HOLD_MS: 3000, // hold gesture duration for reset/lockout escape
    LIMIT_IN: 2, // S3: optional "at a terminal" feedback (active when input:2 enabled)
    POS_KEY: "lift.pos",
    EST_KEY: "lift.est",
    LOG_KEY: "lift.blackbox",
    HB_WEBHOOK: "http://192.168.10.175:51828", // homebridge-http-webhooks listener
};
var UP = 0;
var DOWN = 1;
var DIR_NAME = ["UP", "DOWN"];
var S = {
    state: "IDLE",
    dir: null,
    calib: false,
    calibPending: false,
    seqN: 0,
    seqDir: null,
    seqStartTs: 0,
    nextDir: null,
    runOnTs: 0,
    lastRunDir: null,
    onPending: null,
    cmd: [false, false],
    offTs: [0, 0],
    est: null,
    stopping: false,
    cdTimer: null,
    resetTimer: null,
    holdTimer: null,
    limitFb: false,
    hist: [],
    pos: "unknown",
};
var IO = {
    relay: [],
    jobs: [],
    dirtyPos: false,
    dirtyEst: false,
    dirtyBB: false,
    whQueue: [],
    inflight: 0,
};
function log(msg) {
    print("[lift] " + msg);
    S.hist.push(Math.round(Date.now() / 1000) + " " + msg);
    if (S.hist.length > 15)
        S.hist.splice(0, 1);
    IO.dirtyBB = true; // persisted by the tick; NO calls from here
}
function setOut(id, on) {
    S.cmd[id] = on; // intent, set synchronously; hardware lags by queue ticks
    if (!on)
        S.offTs[id] = Date.now();
    IO.relay.push({ id: id, on: on, r: 0 });
}
function bothOff() {
    setOut(UP, false);
    setOut(DOWN, false);
}
function outOn(id) {
    var st = Shelly.getComponentStatus("switch:" + id);
    return st !== null && st.output === true;
}
function inOn(id) {
    var st = Shelly.getComponentStatus("input:" + id);
    return st !== null && st.state === true;
}
// physically ON with no command intent and no recent OFF still landing
function rogueOn() {
    for (var i = UP; i <= DOWN; i++) {
        var d = i;
        if (outOn(d) && !S.cmd[d] && Date.now() - S.offTs[d] > CFG.OFF_GRACE_MS)
            return true;
    }
    return false;
}
function setPos(p) {
    if (S.pos === p)
        return;
    S.pos = p;
    log("position: " + p);
    IO.dirtyPos = true;
    // Two occupancy sensors in Homebridge; mid/unknown = both clear
    IO.whQueue = [
        CFG.HB_WEBHOOK + "/?accessoryId=lift-top&state=" + (p === "top"),
        CFG.HB_WEBHOOK + "/?accessoryId=lift-bottom&state=" + (p === "bottom"),
    ];
}
function setEst(e) {
    S.est = e;
    IO.dirtyEst = true;
}
// the tick: dispatch AT MOST one RPC per pass; relay commands first
Timer.set(CFG.TICK_MS, true, function () {
    var j;
    if (IO.relay.length > 0 && IO.inflight < 4) {
        var rc = IO.relay.splice(0, 1)[0];
        j = { m: "Switch.Set", p: { id: rc.id, on: rc.on }, kind: "relay", rc: rc };
    }
    else if (IO.inflight >= 2) {
        return; // non-relay I/O keeps 2 slots of headroom below the fw cap
    }
    else if (IO.jobs.length > 0) {
        j = IO.jobs.splice(0, 1)[0];
    }
    else if (IO.dirtyPos) {
        IO.dirtyPos = false;
        j = { m: "KVS.Set", p: { key: CFG.POS_KEY, value: S.pos }, kind: "pos" };
    }
    else if (IO.dirtyEst) {
        IO.dirtyEst = false;
        var v = "";
        if (S.est !== null)
            v = JSON.stringify(S.est);
        j = { m: "KVS.Set", p: { key: CFG.EST_KEY, value: v }, kind: "est" };
    }
    else if (IO.whQueue.length > 0) {
        var u = IO.whQueue.splice(0, 1)[0];
        j = { m: "HTTP.GET", p: { url: u, timeout: 3 }, kind: "wh" };
    }
    else if (IO.dirtyBB) {
        IO.dirtyBB = false;
        j = {
            m: "KVS.Set",
            p: { key: CFG.LOG_KEY, value: S.hist.join(" | ").slice(-250) },
            kind: "bb",
        };
    }
    else {
        return;
    }
    IO.inflight++;
    try {
        Shelly.call(j.m, j.p, function (r, ec, em, ud) {
            IO.inflight--;
            var job = ud;
            if (ec !== 0 && job.kind === "relay") {
                job.rc.r++;
                if (job.rc.r <= 2)
                    IO.relay.unshift(job.rc); // idempotent retry
                else
                    log("relay failed: " + em + " id=" + job.rc.id);
            }
            else if (ec !== 0 && job.kind === "pos")
                IO.dirtyPos = true;
            else if (ec !== 0 && job.kind === "est")
                IO.dirtyEst = true;
            if (job.kind === "job" && job.cb)
                job.cb(r, ec, em);
        }, j);
    }
    catch (e) {
        IO.inflight--;
        if (j.kind === "relay")
            IO.relay.unshift(j.rc);
        else if (j.kind === "job")
            IO.jobs.unshift(j);
        else if (j.kind === "pos")
            IO.dirtyPos = true;
        else if (j.kind === "est")
            IO.dirtyEst = true;
        else if (j.kind === "bb")
            IO.dirtyBB = true;
    }
});
function guard(name, fn) {
    return function (a, b, c, d) {
        try {
            fn(a, b, c, d);
        }
        catch (e) {
            try {
                fault("exception in " + name + ": " + e.message);
            }
            catch (e2) {
                bothOff(); // last resort
            }
        }
    };
}
// integrate elapsed run time into the travel estimate
function updateEst(dirId, dtMs) {
    if (S.est === null || dtMs <= 0)
        return;
    var d = dirId === UP ? dtMs / CFG.TRAVEL_UP_MS : -dtMs / CFG.TRAVEL_DOWN_MS;
    var e = S.est + d;
    if (e < 0)
        e = 0;
    if (e > 1)
        e = 1;
    setEst(e);
}
// a run reached a terminal for certain (Auto-Off, S3 feedback)
function atTerminal(dirId, why) {
    setEst(dirId === UP ? 1 : 0);
    setPos(dirId === UP ? "top" : "bottom");
    log("at " + (dirId === UP ? "top" : "bottom") + " (" + why + ")");
}
// after a stop: dead reckoning may still conclude we reached a floor
function declareFromEst() {
    if (S.est === null || S.pos !== "mid")
        return;
    if (S.est >= 1 - CFG.EST_EDGE)
        atTerminal(UP, "dead reckoning");
    else if (S.est <= CFG.EST_EDGE)
        atTerminal(DOWN, "dead reckoning");
}
function clearTimers() {
    if (S.cdTimer !== null) {
        Timer.clear(S.cdTimer);
        S.cdTimer = null;
    }
}
function fault(reason) {
    log("FAULT: " + reason + " — both outputs OFF, lockout (cmd=reset to clear)");
    clearTimers();
    bothOff();
    S.state = "FAULT";
    S.dir = null;
    S.calib = false;
    S.calibPending = false;
}
function cooldown() {
    clearTimers();
    S.state = "COOLDOWN";
    S.dir = null;
    S.cdTimer = Timer.set(CFG.COOLDOWN_MS, false, guard("cdTimer", function () {
        S.cdTimer = null;
        S.state = "IDLE";
        log("re-armed");
        if (S.calibPending) {
            if (inOn(UP) || inOn(DOWN)) {
                cooldown(); // the calibration press is still held: wait it out
                return;
            }
            S.calibPending = false;
            S.nextDir = null;
            startCalibTrip();
        }
        else if (S.nextDir !== null) {
            var d = S.nextDir;
            S.nextDir = null;
            request(d, "reverse");
        }
    }));
}
function stopTrip(reason) {
    log("STOP (" + reason + ")");
    // only expect an off-event if something is actually on (a stop can race Auto-Off)
    S.stopping = outOn(UP) || outOn(DOWN);
    bothOff();
    cooldown();
}
// full state reset (also clears FAULT/calibration); keeps position
function hardReset(source) {
    log("HARD RESET (" + source + ")");
    clearTimers();
    bothOff();
    S.state = "IDLE";
    S.dir = null;
    S.calib = false;
    S.calibPending = false;
    S.nextDir = null;
    S.seqN = 0;
    S.seqDir = null;
    S.stopping = false;
    S.onPending = null;
    S.runOnTs = 0;
}
function armResetGesture() {
    if (S.resetTimer !== null)
        return;
    S.resetTimer = Timer.set(CFG.RESET_HOLD_MS, false, guard("resetTimer", function () {
        S.resetTimer = null;
        if (inOn(UP) && inOn(DOWN))
            hardReset("both buttons held");
    }));
}
// Rocker paddle can't press both directions at once, so lockout states need a
// one-button escape: hold EITHER paddle ≥ RESET_HOLD_MS during FAULT or a
// calibration ride = hard reset. Never armed in normal states, so leaning on
// the paddle during a run can't trigger it (runs are latched anyway).
function armHoldEscape(dir) {
    if (S.holdTimer !== null)
        return;
    S.holdTimer = Timer.set(CFG.RESET_HOLD_MS, false, guard("holdTimer", function () {
        S.holdTimer = null;
        if (inOn(dir) && (S.state === "FAULT" || S.calib || S.calibPending))
            hardReset("paddle held in lockout");
    }));
}
// Calibration: full UP ride to the top limit; est becomes exactly 1 (100%).
// Paddle inputs are IGNORED until Auto-Off completes it, then normal service
// resumes at top/100%. Escapes: hold either paddle 3 s, ?cmd=stop, ?cmd=reset.
function startCalibration(source) {
    log("CALIBRATION (" + source + "): full UP, paddle locked until Auto-Off");
    S.calib = true;
    if (S.state === "RUNNING") {
        if (S.dir === UP)
            return "calibrating"; // already riding up: this run is it
        S.calibPending = true;
        stopTrip("calibration: stop before UP ride");
        return "calibrating";
    }
    if (S.state === "COOLDOWN") {
        S.calibPending = true;
        return "calibrating";
    }
    startCalibTrip();
    return "calibrating";
}
function startCalibTrip() {
    var r = request(UP, "calib");
    if (r !== "accepted") {
        S.calib = false;
        S.calibPending = false;
        log("calibration failed to start: " + r);
    }
}
// ---------- state machine ----------
// Single entry point for ALL request sources (physical inputs, HTTP/HomeKit).
// Gestures (rev 9): single press = latched full run, energized immediately.
// Opposite press during a run = REVERSE (stop, cooldown, run the other way).
// Chained same-direction presses (within DBL_MS of the chain's first press):
// 2nd = stop, 3rd = calibration.
function request(dir, source) {
    // reset gestures work from ANY state, including FAULT and calibration
    if (source === "input") {
        if (inOn(UP) && inOn(DOWN))
            armResetGesture();
        if (S.state === "FAULT" || S.calib || S.calibPending)
            armHoldEscape(dir);
    }
    if (S.state === "FAULT") {
        log("ignored " + DIR_NAME[dir] + " (" + source + "): FAULT lockout");
        return "fault";
    }
    // calibration ride: paddle inputs are ignored until Auto-Off completes it
    if (S.calib && source === "input") {
        log("ignored " + DIR_NAME[dir] + ": calibration in progress");
        return "calibrating";
    }
    if (source === "input") {
        if (S.seqDir === dir && Date.now() - S.seqStartTs <= CFG.DBL_MS) {
            S.seqN++;
        }
        else {
            S.seqN = 1;
            S.seqDir = dir;
            S.seqStartTs = Date.now();
        }
        log("press " + DIR_NAME[dir] + " " + S.seqN + " (" + S.state + ")");
        if (S.seqN === 3) {
            S.seqN = 0;
            S.seqDir = null;
            return startCalibration(source);
        }
    }
    if (S.state === "RUNNING") {
        if (dir !== S.dir) {
            // opposite press = respected direction change (stop, dead-time, reverse)
            S.nextDir = dir;
            stopTrip("reverse to " + DIR_NAME[dir] + " (" + source + ")");
            return "reversing";
        }
        if (source === "input" && S.seqN >= 2) {
            stopTrip("double-press interrupt");
            return "stopped";
        }
        if (source !== "input")
            return "already-running";
        log("lone press during run ignored (press again within 3 s to stop)");
        return "ignored";
    }
    if (S.state !== "IDLE")
        return "busy"; // COOLDOWN (chain still counted above)
    if (rogueOn()) {
        fault("output ON while believed IDLE");
        return "fault";
    }
    if (outOn(UP) || outOn(DOWN)) {
        log("outputs settling — press again");
        return "settling";
    }
    if (inOn(dir === UP ? DOWN : UP)) {
        log("opposite input held — refusing " + DIR_NAME[dir]);
        cooldown();
        return "conflict";
    }
    S.dir = dir;
    return startTrip() ? "accepted" : "aborted";
}
function startTrip() {
    if (outOn(UP) || outOn(DOWN)) {
        if (rogueOn()) {
            fault("output ON at trip start");
        }
        else {
            // our own OFF command hasn't landed yet (queue lag): abort quietly
            log("outputs still settling — trip aborted, press again");
            cooldown();
        }
        return false;
    }
    // RUNNING before energizing: a chained press landing between decision and
    // relay closure is handled as a run interrupt, never a second acceptance.
    S.state = "RUNNING";
    S.runOnTs = Date.now();
    S.lastRunDir = S.dir;
    S.onPending = S.dir; // expect our own ON echo (may arrive after a stop)
    setPos("mid"); // persisted before energizing: power loss never restores a stale floor
    setOut(S.dir, true);
    log("RUNNING " + DIR_NAME[S.dir] + (S.calib ? " (calibration)" : ""));
    return true;
}
function release(dir) {
    if (S.resetTimer !== null) {
        Timer.clear(S.resetTimer);
        S.resetTimer = null;
    }
    if (S.holdTimer !== null) {
        Timer.clear(S.holdTimer);
        S.holdTimer = null;
    }
    // all runs are latched; releases carry no other meaning
}
Shelly.addEventHandler(guard("eventHandler", function (ev) {
    if (!ev.info || ev.info.event !== "toggle")
        return;
    if (ev.component === "input:" + CFG.LIMIT_IN) {
        if (S.limitFb && ev.info.state === true)
            limitHit();
        return;
    }
    if (ev.component !== "input:" + UP && ev.component !== "input:" + DOWN)
        return;
    var id = ev.info.id;
    if (ev.info.state === true)
        request(id, "input");
    else
        release(id);
}));
// S3: platform physically reached a terminal; direction of travel disambiguates
function limitHit() {
    var d = S.state === "RUNNING" ? S.dir : S.lastRunDir;
    if (d === null) {
        log("limit feedback with no known direction — ignored");
        return;
    }
    atTerminal(d, "S3 feedback");
    if (S.calib) {
        S.calib = false;
        log("CALIBRATION complete — at top, 100%");
    }
    if (S.state === "RUNNING") {
        S.stopping = outOn(UP) || outOn(DOWN);
        bothOff(); // end the command; motion already ended at the Harmar limit
        cooldown();
    }
}
Shelly.addStatusHandler(guard("statusHandler", function (st) {
    if (st.name !== "switch" || (st.id !== UP && st.id !== DOWN))
        return;
    if (!st.delta || st.delta.output === undefined)
        return;
    var id = st.id;
    if (outOn(UP) && outOn(DOWN)) {
        fault("both outputs ON");
        return;
    }
    if (st.delta.output === false) {
        // integrate actual energized time regardless of why it ended
        if (S.runOnTs !== 0 && id === S.lastRunDir) {
            updateEst(id, Date.now() - S.runOnTs);
            S.runOnTs = 0;
        }
        if (S.stopping) {
            S.stopping = false;
            declareFromEst(); // a stop may still have landed on a floor
            return;
        }
        if (S.state === "RUNNING" && id === S.dir) {
            log("Auto-Off end of trip");
            atTerminal(id, "Auto-Off");
            if (S.calib) {
                S.calib = false;
                log("CALIBRATION complete — at top, 100%");
            }
            cooldown();
        }
    }
    else {
        if (id === S.onPending) {
            // our own commanded-ON echo; if a stop already landed, the off-command
            // is in flight and its off-event follows — not a fault
            S.onPending = null;
            return;
        }
        // stale ON event: we may have already commanded the output off
        if (!outOn(id))
            return;
        if (S.state !== "RUNNING" || id !== S.dir) {
            fault("unexpected output ON: switch:" +
                id +
                " source=" +
                (st.delta.source ? st.delta.source : "?"));
        }
    }
}));
// ---------- remote entry ----------
// http://<ip>/script/<id>/lift?dir=up|down | ?cmd=stop|calibrate|reset|hist | ?set=top|bottom|mid
HTTPServer.registerEndpoint("lift", function (req, res) {
    var q = req.query ? req.query : "";
    var result = "status";
    try {
        if (q.indexOf("cmd=stop") !== -1) {
            S.calib = false;
            S.calibPending = false; // http stop is a calibration escape hatch
            if (S.state === "RUNNING") {
                stopTrip("http stop");
                result = "stopped";
            }
            else {
                result = "not-running";
            }
        }
        else if (q.indexOf("cmd=calibrate") !== -1) {
            result = S.calib ? "already-calibrating" : startCalibration("http");
        }
        else if (q.indexOf("cmd=reset") !== -1) {
            hardReset("http");
            result = "reset";
        }
        else if (q.indexOf("cmd=hist") !== -1) {
            result = "hist";
        }
        else if (q.indexOf("dir=up") !== -1) {
            result = request(UP, "http");
        }
        else if (q.indexOf("dir=down") !== -1) {
            result = request(DOWN, "http");
        }
        else if (q.indexOf("set=") !== -1) {
            // manual position calibration, only while stationary
            var p = null;
            if (q.indexOf("set=top") !== -1)
                p = "top";
            else if (q.indexOf("set=bottom") !== -1)
                p = "bottom";
            else if (q.indexOf("set=mid") !== -1)
                p = "mid";
            if (p !== null && S.state === "IDLE") {
                setEst(p === "top" ? 1 : p === "bottom" ? 0 : null);
                setPos(p);
                result = "calibrated";
            }
            else {
                result = "set-refused";
            }
        }
    }
    catch (e) {
        fault("exception in http handler: " + e.message);
        result = "error";
    }
    var body = {
        result: result,
        state: S.state,
        dir: S.dir === null ? null : DIR_NAME[S.dir],
        calib: S.calib || S.calibPending,
        pos: S.pos,
        pct: S.est === null ? null : Math.round(S.est * 100),
        est: S.est === null ? null : Math.round(S.est * 100) / 100,
    };
    if (result === "hist")
        body.hist = S.hist;
    res.code = 200;
    res.body = JSON.stringify(body);
    res.send();
});
// ---------- init ----------
function init() {
    bothOff(); // fail-safe regardless of pre-boot state
    S.state = "IDLE";
    S.dir = null;
    S.calib = false;
    S.calibPending = false;
    S.stopping = false;
    // est restore chained after pos restore: its fallback derives from S.pos
    IO.jobs.push({
        kind: "job",
        m: "KVS.Get",
        p: { key: CFG.POS_KEY },
        cb: function (r, ec) {
            var rv = r;
            if (ec === 0 && rv && typeof rv.value === "string")
                S.pos = rv.value;
            log("position restored: " + S.pos);
            IO.whQueue = [
                CFG.HB_WEBHOOK + "/?accessoryId=lift-top&state=" + (S.pos === "top"),
                CFG.HB_WEBHOOK +
                    "/?accessoryId=lift-bottom&state=" +
                    (S.pos === "bottom"),
            ];
            IO.jobs.push({
                kind: "job",
                m: "KVS.Get",
                p: { key: CFG.EST_KEY },
                cb: function (r2, ec2) {
                    var rv2 = r2;
                    if (ec2 === 0 && rv2 && rv2.value !== "" && typeof rv2.value === "string") {
                        var e = JSON.parse(rv2.value);
                        if (typeof e === "number")
                            S.est = e;
                    }
                    if (S.est === null) {
                        if (S.pos === "top")
                            S.est = 1;
                        else if (S.pos === "bottom")
                            S.est = 0;
                    }
                    log("est restored: " + (S.est === null ? "null" : S.est));
                },
            });
        },
    });
    var lc = Shelly.getComponentConfig("input:" + CFG.LIMIT_IN);
    S.limitFb = lc !== null && lc.enable === true;
    log("S3 limit feedback: " +
        (S.limitFb ? "ACTIVE" : "not wired (input:2 disabled)"));
    for (var i = UP; i <= DOWN; i++) {
        var c = Shelly.getComponentConfig("switch:" + i);
        if (c) {
            if (c.auto_off && typeof c.auto_off_delay === "number") {
                // Auto-Off ≥ travel time, so it doubles as the full-travel scale
                if (i === UP)
                    CFG.TRAVEL_UP_MS = c.auto_off_delay * 1000;
                else
                    CFG.TRAVEL_DOWN_MS = c.auto_off_delay * 1000;
            }
            if (c.initial_state !== "off")
                log("WARN switch:" + i + " initial_state='" + c.initial_state + "'");
            if (c.in_mode !== "detached")
                log("WARN switch:" + i + " in_mode='" + c.in_mode + "'");
            if (!c.auto_off)
                log("WARN switch:" + i + " auto_off DISABLED");
        }
    }
    log("armed — immediate latch, cooldown " +
        CFG.COOLDOWN_MS +
        "ms, chain " +
        CFG.DBL_MS +
        "ms, travel " +
        CFG.TRAVEL_UP_MS / 1000 +
        "s/" +
        CFG.TRAVEL_DOWN_MS / 1000 +
        "s (from auto_off_delay)");
}
init();
