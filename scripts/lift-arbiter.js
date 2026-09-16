// lift-arbiter.js — Harmar Highlander II motion arbiter (Shelly Pro 3 "Lift")
// Supervisory convenience logic ONLY. The Harmar controller owns all safety,
// interlocks and travel limits. Firmware Auto-Off (UP 55s / DOWN 45s) is the
// hard command backstop and is never refreshed or extended by this script.
//
// O1 (switch:0) = J6 UP, O2 (switch:1) = J6 DOWN.
// S1 (input:0)  = any physical UP request, S2 (input:1) = any physical DOWN.
// Inputs must be type "switch", in_mode "detached", initial_state "off".

var CFG = {
  ARB_MS: 75, // arbitration window before energizing
  COOLDOWN_MS: 400, // dead-time after any stop before re-arm
  TAP_MS: 400, // jog mode: press shorter than this = tap (arms jog-exit double-tap)
  DBL_MS: 1000, // gesture window: all presses of a command within 1 s
  TRAVEL_UP_MS: 55000, // dead-reckoning scale; overwritten at init from auto_off_delay
  TRAVEL_DOWN_MS: 45000,
  EST_EDGE: 0.03, // estimate within this of 0/1 counts as at that floor
  RESET_HOLD_MS: 3000, // hold UP+DOWN together this long = state reset
  LIMIT_IN: 2, // S3: optional "at a terminal" feedback (active when input:2 enabled)
  POS_KEY: "lift.pos", // KVS key for persisted position
  EST_KEY: "lift.est", // KVS key for persisted travel estimate
  HB_WEBHOOK: "http://192.168.10.175:51828", // homebridge-http-webhooks listener
};

var UP = 0;
var DOWN = 1;
var DIR_NAME = ["UP", "DOWN"];

var S = {
  state: "IDLE", // IDLE | PENDING | RUNNING | COOLDOWN | FAULT
  dir: null,
  jog: false, // set by interrupting a trip; cleared when a run ends at a limit
  latched: false, // RUNNING: true = full trip, false = hold-to-run (jog)
  lastTapDir: null, // jog-exit double-tap arming
  lastTapTs: 0,
  pressTs: 0,
  runOnTs: 0, // when the output actually energized (dead reckoning)
  lastRunDir: null,
  est: null, // 0=bottom..1=top travel estimate; null until first known floor
  stopping: false, // we commanded OFF; swallow the resulting status event
  arbTimer: null,
  cdTimer: null,
  resetTimer: null,
  limitFb: false, // S3 hardware limit feedback available
  hist: [], // ring buffer of recent log lines for ?cmd=hist
  pos: "unknown", // top | bottom | mid | unknown
};

function log(msg) {
  print("[lift] " + msg);
  S.hist.push(Math.round(Date.now() / 1000) + " " + msg);
  if (S.hist.length > 15) S.hist.splice(0, 1);
}

function outOn(id) {
  var st = Shelly.getComponentStatus("switch:" + id);
  return st !== null && st.output === true;
}

function inOn(id) {
  var st = Shelly.getComponentStatus("input:" + id);
  return st !== null && st.state === true;
}

function setOut(id, on) {
  Shelly.call("Switch.Set", { id: id, on: on });
}

// Firmware allows ~5 concurrent outbound calls; a terminal declaration bursts 6
// (2x Switch.Set + 2x KVS.Set + 2x webhook) and crashes the script ("Too many
// calls in progress"). Switch.Set stays direct (≤2 at once, never delayed);
// everything else shares 2 queue slots => ≤4 concurrent total.
var Q = { inflight: 0, jobs: [] };

function rpc(method, params, tag) {
  Q.jobs.push({ m: method, p: params, t: tag });
  pump();
}

function pump() {
  while (Q.inflight < 2 && Q.jobs.length > 0) {
    var j = Q.jobs.splice(0, 1)[0];
    Q.inflight++;
    Shelly.call(
      j.m,
      j.p,
      function (r, ec, em, ud) {
        Q.inflight--;
        if (ec !== 0) log(ud + " failed: " + em);
        pump();
      },
      j.t,
    );
  }
}

function bothOff() {
  setOut(UP, false);
  setOut(DOWN, false);
}

function pushPos() {
  // Two occupancy sensors in Homebridge; mid/unknown = both clear
  var top = S.pos === "top";
  var bottom = S.pos === "bottom";
  var urls = [
    CFG.HB_WEBHOOK + "/?accessoryId=lift-top&state=" + JSON.stringify(top),
    CFG.HB_WEBHOOK +
      "/?accessoryId=lift-bottom&state=" +
      JSON.stringify(bottom),
  ];
  for (var i = 0; i < urls.length; i++) {
    rpc("HTTP.GET", { url: urls[i], timeout: 5 }, "webhook");
  }
}

