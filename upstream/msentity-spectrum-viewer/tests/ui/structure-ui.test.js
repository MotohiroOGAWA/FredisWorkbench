const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("chemistry capabilities control Structure and SMARTS UI", () => {
  const elements = new Map();
  const posted = [];
  let onMessage;
  const app = { dataset: { filename: "sample.msp" }, innerHTML: "" };
  const structureButton = { dataset: { structureIndex: "0" }, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, value: "", setAttribute() {}, focus() {}, handlers: {},
      addEventListener(name, handler) { this.handlers[name] = handler; }
    });
    return elements.get(id);
  };
  const document = {
    getElementById: id => id === "app" ? app : element(id),
    querySelector: () => null,
    querySelectorAll: selector => selector === "[data-structure-index]" ? [structureButton] : [],
    addEventListener() {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../ui/viewer.js"), "utf8"), {
    Blob, URL, document,
    window: { addEventListener: (_, handler) => { onMessage = handler; } },
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) })
  });
  const send = data => onMessage({ data });
  const datasetPage = () => send({ type: "dataset-page", value: {
    dataset_id: "dataset", columns: ["Name", "SMILES"], all_columns: ["Name", "SMILES"],
    rows: [{ Name: "aspirin", SMILES: "CC(=O)Oc1ccccc1C(=O)O" }], row_ids: [0],
    structure_smiles_column: "SMILES", total_rows: 1, total_pages: 1, attributes: {}, tags: []
  } });

  send({ type: "backend-ready", dataset: { id: "dataset", name: "sample.msp" } });
  send({ type: "capabilities", chemistry: { backend: null, smarts_filter: false, structure_render: false } });
  datasetPage();
  assert.doesNotMatch(app.innerHTML, /Structure<\/th>/);
  assert.doesNotMatch(app.innerHTML, /structure-column/);
  assert.doesNotMatch(app.innerHTML, /class="structure-button"/);
  assert.doesNotMatch(app.innerHTML, /SMARTS substructure/);

  send({ type: "capabilities", chemistry: { backend: "rdkit", smarts_filter: true, structure_render: true } });
  assert.ok(app.innerHTML.indexOf("Spectrum</th>") < app.innerHTML.indexOf("Structure</th>"));
  assert.ok(app.innerHTML.indexOf("Structure</th>") < app.innerHTML.indexOf(">Name<"));
  assert.match(app.innerHTML, /class="structure-button"[^>]*>[\s\S]*?<svg viewBox="0 0 28 24"/);
  assert.match(app.innerHTML, /M14 3 21\.8 7\.5v9L14 21l-7\.8-4\.5v-9Z/);
  const nodes = app.innerHTML.match(/class="structure-nodes">([\s\S]*?)<\/g>/)[1];
  assert.equal((nodes.match(/<circle /g) || []).length, 6);
  assert.ok(app.innerHTML.indexOf('class="structure-edges"') < app.innerHTML.indexOf('class="structure-nodes"'));
  structureButton.handlers.click();
  assert.equal(posted.at(-1).type, "render-structure");
  assert.equal(posted.at(-1).smiles, "CC(=O)Oc1ccccc1C(=O)O");

  element("filter-button").handlers.click({ stopPropagation() {} });
  element("add-filter").handlers.click();
  assert.match(app.innerHTML, /value="smarts"[^>]*>SMARTS substructure/);
  element("export-button").handlers.click();
  assert.deepEqual(Array.from(posted.at(-1).columns), ["Name", "SMILES"]);
  assert.equal(posted.at(-1).columns.includes("Structure"), false);
  element("settings-button").handlers.click();
  assert.equal(posted.at(-1).type, "open-settings");
});
