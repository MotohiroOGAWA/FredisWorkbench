(() => {
  // The VS Code webview API, or a host object { postMessage(message) } provided by
  // the embedding page as window.msentityViewerHost (see ui/README.md).
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : window.msentityViewerHost;
  const app = document.getElementById("spectrum-app");
  let state = null;
  let exportPlot = null;
  const exportDefaults = { gridLines: false, mzTickLabels: false, intensityTickLabels: false,
    peakLabels: false, width: 900, height: 540, upperColor: "#2563eb", lowerColor: "#dc2626",
    mzMin: "", mzMax: "", intensityMin: "", intensityMax: "", lowerMin: "", lowerMax: "",
    labelSize: 11, labelColor: "#000000", topK: 0, decimals: 4, peakWidth: 2.4 };
  let exportSettings = { ...exportDefaults, ...vscode.getState()?.exportSettings };
  const exportRange = (min, max, fallback) => {
    const lo = min === "" ? fallback[0] : Number(min);
    const hi = max === "" ? fallback[1] : Number(max);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi <= lo) {
      throw new Error("Ranges must have non-negative minimum and maximum greater than minimum.");
    }
    return [lo, hi];
  };
  const labelPeaks = (peaks, range, options) => {
    const eligible = peaks.filter(p => p.y >= range[0] && p.y <= range[1]);
    return options?.topK > 0
      ? eligible.slice().sort((a, b) => b.y - a.y || a.index - b.index).slice(0, options.topK)
      : eligible;
  };
  const comparison = { top: null, bottom: null, topPinned: false, bottomPinned: false };
  let similarityMethod = "dot";
  let similarityTolerance = 0.05;

  const esc = (v) => String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const display = (v) => v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);

  const peakColumns = payload => payload?.spectrum?.metadata_columns || [];
  const peakColumnViews = new Map();
  let peakMenuOpen = false;
  let peakMenuSide = "top";
  const peakColumnKey = payload => payload?.datasetId || payload?.datasetPath || payload?.datasetName || "spectrum";
  const allPeakColumns = payload => peakColumns(payload).map(c => "meta:" + c);
  const tablePeakColumns = payload => ["mz", "intensity", ...visiblePeakColumns(payload)];
  const columnLabel = id => id === "mz" ? "m/z" : id === "intensity" ? "Intensity" : id.slice(5);
  function visiblePeakColumns(payload) {
    const key = peakColumnKey(payload);
    const available = allPeakColumns(payload);
    let view = peakColumnViews.get(key);
    if (!view) view = { known: [], selected: [] };
    view.selected = view.selected.filter(id => available.includes(id));
    view.selected.push(...available.filter(id => !view.known.includes(id)));
    view.known = available;
    peakColumnViews.set(key, view);
    return view.selected;
  }
  function togglePeakColumn(payload, id) {
    if (!allPeakColumns(payload).includes(id)) return;
    const selected = visiblePeakColumns(payload);
    const view = peakColumnViews.get(peakColumnKey(payload));
    view.selected = selected.includes(id) ? selected.filter(c => c !== id) : [...selected, id];
  }
  function movePeakColumn(payload, id, offset) {
    const selected = visiblePeakColumns(payload);
    const index = selected.indexOf(id), target = index + offset;
    if (index >= 0 && target >= 0 && target < selected.length) {
      [selected[index], selected[target]] = [selected[target], selected[index]];
    }
  }
  const peakAnnotationCells = (payload, index, side) => peakColumns(payload).map((column, columnIndex) => {
    const value = index == null ? "" : payload?.spectrum?.metadata?.[index]?.[column] ?? "";
    const editable = index != null && payload?.datasetId && Number.isInteger(payload?.rowId);
    return `<td ${editable ? `tabindex="0" data-annotation-side="${side}" data-annotation-peak="${index}" data-annotation-column="${columnIndex}" title="Double-click or press Enter to edit"` : ""}>${esc(display(value))}</td>`;
  }).join("");
  const peakTableHeaders = (payload, side, comparing) => tablePeakColumns(payload).map(id => {
    if (id === "mz") return '<th><button class="sort-button" data-sort-mz>m/z ↑</button></th>';
    if (id === "intensity") return comparing ? "<th>Intensity</th>" : '<th><button class="sort-button" id="sort-intensity">Intensity</button></th>';
    return `<th>${esc(columnLabel(id))}</th>`;
  }).join("");
  const peakTableCells = (payload, peak, side) => tablePeakColumns(payload).map(id => {
    if (!peak) return '<td class="missing-peak"></td>';
    if (id === "mz" || id === "intensity") {
      const text = id === "mz" ? peak.x.toFixed(5) : peak.y.toLocaleString();
      return side === "top" ? `<td><button data-peak-button="${peak.index}">${text}</button></td>` : `<td class="lower-value">${text}</td>`;
    }
    const column = id.slice(5), columnIndex = peakColumns(payload).indexOf(column);
    const value = payload?.spectrum?.metadata?.[peak.index]?.[column] ?? "";
    const editable = payload?.datasetId && Number.isInteger(payload?.rowId);
    return `<td ${editable ? `tabindex="0" data-annotation-side="${side}" data-annotation-peak="${peak.index}" data-annotation-column="${columnIndex}" title="Double-click or press Enter to edit"` : ""}>${esc(display(value))}</td>`;
  }).join("");
  function peakColumnMenu() {
    const source = comparison[peakMenuSide] || comparison.top;
    const selected = visiblePeakColumns(source);
    const available = allPeakColumns(source);
    return `<div id="peak-column-menu" class="peak-column-menu" ${peakMenuOpen ? "" : "hidden"}>
      <div class="column-menu-heading">
        ${comparison.bottom ? `<select id="peak-column-side" aria-label="Dataset columns"><option value="top" ${peakMenuSide === "top" ? "selected" : ""}>Upper</option><option value="bottom" ${peakMenuSide === "bottom" ? "selected" : ""}>Lower</option></select>` : "<strong>Columns</strong>"}
        <button id="add-peak-column-toggle" title="Add column" aria-label="Add peak annotation column" aria-expanded="false" ${source?.datasetId ? "" : "disabled"}>+</button>
      </div>
      <form id="add-peak-column-form" class="add-column-form" hidden>
        <label>Column name<input id="new-peak-column-name" required></label>
        <label>Initial value<input id="new-peak-column-value" placeholder="Blank by default" value=""></label>
        <button type="submit">Add</button>
        <small>Applies to all peaks in this dataset.</small>
      </form>
      <button id="all-peak-columns" class="column-toggle" aria-pressed="${selected.length === available.length}">${selected.length === available.length ? "☑" : "☐"} All columns</button>
      ${[...selected, ...available.filter(id => !selected.includes(id))].map(id => `<div class="peak-column-option">
        <button class="column-toggle" data-toggle-peak-column="${esc(id)}" aria-pressed="${selected.includes(id)}">${selected.includes(id) ? "☑" : "☐"} ${esc(columnLabel(id))}</button>
        ${selected.includes(id) ? `<button data-move-peak-column="${esc(id)}" data-offset="-1" title="Move left" ${selected.indexOf(id) === 0 ? "disabled" : ""}>↑</button><button data-move-peak-column="${esc(id)}" data-offset="1" title="Move right" ${selected.indexOf(id) === selected.length - 1 ? "disabled" : ""}>↓</button>` : ""}
      </div>`).join("")}
    </div>`;
  }

  const metadataPanel = (payload, heading = "Metadata") => {
    const row = payload?.row ?? {};
    const columns = Array.isArray(payload?.columns) ? payload.columns.map(String) : Object.keys(row);
    const entries = columns
      .map((column) => `<div><dt>${esc(column)}</dt><dd>${esc(display(row[column]))}</dd></div>`)
      .join("");
    return `<section class="metadata-panel"><h2>${esc(heading)}</h2><dl>${entries}</dl></section>`;
  };

  // Return human-friendly tick intervals from the 1, 2, 2.5, 5, 10 series.
  const niceStep = (span, targetTicks = 6) => {
    const raw = Math.max(Number.EPSILON, span / targetTicks);
    const power = 10 ** Math.floor(Math.log10(raw));
    const fraction = raw / power;
    const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
    return nice * power;
  };

  const tickDecimals = (step) => Math.max(0, -Math.floor(Math.log10(step) + 1e-12));

  const ticks = (start, end, targetTicks = 6) => {
    const step = niceStep(end - start, targetTicks);
    const first = Math.ceil((start - step * 1e-9) / step) * step;
    const values = [];
    for (let value = first; value <= end + step * 1e-9 && values.length < 100; value += step) {
      values.push(Math.abs(value) < step * 1e-9 ? 0 : value);
    }
    return { step, values };
  };

  const save = async (blob, filename) => {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    vscode.postMessage({ type: "save-image", filename, bytes });
  };

  const exportDimension = (value, fallback) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) && number > 0 ? Math.min(16384, number) : fallback;
  };

  const precursorMz = (payload) => {
    const row = payload?.row || {};
    for (const key of ["PrecursorMZ", "PRECURSORMZ", "precursor_mz", "precursorMz", "PEPMASS", "ParentMZ"]) {
      const value = Number(String(row[key] ?? "").split(/[ ,]/)[0]);
      if (Number.isFinite(value)) return value;
    }
    return null;
  };

  const spectrumPeaks = (payload) => {
    const mz = Array.isArray(payload?.spectrum?.mz) ? payload.spectrum.mz : [];
    const intensity = Array.isArray(payload?.spectrum?.intensity) ? payload.spectrum.intensity : [];
    return mz.map((value, index) => ({ mz: Number(value), intensity: Math.max(0, Number(intensity[index]) || 0), index }))
      .filter((peak) => Number.isFinite(peak.mz) && peak.intensity > 0);
  };

  const tablePeaks = (mz, intensity) => mz
    .map((value, index) => ({ x: Number(value), y: Number(intensity[index] ?? 0), index }))
    .filter((peak) => Number.isFinite(peak.x) && Number.isFinite(peak.y));

  const alignPeakRows = (upperPeaks, lowerPeaks, tolerance, ascending = true) => {
    const upper = [...upperPeaks].sort((a, b) => a.x - b.x || a.index - b.index);
    const lower = [...lowerPeaks].sort((a, b) => a.x - b.x || a.index - b.index);
    const maximumError = Math.max(0, Number(tolerance) || 0);
    const rows = [];
    let upperIndex = 0;
    let lowerIndex = 0;

    while (upperIndex < upper.length && lowerIndex < lower.length) {
      const upperPeak = upper[upperIndex];
      const lowerPeak = lower[lowerIndex];
      const error = Math.abs(upperPeak.x - lowerPeak.x);
      const roundingAllowance = Number.EPSILON * Math.max(1, Math.abs(upperPeak.x), Math.abs(lowerPeak.x)) * 8;
      if (error <= maximumError + roundingAllowance) {
        rows.push({ upper: upperPeak, lower: lowerPeak });
        upperIndex += 1;
        lowerIndex += 1;
      } else if (upperPeak.x < lowerPeak.x) {
        rows.push({ upper: upperPeak, lower: null });
        upperIndex += 1;
      } else {
        rows.push({ upper: null, lower: lowerPeak });
        lowerIndex += 1;
      }
    }
    while (upperIndex < upper.length) rows.push({ upper: upper[upperIndex++], lower: null });
    while (lowerIndex < lower.length) rows.push({ upper: null, lower: lower[lowerIndex++] });
    return ascending ? rows : rows.reverse();
  };

  const peaksAsDelimited = (mz, intensity, format, lowerMz = null, lowerIntensity = null, tolerance = 0, upperAnnotations = null, lowerAnnotations = null, upperSelection = null, lowerSelection = null) => {
    const delimiter = format === "csv" ? "," : "\t";
    const peaks = tablePeaks(mz, intensity);
    const annotationColumns = data => data?.metadata_columns || [];
    const selected = (data, selection) => ["mz", "intensity", ...(selection ?? annotationColumns(data).map(c => "meta:" + c)).filter(id => id.startsWith("meta:"))];
    const label = id => id === "mz" ? "m/z" : id === "intensity" ? "Intensity" : id.slice(5);
    const values = (data, selection, peak) => selected(data, selection).map(id => {
      if (!peak) return "";
      return id === "mz" ? peak.x : id === "intensity" ? peak.y : data?.metadata?.[peak.index]?.[id.slice(5)] ?? "";
    });
    const encode = value => {
      const text = String(value ?? "");
      return /["\r\n\t,]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
    };
    const line = values => values.map(encode).join(delimiter);
    if (Array.isArray(lowerMz)) {
      const lowerPeaks = tablePeaks(lowerMz, Array.isArray(lowerIntensity) ? lowerIntensity : []);
      const lines = [line([...selected(upperAnnotations, upperSelection).map(c => "Upper " + label(c)),
        ...selected(lowerAnnotations, lowerSelection).map(c => "Lower " + label(c))])];
      const rows = alignPeakRows(peaks, lowerPeaks, tolerance, state?.sortAscending !== false);
      rows.forEach(({ upper, lower }) => lines.push(line([
        ...values(upperAnnotations, upperSelection, upper),
        ...values(lowerAnnotations, lowerSelection, lower)
      ])));
      return `${lines.join("\n")}\n`;
    }

    const lines = [line(selected(upperAnnotations, upperSelection).map(label))];
    const key = state?.sortKey === "intensity" ? "intensity" : "mz";
    const direction = state?.sortAscending === false ? -1 : 1;
    peaks.sort((a, b) => ((key === "mz" ? a.x - b.x : a.y - b.y) || a.index - b.index) * direction);
    peaks.forEach((peak) => lines.push(line(values(upperAnnotations, upperSelection, peak))));
    return `${lines.join("\n")}\n`;
  };

  const matchSpectrumPeaks = (upper, lower, allowShift) => {
    const shift = allowShift && precursorMz(comparison.top) !== null && precursorMz(comparison.bottom) !== null
      ? precursorMz(comparison.top) - precursorMz(comparison.bottom)
      : null;
    const candidates = [];
    upper.forEach((a, upperIndex) => lower.forEach((b, lowerIndex) => {
      const directError = Math.abs(a.mz - b.mz);
      const shiftedError = shift === null ? Infinity : Math.abs((a.mz - b.mz) - shift);
      const error = Math.min(directError, shiftedError);
      if (error <= similarityTolerance) candidates.push({ upperIndex, lowerIndex, error, product: a.intensity * b.intensity });
    }));
    candidates.sort((a, b) => b.product - a.product || a.error - b.error);
    const usedUpper = new Set(), usedLower = new Set(), matches = [];
    for (const candidate of candidates) {
      if (usedUpper.has(candidate.upperIndex) || usedLower.has(candidate.lowerIndex)) continue;
      usedUpper.add(candidate.upperIndex);
      usedLower.add(candidate.lowerIndex);
      matches.push(candidate);
    }
    return { matches, usedUpper, usedLower };
  };

  const calculateSimilarity = () => {
    if (!comparison.top || !comparison.bottom) return null;
    const upper = spectrumPeaks(comparison.top);
    const lower = spectrumPeaks(comparison.bottom);
    if (!upper.length || !lower.length) return { score: 0, matched: 0 };
    const shifted = similarityMethod === "modified" || similarityMethod === "bonanza";
    const { matches, usedUpper, usedLower } = matchSpectrumPeaks(upper, lower, shifted);
    if (!matches.length) return { score: 0, matched: 0 };

    if (similarityMethod === "bonanza") {
      const upperTotal = upper.reduce((sum, peak) => sum + peak.intensity, 0);
      const lowerTotal = lower.reduce((sum, peak) => sum + peak.intensity, 0);
      const upperNormalized = upper.map((peak) => peak.intensity / upperTotal);
      const lowerNormalized = lower.map((peak) => peak.intensity / lowerTotal);
      const product = matches.reduce((sum, match) => sum + upperNormalized[match.upperIndex] * lowerNormalized[match.lowerIndex], 0);
      const unmatchedUpper = upperNormalized.reduce((sum, value, index) => sum + (usedUpper.has(index) ? 0 : value * value), 0);
      const unmatchedLower = lowerNormalized.reduce((sum, value, index) => sum + (usedLower.has(index) ? 0 : value * value), 0);
      return { score: product / (product + unmatchedUpper + unmatchedLower), matched: matches.length };
    }

    const numerator = matches.reduce((sum, match) => sum + upper[match.upperIndex].intensity * lower[match.lowerIndex].intensity, 0);
    const upperNorm = similarityMethod === "reverse"
      ? Math.sqrt(matches.reduce((sum, match) => sum + upper[match.upperIndex].intensity ** 2, 0))
      : Math.sqrt(upper.reduce((sum, peak) => sum + peak.intensity ** 2, 0));
    const lowerNorm = Math.sqrt(lower.reduce((sum, peak) => sum + peak.intensity ** 2, 0));
    return { score: upperNorm && lowerNorm ? numerator / (upperNorm * lowerNorm) : 0, matched: matches.length };
  };

  const keepExportTextUnscaled = (svg) => {
    const viewBox = String(svg.getAttribute("viewBox") || "0 0 900 540")
      .trim().split(/[\s,]+/).map(Number);
    const viewWidth = viewBox[2] > 0 ? viewBox[2] : 900;
    const viewHeight = viewBox[3] > 0 ? viewBox[3] : 540;
    const outputWidth = exportDimension(svg.getAttribute("width"), viewWidth);
    const outputHeight = exportDimension(svg.getAttribute("height"), viewHeight);
    const inverseX = viewWidth / outputWidth;
    const inverseY = viewHeight / outputHeight;
    const namespace = "http://www.w3.org/2000/svg";

    svg.querySelectorAll("text").forEach((element) => {
      let centerX = Number(element.getAttribute("x")) || 0;
      let centerY = Number(element.getAttribute("y")) || 0;
      const translation = String(element.getAttribute("transform") || "")
        .match(/translate\(\s*(-?[\d.]+)(?:[ ,]+)(-?[\d.]+)\s*\)/);
      if (translation) {
        centerX = Number(translation[1]);
        centerY = Number(translation[2]);
      }
      const wrapper = document.createElementNS(namespace, "g");
      wrapper.setAttribute(
        "transform",
        `translate(${centerX} ${centerY}) scale(${inverseX} ${inverseY}) translate(${-centerX} ${-centerY})`
      );
      element.parentNode?.insertBefore(wrapper, element);
      wrapper.append(element);
    });
  };

  const prepareExportSvg = (options) => {
    const source = document.getElementById("spectrum-svg");
    if (!source) return null;
    for (const [key, min, max, integer] of [["labelSize", 1, 100, false], ["topK", 0, Number.MAX_SAFE_INTEGER, true], ["decimals", 0, 10, true], ["peakWidth", 0.1, 20, false]]) {
      if (!Number.isFinite(options[key]) || options[key] < min || options[key] > max || (integer && !Number.isInteger(options[key]))) {
        throw new Error(`Invalid ${key}: enter ${integer ? "an integer" : "a number"} between ${min} and ${max}.`);
      }
    }
    const svg = exportPlot ? exportPlot(options) : source.cloneNode(true);
    svg.querySelector("#drag-box")?.remove();
    if (!options.gridLines) svg.querySelectorAll(".grid").forEach((element) => element.remove());
    if (!options.mzTickLabels) svg.querySelectorAll(".mz-tick-label").forEach((element) => element.remove());
    if (!options.intensityTickLabels) svg.querySelectorAll(".intensity-tick-label").forEach((element) => element.remove());
    if (!options.peakLabels) svg.querySelectorAll(".peak-label").forEach((element) => element.remove());
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", "900");
    svg.setAttribute("height", "540");
    if (!options.mzTickLabels) svg.querySelector(".mz-title")?.setAttribute("y", "508");
    if (!options.intensityTickLabels) {
      svg.querySelectorAll(".axis-title:not(.mz-title)").forEach((element) => {
        const transform = String(element.getAttribute("transform") || "");
        element.setAttribute("transform", transform.replace(/translate\([^ ]+ /, "translate(42 "));
      });
    }
    if (!options.mzTickLabels && !options.intensityTickLabels) {
      // Tick labels account for most of the left/bottom margins. Move the axis
      // titles toward their axes and crop those unused margins for export.
      svg.setAttribute("viewBox", "24 10 866 510");
      svg.setAttribute("width", "866");
      svg.setAttribute("height", "510");
    }

    svg.setAttribute("width", String(exportDimension(options.width, Number(svg.getAttribute("width")) || 900)));
    svg.setAttribute("height", String(exportDimension(options.height, Number(svg.getAttribute("height")) || 540)));
    // Fill the requested dimensions instead of preserving the plot's original
    // aspect ratio and adding transparent letterbox space.
    svg.setAttribute("preserveAspectRatio", "none");

    const styles = getComputedStyle(document.documentElement);
    const color = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    const css = `
      text { font: 13px system-ui, sans-serif; fill: ${color("--plot-text", "#667085")} }
      .grid { stroke: ${color("--grid", "#d0d5dd")}; stroke-width: 1; opacity: .72 }
      .peak { stroke: ${color("--peak", "#2563eb")}; stroke-width: 2.4 }
      .peak.lower-peak { stroke: ${color("--lower-peak", "#dc2626")}; }
      .peak.selected { stroke: ${color("--peak-selected", "#dc2626")}; stroke-width: 4 }
      .axis { stroke: #000; stroke-width: 1.5 }
      .axis-title { font-weight: 650; fill: #000 }
      .mz-title { font-style: italic }
      .peak-label { font-size: ${options.labelSize}px; font-style: italic; fill: ${options.labelColor} }
      .intensity-tick-label { fill: #000 }
    `;
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = css;
    svg.prepend(style);
    // Presentation attributes survive both the live preview and SVG-to-canvas
    // conversion even when the webview blocks embedded SVG styles.
    svg.querySelectorAll(".grid").forEach((element) => {
      element.setAttribute("stroke", color("--grid", "#d0d5dd"));
      element.setAttribute("stroke-width", "1");
      element.setAttribute("opacity", ".72");
    });
    svg.querySelectorAll(".peak").forEach((element) => {
      element.style.stroke = element.classList.contains("lower-peak") ? options.lowerColor : options.upperColor;
      element.style.strokeWidth = String(options.peakWidth);
    });
    svg.querySelectorAll(".axis").forEach((element) => {
      element.setAttribute("stroke", "#000");
      element.setAttribute("stroke-width", "1.5");
    });
    svg.querySelectorAll("text").forEach((element) => {
      element.setAttribute("fill", color("--plot-text", "#667085"));
      element.setAttribute("font-family", "system-ui, sans-serif");
      element.setAttribute("font-size", "13");
    });
    svg.querySelectorAll(".axis-title, .peak-label").forEach((element) => element.setAttribute("fill", "#000"));
    svg.querySelectorAll(".intensity-tick-label").forEach((element) => element.setAttribute("fill", "#000"));
    svg.querySelectorAll(".peak-label").forEach((element) => {
      element.style.fontSize = `${options.labelSize}px`;
      element.style.fill = options.labelColor;
      element.setAttribute("font-style", "italic");
    });
    keepExportTextUnscaled(svg);
    return svg;
  };

  const renderPng = (svg) => new Promise((resolve, reject) => {
    const markup = new XMLSerializer().serializeToString(svg);
    const image = new Image();
    const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const exportWidth = exportDimension(svg.getAttribute("width"), 900);
      const exportHeight = exportDimension(svg.getAttribute("height"), 540);
      canvas.width = exportWidth;
      canvas.height = exportHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, exportWidth, exportHeight);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG image could not be created.")), "image/png");
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("PNG preview could not be rendered."));
    };
    image.src = url;
  });

  const saveExport = async (format, options, title) => {
    const svg = prepareExportSvg(options);
    if (!svg) return;
    const markup = new XMLSerializer().serializeToString(svg);
    const basename = String(title || "spectrum").replace(/[^\w.-]+/g, "_");

    if (format === "svg") {
      save(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }), `${basename}.svg`);
      return;
    }

    try {
      await save(await renderPng(svg), `${basename}.png`);
    } catch (error) {
      vscode.postMessage({ type: "export-error", message: error?.message || "PNG preview could not be rendered." });
    }
  };

  const openExportPreview = () => {
    const dialog = document.getElementById("export-dialog");
    const preview = document.getElementById("export-preview");
    if (!dialog || !preview) return;
    const controls = {
      gridLines: document.getElementById("export-grid"),
      mzTickLabels: document.getElementById("export-mz-ticks"),
      intensityTickLabels: document.getElementById("export-intensity-ticks"),
      peakLabels: document.getElementById("export-peaks"),
      width: document.getElementById("export-width"),
      height: document.getElementById("export-height")
    };
    for (const key of Object.keys(exportDefaults)) {
      controls[key] ||= document.getElementById(`export-${key}`);
      const input = controls[key];
      if (input.type === "checkbox") input.checked = exportSettings[key];
      else input.value = exportSettings[key];
    }
    const options = () => ({
      ...Object.fromEntries(Object.entries(controls).map(([key, input]) =>
        [key, input.type === "number" && !key.endsWith("Min") && !key.endsWith("Max")
          ? Number(input.value) : input.value])),
      gridLines: Boolean(controls.gridLines?.checked),
      mzTickLabels: Boolean(controls.mzTickLabels?.checked),
      intensityTickLabels: Boolean(controls.intensityTickLabels?.checked),
      peakLabels: Boolean(controls.peakLabels?.checked),
      width: exportDimension(controls.width?.value, 900),
      height: exportDimension(controls.height?.value, 540)
    });
    const status = document.getElementById("export-status");
    const update = () => {
      exportSettings = options();
      vscode.setState({ ...vscode.getState(), exportSettings });
      try {
      const svg = prepareExportSvg(exportSettings);
      if (svg) svg.style.aspectRatio = `${svg.getAttribute("width")} / ${svg.getAttribute("height")}`;
      preview.replaceChildren(...(svg ? [svg] : []));
      if (status) status.textContent = "";
      dialog.querySelectorAll(".export-actions button:not(#export-cancel)").forEach(b => b.disabled = false);
      } catch (error) {
        if (status) status.textContent = error.message;
        dialog.querySelectorAll(".export-actions button:not(#export-cancel)").forEach(b => b.disabled = true);
      }
    };
    Object.values(controls).forEach((input) => {
      input.onchange = update;
      input.oninput = update;
    });
    document.getElementById("export-reset").onclick = () => {
      for (const [key, input] of Object.entries(controls)) {
        if (input.type === "checkbox") input.checked = exportDefaults[key];
        else input.value = exportDefaults[key];
      }
      update();
      if (status) status.textContent = "All export settings restored to defaults.";
    };
    document.getElementById("export-cancel").onclick = () => dialog.close();
    document.getElementById("export-png").onclick = () => saveExport("png", options(), state?.title);
    document.getElementById("export-svg").onclick = () => saveExport("svg", options(), state?.title);
    document.getElementById("copy-png").onclick = async () => {
      try {
        if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
          throw new Error("Image clipboard access is not available in this VS Code environment.");
        }
        const svg = prepareExportSvg(options());
        if (!svg) throw new Error("No preview image is available.");
        const blob = await renderPng(svg);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        if (status) status.textContent = `Copied ${svg.getAttribute("width")} × ${svg.getAttribute("height")} PNG to clipboard.`;
      } catch (error) {
        if (status) status.textContent = error?.message || "Could not copy the preview image.";
      }
    };
    document.getElementById("copy-svg").onclick = async () => {
      try {
        if (!navigator.clipboard) {
          throw new Error("Clipboard access is not available in this VS Code environment.");
        }
        const svg = prepareExportSvg(options());
        if (!svg) throw new Error("No preview image is available.");
        const markup = new XMLSerializer().serializeToString(svg);
        const blob = new Blob([markup], { type: "image/svg+xml" });
        try {
          if (!navigator.clipboard.write || typeof ClipboardItem === "undefined") throw new Error();
          await navigator.clipboard.write([new ClipboardItem({ "image/svg+xml": blob })]);
          if (status) status.textContent = `Copied ${svg.getAttribute("width")} × ${svg.getAttribute("height")} SVG to clipboard.`;
        } catch {
          await navigator.clipboard.writeText(markup);
          if (status) status.textContent = "This environment does not support SVG image MIME on the clipboard; copied the SVG source instead.";
        }
      } catch (error) {
        if (status) status.textContent = error?.message || "Could not copy the SVG preview.";
      }
    };
    update();
    dialog.showModal();
  };

  function receiveSpectrum(payload) {
    if (!comparison.top) comparison.top = payload;
    else if (comparison.topPinned && !comparison.bottom) comparison.bottom = payload;
    else if (comparison.topPinned && comparison.bottomPinned) return;
    else if (comparison.topPinned) comparison.bottom = payload;
    else if (comparison.bottomPinned) comparison.top = payload;
    else if (comparison.bottom) comparison.top = payload;
    else comparison.top = payload;
    renderSpectrum();
  }

  function receiveComparison(top, bottom, method) {
    comparison.top = top;
    comparison.bottom = bottom;
    comparison.topPinned = false;
    comparison.bottomPinned = false;
    similarityMethod = method === "reverse_cosine" ? "reverse" : "dot";
    renderSpectrum();
  }

  function renderSpectrum(preserveState = false) {
    const payload = comparison.top;
    if (!payload) return;
    const spectrum = payload?.spectrum ?? { mz: [], intensity: [] };
    const row = payload?.row ?? {};
    const columns = Array.isArray(payload?.columns) ? payload.columns.map(String) : Object.keys(row);
    const globalIndex = Number.isInteger(payload?.globalIndex) ? payload.globalIndex : 0;
    const title = String(payload?.title || `Spectrum ${globalIndex + 1}`);
    const mz = Array.isArray(spectrum.mz) ? spectrum.mz.map(Number) : [];
    const intensity = Array.isArray(spectrum.intensity) ? spectrum.intensity.map(Number) : [];
    const lowerSpectrum = comparison.bottom?.spectrum;
    const lowerMz = comparison.bottom && Array.isArray(lowerSpectrum?.mz) ? lowerSpectrum.mz.map(Number) : null;
    const lowerIntensity = comparison.bottom && Array.isArray(lowerSpectrum?.intensity) ? lowerSpectrum.intensity.map(Number) : null;
    const similarity = calculateSimilarity();

    const previousState = preserveState ? state : null;
    state = {
      spectrum,
      row,
      columns,
      globalIndex,
      title,
      selectedPeak: null,
      sortKey: "mz",
      sortAscending: true,
      domain: null,
      yDomain: null,
      ...(previousState ? { selectedPeak: previousState.selectedPeak, sortKey: previousState.sortKey,
        sortAscending: previousState.sortAscending, domain: previousState.domain, yDomain: previousState.yDomain } : {})
    };

    const metadata = comparison.bottom
      ? `<div class="metadata-panels compared">${metadataPanel(payload, "Upper Metadata")}${metadataPanel(comparison.bottom, "Lower Metadata")}</div>`
      : `<div class="metadata-panels">${metadataPanel(payload)}</div>`;
    app.className = "";
    app.innerHTML = `
      <main class="spectrum-viewer">
        <header class="spectrum-header">
          <div>
            <div class="eyebrow">MSENTITY · SPECTRUM ${globalIndex + 1}</div>
            <h1>${esc(title)}</h1>
          </div>
          <div class="actions"><span>${mz.length} peaks</span><div class="peak-columns-control"><button id="peak-columns" type="button" aria-expanded="${peakMenuOpen}">Columns</button>${peakColumnMenu()}</div><button id="export-image">Export image…</button><button id="reset-zoom">Reset zoom</button></div>
        </header>
        <div class="spectrum-workspace ${comparison.bottom ? "compared" : ""}">
          <section class="plot-panel">
            <div class="comparison-slots">
              <div class="comparison-slot"><span class="slot-action-spacer" aria-hidden="true"></span><button id="pin-top" class="pin-button ${comparison.topPinned ? "pinned" : ""}" title="${comparison.topPinned ? "Unpin" : "Pin"} upper spectrum" aria-pressed="${comparison.topPinned}">📌</button><span><strong>Upper</strong> · ${esc(payload.datasetName || "Dataset")} · ${esc(title)}</span></div>
              ${comparison.bottom ? `<div class="comparison-slot"><button id="remove-bottom" class="remove-spectrum" title="Remove lower spectrum" aria-label="Remove lower spectrum"><svg viewBox="0 0 16 16" aria-hidden="true"><path class="trash-outline" d="M3 4h10M6 4V2h4v2m2 0-.6 10H4.6L4 4m2.5 2v6m3-6v6"/><path class="trash-inner" d="M3 4h10M6 4V2h4v2m2 0-.6 10H4.6L4 4m2.5 2v6m3-6v6"/></svg></button><button id="pin-bottom" class="pin-button ${comparison.bottomPinned ? "pinned" : ""}" title="${comparison.bottomPinned ? "Unpin" : "Pin"} lower spectrum" aria-pressed="${comparison.bottomPinned}">📌</button><span><strong>Lower</strong> · ${esc(comparison.bottom.datasetName || "Dataset")} · ${esc(comparison.bottom.title || "Spectrum")}</span></div><div class="similarity-row"><label>Similarity <select id="similarity-method"><option value="dot" ${similarityMethod === "dot" ? "selected" : ""}>Dot product</option><option value="reverse" ${similarityMethod === "reverse" ? "selected" : ""}>Reverse dot product</option><option value="modified" ${similarityMethod === "modified" ? "selected" : ""}>Modified dot product</option><option value="bonanza" ${similarityMethod === "bonanza" ? "selected" : ""}>BONANZA</option></select></label><label>Tolerance <span>±</span><input id="similarity-tolerance" type="number" min="0.000001" max="10" step="0.01" value="${similarityTolerance}"><span>Da</span></label><output>${Number(similarity?.score || 0).toFixed(4)}</output><span>${similarity?.matched || 0} matched peaks</span></div>` : `<div class="comparison-hint">Pin the upper spectrum, then select another spectrum to compare.</div>`}
            </div>
            <div id="plot-root"></div>
          </section>
          <aside class="peaks-panel ${comparison.bottom ? "compared" : ""}">
            <div class="peaks-header"><h2>Peaks</h2><div>${["tsv", "csv"].map((format) => `<button id="copy-peaks-${format}" type="button">Copy ${format.toUpperCase()}</button>`).join("")}<button id="save-peaks" type="button">Save…</button></div></div>
            <div class="peak-scroll">
              <table class="peak-table">
                <thead>
                  ${comparison.bottom ? `<tr class="spectrum-labels">${tablePeakColumns(payload).length ? `<th colspan="${tablePeakColumns(payload).length}">Upper</th>` : ""}${tablePeakColumns(comparison.bottom).length ? `<th colspan="${tablePeakColumns(comparison.bottom).length}">Lower</th>` : ""}</tr>` : ""}
                  <tr>${peakTableHeaders(payload, "top", Boolean(comparison.bottom))}${comparison.bottom ? peakTableHeaders(comparison.bottom, "bottom", true) : ""}</tr>
                </thead>
                <tbody id="peak-body"></tbody>
              </table>
            </div>
          </aside>
        </div>
        ${metadata}
        <dialog id="export-dialog" class="export-dialog">
          <form method="dialog" class="export-header"><h2>Export spectrum image</h2><button aria-label="Close">×</button></form>
          <fieldset class="export-options">
            <legend>Elements to include</legend>
            <label><input id="export-grid" type="checkbox"> Tick grid lines</label>
            <label><input id="export-mz-ticks" type="checkbox"> m/z tick numbers</label>
            <label><input id="export-intensity-ticks" type="checkbox"> Intensity tick numbers</label>
            <label><input id="export-peaks" type="checkbox"> m/z above peaks</label>
          </fieldset>
          <fieldset class="export-options export-size">
            <legend>Image size</legend>
            <label>Width <input id="export-width" type="number" value="900" min="1" max="16384" step="1"> px</label>
            <label>Height <input id="export-height" type="number" value="540" min="1" max="16384" step="1"> px</label>
          </fieldset>
          <details class="export-advanced">
            <summary>Advanced</summary>
            <div class="export-advanced-toolbar"><span>Settings are retained across spectra.</span><button id="export-reset" type="button">Reset export defaults</button></div>
            <div class="export-advanced-grid">
              <fieldset class="export-settings-group"><legend>Axis ranges</legend>
<div class="export-range-row"><span>m/z</span><div class="export-range-inputs"><input id="export-mzMin" type="number" min="0" step="any" placeholder="Auto" aria-label="m/z minimum"><span aria-hidden="true">～</span><input id="export-mzMax" type="number" min="0" step="any" placeholder="Auto" aria-label="m/z maximum"></div></div><div class="export-range-row"><span>Upper intensity</span><div class="export-range-inputs"><input id="export-intensityMin" type="number" min="0" step="any" placeholder="Auto" aria-label="Upper intensity minimum"><span aria-hidden="true">～</span><input id="export-intensityMax" type="number" min="0" step="any" placeholder="Auto" aria-label="Upper intensity maximum"></div></div><div class="export-range-row"><span>Lower intensity</span><div class="export-range-inputs"><input id="export-lowerMin" type="number" min="0" step="any" placeholder="Auto" aria-label="Lower intensity minimum"><span aria-hidden="true">～</span><input id="export-lowerMax" type="number" min="0" step="any" placeholder="Auto" aria-label="Lower intensity maximum"></div></div>
                <p class="export-help">Minimum ～ maximum. Leave blank to use the current view.</p>
              </fieldset>
              <fieldset class="export-settings-group"><legend>Spectrum appearance</legend>
<label>Upper color<input id="export-upperColor" type="color" ></label><label>Lower color<input id="export-lowerColor" type="color" ></label><label>Line width (px)<input id="export-peakWidth" type="number" min="0.1" max="20" step="0.1"></label>
              </fieldset>
              <fieldset class="export-settings-group"><legend>Peak labels</legend>
<label>Size (px)<input id="export-labelSize" type="number" min="1" max="100"></label><label>Color<input id="export-labelColor" type="color" ></label><label>m/z decimal places<input id="export-decimals" type="number" min="0" max="10" step="1"></label><label>Top K per spectrum<input id="export-topK" type="number" min="0" step="1"></label>
                <p class="export-help">0 = all visible peaks. Top K selects the strongest visible peaks on each side. Enable “m/z above peaks” to show labels.</p>
              </fieldset>
            </div>
          </details>
          <div id="export-preview" class="export-preview" aria-label="Image preview"></div>
          <div id="export-status" class="export-status" role="status" aria-live="polite"></div>
          <div class="export-actions"><button id="export-cancel" type="button">Cancel</button><button id="copy-svg" type="button">Copy SVG</button><button id="copy-png" type="button">Copy PNG</button><button id="export-svg" type="button">Save SVG</button><button id="export-png" type="button">Save PNG</button></div>
        </dialog>
      </main>`;
    document.getElementById("pin-top").onclick = () => {
      comparison.topPinned = !comparison.topPinned;
      renderSpectrum();
    };
    const pinBottom = document.getElementById("pin-bottom");
    if (pinBottom) pinBottom.onclick = () => {
      comparison.bottomPinned = !comparison.bottomPinned;
      renderSpectrum();
    };
    const removeBottom = document.getElementById("remove-bottom");
    if (removeBottom) removeBottom.onclick = () => {
      comparison.bottom = null;
      comparison.bottomPinned = false;
      renderSpectrum();
    };
    const methodSelect = document.getElementById("similarity-method");
    if (methodSelect) methodSelect.onchange = () => {
      similarityMethod = methodSelect.value;
      renderSpectrum();
    };
    for (const format of ["tsv", "csv"]) {
      document.getElementById(`copy-peaks-${format}`).onclick = async () => {
        try {
          const text = peaksAsDelimited(mz, intensity, format, lowerMz, lowerIntensity, similarityTolerance, spectrum, lowerSpectrum, visiblePeakColumns(payload), comparison.bottom ? visiblePeakColumns(comparison.bottom) : null);
          await navigator.clipboard.writeText(text);
          vscode.postMessage({ type: "copy-notification", message: `Copied peak table as ${format.toUpperCase()}.` });
        } catch (error) {
          vscode.postMessage({ type: "clipboard-error", message: error?.message || `Could not copy peak ${format.toUpperCase()}.` });
        }
      };
    }
    document.getElementById("save-peaks").onclick = () => {
      const comparedTitle = comparison.bottom ? `${title}-vs-${comparison.bottom.title || "spectrum"}` : title;
      const basename = String(comparedTitle || "spectrum").replace(/[^\w.-]+/g, "_");
      vscode.postMessage({
        type: "save-peaks", basename, sourcePath: payload.datasetPath,
        contents: Object.fromEntries(["tsv", "csv"].map((format) => [
          format, peaksAsDelimited(mz, intensity, format, lowerMz, lowerIntensity, similarityTolerance, spectrum, lowerSpectrum, visiblePeakColumns(payload), comparison.bottom ? visiblePeakColumns(comparison.bottom) : null)
        ]))
      });
    };
    const toleranceInput = document.getElementById("similarity-tolerance");
    if (toleranceInput) toleranceInput.onchange = () => {
      const value = Number(toleranceInput.value);
      if (Number.isFinite(value) && value > 0) similarityTolerance = Math.min(10, value);
      renderSpectrum();
    };
    document.getElementById("peak-columns").onclick = () => {
      peakMenuOpen = !peakMenuOpen;
      document.getElementById("peak-column-menu").hidden = !peakMenuOpen;
      document.getElementById("peak-columns").setAttribute("aria-expanded", String(peakMenuOpen));
    };
    document.getElementById("add-peak-column-toggle").onclick = () => {
      const form = document.getElementById("add-peak-column-form");
      form.hidden = !form.hidden;
      document.getElementById("add-peak-column-toggle").setAttribute("aria-expanded", String(!form.hidden));
    };
    const sideSelect = document.getElementById("peak-column-side");
    if (sideSelect) sideSelect.onchange = () => { peakMenuSide = sideSelect.value; renderSpectrum(true); };
    const source = () => comparison[peakMenuSide] || comparison.top;
    document.getElementById("all-peak-columns").onclick = () => {
      const payload = source(), selected = visiblePeakColumns(payload);
      peakColumnViews.get(peakColumnKey(payload)).selected = selected.length === allPeakColumns(payload).length ? [] : allPeakColumns(payload);
      renderSpectrum(true);
    };
    document.querySelectorAll("[data-toggle-peak-column]").forEach(el => {
      el.onclick = () => { togglePeakColumn(source(), el.dataset.togglePeakColumn); renderSpectrum(true); };
    });
    document.querySelectorAll("[data-move-peak-column]").forEach(el => {
      el.onclick = () => { movePeakColumn(source(), el.dataset.movePeakColumn, Number(el.dataset.offset)); renderSpectrum(true); };
    });
    document.getElementById("add-peak-column-form").onsubmit = event => {
      event.preventDefault();
      const selected = source();
      if (!selected?.datasetId) return;
      vscode.postMessage({ type: "add-peak-column", datasetId: selected.datasetId,
        column: document.getElementById("new-peak-column-name").value,
        value: document.getElementById("new-peak-column-value").value });
    };
    setupSpectrumPlot(mz, intensity,
      lowerMz ?? [], lowerIntensity ?? [], Boolean(comparison.bottom));
  }

  function setupSpectrumPlot(mz, intensities, lowerMz = [], lowerIntensities = [], comparing = false) {
    if (!state) return;
    const peaks = mz.map((x, index) => ({ x, y: intensities[index] ?? 0, index }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const lowerPeaks = lowerMz.map((x, index) => ({ x, y: lowerIntensities[index] ?? 0, index }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const root = document.getElementById("plot-root");
    const tbody = document.getElementById("peak-body");
    const reset = document.getElementById("reset-zoom");
    const exportImage = document.getElementById("export-image");
    const mzSorts = [...document.querySelectorAll("[data-sort-mz]")];
    const intensitySort = document.getElementById("sort-intensity");
    if (!root || !tbody || !reset || !exportImage) return;

    const W = 900, H = 540, L = 72, R = 32, T = 30, B = 62;
    const allPeaks = [...peaks, ...lowerPeaks];
    const rawMax = allPeaks.length ? Math.max(...allPeaks.map((p) => p.x)) : 1;
    const fullXStep = niceStep(Math.max(1, rawMax), 6);
    const full = [0, Math.max(fullXStep, Math.ceil(rawMax / fullXStep) * fullXStep)];
    const upperPeakMax = Math.max(0, ...peaks.map((p) => p.y));
    const lowerPeakMax = Math.max(0, ...lowerPeaks.map((p) => p.y));
    const fullYMax = upperPeakMax > 0 ? upperPeakMax * 1.1 : 1.1;
    const lowerYMax = lowerPeakMax > 0 ? lowerPeakMax * 1.1 : 1.1;
    if (!Array.isArray(state.domain)) state.domain = [...full];
    if (!Array.isArray(state.yDomain)) state.yDomain = [0, fullYMax];
    let start = null, current = null, pressedPeak = null;

    const choose = (index) => {
      state.selectedPeak = index;
      draw();
      document.querySelector(`[data-peak-row="${index}"]`)?.scrollIntoView({ block: "nearest" });
    };

    const draw = (options = null) => {
      if (!state) return;
      const domain = options ? exportRange(options.mzMin, options.mzMax, state.domain) : state.domain;
      const domainWidth = Math.max(Number.EPSILON, domain[1] - domain[0]);
      const yDomain = options ? exportRange(options.intensityMin, options.intensityMax, state.yDomain) : state.yDomain;
      const lowerDomain = options ? exportRange(options.lowerMin, options.lowerMax, [0, lowerYMax]) : [0, lowerYMax];
      const yDomainWidth = Math.max(Number.EPSILON, yDomain[1] - yDomain[0]);
      const shown = peaks.filter((p) => p.x >= domain[0] && p.x <= domain[1]);
      const lowerShown = lowerPeaks.filter((p) => p.x >= domain[0] && p.x <= domain[1]);
      const hasLower = lowerPeaks.length > 0;
      const baseline = hasLower ? H / 2 : H - B;
      const sx = (x) => L + (x - domain[0]) / domainWidth * (W - L - R);
      const sy = (y) => baseline - (y - yDomain[0]) / yDomainWidth * (baseline - T);
      const lowerSy = (y) => baseline + (Math.max(lowerDomain[0], y) - lowerDomain[0]) / (lowerDomain[1] - lowerDomain[0]) * (H - B - baseline);

      let grid = "";
      const xTicks = ticks(domain[0], domain[1]);
      for (const value of xTicks.values) {
        const x = sx(value);
        grid += `<line x1="${x}" y1="${T}" x2="${x}" y2="${H - B}" class="grid"/>`;
        grid += `<text class="tick-label mz-tick-label" x="${x}" y="${H - B + 26}" text-anchor="middle">${value.toFixed(tickDecimals(xTicks.step))}</text>`;
      }
      const yTicks = ticks(yDomain[0], yDomain[1]);
      for (const value of yTicks.values) {
        const y = sy(value);
        grid += `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" class="grid"/>`;
        grid += `<text class="tick-label intensity-tick-label" x="${L - 10}" y="${y + 4}" text-anchor="end">${value.toFixed(tickDecimals(yTicks.step))}</text>`;
      }
      if (hasLower) {
        const lowerTicks = ticks(...lowerDomain);
        for (const value of lowerTicks.values) {
          if (Math.abs(value) < lowerTicks.step * 1e-9) continue;
          const y = lowerSy(value);
          grid += `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" class="grid lower-grid"/>`;
          grid += `<text class="tick-label intensity-tick-label lower-tick-label" x="${L - 10}" y="${y + 4}" text-anchor="end">${value.toFixed(tickDecimals(lowerTicks.step))}</text>`;
        }
      }
      const sticks = shown.map((p) => `<line data-peak="${p.index}" x1="${sx(p.x)}" y1="${sy(Math.max(0, yDomain[0]))}" x2="${sx(p.x)}" y2="${sy(p.y)}" class="peak ${state.selectedPeak === p.index ? "selected" : ""}"><title>m/z ${p.x} · intensity ${p.y}</title></line>`).join("");
      const peakLabels = labelPeaks(shown, yDomain, options).map((p) => `<text x="${sx(p.x)}" y="${Math.max(T + 11, sy(p.y) - 8)}" text-anchor="middle" class="peak-label">${p.x.toFixed(options?.decimals ?? 4)}</text>`).join("");
      const lowerSticks = lowerShown.map((p) => `<line x1="${sx(p.x)}" y1="${baseline}" x2="${sx(p.x)}" y2="${lowerSy(p.y)}" class="peak lower-peak"><title>m/z ${p.x} · intensity ${p.y}</title></line>`).join("");
      const lowerLabels = labelPeaks(lowerShown, lowerDomain, options).map((p) => `<text x="${sx(p.x)}" y="${Math.min(H - B - 4, lowerSy(p.y) + 14)}" text-anchor="middle" class="peak-label lower-label">${p.x.toFixed(options?.decimals ?? 4)}</text>`).join("");
      const markup = `<svg id="spectrum-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${hasLower ? "Compared mass spectra" : "Mass spectrum"}"><defs><clipPath id="plot-clip"><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></clipPath></defs><g class="spectrum-grid">${grid}</g><line x1="${L}" y1="${baseline}" x2="${W - R}" y2="${baseline}" class="axis"/><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="axis"/><g clip-path="url(#plot-clip)">${sticks}${lowerSticks}<g class="peak-labels">${peakLabels}${lowerLabels}</g></g><rect id="drag-box" x="${L}" y="${T}" width="0" height="${baseline - T}" class="selection"/><text x="${(L + W - R) / 2}" y="${H - 12}" text-anchor="middle" class="axis-title mz-title">m/z</text><text transform="translate(17 ${(T + baseline) / 2}) rotate(-90)" text-anchor="middle" class="axis-title">Intensity</text>${hasLower ? `<text transform="translate(17 ${(baseline + H - B) / 2}) rotate(-90)" text-anchor="middle" class="axis-title lower-axis-title">Intensity</text>` : ""}</svg>`;
      if (options) {
        const container = document.createElement("div");
        container.innerHTML = markup;
        return container.firstElementChild;
      }
      root.innerHTML = markup;

      if (comparing) {
        const aligned = alignPeakRows(peaks, lowerPeaks, similarityTolerance, state.sortAscending);
        tbody.innerHTML = aligned.map(({ upper, lower }) => {
          return `<tr ${upper ? `data-peak-row="${upper.index}"` : ""} class="peak-row ${upper && state.selectedPeak === upper.index ? "selected" : ""}">${peakTableCells(comparison.top, upper, "top")}${peakTableCells(comparison.bottom, lower, "bottom")}</tr>`;
        }).join("");
      } else {
        const ordered = [...peaks].sort((a, b) => {
          const difference = state.sortKey === "mz" ? a.x - b.x : a.y - b.y;
          return (difference || a.index - b.index) * (state.sortAscending ? 1 : -1);
        });
        tbody.innerHTML = ordered.map((peak) => `<tr data-peak-row="${peak.index}" class="peak-row ${state.selectedPeak === peak.index ? "selected" : ""}">${peakTableCells(comparison.top, peak, "top")}</tr>`).join("");
      }
      tbody.querySelectorAll("[data-annotation-side]").forEach(el => {
        const edit = () => {
          const source = comparison[el.dataset.annotationSide];
          const index = Number(el.dataset.annotationPeak);
          const column = peakColumns(source)[Number(el.dataset.annotationColumn)];
          vscode.postMessage({ type: "edit-peak-cell", datasetId: source.datasetId, rowId: source.rowId,
            peakIndex: index, column, value: source.spectrum.metadata?.[index]?.[column] ?? "" });
        };
        el.addEventListener("dblclick", edit);
        el.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); edit(); } });
      });
      mzSorts.forEach((sort) => { sort.textContent = `m/z ${state.sortAscending ? "↑" : "↓"}`; });
      if (intensitySort) intensitySort.textContent = `Intensity ${state.sortKey === "intensity" ? (state.sortAscending ? "↑" : "↓") : ""}`;

      root.querySelectorAll("[data-peak]").forEach((el) => el.addEventListener("click", (e) => {
        e.stopPropagation();
        choose(Number(el.dataset.peak));
      }));
      tbody.querySelectorAll("[data-peak-button]").forEach((el) => el.addEventListener("click", () => choose(Number(el.dataset.peakButton))));

      const svg = root.querySelector("#spectrum-svg");
      if (!svg) return;
      const pointer = (e) => {
        const rect = svg.getBoundingClientRect();
        return {
          x: Math.min(W - R, Math.max(L, (e.clientX - rect.left) / rect.width * W)),
          y: Math.min(H - B, Math.max(T, (e.clientY - rect.top) / rect.height * H))
        };
      };
      svg.addEventListener("pointerdown", (e) => {
        const peak = e.target.closest?.("[data-peak]");
        pressedPeak = peak ? Number(peak.dataset.peak) : null;
        start = pointer(e);
        current = { ...start };
        svg.setPointerCapture(e.pointerId);
      });
      svg.addEventListener("pointermove", (e) => {
        if (start === null) return;
        current = pointer(e);
        const box = svg.querySelector("#drag-box");
        if (box) {
          const zoomX = Math.abs(current.x - start.x) > 8;
          const zoomY = !hasLower && Math.abs(current.y - start.y) > 8;
          box.setAttribute("x", String(zoomX ? Math.min(start.x, current.x) : L));
          box.setAttribute("width", String(zoomX ? Math.abs(current.x - start.x) : W - L - R));
          box.setAttribute("y", String(zoomY ? Math.min(start.y, current.y) : T));
          box.setAttribute("height", String(zoomY ? Math.abs(current.y - start.y) : baseline - T));
        }
      });
      svg.addEventListener("pointerup", () => {
        const zoomX = start !== null && current !== null && Math.abs(current.x - start.x) > 8;
        const zoomY = !hasLower && start !== null && current !== null && Math.abs(current.y - start.y) > 8;
        const dragged = zoomX || zoomY;
        if (zoomX) {
          const toMz = (x) => domain[0] + (x - L) / (W - L - R) * domainWidth;
          state.domain = [toMz(Math.min(start.x, current.x)), toMz(Math.max(start.x, current.x))];
        }
        if (zoomY) {
          const toIntensity = (y) => yDomain[1] - (y - T) / (baseline - T) * yDomainWidth;
          state.yDomain = [toIntensity(Math.max(start.y, current.y)), toIntensity(Math.min(start.y, current.y))];
        }
        const clickedPeak = pressedPeak;
        start = current = pressedPeak = null;
        if (dragged) draw();
        else if (clickedPeak !== null) choose(clickedPeak);
        else if (state.selectedPeak !== null) {
          state.selectedPeak = null;
          draw();
        } else {
          svg.querySelector("#drag-box")?.setAttribute("width", "0");
        }
      });
    };

    const changeSort = (key) => {
      if (!state) return;
      if (state.sortKey === key) state.sortAscending = !state.sortAscending;
      else {
        state.sortKey = key;
        state.sortAscending = true;
      }
      draw();
    };
    mzSorts.forEach((sort) => { sort.onclick = () => changeSort("mz"); });
    if (intensitySort) intensitySort.onclick = () => changeSort("intensity");
    const resetZoom = () => {
      state.domain = [...full];
      state.yDomain = [0, fullYMax];
      state.selectedPeak = null;
      draw();
    };
    reset.onclick = resetZoom;
    root.ondblclick = (event) => {
      event.preventDefault();
      resetZoom();
    };
    exportPlot = options => draw(options);
    exportImage.onclick = openExportPreview;
    draw();
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "peak-columns-updated") {
      for (const slot of [comparison.top, comparison.bottom]) {
        if (slot?.datasetId === event.data.dataset_id) vscode.postMessage({
          type: "get-peak-record", datasetId: slot.datasetId, rowId: slot.rowId
        });
      }
    } else if (event.data?.type === "peak-record") {
      let changed = false;
      for (const slot of [comparison.top, comparison.bottom]) {
        if (slot?.datasetId === event.data.dataset_id && slot.rowId === event.data.row_id) {
          slot.spectrum = event.data.spectrum; changed = true;
        }
      }
      if (changed) renderSpectrum(true);
    } else if (event.data?.type === "spectrum") receiveSpectrum(event.data.payload);
    else if (event.data?.type === "spectrum-comparison") {
      receiveComparison(event.data.top, event.data.bottom, event.data.method);
    }
  });

  document.addEventListener("click", event => {
    if (peakMenuOpen && !event.target.closest?.(".peak-columns-control")) {
      peakMenuOpen = false;
      document.getElementById("peak-column-menu").hidden = true;
      document.getElementById("peak-columns").setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && peakMenuOpen) {
      peakMenuOpen = false;
      document.getElementById("peak-column-menu").hidden = true;
      document.getElementById("peak-columns").setAttribute("aria-expanded", "false");
      document.getElementById("peak-columns").focus();
    }
  });

  vscode.postMessage({ type: "ready" });
})();
