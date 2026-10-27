"use strict";
// host/: chemistry (RDKit, WebAssembly) and the session that resolves SMARTS
// filters and structure requests for the dataset viewer.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { BackendProcess, RdkitChemistry, DatasetSession, NO_CHEMISTRY } = require("../../host");
const { BACKEND, skip, tempDir } = require("../backend/helpers");

const ALL = { backend: "rdkit", smarts_filter: true, structure_render: true, structure_count: true };

// RDKit is an optional dependency of host/ (`npm install` in host/).
let rdkitInstalled = true;
try {
  require.resolve("@rdkit/rdkit", { paths: [path.join(__dirname, "../../host")] });
} catch {
  rdkitInstalled = false;
}
const rdkitSkip = rdkitInstalled ? false : "@rdkit/rdkit is not installed (npm install in host/)";

// Stands in for RDKit: a "match" is a substring test.
function fakeChemistry(capabilities = ALL) {
  const calls = [];
  return {
    calls,
    capabilities: Promise.resolve(capabilities),
    async call(type, params) {
      calls.push({ type, ...params });
      if (type === "smarts-match") {
        if (params.pattern === "[invalid") throw new Error("Invalid SMARTS pattern");
        return params.values.map((value) => typeof value === "string" && value.includes(params.pattern));
      }
      if (type === "structure-counts") return { unique_smiles: new Set(params.values).size, canonical_structures: 1 };
      if (type === "render") return { smiles: params.smiles, svg: `<svg>${params.smiles}</svg>` };
      throw new Error(`unknown ${type}`);
    },
  };
}

async function withSession(chemistry, run) {
  const tmp = tempDir();
  const file = tmp.file("structures.tsv",
    "Name\tmy_structure\tSMILES\tPeak\n" +
    "aspirin\tCC(=O)Oc1ccccc1C(=O)O\tCCO\t100,10\n" +
    "ethanol\tCCO\tCCO\t200,20\n" +
    "benzene\tc1ccccc1\t\t300,1\n");
  const backend = new BackendProcess({ executable: BACKEND, mode: "dataset", file, pageSize: 20 });
  const messages = [];
  const waiters = [];
  const session = new DatasetSession(backend, chemistry, (message) => {
    messages.push(message);
    waiters.splice(0).forEach((wake) => wake());
  });
  const next = async (type) => {
    for (;;) {
      const index = messages.findIndex((m) => m.type === type);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise((resolve) => waiters.push(resolve));
    }
  };
  backend.start();
  try {
    await run({ session, next });
  } finally {
    backend.stop();
    tmp.cleanup();
  }
}

test("capabilities follow backend-ready; SMARTS filters become row ids", { skip }, async () => {
  const chemistry = fakeChemistry();
  await withSession(chemistry, async ({ session, next }) => {
    await next("backend-ready");
    assert.deepEqual((await next("capabilities")).chemistry, ALL);
    session.request({ type: "page", filters: [{ column: "my_structure", operator: "smarts", value: "c1ccccc1" }],
      sort: [{ column: "Name", direction: "asc" }] });
    assert.deepEqual((await next("dataset-page")).value.rows.map((r) => r.Name), ["aspirin", "benzene"]);
    assert.deepEqual(chemistry.calls[0].values, ["CC(=O)Oc1ccccc1C(=O)O", "CCO", "c1ccccc1"]);
    // Combined with an ordinary filter; an unknown column is ignored.
    session.request({ type: "page", filters: [
      { column: "my_structure", operator: "smarts", value: "c1ccccc1" },
      { column: "Name", operator: "text_eq", value: "benzene" },
      { column: "Missing", operator: "smarts", value: "C" }] });
    assert.deepEqual((await next("dataset-page")).value.rows.map((r) => r.Name), ["benzene"]);
    session.request({ type: "page", filters: [{ column: "my_structure", operator: "smarts", value: "[invalid" }] });
    const error = await next("filter-error");
    assert.equal(error.operator, "smarts");
    assert.equal(error.message, "Invalid SMARTS pattern");
  });
});

test("structure rendering and counts go through the chemistry provider", { skip }, async () => {
  await withSession(fakeChemistry(), async ({ session, next }) => {
    await next("backend-ready");
    session.request({ type: "render-structure", smiles: "CCO", width: 300, height: 200 });
    assert.deepEqual(await next("structure-rendered"), { type: "structure-rendered", smiles: "CCO", svg: "<svg>CCO</svg>" });
    session.request({ type: "calculate-structure-counts",
      filters: [{ column: "Name", operator: "!=", value: "aspirin" }], structure_smiles_column: "SMILES" });
    const counts = await next("structure-counts");
    assert.equal(counts.total_rows, 2);
    assert.equal(counts.smiles_column, "SMILES");
    session.request({ type: "calculate-structure-counts", structure_smiles_column: "my_structure" });
    assert.equal((await next("structure-counts")).smiles_column, "my_structure");
  });
});