function setPos(p) {
  if (S.pos === p) return;
  S.pos = p;
  log("position: " + p);
  rpc("KVS.Set", { key: CFG.POS_KEY, value: p }, "kvs pos");
  pushPos();
}

function setEst(e) {
  S.est = e;
  rpc(
    "KVS.Set",
    {
      key: CFG.EST_KEY,
      value: e === null ? "" : JSON.stringify(e),
    },
    "kvs est",
  );
}

// integrate elapsed run time into the travel estimate
function updateEst(dirId, dtMs) {
  if (S.est === null || dtMs <= 0) return;
  var d = dirId === UP ? dtMs / CFG.TRAVEL_UP_MS : -dtMs / CFG.TRAVEL_DOWN_MS;
  var e = S.est + d;
  if (e < 0) e = 0;
  if (e > 1) e = 1;
  setEst(e);
}

// a run reached a terminal for certain (Auto-Off, S3 feedback)
function atTerminal(dirId, why) {
  S.jog = false;
  setEst(dirId === UP ? 1 : 0);
  setPos(dirId === UP ? "top" : "bottom");
  log("at " + (dirId === UP ? "top" : "bottom") + " (" + why + ")");
}

// after a manual stop: dead reckoning may still conclude we reached a floor
function declareFromEst() {
  if (S.est === null || S.pos !== "mid") return;
  if (S.est >= 1 - CFG.EST_EDGE) atTerminal(UP, "dead reckoning");
  else if (S.est <= CFG.EST_EDGE) atTerminal(DOWN, "dead reckoning");
}

function clearTimers() {
  if (S.arbTimer !== null) {
    Timer.clear(S.arbTimer);
    S.arbTimer = null;
  }
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
  S.latched = false;
}

function cooldown() {
  clearTimers();
  S.state = "COOLDOWN";
  S.dir = null;
  S.latched = false;
  S.cdTimer = Timer.set(CFG.COOLDOWN_MS, false, function () {
    S.cdTimer = null;
    S.state = "IDLE";
    log("re-armed" + (S.jog ? " (jog mode)" : ""));
  });
}

function stopTrip(reason) {
  log("STOP (" + reason + ")");
  S.stopping = true;
  bothOff();
  cooldown();
}

// full state reset: hold UP+DOWN ≥ RESET_HOLD_MS (also clears FAULT); keeps position
function hardReset(source) {
  log("HARD RESET (" + source + ")");
  clearTimers();
  bothOff();
  S.state = "IDLE";
  S.dir = null;
  S.jog = false;
  S.latched = false;
  S.lastTapDir = null;
  S.stopping = false;
  S.runOnTs = 0;
}

function armResetGesture() {
  if (S.resetTimer !== null) return;
  S.resetTimer = Timer.set(CFG.RESET_HOLD_MS, false, function () {
    S.resetTimer = null;
    if (inOn(UP) && inOn(DOWN)) hardReset("both buttons held");
  });
}

// Single entry point for ALL request sources (physical inputs, HTTP/HomeKit).
function request(dir, source) {
  // reset gesture works from ANY state, including FAULT
  if (source === "input" && inOn(UP) && inOn(DOWN)) armResetGesture();

  if (S.state === "FAULT") {
    log("ignored " + DIR_NAME[dir] + " (" + source + "): FAULT lockout");
    return "fault";
  }

  if (S.state === "RUNNING") {
    // any press during a trip = stop (mode unchanged)
    stopTrip(DIR_NAME[dir] + " press during trip, " + source);
    return "stopped";
  }

  if (S.state === "PENDING") {
    if (dir !== S.dir) {
      // opposite direction inside arbitration window
      log("UP/DOWN conflict during arbitration — aborting");
      cooldown();
      return "conflict";
    }
    if (!S.jog && source === "input") {
      // 2nd same-direction press before the trip started = double-tap: jog ON
      clearTimers();
      S.state = "IDLE";
      S.dir = null;
      S.jog = true;
      log("double-tap — jog mode ON");
      return "jog-on";
    }
    return "duplicate";
  }

  // jog mode: double-tap = exit jog AND begin full travel that direction
  var jogExit =
    S.jog &&
    source === "input" &&
    S.lastTapDir === dir &&
    Date.now() - S.lastTapTs <= CFG.DBL_MS;
  if (jogExit) {
    S.lastTapDir = null;
    S.jog = false;
    log("double-tap — jog OFF, full travel " + DIR_NAME[dir]);
    if (S.state === "COOLDOWN") {
      // the 2nd press usually lands in the post-tap cooldown; safe to cut short
      clearTimers();
      S.state = "IDLE";
    }
  }

  if (S.state !== "IDLE") return "busy"; // COOLDOWN

  if (outOn(UP) || outOn(DOWN)) {
    fault("output ON while believed IDLE");
    return "fault";
  }
  if (inOn(dir === UP ? DOWN : UP)) {
    log("opposite input held — refusing " + DIR_NAME[dir]);
    cooldown();
    return "conflict";
  }

  S.state = "PENDING";
  S.dir = dir;
  S.lastTapDir = null;
  // normal-mode physical press waits out the double-tap window; jog-exit,
  // jog and HTTP use the short arbitration window only
  var wait =
    !S.jog && source === "input" && !jogExit ? CFG.DBL_MS : CFG.ARB_MS;
  log(DIR_NAME[dir] + " pending (" + source + ")");
  S.arbTimer = Timer.set(wait, false, function () {
    S.arbTimer = null;
    startTrip(source);
  });
  return "accepted";
}

