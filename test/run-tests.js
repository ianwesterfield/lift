// Unit + fuzz tests for lift-arbiter.js. Run: node test/run-tests.js
"use strict";
const { createEnv } = require("./shelly-mock");

let passed = 0,
  failed = 0,
  current = "";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function test(name, fn) {
  current = name;
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

// shared invariant check
function baseline(env) {
  assert(env.bothOnViolations === 0, "both outputs were ON simultaneously");
  assert(env.crashed === null, "script crashed: " + env.crashed);
  assert(env.maxInflightSeen <= 5, "exceeded 5 concurrent RPC calls");
}

const UP = 0,
  DOWN = 1;

// ---------- scripted cases ----------

test("boot: outputs off, IDLE, normal mode", () => {
  const env = boot();
  const st = env.http("");
  assert(st.state === "IDLE" && !st.jog, "not idle/normal: " + JSON.stringify(st));
  assert(!env.outputs[UP] && !env.outputs[DOWN], "outputs not off");
  baseline(env);
});

test("single press = latched full trip, Auto-Off ends at top", () => {
  const env = boot();
  env.tap(UP, 100);
  env.advance(1100); // gesture window
  assert(env.outputs[UP], "UP output not on after gesture window");
  env.advance(60000); // ride out auto-off
  const st = env.http("");
  assert(!env.outputs[UP], "output still on after auto-off");
  assert(st.state === "IDLE" && st.pos === "top" && st.est === 1, "not at top: " + JSON.stringify(st));
  baseline(env);
});

test("press during trip = stop, stays normal mode", () => {
  const env = boot();
  env.tap(UP, 100);
  env.advance(5000); // running
  assert(env.outputs[UP], "trip not running");
  env.tap(DOWN, 100);
  env.advance(1000);
  const st = env.http("");
  assert(!env.outputs[UP] && !env.outputs[DOWN], "outputs not off after stop");
  assert(st.state === "IDLE" && !st.jog, "should stay normal-mode IDLE: " + JSON.stringify(st));
  baseline(env);
});

test("opposite press during pending window = conflict, no motion", () => {
  const env = boot();
  env.tap(UP, 50, 100);
  env.tap(DOWN, 50);
  env.advance(3000);
  assert(!env.outputs[UP] && !env.outputs[DOWN], "motion after UP/DOWN conflict");
  assert(env.http("").state === "IDLE", "not idle after conflict");
  baseline(env);
});

test("double press = trip cancelled, no jog, no motion", () => {
  const env = boot();
  env.tap(UP, 80, 200);
  env.tap(UP, 80);
  env.advance(3000);
  const st = env.http("");
  assert(!env.outputs[UP], "motion after 2-press cancel");
  assert(!st.jog && st.state === "IDLE", "unexpected state: " + JSON.stringify(st));
  baseline(env);
});

test("triple press = jog ON, no motion; triple again = jog OFF", () => {
  const env = boot();
  env.tap(UP, 80, 200);
  env.tap(UP, 80, 200);
  env.tap(UP, 80);
  env.advance(2000);
  let st = env.http("");
  assert(st.jog === true, "jog not on after triple: " + JSON.stringify(st));
  assert(!env.outputs[UP] && !env.outputs[DOWN], "motion during jog toggle");
  env.tap(UP, 60, 200);
  env.tap(UP, 60, 200);
  env.tap(UP, 60);
  env.advance(2000);
  st = env.http("");
  assert(st.jog === false, "jog not off after 2nd triple: " + JSON.stringify(st));
  baseline(env);
});

test("jog: hold runs while held, stops on release", () => {
  const env = boot();
  env.http("cmd=jog");
  env.press(DOWN);
  env.advance(500);
  assert(env.outputs[DOWN], "jog hold not running");
  env.advance(4500);
  env.release(DOWN);
  env.advance(1000);
  const st = env.http("");
  assert(!env.outputs[DOWN], "jog did not stop on release");
  assert(st.jog === true, "jog mode lost after release");
  baseline(env);
});

test("jog persists at limit only via est=null; declared floor keeps jog until triple", () => {
  const env = boot();
  env.http("set=top");
  env.advance(100);
  env.http("cmd=jog");
  env.press(DOWN);
  env.advance(46000); // held past DOWN auto-off (45s)
  env.release(DOWN);
  env.advance(1000);
  const st = env.http("");
  assert(st.pos === "bottom", "auto-off run should declare bottom: " + JSON.stringify(st));
  assert(st.jog === true, "jog must persist until triple-press");
  baseline(env);
});

test("dead reckoning: mid-trip stop tracks est; jog to floor declares it", () => {
  const env = boot();
  env.http("set=top");
  env.advance(100);
  env.tap(DOWN, 100);
  env.advance(1100); // trip starts
  env.advance(22500); // ~half of 45s
  env.tap(DOWN, 100); // stop mid-shaft
  env.advance(1000);
  let st = env.http("");
  assert(st.pos === "mid", "should be mid: " + JSON.stringify(st));
  assert(st.est > 0.35 && st.est < 0.65, "est not ~0.5: " + st.est);
  // jog the rest of the way down
  env.http("cmd=jog");
  env.press(DOWN);
  env.advance(st.est * 45000 + 500);
  env.release(DOWN);
  env.advance(1000);
  st = env.http("");
  assert(st.pos === "bottom" && st.est === 0, "jog to limit not declared: " + JSON.stringify(st));
  baseline(env);
});

test("near-simultaneous UP+DOWN = no motion ever", () => {
  const env = boot();
  env.press(UP);
  env.advance(30);
  env.press(DOWN);
  env.advance(200);
  env.release(UP);
  env.release(DOWN);
  env.advance(3000);
  assert(!env.outputs[UP] && !env.outputs[DOWN], "motion after simultaneous press");
  baseline(env);
});

test("hold UP+DOWN 3s = hard reset (clears jog)", () => {
  const env = boot();
  env.http("cmd=jog");
  env.press(UP);
  env.advance(30);
  env.press(DOWN);
  env.advance(3300);
  env.release(UP);
  env.release(DOWN);
  env.advance(1000);
  const st = env.http("");
  assert(st.state === "IDLE" && st.jog === false, "reset gesture failed: " + JSON.stringify(st));
  baseline(env);
});

test("rogue direct Switch.Set while IDLE => FAULT on next press; cmd=reset recovers", () => {
  const env = boot();
  env.setOutputExternal(UP, true); // HomeKit bypass simulation
  env.advance(100);
  let st = env.http("");
  assert(st.state === "FAULT", "unexpected ON did not FAULT: " + JSON.stringify(st));
  assert(!env.outputs[UP], "FAULT did not force outputs off");
  env.tap(DOWN, 100);
  env.advance(2000);
  assert(!env.outputs[DOWN], "FAULT lockout did not hold");
  env.http("cmd=reset");
  env.advance(500);
  env.tap(DOWN, 100);
  env.advance(1200);
  assert(env.outputs[DOWN], "no trip after reset");
  baseline(env);
});

test("terminal declaration burst stays within RPC limit", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(100);
  env.tap(UP, 100);
  env.advance(1100);
  env.advance(60000); // auto-off at top: KVS x2 + webhooks x2 + Switch.Set
  baseline(env); // throws if >5 concurrent
  assert(env.http("").pos === "top", "trip did not complete");
});

