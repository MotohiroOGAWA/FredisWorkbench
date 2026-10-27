"use strict";

// Connects a dataset viewer UI to its backend and the optional chemistry
// features (chemistry/index.js).
//
// Requests from the UI go to `session.request(request)`; messages for the UI
// arrive through `onMessage`. Requests are processed in order. The session
// answers the chemistry requests itself:
//   * filters with operator "smarts" are resolved to {operator: "row_ids"}
//     before page, reload, export, and structure-count requests;
//   * render-structure and calculate-structure-counts use RDKit;
//   * a "capabilities" message follows "backend-ready".

const { NO_CHEMISTRY } = require("./chemistry");

const RESOLVED_TYPES = new Set(["page", "reload", "export", "calculate-structure-counts"]);

class DatasetSession {
  /**
   * @param {import("./backend").BackendProcess} backend  started or not yet started
   * @param {{capabilities: Promise<object>, call: Function} | null} chemistry  e.g. an RdkitChemistry
   * @param {(message: object) => void} onMessage  messages for the UI
   */
  constructor(backend, chemistry, onMessage) {
    this.backend = backend;
    this.chemistry = chemistry;
    this.onMessage = onMessage;
    this.queue = Promise.resolve();
    backend.on("message", (message) => {
      onMessage(message);
      if (message.type === "backend-ready") {
        this.capabilities().then((chemistry) => onMessage({ type: "capabilities", chemistry }));
      }
    });
  }

  capabilities() {
    return this.chemistry ? this.chemistry.capabilities : Promise.resolve(NO_CHEMISTRY);
  }

  /** Handle one request from the UI (backend requests, see docs/protocol.md). */
  request(request) {
    this.queue = this.queue
      .then(() => this.process(request))
      .catch((error) => this.onMessage({ type: "error", title: "Viewer error", message: error.message || String(error) }));
    return this.queue;
  }

  async process(request) {
    if (request.type === "render-structure") return this.renderStructure(request);
    if (!RESOLVED_TYPES.has(request.type)) {
      this.backend.send(request);
      return;
    }
    let filters;
    try {
      filters = await this.resolveFilters(request.dataset_id, request.filters);
    } catch (error) {
      const message = error.message || String(error);
      if (request.type === "export") this.onMessage({ type: "export-error", message });
      else if (request.type === "calculate-structure-counts") {
        this.onMessage({ type: "structure-counts-error", dataset_id: request.dataset_id, message });
      } else this.onMessage({ type: "filter-error", operator: "smarts", message });
      return;
    }
    if (request.type === "calculate-structure-counts") return this.structureCounts(request, filters);
    this.backend.send({ ...request, filters });
  }

  /** Replace SMARTS conditions with the row ids of the matching spectra. */
  async resolveFilters(datasetId, filters) {
    if (!Array.isArray(filters) || !filters.some((f) => f && f.operator === "smarts")) return filters;
    const capabilities = await this.capabilities();
    const resolved = [];
    for (const condition of filters) {
      if (!condition || condition.operator !== "smarts" || condition.value == null || String(condition.value) === "") {
        resolved.push(condition);
        continue;
      }
      if (!capabilities.smarts_filter) throw new Error("SMARTS filtering requires optional RDKit support");
      const reply = await this.backend.request({
        type: "column-values", dataset_id: datasetId, column: condition.column,
      });
      if (reply.error) continue;  // unknown column: ignored like other filters
      const matches = await this.chemistry.call("smarts-match", {
        values: reply.values, pattern: String(condition.value),
      });
      resolved.push({ operator: "row_ids", row_ids: reply.row_ids.filter((_, i) => matches[i]) });
    }
    return resolved;
  }

  async structureCounts(request, filters) {
    const fail = (message) => this.onMessage({
      type: "structure-counts-error", dataset_id: request.dataset_id, message,
    });
    const capabilities = await this.capabilities();
    if (!capabilities.structure_count) return fail("Structure counting requires optional RDKit support");
    const reply = await this.backend.request({
      type: "column-values", dataset_id: request.dataset_id, filters, detect_smiles: true,
      structure_smiles_column: request.structure_smiles_column,
    });
    if (reply.error) return fail(reply.error);
    try {
      const values = reply.values.filter((value) => value != null);
      const counts = await this.chemistry.call("structure-counts", { values });
      this.onMessage({
        type: "structure-counts", dataset_id: request.dataset_id, total_rows: reply.total_rows,
        smiles_column: reply.column, ...counts,
      });
    } catch (error) {
      fail(error.message || String(error));
    }
  }

  async renderStructure(request) {
    try {
      const capabilities = await this.capabilities();
      if (!capabilities.structure_render) throw new Error("Structure rendering requires optional RDKit support");
      const { smiles, svg } = await this.chemistry.call("render", {
        smiles: request.smiles, width: request.width, height: request.height,
      });
      this.onMessage({ type: "structure-rendered", smiles, svg });
    } catch (error) {
      this.onMessage({ type: "chemistry-error", operation: "render-structure", message: error.message || String(error) });
    }
  }
}

module.exports = { DatasetSession };
