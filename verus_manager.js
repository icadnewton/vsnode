const os = require("os");
const { Worker } = require("worker_threads");
const path = require("path");
const fs = require("fs");
const pool = require("./src/js/pool.js");
const log = require("./src/js/log.js");
const crypto = require("crypto");

// utils
const dsha256 = buf => crypto.createHash("sha256").update(
  crypto.createHash("sha256").update(buf).digest()
).digest();

function targetFromBits(nbitsHexBE) {
  const buf = Buffer.from(nbitsHexBE, "hex");
  const exp = buf[0];
  const mant = (buf[1] << 16) | (buf[2] << 8) | buf[3];
  return BigInt(mant) * (1n << (8n * (BigInt(exp) - 3n)));
}

function buildMerkleRoot(coinbaseHex, branchHexes) {
  let root = dsha256(Buffer.from(coinbaseHex, "hex"));
  for (const h of branchHexes) {
    const bh = Buffer.from(h, "hex").reverse(); // PERBAIKAN: Reverse merkle branch
    root = dsha256(Buffer.concat([root, bh]));
  }
  return root;
}

class VerusManager {
  constructor(poolUrl, wallet, pass = "x", options = {}) {
    this.poolUrl = poolUrl;
    this.wallet = wallet;
    this.pass = pass;
    this.options = options;

    this.baseCores = os.cpus().length;
    this.nthreads = options.threads || this.baseCores;
    this.batchSize = options.batchSize || 10000;
    this.hashFunc = options.hashFunc || "hash2b1";
    this.workers = [];
    this.hashrates = {};
    this.runningJob = null;

    this.tunedFile = path.resolve(__dirname, "tuned.json");

    this.onJob = this.onJob.bind(this);
    this.onClose = this.onClose.bind(this);

    setInterval(() => this.reportHashrate(), 10000);
  }

  loadTunedConfig() {
    if (fs.existsSync(this.tunedFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.tunedFile, "utf-8"));
        this.nthreads = data.threads;
        this.batchSize = data.batchSize;
        console.log(`[tuned] Loaded config: threads=${data.threads}, batchSize=${data.batchSize}, H/s=${data.hps.toFixed(2)}`);
        return true;
      } catch (err) {
        console.error("[tuned] Failed to load tuned.json:", err);
        return false;
      }
    }
    return false;
  }

  saveTunedConfig(best) {
    try {
      fs.writeFileSync(this.tunedFile, JSON.stringify(best, null, 2));
      console.log(`[tuned] Saved config to tuned.json`);
    } catch (err) {
      console.error("[tuned] Failed to save tuned.json:", err);
    }
  }

  async autotune() {
    console.log("[autotune] starting...");

    const threadCandidates = [
      Math.max(1, Math.floor(this.baseCores * 0.5)),
      Math.max(1, Math.floor(this.baseCores * 0.75)),
      this.baseCores
    ];
    const batchCandidates = [2000, 5000, 10000, 20000];

    let best = { hps: 0, threads: this.nthreads, batchSize: this.batchSize };

    for (const t of threadCandidates) {
      for (const b of batchCandidates) {
        console.log(`[autotune] Testing threads=${t}, batch=${b}...`);
        this.nthreads = t;
        this.batchSize = b;

        await this.startWorkers();
        await new Promise(r => setTimeout(r, 15000));
        const total = Object.values(this.hashrates).reduce((a, b) => a + b, 0);

        console.log(`[autotune] Result threads=${t}, batch=${b} → ${total.toFixed(2)} H/s`);
        if (total > best.hps) {
          best = { hps: total, threads: t, batchSize: b };
        }

        await this.stopWorkers();
      }
    }

    console.log(`[autotune] Best config: threads=${best.threads}, batch=${best.batchSize}, H/s=${best.hps.toFixed(2)}`);
    this.nthreads = best.threads;
    this.batchSize = best.batchSize;
    this.saveTunedConfig(best);
    return best;
  }

  async start() {
    this.poolConnection = await pool.connect(this.poolUrl, this.wallet, this.pass, this.options.proxy || null, this.onJob, this.onClose, () => {
      console.log(`[net] connected to ${this.poolUrl}`);
    });

    await this.startWorkers();
  }

  async startWorkers() {
    this.hashrates = {};
    this.workers = [];
    for (let i = 0; i < this.nthreads; i++) {
      const w = new Worker(path.resolve(__dirname, "verus_worker.js"), {
        workerData: {
          threadId: i,
          nthreads: this.nthreads,
          hashFunc: this.hashFunc,
          batchSize: this.batchSize
        }
      });
      w.on("message", msg => this._onWorkerMessage(w, msg));
      w.on("error", err => console.error("Worker error", err));
      w.postMessage({ cmd: "pause" });
      this.workers.push(w);
    }
  }

  async stopWorkers() {
    for (const w of this.workers) w.postMessage({ cmd: "stop" });
    this.workers = [];
  }

  reportHashrate() {
    const total = Object.values(this.hashrates).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.log(`[stats] Total hashrate: ${total.toFixed(2)} H/s`);
      for (const [tid, hps] of Object.entries(this.hashrates)) {
        console.log(`  Thread ${tid}: ${hps.toFixed(2)} H/s`);
      }
    }
  }

  async _onWorkerMessage(worker, msg) {
    if (msg.type === "share") {
      console.log(`[share] job=${msg.job_id}, nonce=${msg.nonce_hex}`);
      try {
        await this.poolConnection.submit(msg.job_id, msg.nonce_hex, msg.result_hex, undefined, this.runningJob?.height);
        console.log(`[share] accepted`);
      } catch (err) {
        console.log(`[share] rejected ${err}`);
      }
    } else if (msg.type === "hashrate") {
      this.hashrates[msg.threadId] = msg.hps;
    }
  }

  async onJob(job) {
    this.runningJob = job;

    // Pastikan semua field yang diperlukan ada
    if (!job.coinb1 || !job.coinb2 || !job.merkle_branch) {
      console.error("[job] Missing required job fields");
      return;
    }

    const coinb1 = job.coinb1, coinb2 = job.coinb2;
    const extranonce1 = job.extranonce1 || "";
    const extranonce2 = "00".repeat(job.extranonce2_size || 4);
    const coinbaseHex = coinb1 + extranonce1 + extranonce2 + coinb2;

    const merkleRoot = buildMerkleRoot(coinbaseHex, job.merkle_branch);

    const versionLE = Buffer.from(job.version, "hex").reverse();
    const prevLE = Buffer.from(job.prevhash, "hex").reverse();
    const merkleLE = Buffer.from(merkleRoot).reverse();
    const ntimeLE = Buffer.from(job.ntime, "hex").reverse();
    const nbitsLE = Buffer.from(job.nbits, "hex").reverse();

    const headerTemplate = Buffer.concat([
      versionLE, prevLE, merkleLE, ntimeLE, nbitsLE, Buffer.alloc(4, 0)
    ]);

    const targetBig = targetFromBits(job.nbits);

    const jobData = {
      job_id: job.job_id,
      headerTemplate: headerTemplate.toString("hex"),
      target: targetBig.toString(16).padStart(64, '0') // Pastikan 64 karakter
    };

    this.broadcast({ cmd: "setjob", job: jobData });
    this.broadcast({ cmd: "start" });
  }

  async onClose() {
    console.log("[net] pool disconnected");
    this.broadcast({ cmd: "pause" });
  }

  broadcast(obj) {
    this.workers.forEach(w => w.postMessage(obj));
  }
}

module.exports = VerusManager;