test("without RDKit chemistry requests fail gracefully", { skip }, async () => {
  await withSession(fakeChemistry(NO_CHEMISTRY), async ({ session, next }) => {
    await next("backend-ready");
    assert.deepEqual((await next("capabilities")).chemistry, NO_CHEMISTRY);
    session.request({ type: "page", filters: [{ column: "my_structure", operator: "smarts", value: "C" }] });
    assert.match((await next("filter-error")).message, /requires optional RDKit support/);
    session.request({ type: "render-structure", smiles: "CCO" });
    assert.match((await next("chemistry-error")).message, /requires optional RDKit support/);
    session.request({ type: "calculate-structure-counts" });
    assert.match((await next("structure-counts-error")).message, /requires optional RDKit support/);
    session.request({ type: "export", path: "/nonexistent/x.msds",
      filters: [{ column: "my_structure", operator: "smarts", value: "C" }] });
    assert.match((await next("export-error")).message, /requires optional RDKit support/);
    session.request({ type: "page" });                          // ordinary requests still work
    assert.equal((await next("dataset-page")).value.total_rows, 3);
  });
  await withSession(null, async ({ next }) => {
    await next("backend-ready");
    assert.deepEqual((await next("capabilities")).chemistry, NO_CHEMISTRY);
  });
});

test("RDKit worker: matches, counts, drawing, and errors", { skip: rdkitSkip }, async () => {
  const chemistry = new RdkitChemistry();
  try {
    assert.deepEqual(await chemistry.capabilities, ALL);
    const aspirin = "CC(=O)Oc1ccccc1C(=O)O";
    assert.deepEqual(await chemistry.call("smarts-match",
      { values: [aspirin, "CCO", null, "invalid smiles", aspirin], pattern: "c1ccccc1" }),
    [true, false, false, false, true]);
    assert.deepEqual(await chemistry.call("smarts-match", { values: [aspirin], pattern: "[N+](=O)[O-]" }), [false]);
    await assert.rejects(chemistry.call("smarts-match", { values: [aspirin], pattern: "[invalid" }), /Invalid SMARTS pattern/);
    assert.deepEqual(await chemistry.call("structure-counts",
      { values: ["CCO", " OCC ", "C(C)O", "CCO", "", "invalid smiles"] }),
    { unique_smiles: 4, canonical_structures: 1 });
    const rendered = await chemistry.call("render", { smiles: ` ${aspirin} `, width: 50, height: 5000 });
    assert.equal(rendered.smiles, aspirin);
    assert.match(rendered.svg, /<svg/);
    await assert.rejects(chemistry.call("render", { smiles: "invalid smiles" }), /Invalid SMILES/);
  } finally {
    chemistry.stop();
  }
});

test("RDKit can be switched off; calls then fail cleanly", async () => {
  const chemistry = new RdkitChemistry({ env: { ...process.env, MSENTITY_SPECTRUM_VIEWER_DISABLE_RDKIT: "1" } });
  try {
    assert.deepEqual(await chemistry.capabilities, NO_CHEMISTRY);
    await assert.rejects(chemistry.call("render", { smiles: "CCO" }), /requires optional RDKit support/);
  } finally {
    chemistry.stop();
  }
});

test("SMARTS filter and structure counts end to end with real RDKit", { skip: skip || rdkitSkip }, async () => {
  const chemistry = new RdkitChemistry();
  try {
    await withSession(chemistry, async ({ session, next }) => {
      await next("backend-ready");
      assert.equal((await next("capabilities")).chemistry.smarts_filter, true);
      session.request({ type: "page", filters: [{ column: "my_structure", operator: "smarts", value: "[#6](=O)[#8]" }] });
      assert.deepEqual((await next("dataset-page")).value.rows.map((r) => r.Name), ["aspirin"]);
      session.request({ type: "calculate-structure-counts", structure_smiles_column: "my_structure" });
      const counts = await next("structure-counts");
      assert.deepEqual([counts.unique_smiles, counts.canonical_structures], [3, 3]);
      session.request({ type: "render-structure", smiles: "c1ccccc1" });
      assert.match((await next("structure-rendered")).svg, /<svg/);
    });
  } finally {
    chemistry.stop();
  }
});
