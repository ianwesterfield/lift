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
// GESTURES (rev 10):
//   idle press            -> latched full travel (energized immediately)
//   opposite press in run -> REVERSE: stop, dead-time, full travel other way
//   same-dir 2nd press    -> toggle JOG MODE (stops the run on entry)
//     (chain: presses within 3 s of the chain's FIRST press, same direction)
//   same-dir 3rd press    -> CALIBRATION ride (full UP, paddle locked)
//   jog mode              -> hold-to-run; double-press exits back to normal
//   hold paddle 3 s       -> lockout escape (FAULT/calibration only)
//
// ARCHITECTURE RULE (hard-won): mJS has a tiny call stack and fw 2.0.0
// clobbers params of Shelly.call dispatched in the same tick. Handlers and
// helpers may ONLY mutate memory; ALL RPC I/O is emitted by ONE flat repeating
// timer (the IoQueue tick), at most one call per tick. No class inheritance,
// no accessors, no spread: those emit ES5 helpers the device cannot run.

type Dir = 0 | 1;
type MachineState = "IDLE" | "RUNNING" | "COOLDOWN" | "FAULT";
type Pos = "top" | "bottom" | "mid" | "unknown";
type Source = "input" | "http" | "calib" | "reverse";
type Gesture = "run" | "jogToggle" | "calibrate";

var UP: Dir = 0;
var DOWN: Dir = 1;
var DIR_NAME = ["UP", "DOWN"];

