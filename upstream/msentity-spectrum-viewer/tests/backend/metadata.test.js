"use strict";
// Metadata editing, export, and dataset removal.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const { ROOT, skip, runBackend, tempDir, ofType } = require("./helpers");

test("edit, export, remove, and re-add", { skip }, () => {
  const tmp = tempDir();
  try {
    const source = tmp.file("source.tsv", "Name\tMass\tPeak\na\t100\t100,10\nb\t200\t200,20\n");
    const other = tmp.file("other.tsv", "Name\tPeak\nother\t50,5\n");
    const output = tmp.file("edited.msds");
    const messages = runBackend("dataset", source, [
      { type: "add-dataset", path: other },
      { type: "update-metadata", dataset_id: other, description: "説明", attributes: { "測定": "test" }, tags: ["確認済み"] },
      { type: "page", dataset_id: other },
      { type: "export", dataset_id: other, path: output, file_type: "msds" },
      { type: "page", sort: [{ column: "Mass", direction: "desc" }] },
      { type: "update-cell", row_id: 1, column: "Name", value: "changed" },
      { type: "update-cell", row_id: 1, column: "Mass", value: "201.5" },
      { type: "update-metadata", description: "bad", attributes: { a: 1 }, tags: [] },
      { type: "page" },
      { type: "remove-dataset" },
      { type: "remove-dataset", dataset_id: other },
      { type: "similarity-options" },
      { type: "add-dataset", path: other },
      { type: "add-dataset", path: output },
    ], ["--file-type", "tsv"]);
    assert.deepEqual(ofType(messages, "error"), []);
    assert.equal(ofType(messages, "edit-error").length, 1);
    const pages = ofType(messages, "dataset-page").map((m) => m.value);
    assert.deepEqual(ofType(messages, "metadata-updated")[0].metadata,
      { description: "説明", attributes: { "測定": "test" }, tags: ["確認済み"] });
    assert.equal(pages[1].description, "説明");
    assert.deepEqual(pages[2].row_ids, [1, 0]);                  // Mass "200" > "100"
    assert.equal(pages[3].rows[0].Name, "a");
    assert.equal(pages[3].rows[1].Name, "changed");
    assert.equal(pages[3].rows[1].Mass, "201.5");                // TSV text stays text
    assert.equal(pages[3].description, "");
    assert.equal(pages[4].description, "");
    assert.equal(pages[5].description, "説明");                   // the exported .msds
    assert.deepEqual(pages[5].attributes, { "測定": "test" });
    assert.deepEqual(pages[5].tags, ["確認済み"]);
    assert.equal(ofType(messages, "similarity-options")[0].datasets.length, 0);
    assert.deepEqual(ofType(messages, "dataset-removed").map((m) => m.dataset_id), [source, other]);
    assert.ok(!fs.readFileSync(source, "utf8").includes("changed"));
  } finally {
    tmp.cleanup();
  }
});

test("typed cells keep their type", { skip }, () => {
  // tests/data/typed.msds: Name (text), Count (int64: 1, 2), Mass (float64: 1.5, null)
  const source = path.join(ROOT, "tests", "data", "typed.msds");
  const messages = runBackend("dataset", source, [
    { type: "update-cell", row_id: 0, column: "Count", value: "7" },
    { type: "update-cell", row_id: 1, column: "Count", value: "2.5" },
    { type: "update-cell", row_id: 0, column: "Mass", value: "2.25" },
    { type: "update-cell", row_id: 0, column: "Mass", value: "nan" },
    { type: "update-cell", row_id: 0, column: "Mass", value: "abc" },
    { type: "update-cell", row_id: 1, column: "Mass", value: "text" },
    { type: "update-cell", row_id: 0, column: "Name", value: "renamed" },
    { type: "update-cell", row_id: 5, column: "Name", value: "x" },
    { type: "update-cell", row_id: 0, column: "Missing", value: "x" },
    { type: "page" },
  ]);
  const errors = ofType(messages, "edit-error").map((m) => m.message);
  assert.deepEqual(errors, ["Enter a finite number", "could not convert string to float: 'abc'",
    "Unknown spectrum", "Unknown metadata column"]);
  const rows = ofType(messages, "dataset-page")[0].value.rows;
  // A column holds one type: text in a missing Mass cell turns the column into text.
  assert.deepEqual(rows.map((r) => [r.Name, r.Count, r.Mass]), [["renamed", 7, "2.25"], ["b", 2.5, "text"]]);
});
