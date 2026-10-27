"use strict";
// Export of the filtered, sorted, column-ordered view (CSV) and reading it back.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { skip, runBackend, tempDir, ofType } = require("./helpers");

test("export uses the view and reports progress", { skip }, () => {
  const tmp = tempDir();
  try {
    const source = tmp.file("source.csv", 'Name,Score,Peak\n"a,b",2,"100,10"\nc,1,"200,20"\nd,0,\n');
    const output = tmp.file("output.csv");
    const messages = runBackend("dataset", source, [
      { type: "export", path: output, file_type: "csv",
        filters: [{ column: "Name", operator: "!=", value: "d" }],
        sort: [{ column: "Score", direction: "asc" }], columns: ["Score", "Name"] },
      { type: "add-dataset", path: output },
    ], ["--file-type", "csv"]);
    assert.deepEqual(messages.filter((m) => m.type.endsWith("error")), []);
    const progress = ofType(messages, "export-progress");
    assert.equal(progress[0].percent, 0);
    assert.equal(progress.at(-1).percent, 100);
    assert.equal(ofType(messages, "export-complete")[0].total_rows, 2);
    const reread = ofType(messages, "dataset-page")[0].value;
    assert.deepEqual(reread.columns, ["Score", "Name"]);
    assert.deepEqual(reread.rows.map((r) => r.Name), ["c", "a,b"]);
    assert.match(fs.readFileSync(output, "utf8"), /^Score,Name,Peak\n/);
  } finally {
    tmp.cleanup();
  }
});

test("export to every format", { skip }, () => {
  const tmp = tempDir();
  try {
    const source = tmp.file("source.tsv", "Name\tPeak\na\t100,10;150,5\nb\t200,20\n");
    const requests = ["msds", "msp", "mgf", "tsv", "csv"].map((format) => (
      { type: "export", path: tmp.file(`out.${format}`), file_type: format }));
    requests.push({ type: "export", path: tmp.file("out.txt"), file_type: "txt" });
    const messages = runBackend("dataset", source, requests);
    assert.equal(ofType(messages, "export-complete").length, 5);
    assert.match(ofType(messages, "export-error")[0].message, /msds, msp, mgf, tsv, or csv/);
    for (const format of ["msp", "mgf", "msds"]) {
      const back = runBackend("dataset", tmp.file(`out.${format}`), [{ type: "page" }]);
      assert.equal(ofType(back, "dataset-page")[0].value.total_rows, 2, format);
    }
  } finally {
    tmp.cleanup();
  }
});
