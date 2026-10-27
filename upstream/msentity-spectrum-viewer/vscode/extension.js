const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATASET_FORMATS = {
  msds: "msentity dataset", msp: "NIST MSP", mgf: "Mascot Generic Format",
  tsv: "Tab-separated spectrum table", csv: "Comma-separated spectrum table"
};

const VIEW_TYPE = "msentity.spectrumViewer";
const SIMILARITY_VIEW_TYPE = "msentity.similarityViewer";
let outputChannel;

function configuredStructureSmilesColumn() {
  return String(
    vscode.workspace.getConfiguration("msentitySpectrumViewer").get("structureSmilesColumn", "SMILES") || "SMILES"
  ).trim() || "SMILES";
}

function configuredStructureOptions() {
  const config = vscode.workspace.getConfiguration("msentitySpectrumViewer");
  return {
    structure_smiles_column: configuredStructureSmilesColumn(),
    show_structure_column: config.get("showStructureColumn", true) !== false,
  };
}

function configuredStructurePreviewSize() {
  const config = vscode.workspace.getConfiguration("msentitySpectrumViewer");
  const bounded = (value, fallback) => Math.min(1200, Math.max(200, Number(value) || fallback));
  return {
    width: bounded(config.get("structurePreviewWidth", 560), 560),
    height: bounded(config.get("structurePreviewHeight", 400), 400),
  };
}

// Directory of a component shipped with the extension (ui, host, bin). A packaged extension contains them; when the extension runs from the
// repository (vscode/), they are found one level up.
function resourceDir(context, name) {
  const inside = context.asAbsolutePath(name);
  return fs.existsSync(inside) ? inside : path.join(context.extensionPath, "..", name);
}

function loadHost(context) {
  return require(path.join(resourceDir(context, "host"), "index.js"));
}

// The backend executable: msentitySpectrumViewer.backendPath, else
// MSENTITY_VIEWER_BACKEND, else bin/<platform>/ of the package, else the
// repository build (build/backend/).
function resolveBackendExecutable(context, host) {
  const config = vscode.workspace.getConfiguration("msentitySpectrumViewer");
  return host.findBackendExecutable({
    roots: [context.extensionPath, path.join(context.extensionPath, "..")],
    override: String(config.get("backendPath", "") || "").trim(),
  });
}

function requestColumn(message, writeRequest) {
  writeRequest({ type: message.type, dataset_id: message.datasetId,
    column: message.column, value: message.value ?? "" });
}

class MSEntityDocument {
  constructor(uri, fileType = null) {
    this.uri = uri;
    this.fileType = fileType;
  }
  dispose() {}
}

