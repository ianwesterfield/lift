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
  TAP_MS: 400, // jog mode: press shorter than this = tap (arms double-tap)
  DBL_MS: 500, // jog mode: 2nd same-direction press within this of a tap = full trip
  POS_KEY: "lift.pos", // KVS key for persisted position
  HB_WEBHOOK: "http://192.168.10.175:51828", // homebridge-http-webhooks listener
};

var UP = 0;
var DOWN = 1;
var DIR_NAME = ["UP", "DOWN"];

var S = {
  state: "IDLE", // IDLE | PENDING | RUNNING | COOLDOWN | FAULT
  dir: null,
  jog: false, // set by interrupting a trip; cleared when a run ends via Auto-Off
  latched: false, // RUNNING: true = full trip, false = hold-to-run (jog)
  forceLatch: false, // double-tap detected: this trip is a latched full trip
  lastTapDir: null, // jog double-tap arming
  lastTapTs: 0,
  pressTs: 0,
  stopping: false, // we commanded OFF; swallow the resulting status event
  arbTimer: null,
  cdTimer: null,
  pos: "unknown", // top | bottom | mid | unknown (script inference, not a sensor)
};

function log(msg) {
  print("[lift] " + msg);
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
    Shelly.call("HTTP.GET", { url: urls[i], timeout: 5 }, function (r, ec, em) {
      if (ec !== 0) log("webhook push failed: " + em);
    });
  }
}

function setPos(p) {
  if (S.pos === p) return;
  S.pos = p;
  log("position: " + p);
  Shelly.call("KVS.Set", { key: CFG.POS_KEY, value: p });
  pushPos();
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

// Single entry point for ALL request sources (physical inputs, HTTP/HomeKit).
function request(dir, source) {
  if (S.state === "FAULT") {
    log("ignored " + DIR_NAME[dir] + " (" + source + "): FAULT lockout");
    return "fault";
  }

  if (S.state === "RUNNING") {
    // any press during a trip = stop, unlock jog mode
    S.jog = true;
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
    return "duplicate";
  }

  var dbl =
    S.jog && S.lastTapDir === dir && Date.now() - S.lastTapTs <= CFG.DBL_MS;

  if (S.state === "COOLDOWN") {
    // double-tap's 2nd press usually lands inside the post-tap cooldown;
    // same-direction resume is safe to cut it short
    if (!dbl) return "busy";
    clearTimers();
    S.state = "IDLE";
  }

  if (S.state !== "IDLE") return "busy";

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
  S.forceLatch = dbl;
  S.lastTapDir = null; // consume the armed tap
  log(
    DIR_NAME[dir] + " pending (" + source + ")" + (dbl ? " [double-tap]" : ""),
  );
  S.arbTimer = Timer.set(CFG.ARB_MS, false, function () {
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
  // Jog-mode physical press = hold-to-run unless it was a double-tap;
  // HTTP requests and normal mode are always latched full trips.
  S.latched = S.forceLatch || !(S.jog && source === "input");
  S.forceLatch = false;
  S.pressTs = Date.now();
  setPos("mid"); // persisted before energizing: power loss mid-trip never restores a floor
  setOut(S.dir, true);
  log(
    "RUNNING " +
      DIR_NAME[S.dir] +
      (S.latched ? " (latched)" : " (hold-to-run)"),
  );
}

function release(dir) {
  if (S.state === "PENDING" && dir === S.dir && S.jog && !S.forceLatch) {
    // released inside the arbitration window: no motion, just arm double-tap
    clearTimers();
    S.state = "IDLE";
    S.dir = null;
    S.lastTapDir = dir;
    S.lastTapTs = Date.now();
    log("tap " + DIR_NAME[dir] + " (double-tap armed)");
    return;
  }
  if (S.state === "RUNNING" && !S.latched && dir === S.dir) {
    if (Date.now() - S.pressTs < CFG.TAP_MS) {
      S.lastTapDir = dir; // short nudge counts as a tap: arms double-tap
      S.lastTapTs = Date.now();
      stopTrip("tap " + DIR_NAME[dir] + " (double-tap armed)");
    } else {
      S.lastTapDir = null;
      stopTrip("jog release"); // stay in jog mode
    }
  }
}

Shelly.addEventHandler(function (ev) {
  if (!ev.info || ev.info.event !== "toggle") return;
  if (ev.component !== "input:" + UP && ev.component !== "input:" + DOWN)
    return;
  if (ev.info.state === true) request(ev.info.id, "input");
  else release(ev.info.id);
});

Shelly.addStatusHandler(function (st) {
  if (st.name !== "switch" || (st.id !== UP && st.id !== DOWN)) return;
  if (!st.delta || st.delta.output === undefined) return;

  if (outOn(UP) && outOn(DOWN)) {
    fault("both outputs ON");
    return;
  }

  if (st.delta.output === false) {
    if (S.stopping) {
      S.stopping = false;
      return;
    } // our own commanded stop
    if (S.state === "RUNNING" && st.id === S.dir) {
      // Firmware Auto-Off: ran to a limit → clear jog mode, floor is known
      log("Auto-Off end of trip" + (S.jog ? " — jog mode cleared" : ""));
      S.jog = false;
      setPos(st.id === UP ? "top" : "bottom");
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

// HomeKit/remote entry: http://<ip>/script/<id>/lift?dir=up|down | ?cmd=stop | ?cmd=reset
HTTPServer.registerEndpoint("lift", function (req, res) {
  var q = req.query ? req.query : "";
  var result = "status";

  if (q.indexOf("cmd=stop") !== -1) {
    if (S.state === "RUNNING") {
      S.jog = true;
      stopTrip("http stop");
      result = "stopped";
    } else {
      result = "not-running";
    }
  } else if (q.indexOf("cmd=reset") !== -1) {
    if (S.state === "FAULT") {
      bothOff();
      S.jog = false;
      cooldown();
      result = "reset";
    } else {
      result = "not-faulted";
    }
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
      setPos(p);
      result = "calibrated";
    } else {
      result = "set-refused";
    }
  }

  res.code = 200;
  res.body = JSON.stringify({
    result: result,
    state: S.state,
    dir: S.dir === null ? null : DIR_NAME[S.dir],
    jog: S.jog,
    pos: S.pos,
  });
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
  S.stopping = false;

  for (var i = UP; i <= DOWN; i++) {
    var c = Shelly.getComponentConfig("switch:" + i);
    if (c) {
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
      "ms",
  );
}

init();
