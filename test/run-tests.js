// Unit + fuzz tests for lift-arbiter (rev 14, push-to-jog / press-to-run). Run: npm test
"use strict";
const { createEnv } = require("./shelly-mock");

let passed = 0,
  failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    failed++;
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

function boot() {
  const env = createEnv();
  env.load();
  env.advance(500);
  return env;
}

function baseline(env) {
  assert(env.bothOnViolations === 0, "both outputs were ON simultaneously");
  assert(env.crashed === null, "script crashed: " + env.crashed);
  assert(env.maxInflightSeen <= 5, "exceeded 5 concurrent RPC calls");
}

const UP = 0,
  DOWN = 1;

function go(env, dir) {
  env.tap(dir, 80);
  env.advance(200);
}

// ---------- scripted cases ----------

test("boot: outputs off, IDLE", () => {
  const env = boot();
  const st = env.http("");
  assert(st.state === "IDLE", "not idle: " + JSON.stringify(st));
  assert(!env.outputs[UP] && !env.outputs[DOWN], "outputs not off");
  baseline(env);
});

test("single press = immediate latched full travel", () => {
  const env = boot();
  env.press(UP);
  env.advance(100);
  assert(env.outputs[UP], "run not energized promptly");
  env.release(UP);
  env.advance(60000);
  const st = env.http("");
  assert(
    st.state === "IDLE" && st.pos === "top" && st.pct === 100,
    "not at top: " + JSON.stringify(st),
  );
  baseline(env);
});

test("opposite press mid-travel = immediate stop then full travel opposite", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(200);
  go(env, UP);
  env.advance(10000);
  env.tap(DOWN, 80); // reversal
  env.advance(150);
  assert(!env.outputs[UP] || !env.outputs[DOWN], "both on during reversal");
  env.advance(1500); // stop + dead-time + auto-start
  assert(env.outputs[DOWN] && !env.outputs[UP], "did not reverse to DOWN");
  env.advance(50000);
  assert(env.http("").pos === "bottom", "reversed travel did not complete");
  baseline(env);
});

test("reverse then reverse again (indecisive rider)", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(5000);
  env.tap(UP, 80); // reverse to UP
  env.advance(2000);
  assert(env.outputs[UP], "first reversal failed");
  env.advance(2000);
  env.tap(DOWN, 80); // reverse back to DOWN
  env.advance(2000);
  assert(env.outputs[DOWN] && !env.outputs[UP], "second reversal failed");
  env.advance(50000);
  baseline(env);
});

test("same-direction tap mid-run = stop (no reverse)", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(5000);
  env.tap(DOWN, 80); // press again = deliberate stop
  env.advance(1500);
  const st = env.http("");
  assert(!env.outputs[DOWN] && !env.outputs[UP], "tap did not stop the run");
  assert(
    st.state === "IDLE" && st.pos === "mid",
    "bad state after tap stop: " + JSON.stringify(st),
  );
  baseline(env);
});

test("push (hold >= 1 s): release stops the run — hold-to-run", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  env.press(DOWN);
  env.advance(5000); // pushing: lift moves while held
  assert(env.outputs[DOWN], "push not running while held");
  env.release(DOWN);
  env.advance(1000);
  const st = env.http("");
  assert(!env.outputs[DOWN], "push release did not stop");
  assert(
    st.state === "IDLE" && st.pos === "mid",
    "bad state after push: " + JSON.stringify(st),
  );
  assert(st.est < 0.95, "est did not integrate the push: " + st.est);
  baseline(env);
});

test("quick opposite tap = immediate reverse (no gesture window)", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  env.tap(DOWN, 80, 500); // run starts
  env.tap(UP, 80); // opposite tap only 500 ms in: reverse, not a mode
  env.advance(2000);
  assert(env.outputs[UP] && !env.outputs[DOWN], "did not reverse to UP");
  baseline(env);
});

test("push opposite mid-run: reversed run inherits push semantics", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(200);
  go(env, UP);
  env.advance(10000);
  env.press(DOWN); // opposite PUSH: reverse fires while still held
  env.advance(4000); // held through the reversal, > HOLD_JOG_MS into the run
  assert(env.outputs[DOWN] && !env.outputs[UP], "reverse did not launch");
  env.release(DOWN); // it was a push: release stops the reversed run
  env.advance(1000);
  const st = env.http("");
  assert(!env.outputs[DOWN], "reversed push did not stop on release");
  assert(st.state === "IDLE", "not idle after reversed push: " + JSON.stringify(st));
  baseline(env);
});

test("calibration is remote-only: paddle locked during ride, exits to normal", () => {
  const env = boot();
  const res = env.http("cmd=calibrate");
  assert(res.result === "calibrating", "http calibrate refused: " + res.result);
  env.advance(2000);
  let st = env.http("");
  assert(st.calib === true, "calibration not entered: " + JSON.stringify(st));
  assert(env.outputs[UP], "calibration ride not running");
  env.tap(DOWN, 200, 100); // ignored during ride
  env.advance(1000);
  assert(env.outputs[UP], "paddle interrupted calibration");
  env.advance(60000);
  st = env.http("");
  assert(
    st.calib === false && st.pos === "top" && st.pct === 100,
    "calibration did not complete to normal: " + JSON.stringify(st),
  );
  go(env, DOWN);
  assert(env.outputs[DOWN], "normal travel refused after calibration");
  env.advance(50000);
  baseline(env);
});

