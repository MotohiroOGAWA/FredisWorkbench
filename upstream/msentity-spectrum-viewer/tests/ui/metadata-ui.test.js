const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const test = require("node:test");

test("metadata form sends edits and dataset removal restores original selection", () => {
  const elements = new Map();
  const posted = [];
  let onMessage;
  const app = { dataset: {}, innerHTML: "" };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, setAttribute() {}, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; }
    });
    return elements.get(id);
  };
  const document = {
    getElementById: id => id === "app" ? app : element(id),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../ui/viewer.js"), "utf8"), {
    document, window: { addEventListener: (_, handler) => { onMessage = handler; } },
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) })
  });
  const send = data => onMessage({ data });
  const page = id => send({ type: "dataset-page", value: {
    dataset_id: id, columns: ["Name"], rows: [{ Name: "sample" }], row_ids: [0],
    description: "<safe>", attributes: {}, tags: ["tag"], total_pages: 1
  } });
  send({ type: "backend-ready", dataset: { id: "original", name: "original" } });
  page("original");
  assert.doesNotMatch(app.innerHTML, /id="remove-dataset"[^>]* disabled/);
  element("metadata-button").handlers.click();
  assert.match(app.innerHTML, /&lt;safe&gt;/);
  element("metadata-description").handlers.input({ target: { value: "edited" } });
  element("metadata-tags").handlers.input({ target: { value: "a\nb" } });
  element("apply-metadata").handlers.click();
  assert.equal(posted.at(-1).type, "update-metadata");
  assert.equal(posted.at(-1).description, "edited");
  const accepted = { description: "edited", attributes: { instrument: "MS" }, tags: ["a", "b"] };
  send({ type: "metadata-updated", dataset_id: "original", metadata: accepted });
  assert.match(app.innerHTML, /id="metadata-description">edited<\/textarea>/);
  assert.match(app.innerHTML, /id="metadata-tags">a\nb<\/textarea>/);
  assert.match(app.innerHTML, /value="instrument"/);
  assert.match(app.innerHTML, /value="MS"/);
  assert.doesNotMatch(app.innerHTML, /&lt;safe&gt;/);
  // A second Apply must not send the pre-edit values back to the backend.
  element("apply-metadata").handlers.click();
  assert.equal(posted.at(-1).description, "edited");
  assert.equal(posted.at(-1).attributes.instrument, "MS");
  send({ type: "metadata-updated", dataset_id: "original", metadata: accepted });
  element("metadata-description").handlers.input({ target: { value: "next draft" } });
  send({ type: "metadata-updated", dataset_id: "original" });
  assert.equal(posted.at(-1).type, "page-request");
  assert.match(app.innerHTML, /id="metadata-description">next draft<\/textarea>/);
  element("columns-button").handlers.click({ stopPropagation() {} });
  assert.match(app.innerHTML, /id="add-column-form" class="add-column-form" hidden/);
  element("add-column-toggle").handlers.click();
  assert.equal(element("add-column-form").hidden, false);
  assert.match(app.innerHTML, /id="new-column-name"/);
  assert.match(app.innerHTML, /id="new-column-value"/);
  element("new-column-name").value = "Note";
  element("new-column-value").value = "";
  element("add-column-form").handlers.submit({ preventDefault() {} });
  assert.equal(posted.at(-1).type, "add-column");
  assert.equal(posted.at(-1).column, "Note");
  assert.equal(posted.at(-1).value, "");
  send({ type: "column-added", dataset_id: "original", column: "Note" });
  assert.equal(posted.at(-1).type, "page-request");
  assert.equal(posted.at(-1).columns.includes("Note"), true);
  send({ type: "dataset-added", dataset: { id: "added", name: "added" } });
  page("added");
  element("remove-dataset").handlers.click();
  assert.equal(posted.at(-1).datasetId, "added");
  send({ type: "dataset-removed", dataset_id: "added" });
  assert.equal(posted.at(-1).datasetId, "original");
  assert.doesNotMatch(app.innerHTML, /value="added"/);
  send({type: "dataset-removed", dataset_id: "original"});
  assert.match(app.innerHTML, /No datasets loaded/);
  element("add-dataset").handlers.click();
  assert.equal(posted.at(-1).type, "add-dataset");
  send({type: "dataset-added", dataset: {id: "new", name: "new"}});
  page("new");
  assert.doesNotMatch(app.innerHTML, /No datasets loaded/);
});
