// Unit + fuzz tests for lift-arbiter.js (rev 9). Run: node test/run-tests.js
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

// single press = full run (energized on the next tick)
function go(env, dir) {
  env.tap(dir, 80);
  env.advance(200);
}

// chained same-direction 2nd press = stop
function stopDbl(env, dir) {
  env.tap(dir, 80, 300);
  env.tap(dir, 80);
  env.advance(300);
}

const CHAIN_GAP = 3500; // outwait the 3 s chain anchor

// ---------- scripted cases ----------

test("boot: outputs off, IDLE", () => {
  const env = boot();
  const st = env.http("");
  assert(st.state === "IDLE", "not idle: " + JSON.stringify(st));
  assert(!env.outputs[UP] && !env.outputs[DOWN], "outputs not off");
  baseline(env);
});

test("single press = immediate latched run, Auto-Off ends at top", () => {
  const env = boot();
  env.press(UP);
  env.advance(100); // no arbitration delay: energized within ~2 ticks
  assert(env.outputs[UP], "run not energized promptly");
  env.release(UP);
  env.advance(60000);
  const st = env.http("");
  assert(!env.outputs[UP], "output still on after auto-off");
  assert(
    st.state === "IDLE" && st.pos === "top" && st.pct === 100,
    "not at top: " + JSON.stringify(st),
  );
  baseline(env);
});

test("lone same-direction press mid-run ignored; chained 2nd stops", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(CHAIN_GAP); // let the start chain expire
  env.tap(DOWN, 80); // lone press: new chain, ignored
  env.advance(1000);
  assert(env.outputs[DOWN], "lone press stopped the run");
  env.tap(DOWN, 80); // chained 2nd (within 3 s of the lone press) = stop
  env.advance(500);
  assert(!env.outputs[DOWN], "chained 2nd press did not stop");
  env.advance(CHAIN_GAP);
  go(env, DOWN); // fresh chain = new run
  assert(env.outputs[DOWN], "press after stop did not start a run");
  env.advance(50000);
  assert(env.http("").pos === "bottom", "remaining travel did not complete");
  baseline(env);
});

test("opposite press mid-run = respected reversal (stop, dead-time, reverse)", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(200);
  go(env, UP);
  env.advance(10000); // partway up
  env.tap(UP === UP ? DOWN : UP, 80); // press DOWN
  env.advance(150);
  assert(!env.outputs[UP] || !env.outputs[DOWN], "both on during reversal");
  env.advance(1500); // stop + cooldown + auto-start
  assert(env.outputs[DOWN] && !env.outputs[UP], "did not reverse to DOWN");
  env.advance(50000);
  const st = env.http("");
  assert(
    st.pos === "bottom",
    "reversed run did not complete: " + JSON.stringify(st),
  );
  baseline(env);
});

test("reversal never overlaps outputs (mock invariant across the swap)", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(5000);
  env.tap(UP, 80); // reverse
  env.advance(2000);
  assert(
    env.outputs[UP] && !env.outputs[DOWN],
    "not running UP after reversal",
  );
  env.advance(60000);
  assert(env.http("").pos === "top", "reversal ride did not complete");
  baseline(env); // bothOnViolations check
});

test("HTTP same-direction request during run = already-running (no stop)", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(200);
  env.http("dir=up");
  env.advance(200);
  assert(env.outputs[UP], "http run did not start");
  const r = env.http("dir=up");
  assert(r.result === "already-running", "unexpected: " + r.result);
  env.advance(300);
  assert(env.outputs[UP], "same-direction http request stopped the run");
  env.advance(60000);
  baseline(env);
});

