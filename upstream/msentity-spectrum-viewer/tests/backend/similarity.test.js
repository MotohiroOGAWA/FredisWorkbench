"use strict";
// Similarity calculation from the dataset viewer and the .mssim result viewer.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { skip, runBackend, tempDir, ofType } = require("./helpers");

const resultPage = (file, requests) => runBackend("similarity", file, requests, ["--page-size", "1"]);

test("library search with a loaded and a file reference", { skip }, () => {
  const tmp = tempDir();
  try {
    const query = tmp.file("query.tsv", "Name\tPeak\nq-noisy\t100,1;300,10\nq-exact\t200,1\n");
    const reference = tmp.file("reference.tsv", "Name\tPeak\nr-100\t100,1\nr-200\t200,1\nr-other\t400,1\n");
    const loadedOutput = tmp.file("loaded.mssim");
    const fileOutput = tmp.file("file.mssim");
    const messages = runBackend("dataset", query, [
      { type: "add-dataset", path: reference },
      { type: "calculate-similarity", mode: "library_search", dataset1: query, dataset2: reference,
        path: loadedOutput, parameters: { threshold: 0.8 } },
      { type: "calculate-similarity", mode: "library_search", dataset1: query, reference_path: reference,
        path: fileOutput, parameters: { threshold: 0.8, method: "reverse_cosine", include_matched_data: false } },
    ]);
    assert.deepEqual(ofType(messages, "similarity-error"), []);
    const complete = ofType(messages, "similarity-complete");
    assert.equal(complete.length, 2);
    assert.equal(complete[0].candidate_pairs, 6);
    assert.equal(ofType(messages, "similarity-progress").at(-1).percent, 100);

    const viewer = resultPage(loadedOutput, [{ type: "page" }, { type: "match", row: 0 }]);
    const page = ofType(viewer, "similarity-page")[0].value;
    assert.equal(page.has_matched_data, true);
    assert.deepEqual(page.matched_data_rows, [1, 1]);
    assert.deepEqual([page.rows[0].index1, page.rows[0].index2], [1, 1]);
    const match = ofType(viewer, "similarity-match")[0];
    assert.equal(match.query.row.Name, "q-exact");
    assert.equal(match.reference.row.Name, "r-200");
    assert.equal(match.query.datasetName, "query.tsv");
    assert.equal(match.reference.globalIndex, 1);
    assert.deepEqual(match.reference.spectrum.mz, [200]);
    assert.equal(match.method, "cosine");

    const reverse = resultPage(fileOutput, [{ type: "page", page: 1 }, { type: "match", row: 0 }]);
    const reversePage = ofType(reverse, "similarity-page")[0].value;
    assert.equal(reversePage.has_matched_data, false);
    assert.equal(reversePage.total_rows, 2);                  // (0, 0) and (1, 1)
    assert.deepEqual([reversePage.rows[0].index1, reversePage.rows[0].index2], [1, 1]);
    assert.match(ofType(reverse, "error")[0].message, /does not contain matched data/);
  } finally {
    tmp.cleanup();
  }
});

