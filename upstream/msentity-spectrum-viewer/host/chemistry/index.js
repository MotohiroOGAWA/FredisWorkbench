"use strict";

// Optional chemistry features (RDKit, WebAssembly build) for the dataset viewer.
// RDKit runs in a worker thread so that long SMARTS searches never block the
// host. Without the optional dependency @rdkit/rdkit every capability is false.

const path = require("path");
const { Worker } = require("worker_threads");

/** Capabilities when RDKit is not available. */
const NO_CHEMISTRY = Object.freeze({
  backend: null, smarts_filter: false, structure_render: false, structure_count: false,
});

/**
 * RDKit in a worker thread, shared by every viewer of a host.
 *
 *   const chemistry = new RdkitChemistry();
 *   await chemistry.capabilities;   // {backend: "rdkit", smarts_filter, structure_render, structure_count}
 *   await chemistry.call("smarts-match", { values: ["CCO", "N"], pattern: "C" });   // [true, false]
 *   await chemistry.call("structure-counts", { values: ["CCO", "OCC"] });          // {unique_smiles: 2, canonical_structures: 1}
 *   await chemistry.call("render", { smiles: "CCO", width: 560, height: 400 });    // {smiles, svg}
 *   chemistry.stop();
 */
class RdkitChemistry {
  constructor({ log = () => {}, env } = {}) {
    this.log = log;
    this.pending = new Map();
    this.nextId = 1;
    this.worker = new Worker(path.join(__dirname, "worker.js"), { env: env || process.env });
    this.capabilities = new Promise((resolve) => {
      this.worker.on("message", (message) => {
        if (message.type === "capabilities") {
          log(`chemistry: RDKit ${message.version || "unavailable"} → ${JSON.stringify(message.chemistry)}`);
          resolve({ ...NO_CHEMISTRY, ...message.chemistry });
        } else if (message.type === "log") {
          log(`chemistry: ${message.message}`);
        } else if (this.pending.has(message.id)) {
          const { resolve: done, reject } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.ok) done(message.result);
          else reject(new Error(message.error));
        }
      });
      const fail = (reason) => {
        log(`chemistry: worker stopped (${reason})`);
        for (const { reject } of this.pending.values()) reject(new Error("The chemistry worker stopped."));
        this.pending.clear();
        this.worker = null;
        resolve(NO_CHEMISTRY);
      };
      this.worker.on("error", (error) => fail(error.message));
      this.worker.on("exit", (code) => fail(`exit ${code}`));
    });
  }

  /** Run one request: "smarts-match", "structure-counts", or "render". */
  async call(type, params = {}) {
    await this.capabilities;
    if (!this.worker) throw new Error("Optional RDKit support is not available");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...params, id, type });
    });
  }

  stop() {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
  }
}

module.exports = { RdkitChemistry, NO_CHEMISTRY };