test("calibration lockout escape: hold one paddle 3 s", () => {
  const env = boot();
  env.http("cmd=calibrate");
  env.advance(2000);
  assert(env.http("").calib === true, "calibration not entered");
  env.press(DOWN);
  env.advance(3300);
  env.release(DOWN);
  env.advance(500);
  const st = env.http("");
  assert(st.calib === false && st.state === "IDLE", "hold escape failed");
  assert(!env.outputs[UP] && !env.outputs[DOWN], "outputs on after escape");
  baseline(env);
});

test("UNEXPLAINED output ON (no user source) => FAULT; hold escape clears", () => {
  const env = boot();
  env.setOutputExternal(UP, true, "init"); // no deliberate source: rogue
  env.advance(2500);
  assert(env.http("").state === "FAULT", "rogue output did not FAULT");
  assert(!env.outputs[UP], "FAULT did not force outputs off");
  env.press(DOWN);
  env.advance(3300);
  env.release(DOWN);
  env.advance(500);
  assert(env.http("").state === "IDLE", "hold escape did not clear FAULT");
  go(env, DOWN);
  assert(env.outputs[DOWN], "no travel after escape");
  env.advance(50000);
  baseline(env);
});

test("management-UI ON is ADOPTED as a governed run", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(200);
  env.setOutputExternal(UP, true, "ui"); // user toggles O1 in the web UI
  env.advance(300);
  let st = env.http("");
  assert(
    st.state === "RUNNING" && st.dir === "UP",
    "UI run not adopted: " + JSON.stringify(st),
  );
  // adopted run obeys arbiter rules: same-direction tap stops it
  env.tap(UP, 80);
  env.advance(500);
  assert(!env.outputs[UP], "adopted run did not obey tap stop");
  assert(env.http("").state !== "FAULT", "adoption faulted");
  baseline(env);
});

test("adopted run completes via Auto-Off and declares the floor", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(200);
  env.setOutputExternal(UP, true, "ui");
  env.advance(60000); // firmware Auto-Off still backs the external run
  const st = env.http("");
  assert(
    st.state === "IDLE" && st.pos === "top" && st.pct === 100,
    "adopted run did not complete: " + JSON.stringify(st),
  );
  baseline(env);
});

test("external UI OFF mid-run = stop, NOT a floor declaration", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(20000); // mid-shaft
  env.setOutputExternal(DOWN, false, "ui"); // user switches it off in the UI
  env.advance(1000);
  const st = env.http("");
  assert(
    st.state === "IDLE",
    "external off did not settle: " + JSON.stringify(st),
  );
  assert(
    st.pos === "mid",
    "external off falsely declared a floor: " + JSON.stringify(st),
  );
  assert(
    st.est > 0.3 && st.est < 0.8,
    "est wrong after external off: " + st.est,
  );
  baseline(env);
});

test("external ON opposite a running direction still FAULTs", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(5000);
  env.setOutputExternal(UP, true, "ui"); // conflict: never adopt
  env.advance(500);
  const st = env.http("");
  assert(st.state === "FAULT", "conflicting external ON did not FAULT");
  assert(
    !env.outputs[UP] && !env.outputs[DOWN],
    "outputs on after conflict FAULT",
  );
  env.bothOnViolations = 0; // the injected conflict IS the expected overlap
  baseline(env);
});

test("S3 limit feedback ends the run early and declares the floor", () => {
  const env = createEnv();
  env.limitEnabled = true; // input:2 wired
  env.load();
  env.advance(500);
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(20000); // platform hits the physical limit early
  env.press(2); // S3 fires
  env.advance(1000);
  env.release(2);
  const st = env.http("");
  assert(!env.outputs[DOWN], "S3 did not end the command");
  assert(
    st.pos === "bottom" && st.pct === 0,
    "S3 did not declare the floor: " + JSON.stringify(st),
  );
  env.advance(2000);
  assert(env.http("").state === "IDLE", "not idle after S3 stop");
  baseline(env);
});

test("script restart restores position/estimate from KVS, no motion", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(200);
  go(env, UP);
  env.advance(60000); // at top, persisted
  const reborn = createEnv();
  reborn.kvs = env.kvs; // same device KVS across the restart
  reborn.load();
  reborn.advance(1000);
  const st = reborn.http("");
  assert(
    st.state === "IDLE" && st.pos === "top" && st.pct === 100,
    "restart did not restore state: " + JSON.stringify(st),
  );
  assert(
    !reborn.outputs[UP] && !reborn.outputs[DOWN],
    "restart energized an output",
  );
  baseline(reborn);
});

