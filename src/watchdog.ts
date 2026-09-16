// watchdog.ts — revives the lift-arbiter script if it ever halts.
// Build target: scripts/watchdog.js; deploy as a SEPARATE Shelly script slot
// with "run on startup". Kept intentionally tiny and independent: if the
// arbiter crashes, physical paddles are dead (detached inputs) until restart.

var ARBITER_SCRIPT_ID = 1;
var CHECK_MS = 10000;

Timer.set(CHECK_MS, true, function () {
  Shelly.call(
    "Script.GetStatus",
    { id: ARBITER_SCRIPT_ID },
    function (r, ec, em, ud) {
      var st = r as { running?: boolean } | null;
      if (ec !== 0 || st === null) return; // arbiter slot missing: nothing to do
      if (st.running === true) return;
      print("[watchdog] arbiter not running — restarting");
      Shelly.call("Script.Start", { id: ARBITER_SCRIPT_ID });
    },
    null,
  );
});

print("[watchdog] armed — monitoring script " + ARBITER_SCRIPT_ID + " every " + CHECK_MS + "ms");