function startTrip(source) {
  if (outOn(UP) || outOn(DOWN)) {
    fault("output ON at trip start");
    return;
  }
  // RUNNING before energizing: a press landing between here and relay closure
  // is treated as "press during trip" (stop), never a second acceptance.
  S.state = "RUNNING";
  // Jog-mode physical press = hold-to-run; everything else = latched full trip.
  S.latched = !(S.jog && source === "input");
  S.pressTs = Date.now();
  S.runOnTs = Date.now();
  S.lastRunDir = S.dir;
  setPos("mid"); // persisted before energizing: power loss mid-trip never restores a floor
  setOut(S.dir, true);
  log(
    "RUNNING " +
      DIR_NAME[S.dir] +
      (S.latched ? " (latched)" : " (hold-to-run)"),
  );
}

function release(dir) {
  if (S.resetTimer !== null) {
    Timer.clear(S.resetTimer);
    S.resetTimer = null;
  }
  if (S.state === "PENDING" && dir === S.dir && S.jog) {
    // jog: released inside the arbitration window — no motion, arm double-tap
    clearTimers();
    S.state = "IDLE";
    S.dir = null;
    S.lastTapDir = dir;
    S.lastTapTs = Date.now();
    log("tap " + DIR_NAME[dir] + " (jog-exit double-tap armed)");
    return;
  }
  if (S.state === "RUNNING" && !S.latched && dir === S.dir) {
    if (Date.now() - S.pressTs < CFG.TAP_MS) {
      S.lastTapDir = dir; // short nudge counts as a tap: arms jog-exit double-tap
      S.lastTapTs = Date.now();
      stopTrip("tap " + DIR_NAME[dir] + " (jog-exit double-tap armed)");
    } else {
      S.lastTapDir = null;
      stopTrip("jog release"); // stay in jog mode
    }
  }
}

Shelly.addEventHandler(function (ev) {
  if (!ev.info || ev.info.event !== "toggle") return;
  if (ev.component === "input:" + CFG.LIMIT_IN) {
    if (S.limitFb && ev.info.state === true) limitHit();
    return;
  }
  if (ev.component !== "input:" + UP && ev.component !== "input:" + DOWN)
    return;
  if (ev.info.state === true) request(ev.info.id, "input");
  else release(ev.info.id);
});

// S3: platform physically reached a terminal; direction of travel disambiguates
function limitHit() {
  var d = S.state === "RUNNING" ? S.dir : S.lastRunDir;
  if (d === null) {
    log("limit feedback with no known direction — ignored");
    return;
  }
  atTerminal(d, "S3 feedback");
  if (S.state === "RUNNING") {
    S.stopping = true;
    bothOff(); // end the command; motion already ended at the Harmar limit
    cooldown();
  }
}

Shelly.addStatusHandler(function (st) {
  if (st.name !== "switch" || (st.id !== UP && st.id !== DOWN)) return;
  if (!st.delta || st.delta.output === undefined) return;

  if (outOn(UP) && outOn(DOWN)) {
    fault("both outputs ON");
    return;
  }

  if (st.delta.output === false) {
    // integrate actual energized time regardless of why it ended
    if (S.runOnTs !== 0 && st.id === S.lastRunDir) {
      updateEst(st.id, Date.now() - S.runOnTs);
      S.runOnTs = 0;
    }
    if (S.stopping) {
      S.stopping = false;
      declareFromEst(); // manual stop may still have landed on a floor
      return;
    }
    if (S.state === "RUNNING" && st.id === S.dir) {
      log("Auto-Off end of trip");
      atTerminal(st.id, "Auto-Off");
      cooldown();
    }
  } else {
    if (S.state !== "RUNNING" || st.id !== S.dir) {
      fault(
        "unexpected output ON: switch:" +
          st.id +
          " source=" +
          (st.delta.source ? st.delta.source : "?"),
      );
    }
  }
});

