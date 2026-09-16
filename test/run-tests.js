// Unit + fuzz tests for lift-arbiter.js (rev 6 modeless). Run: node test/run-tests.js
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
  env.advance(200); // drain init
  return env;
}

// double-press: quick tap, then press again inside the 1 s window
function dbl(env, dir) {
  env.tap(dir, 100, 250);
  env.press(dir);
  env.advance(200);
  env.release(dir);
  env.advance(50);
}

function baseline(env) {
  assert(env.bothOnViolations === 0, "both outputs were ON simultaneously");
  assert(env.crashed === null, "script crashed: " + env.crashed);
  assert(env.maxInflightSeen <= 5, "exceeded 5 concurrent RPC calls");
}

const UP = 0,
  DOWN = 1;

// ---------- scripted cases ----------

test("boot: outputs off, IDLE", () => {
  const env = boot();
  const st = env.http("");
  assert(st.state === "IDLE", "not idle: " + JSON.stringify(st));
  assert(!env.outputs[UP] && !env.outputs[DOWN], "outputs not off");
  baseline(env);
});

test("press-and-hold = run while held; release = stop", () => {
  const env = boot();
  env.press(UP);
  env.advance(500);
  assert(env.outputs[UP], "not running while held");
  env.advance(4500);
  env.release(UP);
  env.advance(1000);
  const st = env.http("");
  assert(!env.outputs[UP], "did not stop on release");
  assert(st.state === "IDLE", "not idle after release");
  baseline(env);
});

test("single quick tap = nudge only, no latched trip", () => {
  const env = boot();
  env.tap(UP, 100);
  env.advance(3000);
  assert(!env.outputs[UP], "tap latched a trip");
  assert(env.http("").state === "IDLE", "not idle after tap");
  baseline(env);
});

test("double-press = latched full trip, Auto-Off ends at top", () => {
  const env = boot();
  dbl(env, UP);
  assert(env.outputs[UP], "double-press did not latch a trip");
  env.advance(60000);
  const st = env.http("");
  assert(!env.outputs[UP], "output still on after auto-off");
  assert(
    st.state === "IDLE" && st.pos === "top" && st.est === 1,
    "not at top: " + JSON.stringify(st),
  );
  baseline(env);
});

test("press during latched trip = stop; quick press again = resume travel", () => {
  const env = boot();
  env.http("set=top");
  env.advance(100);
  dbl(env, DOWN);
  env.advance(10000); // partway down
  env.tap(DOWN, 80, 300); // stop press (arms the double)
  assert(!env.outputs[DOWN], "did not stop");
  env.press(DOWN); // 2nd press within 1 s = remaining travel
  env.advance(200);
  env.release(DOWN);
  assert(env.outputs[DOWN], "resume press did not latch remaining travel");
  env.advance(50000);
  const st = env.http("");
  assert(
    st.state === "IDLE" && st.pos === "bottom",
    "remaining travel did not complete: " + JSON.stringify(st),
  );
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
  assert(env.http("").state === "IDLE", "not idle after conflict");
  baseline(env);
});

test("hold past Auto-Off declares the floor", () => {
  const env = boot();
  env.http("set=top");
  env.advance(100);
  env.press(DOWN);
  env.advance(46000); // held past DOWN auto-off (45 s)
  env.release(DOWN);
  env.advance(1000);
  const st = env.http("");
  assert(
    st.pos === "bottom" && st.state === "IDLE",
    "hold to limit not declared: " + JSON.stringify(st),
  );
  baseline(env);
});

