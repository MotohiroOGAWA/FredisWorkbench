"use strict";
// SpecID assignment through the protocol.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { skip, runBackend, tempDir, ofType } = require("./helpers");

test("assignment, overwrite, dataset scope, and export", { skip }, () => {
  const tmp = tempDir();
  try {
    const rows = Array.from({ length: 12 }, (_, i) => `row${i}\t100,10\n`).join("");
    const source = tmp.file("source.tsv", `Name\tPeak\n${rows}`);
    const other = tmp.file("other.tsv", "Name\tPeak\nother\t200,20\n");
    const output = tmp.file("export.tsv");
    const messages = runBackend("dataset", source, [
      { type: "add-dataset", path: other },
      { type: "assign-spec-id", prefix: "SP" },
      { type: "page", page: 1 },
      { type: "assign-spec-id", prefix: "BAD" },
      { type: "page" },
      { type: "assign-spec-id", prefix: "試料_", overwrite: true },
      { type: "page", filters: [{ column: "Name", operator: "text_eq", value: "row11" }] },
      { type: "page", dataset_id: other },
      { type: "export", path: output, file_type: "tsv" },
      { type: "assign-spec-id", prefix: "", overwrite: true },
      { type: "page" },
      { type: "assign-spec-id", prefix: 123 },
      { type: "assign-spec-id", dataset_id: "missing" },
    ], ["--page-size", "5"]);
    assert.deepEqual(ofType(messages, "error"), []);
    assert.equal(ofType(messages, "spec-id-complete").length, 3);
    assert.equal(ofType(messages, "spec-id-error").length, 3);
    const pages = ofType(messages, "dataset-page").map((m) => m.value);
    assert.equal(pages[1].rows[0].SpecID, "SP06");
    assert.equal(pages[2].rows[0].SpecID, "SP01");
    assert.equal(pages[3].rows[0].SpecID, "試料_12");
    assert.ok(!pages[4].columns.includes("SpecID"));
    assert.equal(pages[5].rows[0].SpecID, "01");
    assert.match(fs.readFileSync(output, "utf8"), /SpecID/);
    assert.match(fs.readFileSync(output, "utf8"), /試料_12/);
    assert.ok(!fs.readFileSync(source, "utf8").includes("SpecID"));
  } finally {
    tmp.cleanup();
  }
});
