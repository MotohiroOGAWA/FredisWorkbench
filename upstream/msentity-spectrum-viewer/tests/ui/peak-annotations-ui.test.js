const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../../ui/spectrum.js"), "utf8");

test("peak column form targets lower dataset and refresh updates pinned spectra", () => {
  const posted = [], elements = new Map();
  let listener;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", innerHTML: "", hidden: true, setAttribute() {} });
    return elements.get(id);
  };
  vm.runInNewContext(source, {
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message), getState: () => ({}) }),
    document: { getElementById: id => id === "plot-root" ? null : element(id), querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener: (_, handler) => { listener = handler; } }
  });
  const send = data => listener({ data });
  const payload = (id, column) => ({
    datasetId: id, rowId: 0,
    spectrum: { mz: [100], intensity: [10], metadata_columns: [column], metadata: [{ [column]: "existing" }] }
  });
  send({ type: "spectrum-comparison", top: payload("a", "Formula"), bottom: payload("b", "Label") });
  assert.doesNotMatch(element("spectrum-app").innerHTML, /data-toggle-peak-column="(?:mz|intensity)"/);
  assert.match(element("spectrum-app").innerHTML, /<th>Formula<\/th>/);
  assert.match(element("spectrum-app").innerHTML, /<th>Label<\/th>/);
  assert.match(element("spectrum-app").innerHTML, /colspan="3">Upper/);
  element("peak-columns").onclick();
  assert.equal(element("peak-column-menu").hidden, false);
  assert.equal(element("add-peak-column-form").hidden, true);
  element("add-peak-column-toggle").onclick();
  assert.equal(element("add-peak-column-form").hidden, false);
  element("peak-column-side").value = "bottom";
  element("peak-column-side").onchange();
  element("new-peak-column-name").value = "Note";
  element("add-peak-column-form").onsubmit({ preventDefault() {} });
  assert.equal(posted.at(-1).type, "add-peak-column");
  assert.equal(posted.at(-1).datasetId, "b");
  assert.equal(posted.at(-1).value, "");
  send({ type: "peak-columns-updated", dataset_id: "b" });
  assert.equal(posted.at(-1).type, "get-peak-record");
  assert.equal(posted.at(-1).datasetId, "b");
  send({ type: "peak-record", dataset_id: "b", row_id: 0, spectrum: {
    mz: [100], intensity: [10], metadata_columns: ["Label", "Note"], metadata: [{ Label: "existing", Note: "" }]
  } });
  assert.match(element("spectrum-app").innerHTML, /<th>Note<\/th>/);
  assert.match(element("spectrum-app").innerHTML, /colspan="4">Lower/);
});

test("annotation cells escape text and retain original peak index", () => {
  const start = source.indexOf("  const esc =");
  const end = source.indexOf("  const metadataPanel");
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end) + "\nthis.cells = peakAnnotationCells;", context);
  const payload = { datasetId: "a", rowId: 3, spectrum: {
    metadata_columns: ["Note"], metadata: [{ Note: "first" }, { Note: "<fragment>" }]
  } };
  assert.match(context.cells(payload, 1, "top"), /&lt;fragment&gt;/);
  assert.match(context.cells(payload, 1, "top"), /data-annotation-peak="1"/);
  assert.equal(context.cells(payload, undefined, "bottom"), "<td ></td>");
});

test("column visibility and order persist per dataset and map annotation edits correctly", () => {
  const start = source.indexOf("  const esc =");
  const end = source.indexOf("  const metadataPanel");
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end) + "\nthis.visible = visiblePeakColumns; this.toggle = togglePeakColumn; this.move = movePeakColumn; this.cells = peakTableCells;", context);
  const first = { datasetId: "a", rowId: 0, spectrum: {
    metadata_columns: ["Formula", "Note"], metadata: [{ Formula: "C2H4", Note: "fragment" }]
  } };
  const second = { datasetId: "b", rowId: 0, spectrum: first.spectrum };
  context.toggle(first, "mz");
  context.move(first, "meta:Note", -1);
  context.move(first, "meta:Note", -1);
  assert.deepEqual(Array.from(context.visible(first)), ["meta:Note", "meta:Formula"]);
  assert.deepEqual(Array.from(context.visible(second)), ["meta:Formula", "meta:Note"]);
  const html = context.cells(first, { index: 0, x: 100, y: 10 }, "top");
  assert.ok(html.indexOf("fragment") < html.indexOf("C2H4"));
  assert.match(html, /data-annotation-column="1"/);
  assert.match(html, /100.00000/);
  assert.ok(html.indexOf("100.00000") < html.indexOf("fragment"));
  // Another spectrum in the same dataset reuses the selection; new columns appear.
  const next = { ...first, rowId: 1, spectrum: { ...first.spectrum, metadata_columns: ["Formula", "Note", "New"] } };
  assert.deepEqual(Array.from(context.visible(next)), ["meta:Note", "meta:Formula", "meta:New"]);
  for (const id of Array.from(context.visible(next))) context.toggle(next, id);
  assert.deepEqual(Array.from(context.visible(next)), []);
  assert.equal((context.cells(next, { index: 0, x: 100, y: 10 }, "top").match(/<td>/g) || []).length, 2);
});
