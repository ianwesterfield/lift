// Shelly Gen2 script-environment emulator for lift-arbiter.js tests.
// Virtual clock; async RPC completion (5ms) + status events (+1ms); relay
// auto-off; enforces the firmware ~5 concurrent-call limit by throwing.
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const MAX_INFLIGHT = 5;

function createEnv() {
  const env = {
    now: 0,
    seq: 0,
    queue: [], // {t, seq, fn}
    timers: new Map(),
    tid: 1,
    rpcLatency: 5, // ms until an RPC completes (raise to simulate a busy device)
    inflight: 0,
    maxInflightSeen: 0,
    outputs: [false, false, false],
    inputs: [false, false, false],
    autoOff: [55, 45, 60],
    autoOffAt: [null, null, null],
    kvs: {},
    webhooks: [],
    logs: [],
    statusHandlers: [],
    eventHandlers: [],
    endpoints: {},
    bothOnViolations: 0,
    crashed: null,
  };

  const schedule = (delay, fn) =>
    env.queue.push({ t: env.now + delay, seq: env.seq++, fn });

  const emitSwitchStatus = (id, output) =>
    schedule(1, () => {
      for (const h of env.statusHandlers)
        h({
          name: "switch",
          id,
          component: "switch:" + id,
          delta: { output, source: "test" },
        });
    });

  function setOutput(id, on) {
    if (env.outputs[id] === on) return;
    env.outputs[id] = on;
    if (env.outputs[0] && env.outputs[1]) env.bothOnViolations++;
    env.autoOffAt[id] = on ? env.now + env.autoOff[id] * 1000 : null;
    emitSwitchStatus(id, on);
  }
  env.setOutputExternal = setOutput; // simulate rogue direct RPC control

  const Shelly = {
    call(method, params, cb, ud) {
      if (typeof params === "string") params = JSON.parse(params);
      // fw 2.0.0 quirk: a second call dispatched in the same tick clobbers the
      // params of the earlier one (observed on the real Pro 3)
      if (env.lastCall && env.lastCall.t === env.now)
        env.lastCall.clobbered = true;
      const rec = { t: env.now, clobbered: false };
      env.lastCall = rec;
      env.inflight++;
      env.maxInflightSeen = Math.max(env.maxInflightSeen, env.inflight);
      if (env.inflight > MAX_INFLIGHT)
        throw new Error("Too many calls in progress");
      schedule(env.rpcLatency, () => {
        env.inflight--;
        let result = null,
          ec = 0,
          em = "";
        if (rec.clobbered) {
          ec = -103;
          em = "Missing required argument!";
        } else if (method === "Switch.Set") setOutput(params.id, params.on);
        else if (method === "KVS.Set") env.kvs[params.key] = params.value;
        else if (method === "KVS.Get") {
          if (params.key in env.kvs) result = { value: env.kvs[params.key] };
          else ((ec = -105), (em = "not found"));
        } else if (method === "HTTP.GET") env.webhooks.push(params.url);
        if (cb) cb(result, ec, em, ud);
      });
    },
    getComponentStatus(key) {
      const [name, id] = key.split(":");
      if (name === "switch") return { output: env.outputs[+id] };
      if (name === "input") return { state: env.inputs[+id] };
      return null;
    },
    getComponentConfig(key) {
      const [name, id] = key.split(":");
      if (name === "switch")
        return {
          initial_state: "off",
          in_mode: "detached",
          auto_off: true,
          auto_off_delay: env.autoOff[+id],
        };
      if (name === "input") return { enable: +id !== 2 };
      return null;
    },
    addEventHandler(fn) {
      env.eventHandlers.push(fn);
    },
    addStatusHandler(fn) {
      env.statusHandlers.push(fn);
    },
  };

  const Timer = {
    set(ms, repeat, fn) {
      const id = env.tid++;
      env.timers.set(id, { t: env.now + ms, ms, repeat: !!repeat, fn });
      return id;
    },
    clear(id) {
      env.timers.delete(id);
    },
  };

  const sandbox = {
    Shelly,
    Timer,
    HTTPServer: {
      registerEndpoint(name, fn) {
        env.endpoints[name] = fn;
      },
    },
    print: (m) => env.logs.push(m),
    Date: { now: () => env.now },
    JSON,
    Math,
  };

  env.load = () => {
    const code = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "lift-arbiter.js"),
      "utf8",
    );
    vm.runInNewContext(code, sandbox, { filename: "lift-arbiter.js" });
  };

  env.advance = (ms) => {
    const end = env.now + ms;
    for (;;) {
      let next = null;
      for (const q of env.queue)
        if (
          q.t <= end &&
          (!next || q.t < next.t || (q.t === next.t && q.seq < next.seq))
        )
          next = { t: q.t, seq: q.seq, kind: "q", ref: q };
      for (const [id, t] of env.timers)
        if (t.t <= end && (!next || t.t < next.t))
          next = {
            t: t.t,
            seq: Infinity,
            kind: "timer",
            ref: { id, fn: t.fn },
          };
      env.autoOffAt.forEach((t, id) => {
        if (t !== null && t <= end && (!next || t < next.t))
          next = { t, seq: Infinity, kind: "autooff", ref: id };
      });
      if (!next) break;
      env.now = next.t;
      try {
        if (next.kind === "q") {
          env.queue.splice(env.queue.indexOf(next.ref), 1);
          next.ref.fn();
        } else if (next.kind === "timer") {
          const rec = env.timers.get(next.ref.id);
          if (rec && rec.repeat) rec.t = env.now + rec.ms;
          else env.timers.delete(next.ref.id);
          next.ref.fn();
        } else {
          const id = next.ref;
          env.autoOffAt[id] = null;
          env.outputs[id] = false;
          emitSwitchStatus(id, false);
        }
      } catch (e) {
        env.crashed = e; // mirrors real firmware: script halts on uncaught
        throw e;
      }
    }
    env.now = end;
  };

  env.press = (id) => {
    env.inputs[id] = true;
    for (const h of env.eventHandlers)
      h({
        component: "input:" + id,
        info: { event: "toggle", state: true, id },
      });
  };
  env.release = (id) => {
    env.inputs[id] = false;
    for (const h of env.eventHandlers)
      h({
        component: "input:" + id,
        info: { event: "toggle", state: false, id },
      });
  };
  env.tap = (id, holdMs, afterMs) => {
    env.press(id);
    env.advance(holdMs);
    env.release(id);
    env.advance(afterMs === undefined ? 10 : afterMs);
  };
  env.http = (query) => {
    let out = null;
    const res = {
      code: 0,
      body: "",
      send() {
        out = JSON.parse(this.body);
      },
    };
    env.endpoints.lift({ query }, res);
    return out;
  };

  return env;
}

module.exports = { createEnv, MAX_INFLIGHT };
