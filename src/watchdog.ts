// watchdog.ts — revives the lift-arbiter script if it ever halts.
// Build target: scripts/watchdog.js; deployed as a SEPARATE Shelly script slot
// with "run on startup". Kept intentionally tiny and independent: if the
// arbiter crashes, physical paddles are dead (detached inputs) until restart.
// On revival it also raises the lift-fault HomeKit sensor; the arbiter's own
// healthy boot clears it.

var ARBITER_SCRIPT_ID = 1;
var CHECK_INTERVAL_MS = 10000;
var WEBHOOK_ALERT_URL = "http://192.168.10.175:51828/?accessoryId=lift-fault&state=true";

Timer.set(CHECK_INTERVAL_MS, true, () => {
  Shelly.call(
    "Script.GetStatus",
    { id: ARBITER_SCRIPT_ID },
    (result, errorCode) => {
      var status = result as { running?: boolean; } | null;

      if (errorCode !== 0 || status === null) return; // arbiter slot missing

      if (status.running === true) return;

      print("[watchdog] arbiter not running — restarting");
      Shelly.call("Script.Start", { id: ARBITER_SCRIPT_ID });
      Shelly.call("HTTP.GET", { url: WEBHOOK_ALERT_URL, timeout: 3 });
    },
    null,
  );
});

print(
  "[watchdog] armed — monitoring script " +
  ARBITER_SCRIPT_ID +
  " every " +
  CHECK_INTERVAL_MS +
  "ms",
);