test("failed reverse auto-start is logged, never silent", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(5000);
  env.inputs[DOWN] = true; // stuck opposite contact (level only, no event)
  env.tap(UP, 80); // reversal intent — zero cooldown fires the reverse fast
  env.advance(2000);
  assert(!env.outputs[UP], "reverse started despite stuck opposite input");
  const hist = env.http("cmd=hist").hist.join(" | ");
  assert(
    hist.indexOf("reverse did not start") !== -1,
    "reverse failure not logged: " + hist,
  );
  env.inputs[DOWN] = false;
  baseline(env);
});

test("blackbox persists and never exceeds its cap", () => {
  const env = boot();
  go(env, UP);
  env.advance(60000);
  const blackbox = env.kvs["lift.blackbox"];
  assert(
    typeof blackbox === "string" && blackbox.length > 0,
    "blackbox not persisted",
  );
  assert(blackbox.length <= 250, "blackbox exceeded cap: " + blackbox.length);
  baseline(env);
});

test("dead reckoning: tap-stop tracks est; push to limit declares floor", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(22000); // ~half of 45 s
  env.tap(DOWN, 80); // same-direction tap = stop mid-shaft
  env.advance(1000);
  let st = env.http("");
  assert(st.pos === "mid", "should be mid: " + JSON.stringify(st));
  assert(st.est > 0.3 && st.est < 0.7, "est not ~mid: " + st.est);
  env.press(DOWN); // push the rest of the way
  env.advance(st.est * 45000 + 500);
  env.release(DOWN);
  env.advance(1000);
  st = env.http("");
  assert(
    st.pos === "bottom" && st.pct === 0,
    "push to limit not declared: " + JSON.stringify(st),
  );
  baseline(env);
});

test("http stop racing auto-off does not strand the stopping flag", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(200);
  go(env, UP);
  env.advance(54800); // just before 55 s auto-off
  env.http("cmd=stop"); // stop lands as auto-off fires
  env.advance(2500);
  go(env, DOWN);
  env.advance(50000);
  assert(
    env.http("").pos === "bottom",
    "follow-up travel did not declare floor",
  );
  baseline(env);
});

// regression: the rev 13 field crash — reverse racing Auto-Off at a terminal
// blew the mJS stack in declareFloor->atTerminal; declarations now run in pump
test("reverse racing Auto-Off at the top settles cleanly (crash regression)", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(200);
  go(env, UP);
  env.advance(54800); // a whisker before the 55 s Auto-Off
  env.tap(DOWN, 80); // reverse intent racing the Auto-Off
  env.advance(3000);
  assert(env.http("").state !== "FAULT", "race faulted");
  env.advance(60000);
  const st = env.http("");
  assert(st.state === "IDLE", "race did not settle: " + JSON.stringify(st));
  baseline(env);
});

test("slow RPC completions never exceed the firmware call limit", () => {
  const env = boot();
  env.rpcLatency = 250;
  env.http("set=top");
  env.advance(1000);
  go(env, DOWN);
  env.advance(2000);
  env.tap(UP, 80); // reversal under load
  env.advance(2000);
  env.tap(DOWN, 80); // reverse again under load
  env.advance(3000);
  baseline(env);
});

// ---------- Konami fuzzer ----------

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("fuzz: 250 random button-mash sequences, always recoverable", () => {
  for (let iter = 0; iter < 250; iter++) {
    const rnd = mulberry32(1000 + iter);
    const env = boot();
    const held = [false, false];
    const actions = 5 + Math.floor(rnd() * 15);
    for (let a = 0; a < actions; a++) {
      const id = rnd() < 0.5 ? UP : DOWN;
      if (held[id]) {
        env.release(id);
        held[id] = false;
      } else {
        env.press(id);
        held[id] = true;
      }
      env.advance(20 + Math.floor(rnd() * 1480));
    }
    if (held[UP]) env.release(UP);
    if (held[DOWN]) env.release(DOWN);
    env.advance(130000); // settle (reversals + calibration rides included)

    let st = env.http("");
    assert(
      st.state === "IDLE" && !st.calib,
      "iter " +
        iter +
        ": stuck in " +
        st.state +
        " calib=" +
        st.calib +
        " hist=" +
        JSON.stringify(env.http("cmd=hist").hist),
    );
    assert(
      !env.outputs[UP] && !env.outputs[DOWN],
      "iter " + iter + ": output stuck on",
    );

    // recoverability: travel to a floor with a plain tap
    const dir = st.pos === "top" ? DOWN : UP;
    go(env, dir);
    assert(env.outputs[dir], "iter " + iter + ": recovery press did not run");
    env.advance(60000);
    st = env.http("");
    assert(
      st.state === "IDLE" && !env.outputs[dir],
      "iter " + iter + ": recovery run did not finish",
    );
    baseline(env);
  }
});

test("fuzz: literal Konami code (UU DD UD UD) mash", () => {
  const env = boot();
  const seqs = [UP, UP, DOWN, DOWN, UP, DOWN, UP, DOWN];
  for (const id of seqs) env.tap(id, 60, 120);
  env.advance(130000);
  const st = env.http("");
  assert(
    st.state === "IDLE" && !st.calib,
    "Konami stuck the arbiter: " + JSON.stringify(st),
  );
  assert(!env.outputs[UP] && !env.outputs[DOWN], "Konami left an output on");
  baseline(env);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