test("key matching, result filters, histogram, and export", { skip }, () => {
  const tmp = tempDir();
  try {
    const first = tmp.file("first.tsv", "SpecID\tPeak\na\t100,4;101,1\nb\t200,1\n");
    const second = tmp.file("second.tsv", "OtherID\tPeak\nb\t300,1\na\t100,1\n");
    const third = tmp.file("third.tsv", "SpecID\tPeak\nduplicate\t100,1\nduplicate\t101,1\n");
    const output = tmp.file("result.mssim");
    const messages = runBackend("dataset", first, [
      { type: "add-dataset", path: second },
      { type: "add-dataset", path: third },
      { type: "similarity-options" },
      { type: "calculate-similarity", dataset1: first, dataset2: second, path: output,
        parameters: { key2: "OtherID", intensity_exponent: 0.5 } },
      { type: "calculate-similarity", dataset1: first, dataset2: third, path: output },
      { type: "calculate-similarity", dataset1: first, dataset2: first, path: output },
      { type: "calculate-similarity", dataset1: first, dataset2: second, path: first },
      { type: "calculate-similarity", dataset1: first, dataset2: second, path: output, parameters: { bogus: 1 } },
    ]);
    assert.deepEqual(ofType(messages, "error"), []);
    const choices = ofType(messages, "similarity-options")[0].datasets;
    assert.equal(choices.length, 3);
    assert.ok(choices[1].columns.includes("OtherID"));
    assert.equal(ofType(messages, "similarity-complete").length, 1);
    const failures = ofType(messages, "similarity-error").map((m) => m.message);
    assert.equal(failures.length, 4);
    assert.match(failures[0], /one-to-one/);
    assert.match(failures[1], /two different datasets/);
    assert.match(failures[2], /must not overwrite an input/);
    assert.match(failures[3], /Unknown similarity parameter: bogus/);

    const filters = [{ column: "cosine_similarity", operator: ">=", value: "0.8" }];
    const subset = tmp.file("subset.mssim");
    const tsv = tmp.file("subset.tsv");
    const parquet = tmp.file("subset.parquet");
    const viewer = resultPage(output, [
      { type: "page", bins: 2 },
      { type: "page", page: 1, bins: 2 },
      { type: "page", filters, bins: 2 },
      ...[subset, tsv, parquet].map((path) => ({ type: "export", filters, path })),
      { type: "reload", sort: { column: "cosine_similarity", direction: "asc" } },
      { type: "page", filters: [{ column: "SpecID", operator: "text_eq", value: "none" }] },
      { type: "page", bins: 0 },
      { type: "page", filters: [{ column: "cosine_similarity", operator: ">", value: "bad" }] },
      { type: "page" },
    ]);
    const pages = ofType(viewer, "similarity-page").map((m) => m.value);
    assert.deepEqual(pages[0].histogram.counts, [1, 1]);     // the whole table, not one page
    assert.ok(Math.abs(pages[0].statistics.q1 - 0.2236068) < 1e-6);
    assert.ok(Math.abs(pages[0].statistics.q3 - 0.6708204) < 1e-6);
    assert.equal(pages[0].rows[0].SpecID, "a");
    assert.ok(Math.abs(pages[0].rows[0].cosine_similarity - 2 / Math.sqrt(5)) < 1e-6);
    assert.equal(pages[1].rows[0].SpecID, "b");
    assert.deepEqual(pages[2].histogram.counts, [0, 1]);
    assert.equal(pages[3].rows[0].SpecID, "b");               // reload, ascending
    assert.equal(pages[4].total_rows, 0);
    assert.equal(pages[4].statistics.mean, null);
    assert.equal(pages[5].total_rows, 2);                     // recovers after request errors
    assert.equal(ofType(viewer, "error").length, 2);
    assert.equal(ofType(viewer, "export-complete").length, 3);

    const exported = resultPage(subset, [{ type: "page" }]);
    const exportedPage = ofType(exported, "similarity-page")[0].value;
    assert.deepEqual(exportedPage.rows.map((r) => r.SpecID), ["a"]);
    assert.deepEqual(exportedPage.metadata.export_view.filters, filters);
    assert.equal(exportedPage.metadata.export_view.source_rows, 2);
    assert.match(fs.readFileSync(tsv, "utf8"), /^SpecID\tOtherID\tindex1\tindex2\tcosine_similarity\na\ta\t0\t1\t/);
    assert.equal(fs.readFileSync(parquet).subarray(0, 4).toString(), "PAR1");
  } finally {
    tmp.cleanup();
  }
});

test("sorted export keeps the view order and embedded spectra", { skip }, () => {
  const tmp = tempDir();
  try {
    const query = tmp.file("q.tsv", "Name\tPeak\nq0\t100,1;200,1\nq1\t100,1\n");
    const output = tmp.file("all.mssim");
    runBackend("dataset", query, [{ type: "calculate-similarity", mode: "library_search",
      dataset1: query, reference_path: query, path: output, parameters: { threshold: 0 } }]);
    const sorted = tmp.file("sorted.mssim");
    const viewer = resultPage(output, [{ type: "export", path: sorted,
      sort: { column: "cosine_similarity", direction: "asc" },
      filters: [{ column: "index1", operator: "numeric_eq", value: "0" }] }]);
    assert.equal(ofType(viewer, "export-complete")[0].total_rows, 2);
    const back = resultPage(sorted, [{ type: "page" }, { type: "page", page: 1 }, { type: "match", row: 0 }]);
    const rows = ofType(back, "similarity-page").map((m) => m.value.rows[0]);
    assert.deepEqual(rows.map((r) => r.index2), [1, 0]);     // 0.707 before 1.0
    assert.equal(ofType(back, "similarity-match")[0].reference.row.Name, "q1");
  } finally {
    tmp.cleanup();
  }
});

test("histogram includes 1.0 and the viewer does not need the sources", { skip }, () => {
  const tmp = tempDir();
  try {
    const first = tmp.file("a.tsv", "SpecID\tPeak\na\t100,1\nb\t200,1\n");
    const second = tmp.file("b.tsv", "SpecID\tPeak\na\t100,1\nb\t300,1\n");
    const output = tmp.file("standalone.mssim");
    runBackend("dataset", first, [{ type: "add-dataset", path: second },
      { type: "calculate-similarity", dataset1: first, dataset2: second, path: output }]);
    fs.rmSync(first);
    fs.rmSync(second);
    const viewer = resultPage(output, [{ type: "page", bins: 2 }]);
    assert.deepEqual(ofType(viewer, "similarity-page")[0].value.histogram.counts, [1, 1]);
  } finally {
    tmp.cleanup();
  }
});
