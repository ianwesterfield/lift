// Unit + fuzz tests for lift-arbiter.js (rev 8). Run: node test/run-tests.js
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
  env.advance(500); // drain init via the tick
  return env;
}

function baseline(env) {
  assert(env.bothOnViolations === 0, "both outputs were ON simultaneously");
  assert(env.crashed === null, "script crashed: " + env.crashed);
  assert(env.maxInflightSeen <= 5, "exceeded 5 concurrent RPC calls");
}

const UP = 0,
  DOWN = 1;

// single press = full run
function go(env, dir) {
  env.tap(dir, 80);
  env.advance(300); // arb + relay tick
}

// double-press = interrupt (2nd press within the 0.5 s chain)
function stopDbl(env, dir) {
  env.tap(dir, 80, 200);
  env.tap(dir, 80);
  env.advance(300);
}

// ---------- scripted cases ----------

test("boot: outputs off, IDLE", () => {
  const env = boot();
  const st = env.http("");
  assert(st.state === "IDLE", "not idle: " + JSON.stringify(st));
  assert(!env.outputs[UP] && !env.outputs[DOWN], "outputs not off");
  baseline(env);
});

test("single press = latched full run, Auto-Off ends at top", () => {
  const env = boot();
  go(env, UP);
  assert(env.outputs[UP], "single press did not start the run");
  env.advance(60000);
  const st = env.http("");
  assert(!env.outputs[UP], "output still on after auto-off");
  assert(
    st.state === "IDLE" && st.pos === "top" && st.pct === 100,
    "not at top: " + JSON.stringify(st),
  );
  baseline(env);
});

test("release means nothing: press-and-hold is still one latched run", () => {
  const env = boot();
  env.press(UP);
  env.advance(3000);
  env.release(UP);
  env.advance(1000);
  assert(env.outputs[UP], "release stopped a latched run");
  env.advance(60000);
  assert(env.http("").pos === "top", "run did not complete");
  baseline(env);
});

test("lone press during a run is ignored; double-press stops", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(5000);
  env.tap(DOWN, 80); // lone press: chain expired (>0.5 s since start press)
  env.advance(1000);
  assert(env.outputs[DOWN], "lone press stopped the run");
  stopDbl(env, DOWN); // deliberate interrupt
  env.advance(500);
  assert(!env.outputs[DOWN], "double-press did not stop the run");
  assert(env.http("").state !== "FAULT", "unexpected FAULT");
  env.advance(1000);
  // single press afterwards = new full run (remaining travel)
  go(env, DOWN);
  assert(env.outputs[DOWN], "single press after stop did not start a run");
  env.advance(50000);
  assert(env.http("").pos === "bottom", "remaining travel did not complete");
  baseline(env);
});

test("opposite double-press also interrupts", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(5000);
  env.tap(UP, 80, 200); // chain: lone UP ignored...
  env.tap(UP, 80); // ...second UP within window = interrupt
  env.advance(500);
  assert(!env.outputs[DOWN], "opposite double-press did not stop");
  assert(!env.outputs[UP], "opposite press caused reversal");
  baseline(env);
});

test("opposite press during pending window = conflict, no motion", () => {
  const env = boot();
  env.press(UP);
  env.advance(30);
  env.press(DOWN);
  env.advance(200);
  env.release(UP);
  env.release(DOWN);
  env.advance(3000);
  assert(!env.outputs[UP] && !env.outputs[DOWN], "motion after conflict");
  baseline(env);
});

test("dead reckoning: double-stop tracks est; runs declare floors", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(22000); // ~half of 45 s
  stopDbl(env, DOWN);
  env.advance(1000);
  let st = env.http("");
  assert(st.pos === "mid", "should be mid: " + JSON.stringify(st));
  assert(st.est > 0.35 && st.est < 0.65, "est not ~0.5: " + st.est);
  env.advance(1000);
  go(env, DOWN); // ride the rest down; Auto-Off declares bottom
  env.advance(50000);
  st = env.http("");
  assert(st.pos === "bottom" && st.pct === 0, "not at bottom: " + JSON.stringify(st));
  baseline(env);
});