// HomeKit/remote entry: http://<ip>/script/<id>/lift?dir=up|down | ?cmd=stop|reset|jog|hist
HTTPServer.registerEndpoint("lift", function (req, res) {
  var q = req.query ? req.query : "";
  var result = "status";

  if (q.indexOf("cmd=stop") !== -1) {
    if (S.state === "RUNNING") {
      stopTrip("http stop");
      result = "stopped";
    } else {
      result = "not-running";
    }
  } else if (q.indexOf("cmd=jog") !== -1) {
    if (S.state === "IDLE" || S.state === "COOLDOWN") {
      S.jog = !S.jog;
      log("jog mode " + (S.jog ? "ON" : "OFF") + " (http)");
      result = S.jog ? "jog-on" : "jog-off";
    } else {
      result = "jog-refused";
    }
  } else if (q.indexOf("cmd=reset") !== -1) {
    hardReset("http");
    result = "reset";
  } else if (q.indexOf("cmd=hist") !== -1) {
    result = "hist";
  } else if (q.indexOf("dir=up") !== -1) {
    result = request(UP, "http");
  } else if (q.indexOf("dir=down") !== -1) {
    result = request(DOWN, "http");
  } else if (q.indexOf("set=") !== -1) {
    // manual position calibration, only while stationary
    var p = null;
    if (q.indexOf("set=top") !== -1) p = "top";
    else if (q.indexOf("set=bottom") !== -1) p = "bottom";
    else if (q.indexOf("set=mid") !== -1) p = "mid";
    if (p !== null && S.state === "IDLE") {
      setEst(p === "top" ? 1 : p === "bottom" ? 0 : null);
      setPos(p);
      result = "calibrated";
    } else {
      result = "set-refused";
    }
  }

  var body = {
    result: result,
    state: S.state,
    dir: S.dir === null ? null : DIR_NAME[S.dir],
    jog: S.jog,
    pos: S.pos,
    est: S.est === null ? null : Math.round(S.est * 100) / 100,
  };
  if (result === "hist") body.hist = S.hist;
  res.code = 200;
  res.body = JSON.stringify(body);
  res.send();
});

function init() {
  bothOff(); // fail-safe regardless of pre-boot state
  S.state = "IDLE";
  S.dir = null;
  S.jog = false;
  S.latched = false;

  Shelly.call("KVS.Get", { key: CFG.POS_KEY }, function (r, ec) {
    if (ec === 0 && r && typeof r.value === "string") S.pos = r.value;
    log("position restored: " + S.pos);
    pushPos(); // sync Homebridge sensors with reality at boot
  });
  Shelly.call("KVS.Get", { key: CFG.EST_KEY }, function (r, ec) {
    if (ec === 0 && r && r.value !== "" && typeof r.value === "string") {
      var e = JSON.parse(r.value);
      if (typeof e === "number") S.est = e;
    }
    if (S.est === null) {
      // older deploys persisted pos only
      if (S.pos === "top") S.est = 1;
      else if (S.pos === "bottom") S.est = 0;
    }
  });
  var lc = Shelly.getComponentConfig("input:" + CFG.LIMIT_IN);
  S.limitFb = lc !== null && lc.enable === true;
  log(
    "S3 limit feedback: " +
      (S.limitFb ? "ACTIVE" : "not wired (input:2 disabled)"),
  );
  S.stopping = false;

  for (var i = UP; i <= DOWN; i++) {
    var c = Shelly.getComponentConfig("switch:" + i);
    if (c) {
      if (c.auto_off && typeof c.auto_off_delay === "number") {
        // Auto-Off ≥ travel time, so it doubles as the full-travel scale
        if (i === UP) CFG.TRAVEL_UP_MS = c.auto_off_delay * 1000;
        else CFG.TRAVEL_DOWN_MS = c.auto_off_delay * 1000;
      }
      if (c.initial_state !== "off")
        log(
          "WARN switch:" +
            i +
            " initial_state='" +
            c.initial_state +
            "' (want 'off')",
        );
      if (c.in_mode !== "detached")
        log(
          "WARN switch:" + i + " in_mode='" + c.in_mode + "' (want 'detached')",
        );
      if (!c.auto_off)
        log(
          "WARN switch:" +
            i +
            " auto_off DISABLED (firmware backstop required)",
        );
    }
  }
  log(
    "armed — arbitration " +
      CFG.ARB_MS +
      "ms, cooldown " +
      CFG.COOLDOWN_MS +
      "ms, tap " +
      CFG.TAP_MS +
      "ms, double-tap " +
      CFG.DBL_MS +
      "ms, travel " +
      CFG.TRAVEL_UP_MS / 1000 +
      "s up / " +
      CFG.TRAVEL_DOWN_MS / 1000 +
      "s down (from auto_off_delay)",
  );
}

init();