test("stop racing auto-off does not strand the stopping flag", () => {
  const env = boot();
  env.http("set=bottom");
  env.advance(100);
  env.tap(UP, 100);
  env.advance(1100);
  env.advance(54995); // just before 55s auto-off
  env.press(UP); // stop press lands as auto-off fires
  env.advance(50);
  env.release(UP);
  env.advance(2000);
  // next trip must still complete & declare its floor
  env.tap(DOWN, 100);
  env.advance(1100 + 46000);
  const st = env.http("");
  assert(st.pos === "bottom", "follow-up trip did not declare floor: " + JSON.stringify(st));
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
    env.advance(70000); // let everything settle (max auto-off + slack)

    let st = env.http("");
    assert(
      st.state === "IDLE",
      "iter " + iter + ": stuck in " + st.state + " hist=" + JSON.stringify(env.http("cmd=hist").hist),
    );
    assert(!env.outputs[UP] && !env.outputs[DOWN], "iter " + iter + ": output stuck on");

    // recoverability: exit jog if needed, then a single press must run a trip
    if (st.jog) {
      env.tap(st.pos === "top" ? DOWN : UP, 60, 200);
      env.tap(st.pos === "top" ? DOWN : UP, 60, 200);
      env.tap(st.pos === "top" ? DOWN : UP, 60);
      env.advance(2000);
      st = env.http("");
      assert(!st.jog, "iter " + iter + ": triple-press did not exit jog");
    }
    const dir = st.pos === "top" ? DOWN : UP;
    env.tap(dir, 100);
    env.advance(1200);
    assert(env.outputs[dir], "iter " + iter + ": recovery press did not start a trip");
    env.advance(60000);
    st = env.http("");
    assert(st.state === "IDLE" && !env.outputs[dir], "iter " + iter + ": recovery trip did not finish");
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