test("triple-press = calibration: full UP ride, locked paddle, 100%", () => {
  const env = boot(); // est unknown
  env.tap(UP, 60, 150);
  env.tap(UP, 60, 150);
  env.tap(UP, 60);
  env.advance(1500);
  let st = env.http("");
  assert(st.calib === true, "calibration not entered: " + JSON.stringify(st));
  assert(env.outputs[UP], "calibration UP ride not running");
  env.tap(DOWN, 200, 100); // must be ignored
  env.tap(DOWN, 200, 100);
  env.tap(UP, 200, 100);
  env.advance(2000);
  assert(env.outputs[UP], "paddle input interrupted the calibration ride");
  env.advance(60000);
  st = env.http("");
  assert(
    st.calib === false && st.pos === "top" && st.pct === 100 && st.state === "IDLE",
    "calibration did not complete/exit: " + JSON.stringify(st),
  );
  // normal service resumes
  go(env, DOWN);
  assert(env.outputs[DOWN], "normal run refused after calibration");
  env.advance(50000);
  baseline(env);
});

test("triple on DOWN: stop, cooldown, then UP calibration ride", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  env.tap(DOWN, 60, 150); // 1: starts DOWN run
  env.tap(DOWN, 60, 150); // 2: interrupt
  env.tap(DOWN, 60); // 3: calibrate
  env.advance(2000); // stop + cooldown + auto-start
  const st = env.http("");
  assert(st.calib === true, "calibration not entered: " + JSON.stringify(st));
  assert(env.outputs[UP] && !env.outputs[DOWN], "UP calibration ride not running");
  env.advance(60000);
  assert(env.http("").pos === "top", "calibration did not complete");
  baseline(env);
});

test("hold UP+DOWN 3s = hard reset (aborts calibration too)", () => {
  const env = boot();
  env.tap(UP, 60, 150);
  env.tap(UP, 60, 150);
  env.tap(UP, 60);
  env.advance(1000); // calibration running
  env.press(UP);
  env.advance(30);
  env.press(DOWN);
  env.advance(3300);
  env.release(UP);
  env.release(DOWN);
  env.advance(1000);
  const st = env.http("");
  assert(
    st.state === "IDLE" && st.calib === false,
    "reset gesture failed: " + JSON.stringify(st),
  );
  assert(!env.outputs[UP] && !env.outputs[DOWN], "outputs on after reset");
  baseline(env);
});

test("rogue direct Switch.Set while IDLE => FAULT; cmd=reset recovers", () => {
  const env = boot();
  env.setOutputExternal(UP, true);
  env.advance(2500); // beyond the OFF grace window
  env.tap(DOWN, 80);
  env.advance(500);
  let st = env.http("");
  assert(st.state === "FAULT", "rogue output did not FAULT: " + JSON.stringify(st));
  assert(!env.outputs[UP], "FAULT did not force outputs off");
  env.http("cmd=reset");
  env.advance(500);
  go(env, DOWN);
  assert(env.outputs[DOWN], "no run after reset");
  env.advance(50000);
  baseline(env);
});

test("terminal declaration burst stays within RPC limit", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(200);
  go(env, UP);
  env.advance(60000);
  baseline(env);
  assert(env.http("").pos === "top", "trip did not complete");
});

test("double-stop racing auto-off does not strand the stopping flag", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(200);
  go(env, UP);
  env.advance(54500); // just before 55 s auto-off
  env.tap(UP, 60, 150);
  env.tap(UP, 60); // interrupt lands as auto-off fires
  env.advance(2500);
  go(env, DOWN); // follow-up run must still complete & declare its floor
  env.advance(50000);
  const st = env.http("");
  assert(st.pos === "bottom", "follow-up run did not declare floor: " + JSON.stringify(st));
  baseline(env);
});

test("slow RPC completions never exceed the firmware call limit", () => {
  const env = boot();
  env.rpcLatency = 250;
  env.http("set=top");
  env.advance(1000);
  go(env, DOWN);
  env.advance(800);
  stopDbl(env, DOWN);
  env.advance(700);
  go(env, DOWN);
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
    env.advance(130000); // settle: mash may chain a calibration after a trip

    let st = env.http("");
    assert(
      st.state === "IDLE" && !st.calib,
      "iter " + iter + ": stuck in " + st.state + " calib=" + st.calib +
        " hist=" + JSON.stringify(env.http("cmd=hist").hist),
    );
    assert(
      !env.outputs[UP] && !env.outputs[DOWN],
      "iter " + iter + ": output stuck on",
    );

    // recoverability: a single press must run a latched trip to a floor
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
  env.advance(130000); // 3rd chained press starts a calibration ride
  const st = env.http("");
  assert(st.state === "IDLE" && !st.calib, "Konami stuck the arbiter: " + JSON.stringify(st));
  assert(!env.outputs[UP] && !env.outputs[DOWN], "Konami left an output on");
  baseline(env);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
