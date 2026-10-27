"use strict";

// Quick check of a backend executable on the current platform (used by the
// release workflow on every OS):
//
//   node scripts/smoke-backend.js <msentity-viewer-backend>
//
// Opens the example MSP (dataset mode) and the example .mssim (similarity
// mode) shipped in the submodules and checks the first answers.

const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const backend = path.resolve(process.argv[2] || "");
const PREFIX = "MSENTITY_JSON:";

function run(mode, file, requests) {
  const result = spawnSync(backend, [mode, file], {
    input: requests.map((r) => JSON.stringify(r) + "\n").join(""), encoding: "utf8", timeout: 60000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).filter((l) => l.startsWith(PREFIX)).map((l) => JSON.parse(l.slice(PREFIX.length)));
}

const version = spawnSync(backend, ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0, version.stderr);
console.log(`backend ${version.stdout.trim()}: ${backend}`);

const dataset = run("dataset", path.join(root, "external/msentity/docs/examples/example.msp"), [
  { type: "page", page: 0 },
  { type: "page", filters: [{ operator: "spectrum_peak", mz: 185.0961, tolerance: 0.01, tolerance_unit: "Da", intensity: 0 }] },
]);
const pages = dataset.filter((m) => m.type === "dataset-page").map((m) => m.value);
assert.equal(dataset[dataset.length - pages.length - 1].type, "backend-ready");
assert.equal(pages[0].total_rows, 2);
assert.deepEqual(pages[0].spectra[0].mz, [91.0542, 125.0233, 185.0961, 246.1125]);
assert.equal(pages[1].total_rows, 1);

const similarity = run("similarity", path.join(root, "external/msentity-similarity/docs/examples/example.mssim"), [
  { type: "page", bins: 5 },
  { type: "match", row: 1 },
]);
const page = similarity.find((m) => m.type === "similarity-page").value;
assert.equal(page.total_rows, 4);
assert.deepEqual(page.histogram.counts, [0, 0, 0, 2, 2]);
assert.equal(similarity.find((m) => m.type === "similarity-match").reference.title, "MassSpecID0000002");

console.log("smoke test passed");