var CFG = {
  COOLDOWN_MS: 0, // stop -> reverse/re-arm dead-time
  DBL_MS: 3000, // gesture chain: presses within 3 s of the chain's first press
  TICK_MS: 25, // I/O drain tick
  TRAVEL_UP_MS: 55000, // dead-reckoning scale; overwritten at init from auto_off_delay
  TRAVEL_DOWN_MS: 45000,
  EST_EDGE: 0.03, // estimate within this of 0/1 counts as at that floor
  OFF_GRACE_MS: 2000, // commanded-OFF may lag this long before it's "rogue"
  RESET_HOLD_MS: 3000, // lockout-escape hold duration
  LIMIT_IN: 2, // S3: optional "at a terminal" feedback (active when input:2 enabled)
  POS_KEY: "lift.pos",
  EST_KEY: "lift.est",
  LOG_KEY: "lift.blackbox",
  HB_WEBHOOK: "http://192.168.10.175:51828", // homebridge-http-webhooks listener
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (a?: any, b?: any, c?: any, d?: any) => void;

interface RelayCmd {
  id: Dir;
  on: boolean;
  r: number; // retry count
}

type IoJob =
  | { kind: "relay"; m: "Switch.Set"; p: { id: Dir; on: boolean; }; rc: RelayCmd; }
  | { kind: "job"; m: string; p: object; cb?: (r: unknown, ec: number, em: string) => void; }
  | { kind: "pos" | "est" | "bb"; m: "KVS.Set"; p: { key: string; value: string; }; }
  | { kind: "wh"; m: "HTTP.GET"; p: { url: string; timeout: number; }; };

// ---------------------------------------------------------------------------
// IoQueue — the ONLY place Shelly.call happens. Everything else raises
// signals: relay FIFO, one-shot jobs, dirty flags, webhook queue. The tick
// drains at most one call per pass (fw clobbers same-tick dispatches) with
// budget headroom under the ~5 concurrent-call cap.
// ---------------------------------------------------------------------------

class IoQueue {
  relay: RelayCmd[] = []; // FIFO — relay command order is sacred
  jobs: IoJob[] = [];
  dirtyPos = false;
  dirtyEst = false;
  dirtyBB = false;
  whQueue: string[] = [];
  inflight = 0;

  private owner: LiftArbiter | null = null;

  attach(owner: LiftArbiter): void {
    this.owner = owner;
    var self = this;
    Timer.set(CFG.TICK_MS, true, function () {
      self.tick();
      (self.owner as LiftArbiter).pump(); // re-arm / pending auto-starts
    });
  }

  pushRelay(id: Dir, on: boolean): void {
    this.relay.push({ id: id, on: on, r: 0 });
  }

  pushJob(m: string, p: object, cb?: (r: unknown, ec: number, em: string) => void): void {
    this.jobs.push({ kind: "job", m: m, p: p, cb: cb });
  }

  private nextJob(): IoJob | null {
    var o = this.owner as LiftArbiter;
    if (this.relay.length > 0 && this.inflight < 4) {
      var rc = this.relay.splice(0, 1)[0];
      return { m: "Switch.Set", p: { id: rc.id, on: rc.on }, kind: "relay", rc: rc };
    }
    if (this.inflight >= 2) return null; // headroom below the fw call cap
    if (this.jobs.length > 0) return this.jobs.splice(0, 1)[0];
    if (this.dirtyPos) {
      this.dirtyPos = false;
      return { m: "KVS.Set", p: { key: CFG.POS_KEY, value: o.pos }, kind: "pos" };
    }
    if (this.dirtyEst) {
      this.dirtyEst = false;
      var v = "";
      if (o.est !== null) v = JSON.stringify(o.est);
      return { m: "KVS.Set", p: { key: CFG.EST_KEY, value: v }, kind: "est" };
    }
    if (this.whQueue.length > 0) {
      var u = this.whQueue.splice(0, 1)[0];
      return { m: "HTTP.GET", p: { url: u, timeout: 3 }, kind: "wh" };
    }
    if (this.dirtyBB) {
      this.dirtyBB = false;
      return {
        m: "KVS.Set",
        p: { key: CFG.LOG_KEY, value: o.hist.join(" | ").slice(-250) },
        kind: "bb",
      };
    }
    return null;
  }

  private tick(): void {
    var j = this.nextJob();
    if (j === null) return;
    var self = this;
    this.inflight++;
    try {
      Shelly.call(
        j.m,
        j.p,
        function (r, ec, em, ud) {
          self.inflight--;
          var job = ud as IoJob;
          if (ec !== 0 && job.kind === "relay") {
            job.rc.r++;
            if (job.rc.r <= 2)
              self.relay.unshift(job.rc); // idempotent retry
            else (self.owner as LiftArbiter).log("relay failed: " + em + " id=" + job.rc.id);
          } else if (ec !== 0 && job.kind === "pos") self.dirtyPos = true;
          else if (ec !== 0 && job.kind === "est") self.dirtyEst = true;
          if (job.kind === "job" && job.cb) job.cb(r, ec, em);
        },
        j,
      );
    } catch (e) {
      this.inflight--;
      if (j.kind === "relay") this.relay.unshift(j.rc);
      else if (j.kind === "job") this.jobs.unshift(j);
      else if (j.kind === "pos") this.dirtyPos = true;
      else if (j.kind === "est") this.dirtyEst = true;
      else if (j.kind === "bb") this.dirtyBB = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Gestures — classifies physical presses into intents. Chain = same-direction
// presses within DBL_MS of the chain's FIRST press.
// ---------------------------------------------------------------------------

class Gestures {
  private n = 0;
  private startTs = 0;

  // direction-agnostic: only the NUMBER of presses within the window matters
  classify(): { gesture: Gesture; n: number; } {
    if (Date.now() - this.startTs <= CFG.DBL_MS) {
      this.n++;
    } else {
      this.n = 1;
      this.startTs = Date.now();
    }
    if (this.n === 3) {
      this.reset();
      return { gesture: "calibrate", n: 3 };
    }
    if (this.n === 2) return { gesture: "jogToggle", n: 2 };
    return { gesture: "run", n: 1 };
  }

  reset(): void {
    this.n = 0;
    this.startTs = 0;
  }
}

// ---------------------------------------------------------------------------
// LiftArbiter — the state machine. Handlers mutate memory only; all I/O goes
// through the IoQueue.
// ---------------------------------------------------------------------------

class LiftArbiter {
  state: MachineState = "IDLE";
  dir: Dir | null = null;
  jog = false; // hold-to-run mode; toggled by same-dir double-press
  calib = false; // calibration ride: paddle ignored until Auto-Off
  calibPending = false;
  nextDir: Dir | null = null; // reversal target after cooldown
  runOnTs = 0;
  lastRunDir: Dir | null = null;
  onPending: Dir | null = null; // commanded-ON echo still in flight
  cmd: [boolean, boolean] = [false, false];
  offTs: [number, number] = [0, 0];
  est: number | null = null;
  stopping = false;
  cooldownUntil = 0; // re-arm gate; the tick promotes COOLDOWN->IDLE
  resetTimer: number | null = null;
  holdTimer: number | null = null;
  limitFb = false;
  hist: string[] = [];
  pos: Pos = "unknown";

  io: IoQueue;
  gestures: Gestures;

  constructor() {
    this.io = new IoQueue();
    this.gestures = new Gestures();
  }

  // ---- logging / persistence signals ----

  log(msg: string): void {
    print("[lift] " + msg);
    this.hist.push(Math.round(Date.now() / 1000) + " " + msg);
    if (this.hist.length > 15) this.hist.splice(0, 1);
    this.io.dirtyBB = true;
  }

  guard(name: string, fn: AnyFn): AnyFn {
    var self = this;
    return function (a?, b?, c?, d?) {
      try {
        fn(a, b, c, d);
      } catch (e) {
        try {
          self.fault("exception in " + name + ": " + (e as Error).message);
        } catch (e2) {
          self.bothOff(); // last resort
        }
      }
    };
  }

  setOut(id: Dir, on: boolean): void {
    this.cmd[id] = on;
    if (!on) this.offTs[id] = Date.now();
    this.io.pushRelay(id, on);
  }

  bothOff(): void {
    this.setOut(UP, false);
    this.setOut(DOWN, false);
  }

  outOn(id: Dir): boolean {
    var st = Shelly.getComponentStatus("switch:" + id);
    return st !== null && st.output === true;
  }

  inOn(id: Dir): boolean {
    var st = Shelly.getComponentStatus("input:" + id);
    return st !== null && st.state === true;
  }

  rogueOn(): boolean {
    for (var i = UP; i <= DOWN; i++) {
      var d = i as Dir;
      if (this.outOn(d) && !this.cmd[d] && Date.now() - this.offTs[d] > CFG.OFF_GRACE_MS)
        return true;
    }
    return false;
  }

  setPos(p: Pos): void {
    if (this.pos === p) return;
    this.pos = p;
    this.log("position: " + p);
    this.io.dirtyPos = true;
    this.io.whQueue = [
      CFG.HB_WEBHOOK + "/?accessoryId=lift-top&state=" + (p === "top"),
      CFG.HB_WEBHOOK + "/?accessoryId=lift-bottom&state=" + (p === "bottom"),
    ];
  }

  setEst(e: number | null): void {
    this.est = e;
    this.io.dirtyEst = true;
  }

  updateEst(dirId: Dir, dtMs: number): void {
    if (this.est === null || dtMs <= 0) return;
    var d = dirId === UP ? dtMs / CFG.TRAVEL_UP_MS : -dtMs / CFG.TRAVEL_DOWN_MS;
    var e = this.est + d;
    if (e < 0) e = 0;
    if (e > 1) e = 1;
    this.setEst(e);
  }

  atTerminal(dirId: Dir, why: string): void {
    this.setEst(dirId === UP ? 1 : 0);
    this.setPos(dirId === UP ? "top" : "bottom");
    this.log("at " + (dirId === UP ? "top" : "bottom") + " (" + why + ")");
  }

  declareFromEst(): void {
    if (this.est === null || this.pos !== "mid") return;
    if (this.est >= 1 - CFG.EST_EDGE) this.atTerminal(UP, "dead reckoning");
    else if (this.est <= CFG.EST_EDGE) this.atTerminal(DOWN, "dead reckoning");
  }

  // ---- state transitions ----

  clearTimers(): void {
    this.cooldownUntil = 0;
  }

  fault(reason: string): void {
    this.log("FAULT: " + reason + " — both outputs OFF, lockout (cmd=reset to clear)");
    this.clearTimers();
    this.bothOff();
    this.state = "FAULT";
    this.dir = null;
    this.calib = false;
    this.calibPending = false;
    this.nextDir = null;
  }

  // COOLDOWN ends when the dead-time (possibly 0) has passed AND the relays
  // are physically OFF with nothing in flight — promoted by the IO tick, so
  // "zero cooldown" is really "as soon as the hardware confirms quiescent".
  cooldown(): void {
    this.state = "COOLDOWN";
    this.dir = null;
    this.cooldownUntil = Date.now() + CFG.COOLDOWN_MS;
  }

  // called every IO tick: re-arm and run any pending auto-start intents
  pump(): void {
    if (this.state !== "COOLDOWN") return;
    if (Date.now() < this.cooldownUntil) return;
    if (this.io.relay.length > 0) return; // relay commands still queued
    if (this.outOn(UP) || this.outOn(DOWN)) return; // OFF not landed yet
    this.state = "IDLE";
    this.log("re-armed");
    if (this.calibPending) {
      if (this.inOn(UP) || this.inOn(DOWN)) {
        this.cooldown(); // the calibration press is still held: wait it out
        return;
      }
      this.calibPending = false;
      this.nextDir = null;
      this.startCalibTrip();
    } else if (this.nextDir !== null) {
      var d = this.nextDir;
      this.nextDir = null;
      var r = this.request(d, "reverse");
      if (r !== "accepted") this.log("reverse did not start: " + r);
    }
  }

  stopTrip(reason: string): void {
    this.log("STOP (" + reason + ")");
    this.stopping = this.outOn(UP) || this.outOn(DOWN);
    this.bothOff();
    this.cooldown();
  }

  hardReset(source: string): void {
    this.log("HARD RESET (" + source + ")");
    this.clearTimers();
    this.bothOff();
    this.state = "IDLE";
    this.dir = null;
    this.jog = false;
    this.calib = false;
    this.calibPending = false;
    this.nextDir = null;
    this.gestures.reset();
    this.stopping = false;
    this.onPending = null;
    this.runOnTs = 0;
  }

  armResetGesture(): void {
    if (this.resetTimer !== null) return;
    var self = this;
    this.resetTimer = Timer.set(
      CFG.RESET_HOLD_MS,
      false,
      this.guard("resetTimer", function () {
        self.resetTimer = null;
        if (self.inOn(UP) && self.inOn(DOWN)) self.hardReset("both buttons held");
      }),
    );
  }

  // Rocker paddle can't press both directions; lockout states get a one-button
  // escape. Never armed in normal states.
  armHoldEscape(dir: Dir): void {
    if (this.holdTimer !== null) return;
    var self = this;
    this.holdTimer = Timer.set(
      CFG.RESET_HOLD_MS,
      false,
      this.guard("holdTimer", function () {
        self.holdTimer = null;
        if (self.inOn(dir) && (self.state === "FAULT" || self.calib || self.calibPending))
          self.hardReset("paddle held in lockout");
      }),
    );
  }

  // ---- calibration ----

  startCalibration(source: string): string {
    this.log("CALIBRATION (" + source + "): full UP, paddle locked until Auto-Off");
    this.calib = true;
    this.jog = false; // calibration always exits to normal mode
    if (this.state === "RUNNING") {
      if (this.dir === UP) return "calibrating"; // this run becomes the ride
      this.calibPending = true;
      this.stopTrip("calibration: stop before UP ride");
      return "calibrating";
    }
    if (this.state === "COOLDOWN") {
      this.calibPending = true;
      return "calibrating";
    }
    this.startCalibTrip();
    return "calibrating";
  }

  startCalibTrip(): void {
    var r = this.request(UP, "calib");
    if (r !== "accepted") {
      this.calib = false;
      this.calibPending = false;
      this.log("calibration failed to start: " + r);
    }
  }

  // ---- the single request entry point ----

  request(dir: Dir, source: Source): string {
    if (source === "input") {
      if (this.inOn(UP) && this.inOn(DOWN)) this.armResetGesture();
      if (this.state === "FAULT" || this.calib || this.calibPending) this.armHoldEscape(dir);
    }

    if (this.state === "FAULT") {
      this.log("ignored " + DIR_NAME[dir] + " (" + source + "): FAULT lockout");
      return "fault";
    }

    if (this.calib && source === "input") {
      this.log("ignored " + DIR_NAME[dir] + ": calibration in progress");
      return "calibrating";
    }

    if (source === "input") {
      var g = this.gestures.classify();
      this.log("press " + DIR_NAME[dir] + " " + g.n + " (" + this.state + (this.jog ? ",jog" : "") + ")");
      if (g.gesture === "calibrate") return this.startCalibration(source);
      if (g.gesture === "jogToggle") return this.toggleJog(dir);
      if (this.jog) return this.jogPress(dir); // hold-to-run handled on press/release
    }

    if (this.state === "RUNNING") {
      if (dir !== this.dir) {
        // opposite press = immediate stop, dead-time, full travel the other way
        this.nextDir = dir;
        this.stopTrip("reverse to " + DIR_NAME[dir] + " (" + source + ")");
        return "reversing";
      }
      if (source !== "input") return "already-running";
      this.log("same-direction press during run ignored");
      return "ignored";
    }

    if (this.state !== "IDLE") return "busy"; // COOLDOWN (chain counted above)

    if (this.rogueOn()) {
      this.fault("output ON while believed IDLE");
      return "fault";
    }
    if (this.outOn(UP) || this.outOn(DOWN)) {
      this.log("outputs settling — press again");
      return "settling";
    }
    if (this.inOn(dir === UP ? DOWN : UP)) {
      this.log("opposite input held — refusing " + DIR_NAME[dir]);
      this.cooldown();
      return "conflict";
    }

    this.dir = dir;
    return this.startRun(false) ? "accepted" : "aborted";
  }

  // same-direction double-press: enter/exit jog mode (entering stops any run)
  toggleJog(dir: Dir): string {
    this.jog = !this.jog;
    this.log("jog mode " + (this.jog ? "ON (hold-to-run)" : "OFF"));
    if (this.jog && this.state === "RUNNING") {
      this.stopTrip("jog entry");
    } else if (!this.jog && this.state === "RUNNING") {
      this.stopTrip("jog exit"); // exiting mid-hold: stop; next press = travel
    }
    return this.jog ? "jog-on" : "jog-off";
  }

  // jog mode press: run unlatched while held (release stops it)
  jogPress(dir: Dir): string {
    if (this.state === "RUNNING") {
      if (dir !== this.dir) {
        this.nextDir = null; // no auto-reverse in jog: just stop
        this.stopTrip("jog: opposite press");
        return "stopped";
      }
      return "ignored";
    }
    if (this.state !== "IDLE") return "busy";
    if (this.rogueOn()) {
      this.fault("output ON while believed IDLE");
      return "fault";
    }
    if (this.outOn(UP) || this.outOn(DOWN)) return "settling";
    if (this.inOn(dir === UP ? DOWN : UP)) return "conflict";
    this.dir = dir;
    return this.startRun(true) ? "accepted" : "aborted";
  }

  // unlatched=true: jog hold-to-run (release stops); firmware Auto-Off still backs it up
  startRun(unlatched: boolean): boolean {
    if (this.outOn(UP) || this.outOn(DOWN)) {
      if (this.rogueOn()) {
        this.fault("output ON at trip start");
      } else {
        this.log("outputs still settling — run aborted, press again");
        this.cooldown();
      }
      return false;
    }
    // RUNNING before energizing: a press landing between decision and relay
    // closure is handled by the run rules, never as a second acceptance.
    this.state = "RUNNING";
    this.runOnTs = Date.now();
    this.lastRunDir = this.dir;
    this.onPending = this.dir;
    this.setPos("mid"); // persisted before energizing
    this.setOut(this.dir as Dir, true);
    this.log(
      "RUNNING " +
      DIR_NAME[this.dir as Dir] +
      (this.calib ? " (calibration)" : unlatched ? " (jog hold)" : ""),
    );
    return true;
  }

  release(dir: Dir): void {
    if (this.resetTimer !== null) {
      Timer.clear(this.resetTimer);
      this.resetTimer = null;
    }
    if (this.holdTimer !== null) {
      Timer.clear(this.holdTimer);
      this.holdTimer = null;
    }
    // jog hold-to-run: release of the running direction stops the run
    if (this.jog && !this.calib && this.state === "RUNNING" && dir === this.dir) {
      this.stopTrip("jog release");
    }
  }

  // ---- hardware feedback ----

  limitHit(): void {
    var d = this.state === "RUNNING" ? this.dir : this.lastRunDir;
    if (d === null) {
      this.log("limit feedback with no known direction — ignored");
      return;
    }
    this.atTerminal(d, "S3 feedback");
    if (this.calib) {
      this.calib = false;
      this.log("CALIBRATION complete — at top, 100%");
    }
    if (this.state === "RUNNING") {
      this.stopping = this.outOn(UP) || this.outOn(DOWN);
      this.bothOff();
      this.cooldown();
    }
  }

  onSwitchStatus(st: ShellyStatus): void {
    if (st.name !== "switch" || (st.id !== UP && st.id !== DOWN)) return;
    if (!st.delta || st.delta.output === undefined) return;
    var id = st.id as Dir;

    if (this.outOn(UP) && this.outOn(DOWN)) {
      this.fault("both outputs ON");
      return;
    }

    if (st.delta.output === false) {
      if (this.runOnTs !== 0 && id === this.lastRunDir) {
        this.updateEst(id, Date.now() - this.runOnTs);
        this.runOnTs = 0;
      }
      if (this.stopping) {
        this.stopping = false;
        this.declareFromEst();
        return;
      }
      if (this.state === "RUNNING" && id === this.dir) {
        this.log("Auto-Off end of run");
        this.atTerminal(id, "Auto-Off");
        if (this.calib) {
          this.calib = false;
          this.log("CALIBRATION complete — at top, 100%");
        }
        this.cooldown();
      }
    } else {
      if (id === this.onPending) {
        this.onPending = null; // our own commanded-ON echo
        return;
      }
      if (!this.outOn(id)) return; // stale
      if (this.state !== "RUNNING" || id !== this.dir) {
        this.fault(
          "unexpected output ON: switch:" +
          id +
          " source=" +
          (st.delta.source ? st.delta.source : "?"),
        );
      }
    }
  }

  // ---- init ----

  init(): void {
    this.io.attach(this);
    this.bothOff(); // fail-safe regardless of pre-boot state
    var self = this;

    // est restore chained after pos restore: its fallback derives from pos
    this.io.pushJob("KVS.Get", { key: CFG.POS_KEY }, function (r, ec) {
      var rv = r as { value?: unknown; } | null;
      if (ec === 0 && rv && typeof rv.value === "string") self.pos = rv.value as Pos;
      self.log("position restored: " + self.pos);
      self.io.whQueue = [
        CFG.HB_WEBHOOK + "/?accessoryId=lift-top&state=" + (self.pos === "top"),
        CFG.HB_WEBHOOK + "/?accessoryId=lift-bottom&state=" + (self.pos === "bottom"),
      ];
      self.io.pushJob("KVS.Get", { key: CFG.EST_KEY }, function (r2, ec2) {
        var rv2 = r2 as { value?: unknown; } | null;
        if (ec2 === 0 && rv2 && rv2.value !== "" && typeof rv2.value === "string") {
          var e = JSON.parse(rv2.value);
          if (typeof e === "number") self.est = e;
        }
        if (self.est === null) {
          if (self.pos === "top") self.est = 1;
          else if (self.pos === "bottom") self.est = 0;
        }
        self.log("est restored: " + (self.est === null ? "null" : self.est));
      });
    });

    var lc = Shelly.getComponentConfig("input:" + CFG.LIMIT_IN);
    this.limitFb = lc !== null && lc.enable === true;
    this.log(
      "S3 limit feedback: " + (this.limitFb ? "ACTIVE" : "not wired (input:2 disabled)"),
    );

    for (var i = UP; i <= DOWN; i++) {
      var c = Shelly.getComponentConfig("switch:" + i);
      if (c) {
        if (c.auto_off && typeof c.auto_off_delay === "number") {
          if (i === UP) CFG.TRAVEL_UP_MS = c.auto_off_delay * 1000;
          else CFG.TRAVEL_DOWN_MS = c.auto_off_delay * 1000;
        }
        if (c.initial_state !== "off")
          this.log("WARN switch:" + i + " initial_state='" + c.initial_state + "'");
        if (c.in_mode !== "detached")
          this.log("WARN switch:" + i + " in_mode='" + c.in_mode + "'");
        if (!c.auto_off) this.log("WARN switch:" + i + " auto_off DISABLED");
      }
    }
    this.log(
      "armed — rev11 direction-agnostic gestures, cooldown " +
      CFG.COOLDOWN_MS +
      "ms (tick-confirmed), chain " +
      CFG.DBL_MS +
      "ms, travel " +
      CFG.TRAVEL_UP_MS / 1000 +
      "s/" +
      CFG.TRAVEL_DOWN_MS / 1000 +
      "s",
    );
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

var arbiter = new LiftArbiter();

Shelly.addEventHandler(
  arbiter.guard("eventHandler", function (ev: ShellyEvent) {
    if (!ev.info || ev.info.event !== "toggle") return;
    if (ev.component === "input:" + CFG.LIMIT_IN) {
      if (arbiter.limitFb && ev.info.state === true) arbiter.limitHit();
      return;
    }
    if (ev.component !== "input:" + UP && ev.component !== "input:" + DOWN) return;
    var id = ev.info.id as Dir;
    if (ev.info.state === true) arbiter.request(id, "input");
    else arbiter.release(id);
  }),
);

Shelly.addStatusHandler(
  arbiter.guard("statusHandler", function (st: ShellyStatus) {
    arbiter.onSwitchStatus(st);
  }),
);

// http://<ip>/script/<id>/lift?dir=up|down | ?cmd=stop|calibrate|reset|jog|hist | ?set=top|bottom|mid
HTTPServer.registerEndpoint("lift", function (req, res) {
  var q = req.query ? req.query : "";
  var result = "status";

  try {
    if (q.indexOf("cmd=stop") !== -1) {
      arbiter.calib = false;
      arbiter.calibPending = false;
      arbiter.nextDir = null;
      if (arbiter.state === "RUNNING") {
        arbiter.stopTrip("http stop");
        result = "stopped";
      } else {
        result = "not-running";
      }
    } else if (q.indexOf("cmd=calibrate") !== -1) {
      result = arbiter.calib ? "already-calibrating" : arbiter.startCalibration("http");
    } else if (q.indexOf("cmd=reset") !== -1) {
      arbiter.hardReset("http");
      result = "reset";
    } else if (q.indexOf("cmd=jog") !== -1) {
      result = arbiter.toggleJog(UP);
    } else if (q.indexOf("cmd=hist") !== -1) {
      result = "hist";
    } else if (q.indexOf("dir=up") !== -1) {
      result = arbiter.request(UP, "http");
    } else if (q.indexOf("dir=down") !== -1) {
      result = arbiter.request(DOWN, "http");
    } else if (q.indexOf("set=") !== -1) {
      var p: Pos | null = null;
      if (q.indexOf("set=top") !== -1) p = "top";
      else if (q.indexOf("set=bottom") !== -1) p = "bottom";
      else if (q.indexOf("set=mid") !== -1) p = "mid";
      if (p !== null && arbiter.state === "IDLE") {
        arbiter.setEst(p === "top" ? 1 : p === "bottom" ? 0 : null);
        arbiter.setPos(p);
        result = "calibrated";
      } else {
        result = "set-refused";
      }
    }
  } catch (e) {
    arbiter.fault("exception in http handler: " + (e as Error).message);
    result = "error";
  }

  var body: {
    result: string;
    state: MachineState;
    dir: string | null;
    jog: boolean;
    calib: boolean;
    pos: Pos;
    pct: number | null;
    est: number | null;
    hist?: string[];
  } = {
    result: result,
    state: arbiter.state,
    dir: arbiter.dir === null ? null : DIR_NAME[arbiter.dir],
    jog: arbiter.jog,
    calib: arbiter.calib || arbiter.calibPending,
    pos: arbiter.pos,
    pct: arbiter.est === null ? null : Math.round(arbiter.est * 100),
    est: arbiter.est === null ? null : Math.round(arbiter.est * 100) / 100,
  };
  if (result === "hist") body.hist = arbiter.hist;
  res.code = 200;
  res.body = JSON.stringify(body);
  res.send();
});

arbiter.init();
