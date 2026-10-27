"use strict";
// Column creation, peak annotations, peak filters, and MSDS round trip.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { skip, runBackend, tempDir, ofType } = require("./helpers");

test("columns, peak edits, peak filters, and MSDS round trip", { skip }, () => {
  const tmp = tempDir();
  try {
    const source = tmp.file("source.tsv", "Name\tPrecursorMZ\tPeak\na\t250\t200,20;100,10\nb\t100\t50,5\n");
    const other = tmp.file("other.tsv", "Name\tPeak\nother\t70,7\n");
    const output = tmp.file("edited.msds");
    const messages = runBackend("dataset", source, [
      { type: "add-dataset", path: other },
      { type: "add-column", column: "Note" },
      { type: "add-column", column: "Group", value: "sample" },
      { type: "add-column", column: "Note", value: "overwrite" },
      { type: "add-column", column: "  " },
      { type: "add-peak-column", column: "Annotation" },
      { type: "add-peak-column", column: "Quality", value: "unchecked" },
      { type: "add-peak-column", column: "mz" },
      { type: "update-peak-cell", row_id: 0, peak_index: 1, column: "Annotation", value: "fragment <A>" },
      { type: "get-peak-record", row_id: 0 },
      { type: "page", filters: [{ column: "Name", operator: "text_eq", value: "b" }] },
      { type: "page", filters: [{ operator: "spectrum_peak", mz: 100, tolerance: 0.1, tolerance_unit: "Da", intensity: 0.5 }] },
      { type: "page", filters: [{ operator: "neutral_loss", mz: 150, tolerance: 2000, tolerance_unit: "ppm", intensity: 0.5 }] },
      { type: "page", dataset_id: other },
      { type: "export", path: output, file_type: "msds" },
      { type: "add-dataset", path: output },
      { type: "update-peak-cell", row_id: 0, peak_index: 99, column: "Annotation", value: "invalid" },
    ]);
    assert.deepEqual(messages.filter((m) => ["error", "export-error"].includes(m.type)), []);
    assert.equal(ofType(messages, "edit-error").length, 4);
    const records = ofType(messages, "peak-record");
    assert.equal(records[0].spectrum.metadata[1].Annotation, "fragment <A>");
    assert.equal(records[0].spectrum.metadata[0].Annotation, "");
    const pages = ofType(messages, "dataset-page").map((m) => m.value);
    assert.equal(pages[1].rows[0].Note, "");
    assert.equal(pages[1].rows[0].Group, "sample");
    assert.equal(pages[1].spectra[0].metadata[0].Quality, "unchecked");
    assert.deepEqual(pages[2].rows.map((r) => r.Name), ["a"]);   // peak at 100 with ≥ 50 %
    assert.deepEqual(pages[3].rows.map((r) => r.Name), ["a"]);   // loss 250 - 100 = 150
    assert.ok(!pages[4].columns.includes("Note"));               // other dataset unchanged
    assert.deepEqual(pages[4].spectra[0].metadata_columns, []);
    assert.equal(pages[5].spectra[0].metadata[1].Annotation, "fragment <A>");
    assert.equal(pages[5].spectra[1].metadata[0].Annotation, "");
    assert.equal(pages[5].rows[1].Group, "sample");
  } finally {
    tmp.cleanup();
  }
});
