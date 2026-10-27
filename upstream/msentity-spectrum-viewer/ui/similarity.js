(() => {
  // The VS Code webview API, or a host object { postMessage(message) } provided by
  // the embedding page as window.msentityViewerHost (see ui/README.md).
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : window.msentityViewerHost;
  const app = document.getElementById("app");
  const saved = vscode.getState() || {};
  let value = null;
  let filters = saved.filters || [];
  let draftFilters = filters.map((f) => ({ ...f }));
  let sort = saved.sort || null;
  let bins = saved.bins || 20;
  let chartType = saved.chartType || "histogram";
  let countScale = saved.countScale || "linear";
  let chartColor = saved.chartColor || "#3794ff";
  let boxColor = saved.boxColor || "#d18616";
  let showGrid = saved.showGrid !== false;
  let exportOpen = false;
  let imageSaving = false;
  let showFilters = false;
  let busy = true;
  let error = "";
  let notice = "";
  let chartGeometry = null;
  let observer;
  const esc = (text) => String(text ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const number = (n) => n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 5 });
  const operators = [[">=", "≥"], ["<=", "≤"], [">", ">"], ["<", "<"],
    ["numeric_eq", "= (number)"], ["text_eq", "= (text)"], ["!=", "≠ (text)"], ["contains", "Contains"]];

  function request(type = "page-request", page = 0) {
    busy = true; error = ""; notice = "";
    vscode.setState({ filters, sort, bins, chartType, countScale, chartColor, boxColor, showGrid });
    render();
    vscode.postMessage({ type, page, filters, sort, bins });
  }

  function render() {
    observer?.disconnect();
    const disabled = busy ? "disabled" : "";
    const mode = value?.metadata?.mode;
    const method = value?.metadata?.parameters?.method === "reverse_cosine"
      ? "Reverse cosine similarity" : "Cosine similarity";
    const subtitle = mode === "library_search"
      ? `${method} library search · all query/reference pairs · threshold ${number(value?.metadata?.parameters?.threshold)}`
      : `${method} for unique metadata keys shared by both datasets`;
    app.innerHTML = `
      <header><div><span class="eyebrow">MSENTITY · SIMILARITY</span><h1>${esc(app.dataset.filename)}</h1>
        <p>${esc(subtitle)}</p></div>
        <nav aria-label="Result actions"><button id="filter" ${disabled}>Filter${filters.length ? ` (${filters.length})` : ""}</button>
        <button id="export" ${disabled || !value ? "disabled" : ""}>Export…</button>
        <button id="reload" ${disabled}>Reload</button></nav></header>
      <div role="status" class="message">${busy ? "Processing…" : esc(notice)}</div>
      ${error ? `<div role="alert" class="error">${esc(error)}</div>` : ""}
      ${showFilters && value ? `<section class="filter-panel"><h2>Filter results</h2>
        <p>All conditions must match. Filters apply to the table, histogram, statistics, and export.</p>
        ${draftFilters.map((filter, index) => `<div class="filter-row" data-filter="${index}">
          <select aria-label="Filter column">${value.columns.map((column) => `<option ${filter.column === column ? "selected" : ""}>${esc(column)}</option>`).join("")}</select>
          <select aria-label="Filter operator">${operators.map(([op, label]) => `<option value="${esc(op)}" ${filter.operator === op ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>
          <input aria-label="Filter value" value="${esc(filter.value)}" />
          <button data-remove="${index}" aria-label="Remove filter">Remove</button></div>`).join("")}
        <div class="actions"><button id="add-filter">Add condition</button><button id="apply" class="primary">Apply</button><button id="clear">Clear all</button></div>
      </section>` : ""}
      ${value ? `
        <section class="stats" aria-label="Filtered result statistics">
          <div><span>Matched rows</span><strong>${number(value.total_rows)} <small>/ ${number(value.unfiltered_rows)}</small></strong></div>
          <div><span>Stored data</span><strong>${value.has_matched_data ? `${number(value.matched_data_rows[0])} + ${number(value.matched_data_rows[1])}` : "Lightweight"}</strong></div>
          ${Object.entries(value.statistics).map(([key, n]) => `<div><span>${esc(key)}</span><strong>${number(n)}</strong></div>`).join("")}
        </section>
        <section class="distribution"><div class="section-title"><div><h2>Similarity distribution</h2>
          <p>${chartType === "histogram" ? `Frequency across all ${number(value.total_rows)} filtered rows. Click a bar to filter its range.` : "Box plot across all filtered rows, showing minimum, Q1, median, Q3, and maximum."}</p></div>
          <div class="chart-controls"><label>Plot <select id="chart-type" ${disabled}><option value="histogram" ${chartType === "histogram" ? "selected" : ""}>Histogram</option><option value="box" ${chartType === "box" ? "selected" : ""}>Box plot</option></select></label>
          <label>Count <select id="count-scale" ${disabled || chartType !== "histogram" ? "disabled" : ""}><option value="linear" ${countScale === "linear" ? "selected" : ""}>Linear</option><option value="log" ${countScale === "log" ? "selected" : ""}>Log₁₀</option></select></label>
          <label>Bins <input id="bins" type="number" min="1" max="200" step="1" value="${bins}" ${disabled || chartType !== "histogram" ? "disabled" : ""} /></label>
          <button id="save-chart" ${disabled}>Save PNG…</button></div></div>
          <canvas id="histogram" role="img" aria-label="${chartType === "histogram" ? "Similarity score histogram" : "Similarity score box plot"}"></canvas>
          <div id="chart-hint" class="hint" aria-live="polite">${imageSaving ? "Waiting for the PNG save location…" : chartType === "histogram" ? `Range: 0–1 · vertical axis: ${countScale === "log" ? "log₁₀(count + 1)" : "count"}` : "Whiskers show the observed minimum and maximum"}</div>
          <details><summary>Frequency table</summary><div class="frequency-table"><table><thead><tr><th>Similarity range</th><th>Count</th><th>Filter</th></tr></thead>
          <tbody>${value.histogram.counts.map((count, i) => `<tr><td>${rangeLabel(i)}</td><td>${number(count)}</td><td><button data-bin="${i}" ${disabled}>Show rows</button></td></tr>`).join("")}</tbody></table></div></details>
        </section>
        <section><div class="section-title"><h2>Comparison results</h2><span>Indices are zero-based input positions</span></div>
        <div class="table-scroll"><table><thead><tr>${value.has_matched_data ? "<th>Match</th>" : ""}${value.columns.map((column) => `<th aria-sort="${sort?.column === column ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}"><button data-sort="${esc(column)}" ${disabled}>${esc(column)} ${sort?.column === column ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button></th>`).join("")}</tr></thead>
        <tbody>${value.rows.length ? value.rows.map((row, index) => `<tr>${value.has_matched_data ? `<td><button data-open-match="${Number(value.result_indices[index])}" ${disabled}>Open spectra</button></td>` : ""}${value.columns.map((column) => `<td>${column === "cosine_similarity" ? number(row[column]) : esc(typeof row[column] === "object" && row[column] !== null ? JSON.stringify(row[column]) : row[column])}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${value.columns.length + (value.has_matched_data ? 1 : 0)}" class="empty">No matching rows</td></tr>`}</tbody></table></div>
        <footer><button id="previous" ${busy || value.page === 0 ? "disabled" : ""}>Previous</button><span>Page ${value.page + 1} / ${value.total_pages}</span><button id="next" ${busy || value.page + 1 >= value.total_pages ? "disabled" : ""}>Next</button></footer></section>
        <details class="metadata"><summary>Calculation metadata</summary><p>Reload reads the saved result. Recalculate from the dataset viewer to use changed spectra.</p><pre>${esc(JSON.stringify(value.metadata, null, 2))}</pre></details>
      ` : "<p>Opening similarity results…</p>"}
      ${exportOpen ? `<dialog id="chart-export" class="chart-dialog" open><form method="dialog"><h2>Save distribution as PNG</h2>
        <div class="export-options"><label>Width <input id="image-width" type="number" min="200" max="16384" value="1200"> px</label>
        <label>Height <input id="image-height" type="number" min="200" max="16384" value="720"> px</label>
        <label><input id="image-grid" type="checkbox" ${showGrid ? "checked" : ""}> Show grid</label>
        <label>Histogram color <input id="image-color" type="color" value="${esc(chartColor)}"></label>
        <label>Box color <input id="image-box-color" type="color" value="${esc(boxColor)}"></label>
        <label>Count scale <select id="image-scale" ${chartType !== "histogram" ? "disabled" : ""}><option value="linear" ${countScale === "linear" ? "selected" : ""}>Linear</option><option value="log" ${countScale === "log" ? "selected" : ""}>Log₁₀</option></select></label></div>
        <canvas id="export-preview" aria-label="PNG preview"></canvas><div class="actions"><button id="cancel-chart" type="button">Cancel</button><button id="confirm-chart" type="button" class="primary" ${imageSaving ? "disabled" : ""}>${imageSaving ? "Preparing PNG…" : "Save PNG"}</button></div></form></dialog>` : ""}`;

    document.getElementById("filter")?.addEventListener("click", () => { showFilters = !showFilters; draftFilters = filters.map((f) => ({ ...f })); render(); });
    document.getElementById("reload")?.addEventListener("click", () => request("reload"));
    document.getElementById("export")?.addEventListener("click", () => request("export-similarity"));
    document.getElementById("add-filter")?.addEventListener("click", () => {
      draftFilters.push({ column: "cosine_similarity", operator: ">=", value: "0.8" }); render();
    });
    document.querySelectorAll("[data-filter]").forEach((row) => {
      const filter = draftFilters[Number(row.dataset.filter)];
      const selects = row.querySelectorAll("select");
      selects[0].addEventListener("change", (e) => { filter.column = e.target.value; });
      selects[1].addEventListener("change", (e) => { filter.operator = e.target.value; });
      row.querySelector("input").addEventListener("input", (e) => { filter.value = e.target.value; });
      row.querySelector("button").addEventListener("click", () => { draftFilters.splice(Number(row.dataset.filter), 1); render(); });
    });
    document.getElementById("apply")?.addEventListener("click", () => { filters = draftFilters.map((f) => ({ ...f })); showFilters = false; request(); });
    document.getElementById("clear")?.addEventListener("click", () => { filters = []; draftFilters = []; request(); });
    document.getElementById("bins")?.addEventListener("change", (e) => {
      const count = Number(e.target.value);
      if (!Number.isInteger(count) || count < 1 || count > 200) {
        error = "Histogram bins must be an integer between 1 and 200."; render(); return;
      }
      bins = count; request("page-request", value.page);
    });
    document.getElementById("chart-type")?.addEventListener("change", (e) => { chartType = e.target.value; render(); });
    document.getElementById("count-scale")?.addEventListener("change", (e) => { countScale = e.target.value; render(); });
    document.getElementById("save-chart")?.addEventListener("click", () => { exportOpen = true; render(); });
    document.getElementById("cancel-chart")?.addEventListener("click", () => { exportOpen = false; render(); });
    for (const id of ["image-width", "image-height", "image-grid", "image-color", "image-box-color", "image-scale"]) {
      document.getElementById(id)?.addEventListener("input", drawExportPreview);
      document.getElementById(id)?.addEventListener("change", drawExportPreview);
    }
    document.getElementById("confirm-chart")?.addEventListener("click", saveChartPng);
    document.querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => {
      const column = button.dataset.sort;
      sort = { column, direction: sort?.column === column && sort.direction === "asc" ? "desc" : "asc" };
      request();
    }));
    document.querySelectorAll("[data-open-match]").forEach((button) => button.addEventListener("click", () => {
      vscode.postMessage({ type: "open-similarity-match", resultIndex: Number(button.dataset.openMatch) });
    }));
    document.getElementById("previous")?.addEventListener("click", () => request("page-request", value.page - 1));
    document.getElementById("next")?.addEventListener("click", () => request("page-request", value.page + 1));
    document.querySelectorAll("[data-bin]").forEach((button) => button.addEventListener("click", () => filterBin(Number(button.dataset.bin))));
    const canvas = document.getElementById("histogram");
    if (canvas) {
      observer = new ResizeObserver(drawChart); observer.observe(canvas);
      canvas.addEventListener("mousemove", (event) => {
        const i = binAt(event);
        document.getElementById("chart-hint").textContent = i === null ? "Range: 0–1 · vertical axis: frequency" : `${rangeLabel(i)}: ${number(value.histogram.counts[i])} rows`;
      });
      canvas.addEventListener("click", (event) => { const i = binAt(event); if (i !== null) filterBin(i); });
      drawChart();
    }
    if (exportOpen) drawExportPreview();
  }

  function rangeLabel(i) {
    const { edges, counts } = value.histogram;
    return `[${number(edges[i])}, ${number(edges[i + 1])}${i === counts.length - 1 ? "]" : ")"}`;
  }
  function filterBin(i) {
    if (busy) return;
    const { edges, counts } = value.histogram;
    filters = filters.filter((f) => f.column !== "cosine_similarity");
    filters.push({ column: "cosine_similarity", operator: ">=", value: String(edges[i]) },
      { column: "cosine_similarity", operator: i === counts.length - 1 ? "<=" : "<", value: String(edges[i + 1]) });
    draftFilters = filters.map((f) => ({ ...f })); showFilters = true; request();
  }
  function binAt(event) {
    if (!chartGeometry) return null;
    const { left, top, width, height } = chartGeometry;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (x < left || x >= left + width || y < top || y > top + height) return null;
    return Math.min(value.histogram.counts.length - 1, Math.floor((x - left) / width * value.histogram.counts.length));
  }
  function drawChart() {
    const canvas = document.getElementById("histogram");
    if (!canvas || !value) return;
    renderChart(canvas, canvas.clientWidth, 260, { grid: showGrid, histogramColor: chartColor,
      boxColor, scale: countScale, pixelRatio: window.devicePixelRatio || 1 });
  }

  function renderChart(canvas, width, height, options) {
    const scale = options.pixelRatio || 1;
    canvas.width = width * scale; canvas.height = height * scale;
    const ctx = canvas.getContext("2d"); ctx.scale(scale, scale);
    const styles = getComputedStyle(document.body);
    const foreground = styles.getPropertyValue("--vscode-foreground").trim() || "#ddd";
    const accent = options.histogramColor;
    const left = 64, top = 18, plotWidth = Math.max(1, width - 82), plotHeight = height - 62;
    if (canvas.id === "histogram") {
      chartGeometry = { left, top, width: plotWidth, height: plotHeight };
    }
    if (chartType === "box") {
      drawBoxPlot(ctx, { left, top, plotWidth, plotHeight, foreground, color: options.boxColor, grid: options.grid });
      return;
    }
    const counts = value.histogram.counts;
    const transformed = counts.map((count) => options.scale === "log" ? Math.log10(count + 1) : count);
    const observedMax = Math.max(1, ...transformed), tickCount = 4;
    const maximum = Math.ceil(observedMax / tickCount) * tickCount;
    ctx.font = "12px sans-serif";
    for (let tick = 0; tick <= tickCount; tick++) {
      const y = top + plotHeight * (1 - tick / tickCount);
      if (options.grid) { ctx.globalAlpha = 0.15; ctx.strokeStyle = foreground;
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + plotWidth, y); ctx.stroke(); }
      ctx.globalAlpha = 1; ctx.fillStyle = foreground; ctx.textAlign = "right";
      const label = options.scale === "log" ? Math.max(0, Math.pow(10, maximum * tick / tickCount) - 1) : maximum * tick / tickCount;
      ctx.fillText(number(label), left - 8, y + 4);
    }
    ctx.fillStyle = accent;
    transformed.forEach((count, i) => {
      const h = count / maximum * plotHeight;
      ctx.fillRect(left + i / counts.length * plotWidth + 1, top + plotHeight - h,
        Math.max(1, plotWidth / counts.length - 2), h);
    });
    ctx.fillStyle = foreground; ctx.textAlign = "center";
    for (let i = 0; i <= 5; i++) ctx.fillText((i / 5).toFixed(1), left + plotWidth * i / 5, top + plotHeight + 20);
    ctx.fillText("Similarity score", left + plotWidth / 2, height - 4);
    ctx.textAlign = "left"; ctx.fillText("Count", 0, 12);
  }

  function drawBoxPlot(ctx, options) {
    const { left, top, plotWidth, plotHeight, foreground, color, grid } = options;
    const y = top + plotHeight / 2, boxHeight = Math.min(100, plotHeight * .5);
    const x = (n) => left + Number(n || 0) * plotWidth;
    ctx.font = "12px sans-serif";
    if (grid) for (let i = 0; i <= 5; i++) { const gx = left + plotWidth * i / 5;
      ctx.globalAlpha = .15; ctx.strokeStyle = foreground; ctx.beginPath(); ctx.moveTo(gx, top); ctx.lineTo(gx, top + plotHeight); ctx.stroke(); }
    ctx.globalAlpha = 1; ctx.strokeStyle = foreground; ctx.fillStyle = color; ctx.lineWidth = 2;
    const stats = value.statistics;
    if (stats.min != null) {
      ctx.beginPath(); ctx.moveTo(x(stats.min), y); ctx.lineTo(x(stats.q1), y); ctx.moveTo(x(stats.q3), y); ctx.lineTo(x(stats.max), y);
      ctx.moveTo(x(stats.min), y - 20); ctx.lineTo(x(stats.min), y + 20); ctx.moveTo(x(stats.max), y - 20); ctx.lineTo(x(stats.max), y + 20); ctx.stroke();
      ctx.globalAlpha = .72; ctx.fillRect(x(stats.q1), y - boxHeight / 2, Math.max(1, x(stats.q3) - x(stats.q1)), boxHeight);
      ctx.globalAlpha = 1; ctx.strokeRect(x(stats.q1), y - boxHeight / 2, Math.max(1, x(stats.q3) - x(stats.q1)), boxHeight);
      ctx.beginPath(); ctx.moveTo(x(stats.median), y - boxHeight / 2); ctx.lineTo(x(stats.median), y + boxHeight / 2); ctx.stroke();
    }
    ctx.fillStyle = foreground; ctx.textAlign = "center";
    for (let i = 0; i <= 5; i++) ctx.fillText((i / 5).toFixed(1), left + plotWidth * i / 5, top + plotHeight + 20);
    ctx.fillText("Similarity score", left + plotWidth / 2, top + plotHeight + 40);
  }

  function exportOptions() {
    const dimension = (id, fallback) => Math.min(16384, Math.max(200, Number(document.getElementById(id)?.value) || fallback));
    return { width: dimension("image-width", 1200), height: dimension("image-height", 720),
      grid: Boolean(document.getElementById("image-grid")?.checked),
      histogramColor: document.getElementById("image-color")?.value || chartColor,
      boxColor: document.getElementById("image-box-color")?.value || boxColor,
      scale: document.getElementById("image-scale")?.value || countScale };
  }
  function drawExportPreview() {
    const canvas = document.getElementById("export-preview"); if (!canvas) return;
    const options = exportOptions();
    renderChart(canvas, options.width, options.height, { ...options, pixelRatio: 1 });
    canvas.style.aspectRatio = `${options.width} / ${options.height}`;
  }
  function saveChartPng() {
    if (imageSaving) return;
    imageSaving = true;
    const options = exportOptions();
    chartColor = options.histogramColor; boxColor = options.boxColor;
    countScale = options.scale; showGrid = options.grid;
    const canvas = document.createElement("canvas");
    renderChart(canvas, options.width, options.height, { ...options, pixelRatio: 1 });
    render();
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
      const bytes = Array.from(binary, (character) => character.charCodeAt(0));
      if (!bytes.length) throw new Error("PNG image could not be created.");
      vscode.postMessage({ type: "save-similarity-image", filename: `similarity-${chartType}.png`, bytes });
    } catch (cause) {
      imageSaving = false;
      error = cause?.message || "PNG image could not be created.";
      render();
    }
  }

  window.addEventListener("message", ({ data: message }) => {
    if (message.type === "backend-ready") request();
    else if (message.type === "similarity-page") { value = message.value; busy = false; error = ""; render(); }
    else if (message.type === "error") { busy = false; error = message.message || "Could not process results."; render(); }
    else if (message.type === "export-cancelled") { busy = false; render(); }
    else if (message.type === "export-complete") {
      busy = false; notice = `Exported ${number(message.total_rows)} rows to ${message.path}`; render();
    }
    else if (message.type === "image-save-complete") {
      imageSaving = false; exportOpen = false; notice = `Saved PNG to ${message.path}`; render();
    }
    else if (message.type === "image-save-cancelled") {
      imageSaving = false; render();
    }
    else if (message.type === "image-save-error") {
      imageSaving = false; error = message.message || "PNG could not be saved."; render();
    }
  });
  render();
  // Messages posted before this point would be lost: the host holds them
  // until it receives this.
  vscode.postMessage({ type: "webview-ready" });
})();
