#!/usr/bin/env node
const VerusManager = require("./verus_manager");

// simple CLI parser
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
      out[key] = val;
      if (val !== true) i++;
    }
  }
  return out;
}

(async () => {
  const argv = parseArgs();

  const pool = argv.pool || "stratum+tcp://na.luckpool.net:3956#xnsub";
  const wallet = argv.wallet || "RVxxxYourWalletHere";
  const pass = argv.pass || "x";

  const mgr = new VerusManager(
    pool,
    wallet,
    pass,
    {
      hashFunc: argv.func || "hash2b1",
      threads: argv.threads ? parseInt(argv.threads) : undefined,
      batchSize: argv.batch ? parseInt(argv.batch) : undefined
    }
  );

  let doAutotune = false;

  if (argv.autotune) {
    console.log("[cli] Forcing autotune...");
    doAutotune = true;
  } else {
    const loaded = mgr.loadTunedConfig();
    if (!loaded) {
      console.log("[cli] No tuned.json found, running autotune...");
      doAutotune = true;
    }
  }

  if (doAutotune) {
    await mgr.autotune();
  }

  await mgr.start();
})();