test("triple same-direction presses = calibration; mixed directions never calibrate", () => {
  const env = boot();
  env.tap(UP, 60, 400);
  env.tap(UP, 60, 400);
  env.tap(UP, 60);
  env.advance(1500);
  let st = env.http("");
  assert(st.calib === true, "calibration not entered: " + JSON.stringify(st));
  assert(env.outputs[UP], "calibration ride not running");
  env.advance(60000);
  st = env.http("");
  assert(
    st.calib === false &&
      st.pos === "top" &&
      st.pct === 100 &&
      st.state === "IDLE",
    "calibration did not complete/exit: " + JSON.stringify(st),
  );
  baseline(env);

  // mixed-direction mash on a fresh device: U D U within 3 s = reversal chain, no calibration
  const env2 = boot();
  env2.tap(UP, 60, 400);
  env2.tap(DOWN, 60, 400);
  env2.tap(UP, 60);
  env2.advance(3000);
  assert(env2.http("").calib === false, "mixed-direction presses calibrated");
  env2.advance(120000);
  baseline(env2);
});

test("calibration ignores paddle; hold ONE paddle 3s escapes", () => {
  const env = boot();
  env.tap(DOWN, 60, 300); // 1: starts DOWN run
  env.tap(DOWN, 60, 300); // 2: stop
  env.tap(DOWN, 60); // 3: calibrate
  env.advance(2000);
  let st = env.http("");
  assert(st.calib === true, "calibration not entered");
  assert(env.outputs[UP], "UP calibration ride not running");
  env.tap(DOWN, 200, 200); // ignored
  env.tap(UP, 200, 200); // ignored
  env.advance(1000);
  assert(env.outputs[UP], "paddle press interrupted calibration");
  env.press(DOWN); // hold escape
  env.advance(3300);
  env.release(DOWN);
  env.advance(500);
  st = env.http("");
  assert(
    st.calib === false && st.state === "IDLE",
    "hold escape failed: " + JSON.stringify(st),
  );
  assert(!env.outputs[UP] && !env.outputs[DOWN], "outputs on after escape");
  baseline(env);
});

test("rocker escape: hold ONE paddle 3s clears FAULT", () => {
  const env = boot();
  env.setOutputExternal(UP, true);
  env.advance(2500);
  assert(env.http("").state === "FAULT", "rogue output did not FAULT");
  env.press(DOWN);
  env.advance(3300);
  env.release(DOWN);
  env.advance(500);
  assert(env.http("").state === "IDLE", "hold escape did not clear FAULT");
  go(env, DOWN);
  assert(env.outputs[DOWN], "no run after escape");
  env.advance(50000);
  baseline(env);
});

test("leaning on the paddle during a normal run is harmless", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  env.press(DOWN);
  env.advance(10000);
  assert(env.outputs[DOWN], "leaning disturbed the run");
  env.release(DOWN);
  env.advance(40000);
  assert(env.http("").pos === "bottom", "run did not complete");
  baseline(env);
});

test("dead reckoning: stop tracks est; run to limit declares floor", () => {
  const env = boot();
  env.http("set=top");
  env.advance(200);
  go(env, DOWN);
  env.advance(22000); // ~half of 45 s
  env.tap(DOWN, 80, 300);
  env.tap(DOWN, 80); // chained stop
  env.advance(1000);
  let st = env.http("");
  assert(st.pos === "mid", "should be mid: " + JSON.stringify(st));
  assert(st.est > 0.35 && st.est < 0.65, "est not ~0.5: " + st.est);
  env.advance(CHAIN_GAP);
  go(env, DOWN);
  env.advance(50000);
  st = env.http("");
  assert(
    st.pos === "bottom" && st.pct === 0,
    "not at bottom: " + JSON.stringify(st),
  );
  baseline(env);
});

test("stop racing auto-off does not strand the stopping flag", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(200);
  go(env, UP);
  env.advance(54600); // just before 55 s auto-off
  env.tap(UP, 60, 150);
  env.tap(UP, 60); // chained stop lands as auto-off fires
  env.advance(CHAIN_GAP);
  go(env, DOWN); // follow-up run must still complete & declare its floor
  env.advance(50000);
  assert(env.http("").pos === "bottom", "follow-up run did not declare floor");
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
  env.tap(DOWN, 80); // reverse again
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
    env.advance(130000); // settle: mash may chain reversals/calibrations

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
