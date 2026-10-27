const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../../ui/spectrum.js"), "utf8");
const start = source.indexOf("  const tablePeaks =");
const end = source.indexOf("  const matchSpectrumPeaks", start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({ state: { sortKey: "intensity", sortAscending: false } });
vm.runInContext(source.slice(start, end) + "\nthis.exportPeaks = peaksAsDelimited; this.alignPeakRows = alignPeakRows; this.tablePeaks = tablePeaks;", context);

for (const [format, separator] of [["csv", ","], ["tsv", "\t"]]) {
  test(`peak ${format} retains zero/negative peaks and follows table sorting`, () => {
    const actual = context.exportPeaks([100, 200, 300, NaN], [0, -2, 10, 5], format);
    assert.equal(actual, [
      ["m/z", "Intensity"], [300, 10], [100, 0], [200, -2],
    ].map(row => row.join(separator)).join("\n") + "\n");
  });
}

test("comparison peaks align within tolerance and retain both ascending orders", () => {
  const upper = context.tablePeaks([140, 100, 130, 110], [14, 10, 13, 11]);
  const lower = context.tablePeaks([150, 130.04, 99.98, 120], [25, 23, 20, 22]);
  const rows = context.alignPeakRows(upper, lower, 0.05, true);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((row) => [row.upper?.x ?? null, row.lower?.x ?? null]))), [
    [100, 99.98], [110, null], [null, 120], [130, 130.04], [140, null], [null, 150]
  ]);
  assert.deepEqual(Array.from(rows.flatMap((row) => row.upper ? [row.upper.x] : [])), [100, 110, 130, 140]);
  assert.deepEqual(Array.from(rows.flatMap((row) => row.lower ? [row.lower.x] : [])), [99.98, 120, 130.04, 150]);
});

test("comparison peak descending order reverses aligned rows without changing pairs", () => {
  const upper = context.tablePeaks([100, 110, 130], [10, 11, 13]);
  const lower = context.tablePeaks([99.98, 120, 130.05], [20, 22, 23]);
  const rows = context.alignPeakRows(upper, lower, 0.05, false);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((row) => [row.upper?.x ?? null, row.lower?.x ?? null]))), [
    [130, 130.05], [null, 120], [110, null], [100, 99.98]
  ]);
});

test("comparison export includes both spectra and empty unmatched cells", () => {
  context.state = { sortKey: "mz", sortAscending: true };
  const actual = context.exportPeaks([100, 110], [10, 11], "tsv", [100.03, 120], [20, 22], 0.05);
  assert.equal(actual, [
    "Upper m/z\tUpper Intensity\tLower m/z\tLower Intensity",
    "100\t10\t100.03\t20",
    "110\t11\t\t",
    "\t\t120\t22",
    ""
  ].join("\n"));
});

test("annotation export follows peak sorting and quotes CSV text", () => {
  context.state = { sortKey: "mz", sortAscending: true };
  const annotations = { metadata_columns: ["Note"], metadata: [{ Note: 'b,"quoted"' }, { Note: "a" }] };
  assert.equal(context.exportPeaks([200, 100], [20, 10], "csv", null, null, 0, annotations),
    'm/z,Intensity,Note\n100,10,a\n200,20,"b,""quoted"""\n');
});

test("comparison annotation export keeps unmatched annotation cells empty", () => {
  context.state = { sortKey: "mz", sortAscending: true };
  const annotations = { metadata_columns: ["Note"], metadata: [{ Note: "upper" }] };
  const lower = { metadata_columns: ["Label"], metadata: [{ Label: "lower" }] };
  assert.equal(context.exportPeaks([100], [10], "tsv", [200], [20], 0.05, annotations, lower),
    "Upper m/z\tUpper Intensity\tUpper Note\tLower m/z\tLower Intensity\tLower Label\n100\t10\tupper\t\t\t\n\t\t\t200\t20\tlower\n");
});

test("peak export respects hidden and reordered columns", () => {
  const annotations = { metadata_columns: ["Note"], metadata: [{ Note: "fragment" }] };
  assert.equal(context.exportPeaks([100], [10], "tsv", null, null, 0, annotations, null, ["meta:Note", "mz"]),
    "m/z\tIntensity\tNote\n100\t10\tfragment\n");
});