test("dead reckoning: stop tracks est; hold to floor declares it", () => {
  const env = boot();
  env.http("set=top");
  env.advance(100);
  dbl(env, DOWN);
  env.advance(22500); // ~half of 45 s
  env.tap(DOWN, 80); // stop mid-shaft
  env.advance(1500); // outlive the double window
  let st = env.http("");
  assert(st.pos === "mid", "should be mid: " + JSON.stringify(st));
  assert(st.est > 0.35 && st.est < 0.65, "est not ~0.5: " + st.est);
  env.press(DOWN); // hold the rest of the way
  env.advance(st.est * 45000 + 500);
  env.release(DOWN);
  env.advance(1000);
  st = env.http("");
  assert(
    st.pos === "bottom" && st.est === 0,
    "hold to limit not declared: " + JSON.stringify(st),
  );
  baseline(env);
});

test("hold UP+DOWN 3s = hard reset", () => {
  const env = boot();
  env.press(UP);
  env.advance(30);
  env.press(DOWN);
  env.advance(3300);
  env.release(UP);
  env.release(DOWN);
  env.advance(1000);
  const st = env.http("");
  assert(st.state === "IDLE", "reset gesture failed: " + JSON.stringify(st));
  assert(!env.outputs[UP] && !env.outputs[DOWN], "outputs on after reset");
  baseline(env);
});

test("rogue direct Switch.Set while IDLE => FAULT; cmd=reset recovers", () => {
  const env = boot();
  env.setOutputExternal(UP, true); // HomeKit bypass simulation
  env.advance(100);
  let st = env.http("");
  assert(st.state === "FAULT", "unexpected ON did not FAULT: " + JSON.stringify(st));
  assert(!env.outputs[UP], "FAULT did not force outputs off");
  env.press(DOWN);
  env.advance(500);
  assert(!env.outputs[DOWN], "FAULT lockout did not hold");
  env.release(DOWN);
  env.http("cmd=reset");
  env.advance(500);
  env.press(DOWN);
  env.advance(500);
  assert(env.outputs[DOWN], "no run after reset");
  env.release(DOWN);
  env.advance(1000);
  baseline(env);
});

test("terminal declaration burst stays within RPC limit", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(100);
  dbl(env, UP);
  env.advance(60000); // auto-off at top: KVS + webhooks + Switch.Set burst
  baseline(env); // throws if >5 concurrent
  assert(env.http("").pos === "top", "trip did not complete");
});

test("stop racing auto-off does not strand the stopping flag", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(100);
  dbl(env, UP);
  env.advance(54300); // just before 55 s auto-off (trip started ~600ms in)
  env.press(UP); // stop press lands as auto-off fires
  env.advance(50);
  env.release(UP);
  env.advance(2500);
  dbl(env, DOWN); // follow-up trip must still complete & declare its floor
  env.advance(50000);
  const st = env.http("");
  assert(
    st.pos === "bottom",
    "follow-up trip did not declare floor: " + JSON.stringify(st),
  );
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
    env.advance(70000); // settle: max auto-off + slack

    let st = env.http("");
    assert(
      st.state === "IDLE",
      "iter " + iter + ": stuck in " + st.state + " hist=" +
        JSON.stringify(env.http("cmd=hist").hist),
    );
    assert(
      !env.outputs[UP] && !env.outputs[DOWN],
      "iter " + iter + ": output stuck on",
    );

    // recoverability: a double-press must run a latched trip to a floor
    const dir = st.pos === "top" ? DOWN : UP;
    dbl(env, dir);
    assert(env.outputs[dir], "iter " + iter + ": double-press did not latch");
    env.advance(60000);
    st = env.http("");
    assert(
      st.state === "IDLE" && !env.outputs[dir],
      "iter " + iter + ": recovery trip did not finish",
    );
    baseline(env);
  }
});

test("fuzz: literal Konami code (UU DD UD UD) mash", () => {
  const env = boot();
  const seqs = [UP, UP, DOWN, DOWN, UP, DOWN, UP, DOWN];
  for (const id of seqs) env.tap(id, 60, 120);
  env.advance(70000);
  const st = env.http("");
  assert(st.state === "IDLE", "Konami code stuck the arbiter in " + st.state);
  assert(!env.outputs[UP] && !env.outputs[DOWN], "Konami code left an output on");
  baseline(env);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
