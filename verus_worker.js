const { parentPort, workerData } = require("worker_threads");
const path = require("path");
const verus = require(path.resolve(__dirname, "./build/Release/verushash"));
verus.init();

const { threadId = 0, nthreads = 1, hashFunc = "hash2b1", batchSize = 10000 } = workerData;
let job = null, running = false, stopFlag = false;
let hashesDone = 0, lastReport = Date.now();

const hexToBuf = h => Buffer.from(h, "hex");

function u256LEtoBig(buf) {
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(buf[i]);
  return n;
}

parentPort.on("message", async msg => {
  if (msg.cmd === "setjob") {
    job = msg.job;
  } else if (msg.cmd === "start") {
    if (!running && job) {
      running = true; stopFlag = false;
      miningLoop();
    }
  } else if (msg.cmd === "pause") {
    stopFlag = true; running = false;
  } else if (msg.cmd === "stop") {
    stopFlag = true; running = false;
    process.exit(0);
  }
});

async function miningLoop() {
  if (!job || !job.headerTemplate) {
    stopFlag = true;
    running = false;
    return;
  }

  const headerBufTemplate = hexToBuf(job.headerTemplate);
  const nonceOffset = headerBufTemplate.length - 4;
  const hashFn = verus[hashFunc] || verus.hash2b1;
  const target = BigInt("0x" + job.target);

  const buf = Buffer.from(headerBufTemplate);
  let nonce = threadId >>> 0;
  const step = nthreads >>> 0;

  while (!stopFlag) {
    for (let i = 0; i < batchSize; i++) {
      buf.writeUInt32LE(nonce >>> 0, nonceOffset);
      const hashBuf = hashFn(buf);
      hashesDone++;

      // PERBAIKAN: Konversi hash ke BigInt dengan endianness yang benar
      const hashValue = u256LEtoBig(hashBuf);
      
      if (hashValue <= target) {
        const nonceBuf = Buffer.alloc(4);
        nonceBuf.writeUInt32LE(nonce >>> 0, 0);
        parentPort.postMessage({
          type: "share",
          job_id: job.job_id,
          nonce_hex: nonceBuf.toString('hex'), // Tidak perlu di-reverse
          result_hex: hashBuf.toString("hex")
        });
      }
      nonce = (nonce + step) >>> 0;
    }

    const now = Date.now();
    if (now - lastReport >= 5000) {
      const elapsed = (now - lastReport) / 1000;
      const hps = hashesDone / elapsed;
      parentPort.postMessage({ type: "hashrate", threadId, hps });
      hashesDone = 0;
      lastReport = now;
    }
    
    // Menggunakan setImmediate untuk memberi kesempatan event loop
    await new Promise(r => setImmediate(r));
  }
}