class MSEntityViewerProvider {
  constructor(context) {
    this.context = context;
    this.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "editor-icon.png");
    this.spectrumPanels = new Map();
    this.forcedFileTypes = new Map();
  }

  async openCustomDocument(uri) {
    const key = uri.toString();
    const fileType = this.forcedFileTypes.get(key) || null;
    this.forcedFileTypes.delete(key);
    return new MSEntityDocument(uri, fileType);
  }

  async resolveCustomEditor(document, webviewPanel) {
    webviewPanel.iconPath = this.iconPath;
    const webview = webviewPanel.webview;
    const uiDir = resourceDir(this.context, "ui");
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(uiDir)] };
    const isSimilarity = path.extname(document.uri.fsPath).toLowerCase() === ".mssim";
    webview.html = getDatasetWebviewHtml(webview, uiDir, document.uri, isSimilarity);

    const config = vscode.workspace.getConfiguration("msentitySpectrumViewer");
    const pageSize = Math.max(1, Math.min(500, Number(config.get("pageSize", 20)) || 20));
    const host = loadHost(this.context);
    const executable = resolveBackendExecutable(this.context, host);

    outputChannel.appendLine(`[open] ${document.uri.fsPath}`);
    outputChannel.appendLine(`[backend] ${executable || "(not found)"}`);

    const droppedDirectories = new Set();
    let disposed = false;
    // The webview announces "webview-ready" once it listens for messages;
    // until then backend messages are held so that none is lost.
    let webviewReady = false;
    const held = [];
    const send = (message) => {
      if (disposed) return;
      if (webviewReady) webview.postMessage(message);
      else held.push(message);
    };
    if (!executable) {
      webview.postMessage({
        type: "error",
        title: "Viewer backend not found",
        message: "msentity-viewer-backend is not part of this installation. Install the extension package for your platform, or set msentitySpectrumViewer.backendPath."
      });
      return;
    }

    const backend = new host.BackendProcess({
      executable, mode: isSimilarity ? "similarity" : "dataset", file: document.uri.fsPath,
      pageSize: isSimilarity ? undefined : pageSize, fileType: document.fileType || undefined,
    });
    // Dataset viewers go through a session (SMARTS filters, structures);
    // similarity viewers talk to the backend directly.
    const onBackendMessage = (message) => {
      if (message.type === "similarity-options") {
        this.configureSimilarity(
          message.datasets, message.active_dataset_id, document.uri,
          writeRequest, send, () => disposed
        )
          .catch((error) => send({ type: "similarity-error", message: error.message || String(error) }));
      } else if (message.type === "similarity-complete") {
        vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(message.path), SIMILARITY_VIEW_TYPE)
          .catch((error) => vscode.window.showErrorMessage(String(error)));
      } else if (message.type === "similarity-match") {
        this.showSpectrum(document.uri, message.query, message.reference, message.method);
      }
      if (["peak-columns-updated", "peak-record"].includes(message.type)) {
        this.spectrumPanels.get(document.uri.toString())?.panel.webview.postMessage(message);
      }
      send(message);
    };
    const session = isSimilarity
      ? null
      : new host.DatasetSession(backend, this.chemistry(host), onBackendMessage);
    if (isSimilarity) backend.on("message", onBackendMessage);
    backend.on("log", (line, stream) => outputChannel.appendLine(`[backend ${stream}] ${line}`));
    backend.on("error", (error) => {
      outputChannel.appendLine(`[spawn error] ${String(error)}`);
      send({
        type: "error",
        title: "Could not start the viewer backend",
        message: `${error.message}\n\nCheck msentitySpectrumViewer.backendPath or reinstall the extension.`
      });
    });
    backend.on("exit", (code, signal) => {
      outputChannel.appendLine(`[backend exit] code=${code} signal=${signal}`);
      if (!disposed && code !== 0 && code !== null) {
        send({
          type: "error",
          title: "msentity backend stopped",
          message: `The viewer backend exited with code ${code}. Open “MS Entity: Show Spectrum Viewer Logs” for details.`
        });
      }
    });
    backend.start();

    const writeRequest = (request) => {
      if (session) session.request(request);
      else backend.send(request);
    };

    const messageDisposable = webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case "webview-ready":
          webviewReady = true;
          for (const pending of held.splice(0)) webview.postMessage(pending);
          break;
        case "ready":
          writeRequest({ type: "page", page: 0, dataset_id: message.datasetId,
            ...configuredStructureOptions() });
          break;
        case "page-request":
          writeRequest({
            type: "page", page: Number(message.page) || 0, dataset_id: message.datasetId,
            filters: message.filters, sort: message.sort, columns: message.columns, bins: message.bins,
            ...configuredStructureOptions()
          });
          break;
        case "render-structure":
          writeRequest({ type: "render-structure", smiles: message.smiles,
            ...configuredStructurePreviewSize() });
          break;
        case "calculate-structure-counts":
          writeRequest({ type: "calculate-structure-counts", dataset_id: message.datasetId,
            filters: message.filters, ...configuredStructureOptions() });
          break;
        case "add-column":
          await requestColumn(message, writeRequest);
          break;
        case "update-metadata":
          writeRequest({ type: "update-metadata", dataset_id: message.datasetId,
            description: message.description, attributes: message.attributes, tags: message.tags });
          break;
        case "edit-cell": {
          const result = await vscode.window.showInputBox({
            title: `Edit ${message.column}`,
            value: String(message.value ?? ""),
            prompt: "Edit spectrum metadata. Export to save the change.",
            ignoreFocusOut: true
          });
          if (result !== undefined && !disposed) writeRequest({
            type: "update-cell", dataset_id: message.datasetId,
            row_id: message.rowId, column: message.column, value: result
          });
          break;
        }
        case "remove-dataset": {
          const choice = await vscode.window.showWarningMessage(
            "Remove this dataset from the viewer? Changes that have not been exported will be discarded. The file remains on disk.",
            { modal: true }, "Remove dataset"
          );
          if (choice === "Remove dataset" && !disposed) {
            writeRequest({ type: "remove-dataset", dataset_id: message.datasetId });
            this.spectrumPanels.get(document.uri.toString())?.panel.dispose();
          }
          break;
        }
        case "edit-error-notification":
          vscode.window.showErrorMessage(String(message.message));
          break;
        case "open-settings":
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            `@ext:${this.context.extension.packageJSON.publisher}.${this.context.extension.packageJSON.name}`
          );
          break;
        case "chemistry-error-notification":
        case "filter-error-notification":
        case "structure-counts-error-notification":
          vscode.window.showErrorMessage(String(message.message));
          break;
        case "assign-spec-id": {
          try {
            const prefix = await vscode.window.showInputBox({
              title: "Assign SpecID",
              prompt: "Prefix for sequential IDs (e.g. SP → SP01…SP12 for 12 spectra). Applies to all spectra in the selected dataset, in original order. Export to save; Reload discards changes.",
              placeHolder: "Optional prefix",
              value: "",
              ignoreFocusOut: true
            });
            if (prefix === undefined || disposed) {
              send({ type: "spec-id-cancelled" });
              break;
            }
            let overwrite = false;
            if (message.hasSpecId) {
              const choice = await vscode.window.showWarningMessage(
                "Replace all existing SpecID values in the selected dataset?",
                { modal: true }, "Replace SpecID"
              );
              if (choice !== "Replace SpecID" || disposed) {
                send({ type: "spec-id-cancelled" });
                break;
              }
              overwrite = true;
            }
            if (!backend.running) {
              throw new Error("The viewer backend is not running. Reopen the viewer and try again.");
            }
            writeRequest({ type: "assign-spec-id", dataset_id: message.datasetId, prefix, overwrite });
          } catch (error) {
            send({ type: "spec-id-error", message: error.message || String(error) });
          }
          break;
        }
        case "spec-id-notification":
          vscode.window.showInformationMessage(`Assigned SpecID to ${Number(message.totalRows) || 0} spectra. Use Export… to save the changes.`);
          break;
        case "spec-id-error-notification":
          vscode.window.showErrorMessage(String(message.message || "Could not assign SpecID."));
          break;
        case "reload":
          writeRequest({ type: "reload", dataset_id: message.datasetId, filters: message.filters,
            sort: message.sort, bins: message.bins,
            ...configuredStructureOptions() });
          break;
        case "calculate-similarity":
          writeRequest({ type: "similarity-options", dataset_id: message.datasetId });
          break;
        case "similarity-error-notification":
          vscode.window.showErrorMessage(String(message.message || "Could not calculate similarity."));
          break;
        case "export-similarity": {
          try {
            const format = await vscode.window.showQuickPick(["mssim", "tsv", "csv", "parquet"], {
              title: "Export filtered similarity results",
              placeHolder: "MSSIM includes metadata; other formats contain the result table only"
            });
            if (!format || disposed) { send({ type: "export-cancelled" }); break; }
            const name = path.basename(document.uri.fsPath, ".mssim");
            const target = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.joinPath(document.uri, "..", `${name}-filtered.${format}`),
              filters: { "Similarity results": [format] }
            });
            if (!target || disposed) { send({ type: "export-cancelled" }); break; }
            if (path.extname(target.fsPath).toLowerCase() !== `.${format}`) {
              throw new Error(`Use the .${format} extension for this export.`);
            }
            writeRequest({ type: "export", path: target.fsPath, filters: message.filters, sort: message.sort });
          } catch (error) { send({ type: "error", message: error.message || String(error) }); }
          break;
        }
        case "open-similarity-match":
          writeRequest({ type: "match", row: Number(message.resultIndex) });
          break;
        case "drop-datasets": {
          try {
            const supported = name => Object.hasOwn(DATASET_FORMATS, path.extname(name).slice(1).toLowerCase());
            for (const droppedPath of message.paths || []) {
              if (typeof droppedPath !== "string" || !path.isAbsolute(droppedPath) || !supported(droppedPath)) throw new Error("Unsupported dropped dataset path.");
              writeRequest({ type: "add-dataset", path: droppedPath });
            }
            for (const value of message.uris || []) {
              const uri = vscode.Uri.parse(value);
              if (!["file", "vscode-remote"].includes(uri.scheme) || !supported(uri.path)) throw new Error("Unsupported dropped dataset URI.");
              writeRequest({ type: "add-dataset", path: uri.fsPath });
            }
            for (const file of message.files || []) {
              if (!file || typeof file.name !== "string" || path.basename(file.name) !== file.name || file.name.includes("\\") || !supported(file.name) || typeof file.data !== "string") throw new Error("Unsupported dropped dataset file.");
              const directory = await fs.promises.mkdtemp(path.join(require("os").tmpdir(), "msentity-drop-"));
              droppedDirectories.add(directory);
              if (disposed) { await fs.promises.rm(directory, { recursive: true, force: true }); break; }
              const target = path.join(directory, file.name);
              await fs.promises.writeFile(target, Buffer.from(file.data, "base64"));
              if (!disposed) writeRequest({ type: "add-dataset", path: target });
            }
          } catch (error) {
            vscode.window.showErrorMessage(`Could not add dropped dataset: ${error.message || String(error)}`);
          }
          break;
        }
        case "add-dataset": {
          const selected = await vscode.window.showOpenDialog({
            title: "Add dataset to this viewer",
            canSelectMany: false,
            filters: { "Mass spectrum datasets": Object.keys(DATASET_FORMATS) }
          });
          if (selected?.[0]) writeRequest({ type: "add-dataset", path: selected[0].fsPath });
          break;
        }
        case "export-dataset": {
          const format = await vscode.window.showQuickPick(Object.keys(DATASET_FORMATS), {
            title: "Export msentity dataset",
            placeHolder: "Choose the output format"
          });
          if (!format) {
            send({ type: "export-cancelled" });
            break;
          }
          const sourcePath = String(message.datasetPath || document.uri.fsPath);
          const sourceName = path.basename(sourcePath, path.extname(sourcePath));
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(document.uri, "..", `${sourceName}.${format}`),
            filters: { [DATASET_FORMATS[format]]: [format] }
          });
          if (target) {
            const selectedExtension = path.extname(target.fsPath);
            const exportPath = selectedExtension.toLowerCase() === `.${format}`
              ? target.fsPath
              : selectedExtension
                ? `${target.fsPath.slice(0, -selectedExtension.length)}.${format}`
                : `${target.fsPath}.${format}`;
            writeRequest({
              type: "export", path: exportPath, file_type: format, dataset_id: message.datasetId,
              filters: message.filters, sort: message.sort, columns: message.columns
            });
          } else send({ type: "export-cancelled" });
          break;
        }
        case "open-spectrum":
          this.showSpectrum(document.uri, message.payload);
          this.spectrumPanels.get(document.uri.toString()).editRequest = writeRequest;
          break;
        case "save-similarity-image":
          try {
            const savedPath = await this.saveImage(document.uri, message);
            send(savedPath
              ? { type: "image-save-complete", path: savedPath }
              : { type: "image-save-cancelled" });
          } catch (error) {
            outputChannel.appendLine(`[similarity image export] ${error?.stack || String(error)}`);
            send({ type: "image-save-error", message: error?.message || String(error) });
          }
          break;
        case "export-notification":
          vscode.window.showInformationMessage(`Exported ${Number(message.totalRows) || 0} spectra to ${path.basename(String(message.path || "dataset"))}`);
          break;
        case "export-error-notification":
          vscode.window.showErrorMessage(String(message.message || "Could not export dataset."));
          break;
        case "show-logs":
          outputChannel.show(true);
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      disposed = true;
      messageDisposable.dispose();
      backend.stop();
      for (const directory of droppedDirectories) {
        fs.promises.rm(directory, { recursive: true, force: true }).catch(error => outputChannel?.appendLine(`Dropped dataset cleanup: ${error.message}`));
      }
    });
  }

  // RDKit (WebAssembly, in a worker thread), shared by all viewers and started
  // on first use. Without the bundled @rdkit/rdkit the features are off.
  chemistry(host) {
    if (!this.chemistryProvider) {
      this.chemistryProvider = new host.RdkitChemistry({ log: (line) => outputChannel.appendLine(`[${line}]`) });
    }
    return this.chemistryProvider;
  }

  async configureSimilarity(datasets, activeDatasetId, documentUri, writeRequest, send, isDisposed) {
    const cancel = () => send({ type: "similarity-cancelled" });
    if (!datasets.length) throw new Error("No dataset is loaded.");
    const modeChoice = await vscode.window.showQuickPick([
      {
        label: "Library search",
        description: "Compare every query spectrum with every reference spectrum",
        mode: "library_search"
      },
      {
        label: "Match by metadata key",
        description: "Compare records that share the same unique ID or other key",
        mode: "by_key"
      }
    ], { title: "Calculate similarity", placeHolder: "Choose how spectra are paired", ignoreFocusOut: true });
    if (!modeChoice || isDisposed()) return cancel();

    const orderedDatasets = [...datasets].sort((left, right) =>
      Number(right.id === activeDatasetId) - Number(left.id === activeDatasetId));
    const datasetItems = (items) => items.map((dataset) => ({
      label: dataset.name, description: dataset.id, dataset
    }));
    let first = orderedDatasets[0];
    if (orderedDatasets.length > 1) {
      const choice = await vscode.window.showQuickPick(datasetItems(orderedDatasets), {
        title: modeChoice.mode === "library_search" ? "Library search: query dataset" : "Key matching: first dataset",
        placeHolder: "The currently active dataset is listed first", ignoreFocusOut: true
      });
      if (!choice || isDisposed()) return cancel();
      first = choice.dataset;
    }

    let second;
    let referencePath;
    if (modeChoice.mode === "library_search") {
      const referenceItems = [
        ...datasetItems(datasets.filter((dataset) => dataset.id !== first.id)),
        { label: "$(folder-opened) Choose a dataset file…", description: "MSDS, MSP, MGF, TSV, or CSV", browse: true }
      ];
      const referenceChoice = await vscode.window.showQuickPick(referenceItems, {
        title: "Library search: reference library",
        placeHolder: "Choose an Add Dataset entry or load a reference file for this search", ignoreFocusOut: true
      });
      if (!referenceChoice || isDisposed()) return cancel();
      if (referenceChoice.browse) {
        const files = await vscode.window.showOpenDialog({
          title: "Choose reference dataset",
          canSelectMany: false,
          filters: { "Mass spectrum datasets": Object.keys(DATASET_FORMATS) }
        });
        if (!files?.[0] || isDisposed()) return cancel();
        referencePath = files[0].fsPath;
      } else {
        second = referenceChoice.dataset;
      }
    } else {
      const candidates = datasets.filter((dataset) => dataset.id !== first.id);
      if (!candidates.length) throw new Error("Add a second dataset for metadata-key matching.");
      const choice = candidates.length === 1 ? { dataset: candidates[0] } : await vscode.window.showQuickPick(
        datasetItems(candidates),
        { title: "Key matching: second dataset", placeHolder: "Choose the comparison dataset", ignoreFocusOut: true }
      );
      if (!choice || isDisposed()) return cancel();
      second = choice.dataset;
    }

    const methodChoice = await vscode.window.showQuickPick([
      { label: "Cosine similarity", description: "Normalize all peaks in both spectra", method: "cosine" },
      { label: "Reverse cosine similarity", description: "Ignore unmatched query peaks in the query norm", method: "reverse_cosine" }
    ], { title: "Similarity calculation method", ignoreFocusOut: true });
    if (!methodChoice || isDisposed()) return cancel();
    const parameters = { method: methodChoice.method };

    if (modeChoice.mode === "by_key") {
      for (const [index, dataset] of [first, second].entries()) {
        const columns = [...dataset.columns].sort((a, b) => (a === "SpecID" ? -1 : b === "SpecID" ? 1 : a.localeCompare(b)));
        const key = await vscode.window.showQuickPick(columns, {
          title: `Key matching: key${index + 1} — ${dataset.name}`,
          placeHolder: "Non-missing keys must be unique; values found on only one side are skipped", ignoreFocusOut: true
        });
        if (key === undefined || isDisposed()) return cancel();
        parameters[`key${index + 1}`] = key;
      }
    } else {
      const threshold = await vscode.window.showInputBox({
        title: "Library search: score threshold", value: "0.8", ignoreFocusOut: true,
        prompt: "Only matches at or above this score are saved.",
        validateInput: (text) => {
          const number = Number(text);
          return !text.trim() || !Number.isFinite(number) || number < 0 || number > 1
            ? "Enter a finite number from 0 to 1." : undefined;
        }
      });
      if (threshold === undefined || isDisposed()) return cancel();
      parameters.threshold = Number(threshold);
    }

    for (const [name, title, value, integer] of [
      ["bin_width", "m/z bin width", "0.01", false],
      ["intensity_exponent", "Intensity exponent (0.5 = square root)", "1", false]
    ]) {
      const input = await vscode.window.showInputBox({
        title: `Similarity: ${title}`, value, ignoreFocusOut: true,
        prompt: "Compare the entire selected datasets, including unsaved edits. Table filters do not limit this calculation.",
        validateInput: (text) => {
          const number = Number(text);
          return !Number.isFinite(number) || number <= 0 || (integer && !Number.isSafeInteger(number))
            ? `Enter a positive ${integer ? "integer" : "finite number"}.` : undefined;
        }
      });
      if (input === undefined || isDisposed()) return cancel();
      parameters[name] = Number(input);
    }
    const storageChoice = await vscode.window.showQuickPick([
      {
        label: "Include matched data",
        description: "Store each unique matched spectrum and its metadata once",
        include: true
      },
      {
        label: "Lightweight result",
        description: "Store match indices and scores without spectrum data",
        include: false
      }
    ], { title: "Similarity result contents", ignoreFocusOut: true });
    if (!storageChoice || isDisposed()) return cancel();
    parameters.include_matched_data = storageChoice.include;

    const target = await vscode.window.showSaveDialog({
      title: "Save similarity results",
      defaultUri: vscode.Uri.joinPath(documentUri, "..", "similarity.mssim"),
      filters: { "msentity similarity": ["mssim"] }
    });
    if (!target || isDisposed()) return cancel();
    if (path.extname(target.fsPath).toLowerCase() !== ".mssim") throw new Error("Use the .mssim extension.");
    send({ type: "similarity-start" });
    writeRequest({
      type: "calculate-similarity", mode: modeChoice.mode,
      dataset1: first.id, dataset2: second?.id, reference_path: referencePath,
      parameters, path: target.fsPath
    });
  }

  showSpectrum(documentUri, payload, comparisonBottom = null, comparisonMethod = "cosine") {
    if (!payload || typeof payload !== "object") return;
    const key = documentUri.toString();
    let entry = this.spectrumPanels.get(key);

    if (!entry) {
      const panel = vscode.window.createWebviewPanel(
        "msentity.spectrumPlot",
        "Mass Spectrum",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(resourceDir(this.context, "ui"))]
        }
      );
      panel.iconPath = this.iconPath;
      panel.webview.html = getSpectrumWebviewHtml(panel.webview, resourceDir(this.context, "ui"));
      entry = { panel, ready: false, latest: payload, comparisonBottom, comparisonMethod };
      this.spectrumPanels.set(key, entry);

      panel.webview.onDidReceiveMessage(async (message) => {
        if (message?.type === "add-peak-column" && entry.editRequest) {
          await requestColumn(message, entry.editRequest);
        } else if (message?.type === "get-peak-record" && entry.editRequest) {
          entry.editRequest({ type: message.type, dataset_id: message.datasetId, row_id: message.rowId });
        } else if (message?.type === "edit-peak-cell" && entry.editRequest) {
          const value = await vscode.window.showInputBox({
            title: `Edit peak annotation: ${message.column}`,
            value: String(message.value ?? ""), ignoreFocusOut: true,
            prompt: "Export the dataset as MSDS to save peak annotations."
          });
          if (value !== undefined) entry.editRequest({
            type: "update-peak-cell", dataset_id: message.datasetId, row_id: message.rowId,
            peak_index: message.peakIndex, column: message.column, value
          });
        } else if (message?.type === "ready") {
          entry.ready = true;
          if (entry.latest && entry.comparisonBottom) {
            panel.webview.postMessage({
              type: "spectrum-comparison", top: entry.latest,
              bottom: entry.comparisonBottom, method: entry.comparisonMethod
            });
          } else if (entry.latest) {
            panel.webview.postMessage({ type: "spectrum", payload: entry.latest });
          }
        } else if (message?.type === "save-image") {
          this.saveImage(documentUri, message);
        } else if (message?.type === "save-peaks") {
          this.savePeaks(documentUri, message).catch((error) => {
            outputChannel.appendLine(`[peak export] ${error?.stack || String(error)}`);
            vscode.window.showErrorMessage(error?.message || String(error));
          });
        } else if (message?.type === "copy-notification") {
          vscode.window.showInformationMessage(String(message.message || "Copied to clipboard."));
        } else if (message?.type === "clipboard-error") {
          vscode.window.showErrorMessage(String(message.message || "Could not copy to clipboard."));
        } else if (message?.type === "export-error") {
          vscode.window.showErrorMessage(String(message.message || "Could not export spectrum image."));
        }
      });
      panel.onDidDispose(() => this.spectrumPanels.delete(key));

      const config = vscode.workspace.getConfiguration("msentitySpectrumViewer");
      if (config.get("spectrumFloatingWindow", true)) {
        // VS Code 1.85+ supports floating editor windows. createWebviewPanel cannot
        // target one directly, so make the new spectrum editor active and move it.
        setTimeout(async () => {
          try {
            await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
          } catch (error) {
            outputChannel.appendLine(`[floating window] Could not move spectrum editor: ${String(error)}`);
          }
        }, 0);
      }
    } else {
      entry.latest = payload;
      entry.comparisonBottom = comparisonBottom;
      entry.comparisonMethod = comparisonMethod;
      // Reveal in its current location. Omitting a view column is important when
      // the panel lives in a floating VS Code window because specifying a column
      // would move it back into the main window.
      entry.panel.reveal(undefined, true);
    }

    entry.latest = payload;
    entry.comparisonBottom = comparisonBottom;
    entry.comparisonMethod = comparisonMethod;
    entry.panel.title = comparisonBottom
      ? `${payload.title || "Query"} ↔ ${comparisonBottom.title || "Reference"} · Mass Spectrum`
      : `${payload.title || `Spectrum ${(payload.globalIndex ?? 0) + 1}`} · Mass Spectrum`;
    if (entry.ready) {
      entry.panel.webview.postMessage(comparisonBottom
        ? { type: "spectrum-comparison", top: payload, bottom: comparisonBottom, method: comparisonMethod }
        : { type: "spectrum", payload });
    }
  }

  async saveImage(documentUri, message) {
    const filename = String(message?.filename || "spectrum.svg").replace(/[^\w.-]+/g, "_");
    const bytes = Array.isArray(message?.bytes) ? Uint8Array.from(message.bytes) : null;
    if (!bytes?.length) throw new Error("The generated image is empty.");
    const parentUri = vscode.Uri.file(path.dirname(documentUri.fsPath));
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(parentUri, filename),
      filters: filename.endsWith(".png") ? { "PNG image": ["png"] } : { "SVG image": ["svg"] }
    });
    if (!target) return null;
    await vscode.workspace.fs.writeFile(target, bytes);
    vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`);
    return target.fsPath;
  }

  async savePeaks(documentUri, message) {
    const formats = {
      tsv: { label: "TSV", description: "Tab-separated values", filter: "Tab-separated values" },
      csv: { label: "CSV", description: "Comma-separated values", filter: "Comma-separated values" }
    };
    const selected = await vscode.window.showQuickPick(
      Object.entries(formats).map(([format, details]) => ({ ...details, format })),
      { title: "Save spectrum peaks", placeHolder: "Choose the output format" }
    );
    if (!selected) return null;
    const content = message?.contents?.[selected.format];
    if (typeof content !== "string") throw new Error(`Peak ${selected.label} data is unavailable.`);
    const basename = String(message?.basename || "spectrum").replace(/[^\w.-]+/g, "_");
    const filename = `${basename.replace(/\.(?:tsv|csv)$/i, "")}.${selected.format}`;
    const sourcePath = String(message?.sourcePath || "");
    const sourceUri = sourcePath ? vscode.Uri.file(sourcePath) : documentUri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(sourceUri, "..", filename),
      filters: { [selected.filter]: [selected.format] }
    });
    if (!target) return null;
    const chosenExtension = path.extname(target.fsPath);
    const outputPath = chosenExtension.toLowerCase() === `.${selected.format}`
      ? target.fsPath
      : chosenExtension
        ? `${target.fsPath.slice(0, -chosenExtension.length)}.${selected.format}`
        : `${target.fsPath}.${selected.format}`;
    const outputUri = outputPath === target.fsPath ? target : vscode.Uri.file(outputPath);
    await vscode.workspace.fs.writeFile(outputUri, Buffer.from(content, "utf8"));
    vscode.window.showInformationMessage(`Saved ${path.basename(outputPath)}`);
    return outputPath;
  }

  dispose() {
    this.chemistryProvider?.stop();
    this.chemistryProvider = null;
    for (const { panel } of this.spectrumPanels.values()) panel.dispose();
    this.spectrumPanels.clear();
  }

  openAs(uri, fileType) {
    const target = uri || vscode.window.activeTextEditor?.document?.uri;
    if (!target) {
      vscode.window.showWarningMessage("Select a dataset file first.");
      return;
    }
    this.forcedFileTypes.set(target.toString(), fileType);
    return vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
  }
}

function getDatasetWebviewHtml(webview, uiDir, documentUri, isSimilarity = false) {
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(uiDir, isSimilarity ? "similarity.js" : "viewer.js")));
  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(uiDir, isSimilarity ? "similarity.css" : "viewer.css")));
  const nonce = crypto.randomBytes(16).toString("base64");
  const filename = path.basename(documentUri.fsPath).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>${filename} · msentity</title>
</head>
<body>
  <div id="app" data-filename="${filename}"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getSpectrumWebviewHtml(webview, uiDir) {
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(uiDir, "spectrum.js")));
  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(uiDir, "spectrum.css")));
  const nonce = crypto.randomBytes(16).toString("base64");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Mass Spectrum</title>
</head>
<body>
  <div id="spectrum-app" class="spectrum-status">Select a spectrum record.</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel("msentity Spectrum Viewer");
  context.subscriptions.push(outputChannel);

  const provider = new MSEntityViewerProvider(context);
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    })
  );

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(SIMILARITY_VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("msentitySpectrumViewer.openAs", async (uri) => {
      const target = uri || vscode.window.activeTextEditor?.document?.uri;
      if (!target) {
        vscode.window.showWarningMessage("Select a dataset file first.");
        return;
      }
      const fileType = await vscode.window.showQuickPick(Object.keys(DATASET_FORMATS), {
        title: "MS Entity: Open as",
        placeHolder: "Choose the dataset format"
      });
      if (!fileType) return;
      return provider.openAs(target, fileType);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("msentitySpectrumViewer.open", async (uri) => {
      const target = uri || vscode.window.activeTextEditor?.document?.uri;
      if (!target) {
        vscode.window.showWarningMessage("Select a dataset file first, or use “MS Entity: Open as...”.");
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", target,
        path.extname(target.fsPath).toLowerCase() === ".mssim" ? SIMILARITY_VIEW_TYPE : VIEW_TYPE);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("msentitySpectrumViewer.showLogs", () => outputChannel.show(true))
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
