"use strict";
// Repeated imports have independent identities, edits, and display names.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const { skip, interactive, tempDir } = require("./helpers");

test("independent imports and unique names", { skip }, async () => {
  const tmp = tempDir();
  const source = tmp.file("sample.tsv", "Name\tPeak\noriginal\t100,10\n");
  const other = tmp.file("other/sample.tsv", "Name\tPeak\nother\t200,20\n");
  const backend = interactive("dataset", source);
  const { next, send } = backend;
  try {
    const originalId = (await next("backend-ready")).dataset.id;
    assert.equal(originalId, source);
    send({ type: "update-cell", dataset_id: originalId, row_id: 0, column: "Name", value: "edited" });
    await next("metadata-updated");
    send({ type: "add-dataset", path: source });
    const duplicate = (await next("dataset-added")).dataset;
    assert.notEqual(duplicate.id, originalId);
    assert.equal(duplicate.path, source);
    assert.equal(duplicate.name, "sample (1).tsv");
    const duplicatePage = (await next("dataset-page")).value;
    assert.equal(duplicatePage.rows[0].Name, "original");
    assert.equal(duplicatePage.dataset_name, duplicate.name);
    send({ type: "update-cell", dataset_id: duplicate.id, row_id: 0, column: "Name", value: "duplicate edited" });
    await next("metadata-updated");
    send({ type: "page", dataset_id: originalId });
    assert.equal((await next("dataset-page")).value.rows[0].Name, "edited");
    send({ type: "add-dataset", path: other });
    assert.equal((await next("dataset-added")).dataset.name, "sample (2).tsv");
    assert.equal((await next("dataset-page")).value.rows[0].Name, "other");
    // A later addition reads the current on-disk contents again.
    fs.writeFileSync(source, "Name\tPeak\non disk changed\t100,10\n");
    send({ type: "add-dataset", path: source });
    assert.equal((await next("dataset-added")).dataset.name, "sample (3).tsv");
    assert.equal((await next("dataset-page")).value.rows[0].Name, "on disk changed");
    send({ type: "similarity-options", dataset_id: duplicate.id });
    const names = (await next("similarity-options")).datasets.map((d) => d.name);
    assert.equal(new Set(names).size, 4);
    send({ type: "reload", dataset_id: duplicate.id });
    await next("dataset-reloaded");
    const reloaded = (await next("dataset-page")).value;
    assert.equal(reloaded.dataset_name, duplicate.name);
    assert.equal(reloaded.rows[0].Name, "on disk changed");
    send({ type: "remove-dataset", dataset_id: originalId });
    await next("dataset-removed");
    send({ type: "add-dataset", path: source });
    const replacement = (await next("dataset-added")).dataset;
    assert.notEqual(replacement.id, originalId);
    assert.equal(replacement.name, "sample.tsv");
    await next("dataset-page");
    send({ type: "page", dataset_id: duplicate.id });
    assert.equal((await next("dataset-page")).value.dataset_name, "sample (1).tsv");
  } finally {
    await backend.close();
    tmp.cleanup();
  }
});
