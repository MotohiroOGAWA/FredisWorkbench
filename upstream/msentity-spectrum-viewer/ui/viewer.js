(() => {
  // The VS Code webview API, or a host object { postMessage(message) } provided by
  // the embedding page as window.msentityViewerHost (see ui/README.md).
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : window.msentityViewerHost;
  const app = document.getElementById("app");
  const filename = app.dataset.filename || "dataset";

  const toolbarIcon = name => `<svg class="toolbar-icon icon-${name}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${({
    add: '<path d="M12 4v16M4 12h16"/>',
    remove: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
    reload: '<path d="M20 4v6h-6M20 10a8 8 0 1 0 .2 5"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    metadata: '<path d="M14 3H5v18h14V8l-5-5v5h5M8 12h8M8 16h8"/>',
    columns: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M11 3v18M3 10h18M6 6h2m6 0h4M6 14h2m6 0h4"/>',
    filter: '<path d="M3 4h18l-7 9v6l-4 2v-8L3 4Z"/>',
    specid: '<path d="M3 3h9l9 9-9 9-9-9V3Z"/><circle cx="7.5" cy="7.5" r="1"/>',
    export: '<path d="M12 16V3m-5 5 5-5 5 5M5 12H3v9h18v-9h-2"/>',
    similarity: '<path d="M5 20V13m7 7V4m7 16V9" stroke-width="3"/>',
    structureCount: '<circle cx="7" cy="6.5" r="3.5"/><path d="m9.6 9.1 2.4 2.4M3 20v-4h2.7v4M7.2 20v-7h2.7v7M11.4 20v-5h2.7v5M2 20h13"/><path d="m18.5 11 3.5 2v4l-3.5 2-3.5-2v-4l3.5-2Z"/><circle cx="18.5" cy="15" r="1.5"/>',
    settings: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M4.9 4.9l2.8 2.8m8.6 8.6 2.8 2.8M19.1 4.9l-2.8 2.8m-8.6 8.6-2.8 2.8"/>',
  })[name]}</svg>`;

  let value = null;
  let metadataOpen = false;
  let metadataDraft = null;
  let metadataBusy = false;
  const changedDatasets = new Set();

  function metadataForm() {
    if (!metadataOpen) return "";
    if (!metadataDraft) metadataDraft = {
      description: value.description || "",
      tags: (value.tags || []).join("\n"),
      attributes: Object.entries(value.attributes || {}).map(([key, val]) => ({ key, value: val }))
    };
    return `<section class="metadata-panel" aria-label="Dataset metadata">
      <h3>Dataset metadata</h3>
      <label>Description<textarea id="metadata-description">${esc(metadataDraft.description)}</textarea></label>
      <label>Tags (one per line)<textarea id="metadata-tags">${esc(metadataDraft.tags)}</textarea></label>
      <div>Attributes</div>
      ${metadataDraft.attributes.map((item, i) => `<div class="attribute-row">
        <input aria-label="Attribute name" data-attribute-key="${i}" value="${esc(item.key)}" placeholder="Name">
        <input aria-label="Attribute value" data-attribute-value="${i}" value="${esc(item.value)}" placeholder="Value">
        <button data-remove-attribute="${i}" aria-label="Remove attribute">×</button></div>`).join("")}
      <button id="add-attribute">Add attribute</button>
      <p>Apply updates the loaded dataset. Export as MSDS to preserve description, attributes and tags.
      Reload or closing the viewer discards changes that have not been exported.</p>
      <button id="apply-metadata" ${metadataBusy ? "disabled" : ""}>Apply</button>
      <button id="cancel-metadata">Cancel</button>
    </section>`;
  }

  let selectedColumns = [];
  let knownColumnsKey = "";
  let loadingPage = false;
  let datasetMenuOpen = false;
  let moreActionsOpen = false;
  let columnMenuOpen = false;
  let columnMenuScrollTop = 0;
  let filterMenuOpen = false;
  let filters = [];
  let rowSort = [];
  let filterSequence = 0;
  let selectedSpectrumIndex = null;
  let loadingProgress = null;
  let exporting = false;
  let exportProgress = null;
  let calculatingSimilarity = false;
  let similarityProgress = null;
  let assigningSpecId = false;
  let calculatingStructureCounts = false;
  let structureCounts = null;
  let chemistryCapabilities = { backend: null, smarts_filter: false, structure_render: false, structure_count: false };
  let structurePreview = null;
  let datasetOptions = [];
  let activeDatasetId = "";
  const datasetPages = new Map();

  const esc = (v) => String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const display = (v) => v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const columns = () => Array.isArray(value?.all_columns) ? value.all_columns.map(String) : Array.isArray(value?.columns) ? value.columns.map(String) : [];
  const rows = () => Array.isArray(value?.rows) ? value.rows : [];
  const spectra = () => Array.isArray(value?.spectra) ? value.spectra : [];
  const page = () => Number.isInteger(value?.page) ? value.page : 0;
  const pageSize = () => Number.isInteger(value?.page_size) ? value.page_size : 20;
  const rowOffset = () => Number.isInteger(value?.row_offset) ? value.row_offset : page() * pageSize();
  const totalRows = () => Number.isInteger(value?.total_rows) ? value.total_rows : rows().length;
  const pageCount = () => Number.isInteger(value?.total_pages) ? value.total_pages : Math.max(1, Math.ceil(totalRows() / pageSize()));

  function ensureColumns() {
    const cols = columns();
    const key = JSON.stringify(cols);
    if (key !== knownColumnsKey) {
      knownColumnsKey = key;
      selectedColumns = [...cols];
    }
  }

  function titleFor(row, index) {
    return String(row?.Name ?? row?.name ?? row?.TITLE ?? row?.Title ?? row?.ID ?? row?.id ?? `Spectrum ${index + 1}`);
  }

  function viewRequest(pageNumber = 0) {
    return { type: "page-request", page: pageNumber, datasetId: activeDatasetId, filters, sort: rowSort, columns: selectedColumns };
  }

  function refreshView() {
    structureCounts = null;
    loadingPage = true;
    selectedSpectrumIndex = null;
    render();
    vscode.postMessage(viewRequest(0));
  }

  function requestPage(requested) {
    const target = Math.min(pageCount() - 1, Math.max(0, Number(requested) || 0));
    if (target === page() || loadingPage) return;
    loadingPage = true;
    selectedSpectrumIndex = null;
    render();
    vscode.postMessage(viewRequest(target));
  }

  function toggleColumn(column) {
    columnMenuScrollTop = document.getElementById("column-menu")?.scrollTop || 0;
    selectedColumns = selectedColumns.includes(column)
      ? selectedColumns.filter((x) => x !== column)
      : columns().filter((x) => x === column || selectedColumns.includes(x));
    render();
  }

  function moveColumn(column, offset) {
    columnMenuScrollTop = document.getElementById("column-menu")?.scrollTop || 0;
    const index = selectedColumns.indexOf(column);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= selectedColumns.length) return;
    [selectedColumns[index], selectedColumns[target]] = [selectedColumns[target], selectedColumns[index]];
    render();
  }

  function renderLoading(text = "Loading msentity dataset…") {
    const progress = loadingProgress;
    const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
    const details = progress ? `${percent.toFixed(1)}% · ${Number(progress.processed || 0).toLocaleString()} / ${Number(progress.total || 0).toLocaleString()} bytes · ${Number(progress.success || 0).toLocaleString()} spectra` : "Reading the file…";
    app.innerHTML = `<div class="status"><div class="loading-card"><div class="loading-title">${esc(text)}</div><progress max="100" value="${percent}"></progress><div class="loading-details">${esc(details)}</div></div></div>`;
  }

  function renderError(title, message) {
    app.innerHTML = `<div class="status"><div class="error-card"><h2>${esc(title)}</h2><pre>${esc(message)}</pre><button class="secondary-button" id="show-logs">Show logs</button></div></div>`;
    document.getElementById("show-logs")?.addEventListener("click", () => vscode.postMessage({ type: "show-logs" }));
  }

  function render() {
    if (!datasetOptions.length && !activeDatasetId && value === null) {
      app.innerHTML = `<div class="viewer"><div class="toolbar"><span class="summary">No datasets</span><button id="add-dataset" class="secondary-button dataset-primary">${toolbarIcon("add")} Add dataset</button></div><div class="status"><div><p>No datasets loaded.</p><p>Add a dataset or drop MSDS, MSP, MGF, TSV, or CSV files here.</p></div></div></div>`;
      document.getElementById("add-dataset")?.addEventListener("click", () => vscode.postMessage({type: "add-dataset"}));
      return;
    }
    if (!value) return renderLoading();
    ensureColumns();
    const pageRows = rows().map((row, index) => ({ row, index }));
    const cols = columns();
    const allSelected = cols.length > 0 && selectedColumns.length === cols.length;
    const start = rows().length ? rowOffset() + 1 : 0;
    const end = rowOffset() + rows().length;
    const smilesColumn = value?.structure_smiles_column || null;
    const showStructureColumn = value?.show_structure_column !== false && chemistryCapabilities.structure_render && Boolean(smilesColumn);
    const sortFor = (column) => {
      const index = rowSort.findIndex((item) => item.column === column);
      return index < 0 ? null : { ...rowSort[index], priority: index + 1 };
    };

    const columnMenu = columnMenuOpen ? `
      <div class="column-menu" id="column-menu">
        <div class="column-menu-heading"><strong>Columns</strong><button id="add-column-toggle" title="Add column" aria-label="Add metadata column" aria-expanded="false">+</button></div>
        <form id="add-column-form" class="add-column-form" hidden>
          <strong>Add column</strong>
          <input id="new-column-name" aria-label="New column name" placeholder="Column name" required>
          <input id="new-column-value" aria-label="Initial column value" placeholder="Initial value (blank by default)" value="">
          <button type="submit">Add</button>
          <small>Applies to all spectra in this dataset.</small>
        </form>
        <button class="column-option" data-action="all-columns"><span class="checkmark ${allSelected ? "checked" : ""}">✓</span><strong>All columns</strong></button>
        ${cols.map((c) => `<div class="column-option"><button class="column-toggle" data-column="${esc(c)}"><span class="checkmark ${selectedColumns.includes(c) ? "checked" : ""}">✓</span><span>${esc(c)}</span></button>${selectedColumns.includes(c) ? `<span class="column-order"><button data-move-column="${esc(c)}" data-offset="-1" title="Move left" ${selectedColumns.indexOf(c) === 0 ? "disabled" : ""}>↑</button><button data-move-column="${esc(c)}" data-offset="1" title="Move right" ${selectedColumns.indexOf(c) === selectedColumns.length - 1 ? "disabled" : ""}>↓</button></span>` : ""}</div>`).join("")}
      </div>` : "";

    const filterMenu = filterMenuOpen ? `
      <div class="filter-menu" id="filter-menu">
        <div class="filter-title"><strong>Filters</strong><span class="filter-add-actions"><button id="add-filter" title="Add column filter">+ Column filter</button><button id="add-peak-filter" title="Add peak filter">+ Peak filter</button></span></div>
        ${filters.length ? filters.map((filter) => { const spectral = ["spectrum_peak", "neutral_loss"].includes(filter.operator); return `<div class="filter-row ${spectral ? "spectrum-filter-row" : ""}" data-filter-id="${filter.id}">
          ${spectral ? `<fieldset class="peak-kind"><legend>Peak type</legend><label><input data-filter-field="operator" name="peak-type-${filter.id}" type="radio" value="spectrum_peak" ${filter.operator === "spectrum_peak" ? "checked" : ""}>Product ion</label><label><input data-filter-field="operator" name="peak-type-${filter.id}" type="radio" value="neutral_loss" ${filter.operator === "neutral_loss" ? "checked" : ""}>Neutral loss</label></fieldset><label class="mz-tolerance"><span>m/z</span><input data-filter-field="mz" type="number" step="any" value="${esc(filter.mz)}" placeholder="123.45" aria-label="m/z"><span>±</span><input data-filter-field="tolerance" type="number" min="0" step="any" value="${esc(filter.tolerance)}" placeholder="0.01" aria-label="Tolerance"><select data-filter-field="tolerance_unit" aria-label="Tolerance unit"><option value="Da" ${filter.tolerance_unit !== "ppm" ? "selected" : ""}>Da</option><option value="ppm" ${filter.tolerance_unit === "ppm" ? "selected" : ""}>ppm</option></select></label><label class="intensity-filter"><span>Min intensity</span><input data-intensity-slider type="range" min="0" max="1" step="0.01" value="${esc(filter.intensity ?? 0)}" aria-label="Minimum normalized intensity slider"><input data-filter-field="intensity" type="number" min="0" max="1" step="0.01" value="${esc(filter.intensity ?? 0)}" aria-label="Minimum normalized intensity"></label>` : `<select data-filter-target aria-label="Column">${cols.map((c) => `<option value="${esc(c)}" ${c === filter.column ? "selected" : ""}>${esc(c)}</option>`).join("")}</select><select data-filter-field="operator" aria-label="Operator">${[
            ["text_eq", "= (text)"], ["numeric_eq", "= (number)"], ["!=", "!= (text)"], ["contains", "contains"],
            [">", "> (number)"], [">=", ">= (number)"], ["<", "< (number)"], ["<=", "<= (number)"],
            ...(chemistryCapabilities.smarts_filter ? [["smarts", "SMARTS substructure"]] : [])
          ].map(([op, label]) => `<option value="${esc(op)}" ${op === filter.operator ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>
          <input data-filter-field="value" value="${esc(filter.value)}" placeholder="Value" />`}
          <button class="remove-filter" title="Remove filter">×</button>
        </div>`; }).join("") : `<div class="filter-empty">Press + to add a condition.</div>`}
        <div class="filter-actions"><button id="clear-filters" class="secondary-button" ${filters.length ? "" : "disabled"}>Clear</button><button id="apply-filters">Apply</button></div>
      </div>` : "";

    app.innerHTML = `
      <div class="viewer">
        <div class="toolbar">
          <div class="dataset-info">
            <button id="dataset-select" class="dataset-trigger" value="${esc(activeDatasetId)}" ${loadingPage || metadataBusy ? "disabled" : ""} aria-label="Active dataset" aria-haspopup="true" aria-expanded="${datasetMenuOpen}" aria-controls="dataset-menu"><span>${esc(datasetOptions.find(d => d.id === activeDatasetId)?.name || filename)}</span>${toolbarIcon("chevron")}</button>
            <div class="summary">${totalRows().toLocaleString()} spectra${structureCounts && structureCounts.total_rows === totalRows() ? ` · ${Number(structureCounts.unique_smiles).toLocaleString()} unique SMILES · ${Number(structureCounts.canonical_structures).toLocaleString()} canonical structures` : ""} · ${selectedColumns.length}/${cols.length} columns${changedDatasets.has(activeDatasetId) ? ' · Modified' : ''}</div>
            <div class="dataset-menu" id="dataset-menu" ${datasetMenuOpen ? "" : "hidden"}>
              <div class="dataset-menu-actions">
                <button class="secondary-button dataset-primary" id="add-dataset" title="Add dataset" aria-label="Add dataset">${toolbarIcon("add")}</button>
                <button class="secondary-button" id="remove-dataset" title="Remove active dataset" aria-label="Remove dataset" ${!activeDatasetId || loadingPage || metadataBusy ? "disabled" : ""}>${toolbarIcon("remove")}</button>
              </div>
              <div class="dataset-options" role="listbox" aria-label="Datasets">
                ${datasetOptions.map(d => `<button class="dataset-option" role="option" aria-selected="${d.id === activeDatasetId}" data-dataset-id="${esc(d.id)}"><span>${esc(d.name)}</span>${d.id === activeDatasetId ? '<span aria-hidden="true">✓</span>' : ''}</button>`).join("")}
              </div>
            </div>
          </div>
          <div class="toolbar-group view-actions">
            <button class="secondary-button" id="reload-button" title="Reload dataset from disk">${toolbarIcon("reload")}<span>Reload</span></button>
            <div class="filters"><button class="secondary-button" id="filter-button" aria-expanded="${filterMenuOpen}" aria-controls="filter-menu">${toolbarIcon("filter")}<span class="menu-action-label">Filter</span>${filters.length ? ` <span class="filter-count">${filters.length}</span>` : ""}</button>${filterMenu}</div>
            <button class="secondary-button" id="export-button" ${exporting || loadingPage || metadataBusy ? "disabled" : ""} title="Export dataset (Ctrl+S)">${toolbarIcon("export")}<span class="menu-action-label">${exporting ? `Exporting…${exportProgress == null ? "" : ` ${exportProgress.toFixed(1)}%`}` : "Export"}</span></button>
          </div>
          <div class="more-actions columns">
            <button class="secondary-button" id="more-actions-button" aria-haspopup="menu" aria-controls="more-actions-menu" aria-expanded="${moreActionsOpen}"><span>More ...</span></button>
            <div id="more-actions-menu" class="more-actions-menu" role="menu" aria-label="Dataset actions" ${moreActionsOpen ? "" : "hidden"}>
              <button class="more-action" role="menuitem" id="metadata-button" ${loadingPage ? "disabled" : ""}>${toolbarIcon("metadata")}<span class="menu-action-label">Metadata</span></button>
              <button class="more-action" role="menuitem" id="columns-button" aria-expanded="${columnMenuOpen}" aria-controls="column-menu">${toolbarIcon("columns")}<span class="menu-action-label">Columns</span></button>
              <button class="more-action" role="menuitem" id="assign-spec-id-button" ${assigningSpecId || loadingPage || exporting ? "disabled" : ""}>${toolbarIcon("specid")}<span class="menu-action-label">${assigningSpecId ? "Assigning SpecID…" : "Assign SpecID"}</span></button>
              ${chemistryCapabilities.structure_count ? `<button class="more-action" role="menuitem" id="structure-counts-button" ${calculatingStructureCounts || loadingPage ? "disabled" : ""}>${toolbarIcon("structureCount")}<span class="menu-action-label">${calculatingStructureCounts ? "Counting structures…" : "Count SMILES and structures"}</span></button>` : ""}
              <div class="more-actions-divider" role="separator"></div>
              <button class="more-action" role="menuitem" id="similarity-button" ${calculatingSimilarity || datasetOptions.length < 1 ? "disabled" : ""} title="Run a library search or compare matching metadata keys">${toolbarIcon("similarity")}<span class="menu-action-label">${calculatingSimilarity ? `Calculating…${similarityProgress == null ? "" : ` ${similarityProgress.toFixed(1)}%`}` : "Calculate similarity"}</span></button>
              <div class="more-actions-divider" role="separator"></div>
              <button class="more-action" role="menuitem" id="settings-button">${toolbarIcon("settings")}<span class="menu-action-label">Settings</span></button>
            </div>
            ${columnMenu}
          </div>
        </div>
        ${metadataForm()}
        <div class="table-wrap"><table class="dataset-table"><thead><tr><th class="row-column">Row</th><th class="spectrum-column">Spectrum</th>${showStructureColumn ? `<th class="structure-column">Structure</th>` : ""}${selectedColumns.map((c) => { const item = sortFor(c); return `<th><button class="table-sort" data-sort-column="${esc(c)}" title="Click: ascending → descending → remove sort">${esc(c)}<span>${item ? `${item.priority}${item.direction === "asc" ? "▲" : "▼"}` : ""}</span></button></th>`; }).join("")}</tr></thead><tbody>
          ${pageRows.length ? pageRows.map(({ row, index }) => { const smiles = smilesColumn ? String(row?.[smilesColumn] ?? "").trim() : ""; return `<tr class="${selectedSpectrumIndex === index ? "selected-record" : ""}"><td class="row-column">${rowOffset() + index + 1}</td><td class="spectrum-column"><button class="spectrum-button" data-spectrum-index="${index}" title="Show spectrum ${rowOffset() + index + 1}"><svg viewBox="0 0 28 22"><path d="M2 19h24M4 18V13m4 5V7m4 11v-4m4 4V3m4 15V9m4 9v-7"/></svg></button></td>${showStructureColumn ? `<td class="structure-column">${smiles ? `<button class="structure-button" data-structure-index="${index}" aria-label="View structure" title="View structure"><svg viewBox="0 0 28 24" aria-hidden="true" focusable="false"><path class="structure-edges" d="M14 3 21.8 7.5v9L14 21l-7.8-4.5v-9Z"/><g class="structure-nodes"><circle cx="14" cy="3" r="2.1"/><circle cx="21.8" cy="7.5" r="2.1"/><circle cx="21.8" cy="16.5" r="2.1"/><circle cx="14" cy="21" r="2.1"/><circle cx="6.2" cy="16.5" r="2.1"/><circle cx="6.2" cy="7.5" r="2.1"/></g></svg></button>` : ""}</td>` : ""}${selectedColumns.map((c) => `<td tabindex="0" data-edit-row="${index}" data-edit-column="${esc(c)}" title="Double-click or press Enter to edit: ${esc(display(row?.[c]))}">${esc(display(row?.[c]))}</td>`).join("")}</tr>`; }).join("") : `<tr><td colspan="${selectedColumns.length + 2 + (showStructureColumn ? 1 : 0)}" class="empty">No spectra match the filters.</td></tr>`}
        </tbody></table></div>
        <div class="pagination"><span>${start}–${end} of ${totalRows()}</span><div class="page-controls"><button id="prev-page" ${page() === 0 || loadingPage ? "disabled" : ""}>‹</button><span><input id="page-input" type="number" min="1" max="${pageCount()}" value="${page() + 1}" ${loadingPage ? "disabled" : ""}/> / ${pageCount()}</span><button id="next-page" ${page() >= pageCount() - 1 || loadingPage ? "disabled" : ""}>›</button></div><span>${loadingPage ? "Loading…" : `${pageSize()} rows/page`}</span></div>
        ${structurePreview ? `<div class="structure-backdrop" id="structure-backdrop"><section class="structure-preview" role="dialog" aria-modal="true" aria-labelledby="structure-title"><header><strong id="structure-title">Structure</strong><button id="close-structure" class="modal-close" aria-label="Close structure preview">×</button></header><div class="structure-canvas">${structurePreview.url ? `<img src="${esc(structurePreview.url)}" alt="Chemical structure for ${esc(structurePreview.smiles)}">` : `<span>Rendering structure…</span>`}</div><code>${esc(structurePreview.smiles)}</code></section></div>` : ""}
      </div>`;

    const moreButton = document.getElementById("more-actions-button");
    const menuItems = () => [...document.querySelectorAll("#more-actions-menu button:not(:disabled)")];
    moreButton?.addEventListener("click", (e) => {
      e.stopPropagation();
      moreActionsOpen = !moreActionsOpen;
      datasetMenuOpen = false; columnMenuOpen = false; filterMenuOpen = false;
      render();
      if (moreActionsOpen) menuItems()[0]?.focus();
      else document.getElementById("more-actions-button")?.focus();
    });
    moreButton?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); moreActionsOpen = true; columnMenuOpen = false; filterMenuOpen = false; render();
        const items = menuItems(); (e.key === "ArrowUp" ? items.at(-1) : items[0])?.focus();
      }
    });
    document.getElementById("more-actions-menu")?.addEventListener("keydown", (e) => {
      const items = menuItems(); const index = items.indexOf(document.activeElement);
      let next;
      if (e.key === "ArrowDown") next = (index + 1) % items.length;
      else if (e.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      if (next != null) { e.preventDefault(); items[next]?.focus(); }
    });
    document.getElementById("metadata-button")?.addEventListener("click", () => { moreActionsOpen = false; metadataOpen = !metadataOpen; render();
      document.getElementById("metadata-description")?.focus?.(); });
    document.getElementById("metadata-description")?.addEventListener("input", (e) => { metadataDraft.description = e.target.value; });
    document.getElementById("metadata-tags")?.addEventListener("input", (e) => { metadataDraft.tags = e.target.value; });
    document.querySelectorAll("[data-attribute-key]").forEach(el => el.addEventListener("input", () => { metadataDraft.attributes[Number(el.dataset.attributeKey)].key = el.value; }));
    document.querySelectorAll("[data-attribute-value]").forEach(el => el.addEventListener("input", () => { metadataDraft.attributes[Number(el.dataset.attributeValue)].value = el.value; }));
    document.querySelectorAll("[data-remove-attribute]").forEach(el => el.addEventListener("click", () => { metadataDraft.attributes.splice(Number(el.dataset.removeAttribute), 1); render(); }));
    document.getElementById("add-attribute")?.addEventListener("click", () => { metadataDraft.attributes.push({ key: "", value: "" }); render(); });
    document.getElementById("cancel-metadata")?.addEventListener("click", () => { metadataDraft = null; metadataOpen = false; render(); });
    document.getElementById("apply-metadata")?.addEventListener("click", () => {
      const keys = metadataDraft.attributes.map(item => item.key);
      if (keys.some(key => !key.trim()) || new Set(keys).size !== keys.length) {
        vscode.postMessage({ type: "edit-error-notification", message: "Attribute names must be nonempty and unique." }); return;
      }
      metadataBusy = true;
      vscode.postMessage({ type: "update-metadata", datasetId: activeDatasetId,
        description: metadataDraft.description,
        attributes: Object.fromEntries(metadataDraft.attributes.map(item => [item.key, item.value])),
        tags: metadataDraft.tags.split("\n").map(tag => tag.trim()).filter(Boolean) });
      render();
    });
    document.getElementById("remove-dataset")?.addEventListener("click", () => { datasetMenuOpen = false; render(); vscode.postMessage({ type: "remove-dataset", datasetId: activeDatasetId }); });
    document.querySelectorAll("[data-edit-row]").forEach(el => {
      const edit = () => {
        if (loadingPage) return;
        const index = Number(el.dataset.editRow);
        vscode.postMessage({ type: "edit-cell", datasetId: activeDatasetId,
          rowId: value.row_ids[index], column: el.dataset.editColumn, value: rows()[index][el.dataset.editColumn] });
      };
      el.addEventListener("dblclick", edit);
      el.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); edit(); } });
    });

    document.getElementById("add-column-toggle")?.addEventListener("click", () => {
      const form = document.getElementById("add-column-form");
      form.hidden = !form.hidden;
      document.getElementById("add-column-toggle").setAttribute("aria-expanded", String(!form.hidden));
    });
    document.getElementById("add-column-form")?.addEventListener("submit", event => {
      event.preventDefault();
      vscode.postMessage({ type: "add-column", datasetId: activeDatasetId,
        column: document.getElementById("new-column-name").value,
        value: document.getElementById("new-column-value").value });
    });

    const restoredColumnMenu = document.getElementById("column-menu");
    if (restoredColumnMenu) restoredColumnMenu.scrollTop = columnMenuScrollTop;

    document.getElementById("columns-button")?.addEventListener("click", (e) => { e.stopPropagation(); datasetMenuOpen = false; moreActionsOpen = false; columnMenuOpen = !columnMenuOpen; filterMenuOpen = false; render();
      document.getElementById("add-column-toggle")?.focus?.(); });
    document.querySelector("[data-action='all-columns']")?.addEventListener("click", () => { columnMenuScrollTop = document.getElementById("column-menu")?.scrollTop || 0; selectedColumns = allSelected ? [] : [...cols]; render(); });
    document.querySelectorAll("[data-column]").forEach((el) => el.addEventListener("click", () => toggleColumn(el.dataset.column)));
    document.querySelectorAll("[data-move-column]").forEach((el) => el.addEventListener("click", () => moveColumn(el.dataset.moveColumn, Number(el.dataset.offset))));
    document.getElementById("filter-button")?.addEventListener("click", (e) => { e.stopPropagation(); datasetMenuOpen = false; moreActionsOpen = false; filterMenuOpen = !filterMenuOpen; columnMenuOpen = false; render();
      document.getElementById("add-filter")?.focus?.(); });
    document.getElementById("add-filter")?.addEventListener("click", () => { filters.push({ id: ++filterSequence, column: cols[0] || "", operator: "text_eq", value: "" }); render(); });
    document.getElementById("add-peak-filter")?.addEventListener("click", () => { filters.push({ id: ++filterSequence, operator: "spectrum_peak", mz: "", tolerance: "", tolerance_unit: "Da", intensity: "0" }); render(); });
    document.querySelectorAll("[data-filter-id]").forEach((row) => {
      const filter = filters.find((item) => item.id === Number(row.dataset.filterId));
      row.querySelector("[data-filter-target]")?.addEventListener("change", (event) => {
        filter.column = event.target.value;
      });
      row.querySelectorAll("[data-filter-field]").forEach((control) => control.addEventListener("input", () => { filter[control.dataset.filterField] = control.value; }));
      const slider = row.querySelector("[data-intensity-slider]");
      const intensityInput = row.querySelector('[data-filter-field="intensity"]');
      slider?.addEventListener("input", () => { filter.intensity = slider.value; intensityInput.value = slider.value; });
      intensityInput?.addEventListener("input", () => { slider.value = intensityInput.value; });
      row.querySelector(".remove-filter")?.addEventListener("click", () => { filters = filters.filter((item) => item !== filter); render(); });
    });
    document.getElementById("clear-filters")?.addEventListener("click", () => { filters = []; refreshView(); });
    document.getElementById("apply-filters")?.addEventListener("click", refreshView);
    document.querySelectorAll("[data-sort-column]").forEach((el) => el.addEventListener("click", () => {
      const column = el.dataset.sortColumn;
      const index = rowSort.findIndex((item) => item.column === column);
      if (index < 0) rowSort.push({ column, direction: "asc" });
      else if (rowSort[index].direction === "asc") rowSort[index] = { column, direction: "desc" };
      else rowSort.splice(index, 1);
      refreshView();
    }));
    document.getElementById("dataset-select")?.addEventListener("click", (e) => {
      e.stopPropagation(); datasetMenuOpen = !datasetMenuOpen;
      moreActionsOpen = false; columnMenuOpen = false; filterMenuOpen = false; render();
      if (datasetMenuOpen) document.querySelector('.dataset-option[aria-selected="true"]')?.focus();
      else document.getElementById("dataset-select")?.focus();
    });
    const switchDataset = datasetId => {
      datasetMenuOpen = false;
      moreActionsOpen = false; columnMenuOpen = false; filterMenuOpen = false;
      metadataDraft = null; metadataOpen = false;
      activeDatasetId = datasetId;
      structureCounts = null;
      calculatingStructureCounts = false;
      const savedPage = datasetPages.get(activeDatasetId) ?? 0;
      loadingPage = true;
      selectedSpectrumIndex = null;
      filters = [];
      rowSort = [];
      selectedColumns = [];
      knownColumnsKey = "";
      render();
      vscode.postMessage(viewRequest(savedPage));
    };
    document.getElementById("dataset-select")?.addEventListener("change", event => switchDataset(event.currentTarget.value));
    document.querySelectorAll("[data-dataset-id]").forEach(el => el.addEventListener("click", () => switchDataset(el.dataset.datasetId)));
    document.getElementById("dataset-menu")?.addEventListener("keydown", e => {
      const items = [...document.querySelectorAll("#dataset-menu button:not(:disabled)")];
      const index = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); items[(index + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    });
    document.getElementById("similarity-button")?.addEventListener("click", () => {
      moreActionsOpen = false; calculatingSimilarity = true; render();
      vscode.postMessage({ type: "calculate-similarity", datasetId: activeDatasetId });
    });
    document.getElementById("settings-button")?.addEventListener("click", () => {
      moreActionsOpen = false; render(); vscode.postMessage({ type: "open-settings" });
    });
    document.getElementById("add-dataset")?.addEventListener("click", () => { datasetMenuOpen = false; render(); vscode.postMessage({ type: "add-dataset" }); });
    document.getElementById("assign-spec-id-button")?.addEventListener("click", () => {
      moreActionsOpen = false; assigningSpecId = true;
      render();
      vscode.postMessage({ type: "assign-spec-id", datasetId: activeDatasetId, hasSpecId: columns().includes("SpecID") });
    });
    document.getElementById("structure-counts-button")?.addEventListener("click", () => {
      moreActionsOpen = false;
      calculatingStructureCounts = true;
      render();
      vscode.postMessage({ type: "calculate-structure-counts", datasetId: activeDatasetId, filters });
    });
    document.getElementById("export-button")?.addEventListener("click", requestExport);
    document.getElementById("reload-button")?.addEventListener("click", () => { structureCounts = null; loadingPage = true; selectedSpectrumIndex = null; render(); vscode.postMessage({ type: "reload", datasetId: activeDatasetId, filters, sort: rowSort }); });
    document.getElementById("prev-page")?.addEventListener("click", () => requestPage(page() - 1));
    document.getElementById("next-page")?.addEventListener("click", () => requestPage(page() + 1));
    const pageInput = document.getElementById("page-input");
    const go = () => { const n = Number.parseInt(pageInput.value, 10); if (Number.isFinite(n)) requestPage(n - 1); };
    pageInput?.addEventListener("change", go);
    pageInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    document.querySelectorAll("[data-spectrum-index]").forEach((el) => el.addEventListener("click", () => openSpectrum(Number(el.dataset.spectrumIndex))));
    document.querySelectorAll("[data-structure-index]").forEach((el) => el.addEventListener("click", () => {
      const row = rows()[Number(el.dataset.structureIndex)] || {};
      const smiles = smilesColumn ? String(row[smilesColumn] ?? "").trim() : "";
      if (!chemistryCapabilities.structure_render || !smiles) return;
      closeStructurePreview();
      structurePreview = { smiles, url: null };
      render();
      vscode.postMessage({ type: "render-structure", smiles });
    }));
    document.getElementById("close-structure")?.addEventListener("click", () => { closeStructurePreview(); render(); });
    document.getElementById("structure-backdrop")?.addEventListener("click", event => { if (event.target.id === "structure-backdrop") { closeStructurePreview(); render(); } });
  }

  function closeStructurePreview() {
    if (structurePreview?.url) URL.revokeObjectURL(structurePreview.url);
    structurePreview = null;
  }

  function openSpectrum(index) {
    const spectrum = spectra()[index] ?? { mz: [], intensity: [] };
    const row = rows()[index] ?? {};
    const globalIndex = rowOffset() + index;
    selectedSpectrumIndex = index;
    render();
    vscode.postMessage({
      type: "open-spectrum",
      payload: {
        spectrum,
        row,
        columns: columns(),
        globalIndex,
        rowId: value.row_ids[index],
        title: titleFor(row, globalIndex),
        datasetId: activeDatasetId,
        datasetName: value.dataset_name || filename,
        datasetPath: value.dataset_path || ""
      }
    });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "backend-ready") {
      loadingProgress = null;
      if (message.dataset) {
        datasetOptions = [message.dataset];
        activeDatasetId = message.dataset.id;
        datasetPages.set(activeDatasetId, 0);
      }
      vscode.postMessage({ type: "ready", datasetId: activeDatasetId });
    } else if (message?.type === "capabilities") {
      chemistryCapabilities = { ...chemistryCapabilities, ...(message.chemistry || {}) };
      render();
    } else if (message?.type === "dataset-added") {
      metadataDraft = null; metadataOpen = false;
      const dataset = message.dataset;
      if (dataset && !datasetOptions.some((item) => item.id === dataset.id)) datasetOptions.push(dataset);
      if (dataset) {
        activeDatasetId = dataset.id;
        structureCounts = null;
        calculatingStructureCounts = false;
        filters = [];
        rowSort = [];
        selectedColumns = [];
        knownColumnsKey = "";
        if (!datasetPages.has(activeDatasetId)) datasetPages.set(activeDatasetId, 0);
      }
    } else if (message?.type === "dataset-reloaded") {
      structureCounts = null;
      changedDatasets.delete(message.dataset_id);
      if (activeDatasetId === message.dataset_id) metadataDraft = null;
    } else if (message?.type === "dataset-removed") {
      datasetOptions = datasetOptions.filter(item => item.id !== message.dataset_id);
      datasetPages.delete(message.dataset_id);
      changedDatasets.delete(message.dataset_id);
      if (activeDatasetId === message.dataset_id) {
        activeDatasetId = datasetOptions[0]?.id || "";
        structureCounts = null;
        calculatingStructureCounts = false;
        filters = []; rowSort = []; selectedColumns = []; knownColumnsKey = "";
        metadataDraft = null; metadataOpen = false; datasetMenuOpen = false;
        moreActionsOpen = false; columnMenuOpen = false; filterMenuOpen = false;
        selectedSpectrumIndex = null;
        loadingPage = Boolean(activeDatasetId);
        if (activeDatasetId) vscode.postMessage(viewRequest(datasetPages.get(activeDatasetId) || 0));
        else value = null;
      }
      render();
    } else if (message?.type === "column-added" || message?.type === "peak-columns-updated" || message?.type === "peak-record") {
      structureCounts = null;
      if (message.type !== "peak-record" || message.modified) changedDatasets.add(message.dataset_id);
      if (message.dataset_id === activeDatasetId) {
        if (message.type === "column-added") {
          const updatedColumns = [...columns(), message.column];
          selectedColumns.push(message.column);
          value.all_columns = updatedColumns;
          knownColumnsKey = JSON.stringify(updatedColumns);
        }
        if (message.type === "peak-record") {
          const index = value.row_ids.indexOf(message.row_id);
          if (index >= 0) value.spectra[index] = { ...value.spectra[index], ...message.spectrum };
        } else {
          loadingPage = true;
          vscode.postMessage(viewRequest(page()));
        }
      }
      render();
    } else if (message?.type === "metadata-updated") {
      structureCounts = null;
      metadataBusy = false;
      changedDatasets.add(message.dataset_id);
      if (activeDatasetId === message.dataset_id) {
        if (message.metadata) {
          // Rebuild the form only after replacing the old values with the
          // metadata accepted by the backend.
          value = { ...value, ...message.metadata };
          metadataDraft = null;
        } else {
          // Spectrum cell edits affect filtering and sorting; reload the table
          // without discarding an unrelated dataset metadata draft.
          loadingPage = true;
          vscode.postMessage(viewRequest(page()));
        }
      }
      render();
    } else if (message?.type === "edit-error") {
      metadataBusy = false;
      render();
      vscode.postMessage({ type: "edit-error-notification", message: message.message });
    } else if (message?.type === "loading-progress") {
      loadingProgress = message;
      renderLoading(`Reading ${String(message.file_type || "dataset").toUpperCase()}…`);
    } else if (message?.type === "dataset-page") {
      value = message.value;
      activeDatasetId = String(value?.dataset_id || activeDatasetId);
      datasetPages.set(activeDatasetId, Number.isInteger(value?.page) ? value.page : 0);
      loadingProgress = null;
      loadingPage = false;
      columnMenuOpen = false;
      filterMenuOpen = false;
      selectedSpectrumIndex = null;
      render();
    } else if (message?.type === "structure-rendered") {
      closeStructurePreview();
      const blob = new Blob([String(message.svg || "")], { type: "image/svg+xml" });
      structurePreview = { smiles: String(message.smiles || ""), url: URL.createObjectURL(blob) };
      render();
      document.getElementById("close-structure")?.focus();
    } else if (message?.type === "structure-counts") {
      calculatingStructureCounts = false;
      if (message.dataset_id === activeDatasetId) structureCounts = message;
      render();
    } else if (message?.type === "structure-counts-error") {
      calculatingStructureCounts = false;
      render();
      vscode.postMessage({ type: "structure-counts-error-notification", message: message.message || "Could not count structures." });
    } else if (message?.type === "chemistry-error") {
      closeStructurePreview();
      render();
      vscode.postMessage({ type: "chemistry-error-notification", message: message.message || "Chemistry operation failed." });
    } else if (message?.type === "filter-error") {
      loadingPage = false;
      render();
      vscode.postMessage({ type: "filter-error-notification", message: message.message || "Invalid filter." });
    } else if (message?.type === "spec-id-complete") {
      assigningSpecId = false;
      changedDatasets.add(message.dataset_id);
      if (message.dataset_id === activeDatasetId) {
        if (!selectedColumns.includes("SpecID")) selectedColumns.push("SpecID");
        loadingPage = true;
        selectedSpectrumIndex = null;
        vscode.postMessage(viewRequest(page()));
      }
      render();
      vscode.postMessage({ type: "spec-id-notification", totalRows: message.total_rows });
    } else if (message?.type === "spec-id-cancelled" || message?.type === "spec-id-error") {
      assigningSpecId = false;
      render();
      if (message.type === "spec-id-error") vscode.postMessage({ type: "spec-id-error-notification", message: message.message });
    } else if (message?.type === "export-start") {
      exporting = true;
      exportProgress = 0;
      render();
    } else if (message?.type === "export-progress") {
      exporting = true;
      exportProgress = Number.isFinite(Number(message.percent)) ? Number(message.percent) : null;
      render();
    } else if (message?.type === "export-complete") {
      exporting = false;
      exportProgress = null;
      render();
      vscode.postMessage({ type: "export-notification", path: message.path, totalRows: message.total_rows });
    } else if (message?.type === "export-cancelled") {
      exporting = false;
      exportProgress = null;
      render();
    } else if (message?.type === "export-error") {
      exporting = false;
      exportProgress = null;
      render();
      vscode.postMessage({ type: "export-error-notification", message: message.message });
    } else if (message?.type === "similarity-progress") {
      calculatingSimilarity = true;
      similarityProgress = Number.isFinite(Number(message.percent)) ? Number(message.percent) : null;
      render();
    } else if (["similarity-complete", "similarity-cancelled", "similarity-error"].includes(message?.type)) {
      calculatingSimilarity = false;
      similarityProgress = null;
      render();
      if (message.type === "similarity-error") vscode.postMessage({ type: "similarity-error-notification", message: message.message });
    } else if (message?.type === "error") {
      calculatingSimilarity = false;
      exporting = false;
      exportProgress = null;
      renderError(message.title || "Error", message.message || "Unknown error");
    }
  });

  function requestExport() {
    if (!value || !activeDatasetId || exporting || loadingPage || metadataBusy) return;
    datasetMenuOpen = false; moreActionsOpen = false; columnMenuOpen = false; filterMenuOpen = false;
    exporting = true; render();
    vscode.postMessage({type: "export-dataset", datasetId: activeDatasetId,
      datasetPath: value.dataset_path, filters, sort: rowSort, columns: selectedColumns});
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (!e.repeat) requestExport();
      return;
    }
    if (e.key === "Escape" && structurePreview) {
      e.preventDefault(); closeStructurePreview(); render();
    } else if (e.key === "Escape" && (datasetMenuOpen || moreActionsOpen || columnMenuOpen || filterMenuOpen)) {
      const focusTarget = datasetMenuOpen ? "dataset-select" : columnMenuOpen ? "columns-button" : filterMenuOpen ? "filter-button" : "more-actions-button";
      e.preventDefault(); datasetMenuOpen = false; moreActionsOpen = false; columnMenuOpen = false; filterMenuOpen = false;
      render(); document.getElementById(focusTarget)?.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (datasetMenuOpen && !e.target.closest?.(".dataset-info")) { datasetMenuOpen = false; render(); }
    else if (moreActionsOpen && !e.target.closest?.(".more-actions")) { moreActionsOpen = false; render(); }
    else if (columnMenuOpen && !e.target.closest?.(".columns")) { columnMenuOpen = false; render(); }
    else if (filterMenuOpen && !e.target.closest?.(".filters")) { filterMenuOpen = false; render(); }
  });

  let dragDepth = 0;
  const isFileDrag = e => [...(e.dataTransfer?.types || [])].some(t => ["Files", "text/uri-list", "CodeFiles"].includes(t));
  document.addEventListener("dragenter", e => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); dragDepth++; app.classList.add("dataset-drop-active");
  });
  document.addEventListener("dragover", e => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) { dragDepth = 0; app.classList.remove("dataset-drop-active"); }
  });
  document.addEventListener("drop", async e => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); dragDepth = 0; app.classList.remove("dataset-drop-active");
    const supported = name => /\.(msds|msp|mgf|tsv|csv)$/i.test(name);
    const codeFiles = e.dataTransfer.getData("CodeFiles");
    const uris = e.dataTransfer.getData("text/uri-list").split(/\r?\n/).filter(u => u && !u.startsWith("#"));
    try {
      if (codeFiles) {
        const paths = JSON.parse(codeFiles).filter(supported);
        if (!paths.length) throw new Error("Drop an MSDS, MSP, MGF, TSV, or CSV file.");
        vscode.postMessage({type: "drop-datasets", paths});
      } else if (uris.length && uris.every(u => /^(file|vscode-remote):/.test(u))) {
        const selected = uris.filter(u => supported(u.split(/[?#]/)[0]));
        if (!selected.length) throw new Error("Drop an MSDS, MSP, MGF, TSV, or CSV file.");
        vscode.postMessage({type: "drop-datasets", uris: selected});
      } else {
        const files = [...e.dataTransfer.files].filter(f => supported(f.name));
        if (!files.length) throw new Error("Drop an MSDS, MSP, MGF, TSV, or CSV file.");
        for (const file of files) {
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]);
            reader.onerror = () => reject(new Error(`Could not read ${file.name}`)); reader.readAsDataURL(file);
          });
          vscode.postMessage({type: "drop-datasets", files: [{name: file.name, data}]});
        }
      }
    } catch (error) { vscode.postMessage({type: "edit-error-notification", message: error.message}); }
  });

  renderLoading();
  // Messages posted before this point would be lost: the host holds them
  // until it receives this.
  vscode.postMessage({ type: "webview-ready" });
})();
