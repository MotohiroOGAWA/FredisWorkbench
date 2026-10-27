const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const vscode = require('vscode');

function buildArgs(payload) {
  return ['-m', 'fredis.cli', 'molecule', 'smarts-search',
    '--input', String(payload.file || '').trim(),
    ...(Array.isArray(payload.smarts) ? payload.smarts : [payload.smarts || '']).flatMap(value => ['--smarts', String(value).trim()]),
    '--smiles-column', String(payload.column || 'SMILES').trim(), '--include-compounds'];
}

function shellDisplay(program, args) {
  return [program, ...args].map(value => /^[A-Za-z0-9_./:=,-]+$/.test(value)
    ? value : "'" + value.replace(/'/g, "'\\''") + "'").join(' ');
}

function attach(panel, context, projectRoot) {
  let child, running = false, cancelled = false;
  panel.onDidDispose(() => { cancelled = true; if (child) child.kill(); });
  panel.webview.onDidReceiveMessage(async message => {
    if (message.type === 'pickSmartsDataset') {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { MSDataset: ['msds'] } });
      if (picked?.[0]) panel.webview.postMessage({ type: 'smartsDatasets', files: picked.map(file => file.fsPath), rowId: message.rowId });
    }
    if (message.type === 'importSmartsPatterns') {
      try {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true });
        if (!picked?.length) return;
        const patterns = [];
        for (const file of picked) {
          const value = JSON.parse(await fs.promises.readFile(file.fsPath, 'utf8'));
          const entries = value.reaction_pattern_set?.patterns || (value.reactant_smarts ? [value] : null);
          if (!Array.isArray(entries) || !entries.length || entries.some(p => typeof p.reactant_smarts !== 'string' || !p.reactant_smarts.trim()))
            throw new Error('No Reactant SMARTS found in ' + file.fsPath);
          patterns.push(...entries.map(p => ({ name: p.name || '', smarts: p.reactant_smarts })));
        }
        panel.webview.postMessage({ type: 'smartsPatternsImported', patterns });
      } catch (error) { panel.webview.postMessage({ type: 'smartsPatternsImported', error: error.message }); }
      return;
    }
    if (message.type === 'cancelSmartsSearch') { cancelled = true; if (child) child.kill(); }
    if (message.type === 'copySmartsCommand') {
      try {
        const python = vscode.workspace.getConfiguration('fredis').get('pythonPath', 'python');
        const command = (message.payload.datasets || [message.payload]).map(dataset => shellDisplay(python, buildArgs({ ...message.payload, ...dataset }))).join('\n');
        await vscode.env.clipboard.writeText(command);
        panel.webview.postMessage({ type: 'smartsCommandCopied', command, root: projectRoot(context) });
      } catch (error) {
        panel.webview.postMessage({ type: 'smartsCommandCopied', error: error.message });
      }
      return;
    }
    if (message.type !== 'smartsSearch' || running) return;
    running = true; cancelled = false;
    try {
      const root = projectRoot(context);
      const python = vscode.workspace.getConfiguration('fredis').get('pythonPath', 'python');
      const results = [];
      for (const dataset of message.payload.datasets || [message.payload]) {
        if (cancelled) throw new Error('Search cancelled.');
        child = spawn(python, buildArgs({ ...message.payload, ...dataset }), {
          cwd: root, env: { ...process.env, PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) }
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += data; });
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
        child.stdin.on('error', () => {});
        const response = await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', (code, signal) => {
            if (signal) { reject(new Error('Search cancelled.')); return; }
            if (code !== 0) { reject(new Error(stderr || `Search failed (exit ${code}).`)); return; }
            try { resolve(JSON.parse(stdout)); }
            catch (_) { reject(new Error(stderr || `Search failed (exit ${code}).`)); }
          });
          child.stdin.end();
        });
        results.push({ file: dataset.file, column: dataset.column, result: response });
      }
      panel.webview.postMessage({ type: 'smartsSearchResult', ok: true, results });
    } catch (error) {
      panel.webview.postMessage({ type: 'smartsSearchResult', ok: false, error: error.message });
    } finally { child = undefined; running = false; }
  });
}

function html() {
  return `<div id="smartsApp" hidden><section><h2>Substructure Search</h2>
  <p>Search MSDatasets for molecules containing reactant SMARTS substructures. Each record is counted once, even if it contains multiple matches.</p>
  <style>
  #smartsApp .search-table{border:1px solid var(--line,var(--vscode-panel-border));border-radius:6px;overflow:hidden;margin:12px 0}
  #smartsApp .dataset-head,#smartsApp .dataset-main{display:grid;grid-template-columns:52px minmax(0,1fr) 100px;align-items:center;gap:12px;padding:10px 12px}
  #smartsApp .search-table-head{background:var(--soft,var(--vscode-editor-background));font-size:12px;font-weight:600;color:var(--muted,var(--vscode-descriptionForeground))}
  #smartsApp .dataset-entry+.dataset-entry,#smartsApp .query-entry+.query-entry{border-top:1px solid var(--line,var(--vscode-panel-border))}
  #smartsApp .dataset-main input[type=checkbox]{width:16px;height:16px;margin:0;justify-self:center}
  #smartsApp .dataset-main input[type=text],#smartsApp .query-entry input{width:100%;min-width:0;box-sizing:border-box;margin:0}
  #smartsApp .dataset-options{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:0 12px 12px 76px}
  #smartsApp .dataset-options details{flex:1;min-width:0;margin:0;padding:0;border:0;background:transparent}
  #smartsApp .dataset-options summary{cursor:pointer;font-size:12px;padding:4px 0}
  #smartsApp .dataset-options label{display:block;max-width:300px;margin:10px 0 0}
  #smartsApp .dataset-options button{width:100px}
  #smartsApp .dataset-entry[aria-disabled=true] .dataset-main input[type=text]{opacity:.5}
  #smartsApp .query-head,#smartsApp .query-entry{display:grid;grid-template-columns:minmax(0,1fr) 100px;gap:12px;align-items:center;padding:10px 12px}
  #smartsApp .query-entry label{display:grid;grid-template-columns:minmax(120px,180px) minmax(0,1fr);gap:12px;align-items:center;margin:0;font-size:12px}
  #smartsApp .query-entry input{font-family:var(--vscode-editor-font-family,monospace)}
  #smartsApp .search-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
  @media(max-width:650px){#smartsApp .query-entry label{grid-template-columns:1fr}#smartsApp .dataset-options{padding-left:12px}}
  </style><form id="smartsForm"><h3>MSDatasets</h3><div class="search-table"><div class="dataset-head search-table-head"><span>Use</span><span>Path</span><span></span></div><div id="smartsDatasets"></div></div><button type="button" id="smartsAddDataset">Add MSDataset</button>
  <h3>Reactant SMARTS</h3><div class="search-table"><div class="query-head search-table-head"><span>Pattern / Reactant SMARTS</span><span></span></div><div id="smartsQueries"></div></div><div class="search-actions"><button type="button" id="smartsAddQuery">Add reactant SMARTS</button><button type="button" id="smartsImportPatterns">Add from Reaction Patterns…</button></div>
  <p class="muted">Percentages use valid SMILES as the denominator. Unique molecules are deduplicated using canonical isomeric SMILES. Stereochemistry is not required for substructure matching.</p>
  <button type="button" id="smartsCopy">Copy Command</button> <button class="primary" id="smartsRun">Run CLI</button> <button type="button" id="smartsCancel" disabled>Cancel</button></form>
  <p id="smartsStatus" role="status"></p><pre id="smartsCommand" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><div id="smartsResult"></div></section></div>`;
}

function script() { return `(${client.toString()})();`; }
function client() {
  const el = id => document.getElementById(id);
  const form = el('smartsForm');
  const datasetRows = [];
  let nextDatasetId = 0;
  function addDataset(file = '') {
    const row = document.createElement('div'); row.setAttribute('class', 'dataset-entry');
    const main = document.createElement('div'); main.setAttribute('class', 'dataset-main');
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = true;
    enabled.setAttribute('aria-label', 'Enable dataset');
    const input = document.createElement('input'); input.type = 'text';
    input.value = file; input.required = true; input.placeholder = 'Path to MSDataset (.msds)';
    input.setAttribute('aria-label', 'MSDataset path'); input.setAttribute('data-path-kind', 'file');
    const options = document.createElement('div'); options.setAttribute('class', 'dataset-options');
    const details = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = 'SMILES column';
    const columnLabel = document.createElement('label'), column = document.createElement('input');
    column.type = 'text'; column.value = 'SMILES'; column.required = true;
    columnLabel.append('SMILES column', column); details.append(summary, columnLabel);
    column.oninvalid = () => { details.open = true; };
    const browse = document.createElement('button'), remove = document.createElement('button');
    browse.type = remove.type = 'button'; browse.textContent = 'Browse…'; remove.textContent = 'Remove';
    const item = { id: String(nextDatasetId++), row, input, column, enabled, browse, remove };
    enabled.onchange = () => updateDatasets();
    browse.onclick = () => vscode.postMessage({ type: 'pickSmartsDataset', rowId: item.id });
    remove.onclick = () => { if (datasetRows.length === 1) return; datasetRows.splice(datasetRows.indexOf(item), 1); row.remove(); updateDatasets(); };
    main.append(enabled, input, browse); options.append(details, remove); row.append(main, options);
    datasetRows.push(item); el('smartsDatasets').append(row); updateDatasets();
  }
  function updateDatasets() {
    datasetRows.forEach(row => {
      row.remove.disabled = datasetRows.length === 1;
      row.input.disabled = row.column.disabled = row.browse.disabled = !row.enabled.checked;
      row.row.setAttribute('aria-disabled', String(!row.enabled.checked));
    });
  }
  el('smartsAddDataset').onclick = () => addDataset();
  addDataset();
  const queryRows = [];
  function addQuery(smarts = '', name = '') {
    const row = document.createElement('div'); row.setAttribute('class', 'query-entry');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.value = smarts; input.title = name; input.required = true; input.placeholder = 'e.g. c1ccccc1';
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = 'Remove';
    const item = { row, label, input, remove, name };
    label.append(input); row.append(label, remove);
    queryRows.push(item); el('smartsQueries').append(row);
    function update() {
      queryRows.forEach((value, index) => {
        value.label.replaceChildren('Reactant SMARTS ' + (index + 1) + (value.name ? ' · ' + value.name : ''), value.input);
        value.remove.disabled = queryRows.length === 1;
      });
    }
    remove.onclick = () => {
      if (queryRows.length === 1) return;
      queryRows.splice(queryRows.indexOf(item), 1); row.remove(); update();
    };
    update();
  }
  el('smartsAddQuery').onclick = () => addQuery();
  el('smartsImportPatterns').onclick = () => vscode.postMessage({ type: 'importSmartsPatterns' });
  addQuery();
  function busy(value) {
    for (const input of form.querySelectorAll('input,button')) input.disabled = value;
    el('smartsCancel').disabled = !value;
    if (!value) updateDatasets();
    if (!value && queryRows.length === 1) queryRows[0].remove.disabled = true;
  }
  el('smartsCancel').onclick = () => vscode.postMessage({ type: 'cancelSmartsSearch' });
  const payload = () => ({ datasets: datasetRows.filter(row => row.enabled.checked).map(row => ({ file: row.input.value.trim(), column: row.column.value.trim() })), smarts: queryRows.map(row => row.input.value.trim()) });
  function valid() {
    if (!datasetRows.some(row => row.enabled.checked)) { el('smartsStatus').textContent = 'Enable at least one MSDataset.'; return false; }
    return form.reportValidity();
  }
  el('smartsCopy').onclick = () => {
    if (valid()) vscode.postMessage({ type: 'copySmartsCommand', payload: payload() });
  };
  form.onsubmit = event => {
    event.preventDefault();
    if (!valid()) return;
    busy(true); el('smartsResult').textContent = ''; el('smartsStatus').textContent = 'Searching…';
    vscode.postMessage({ type: 'smartsSearch', payload: payload() });
  };
  window.addEventListener('message', event => {
    const m = event.data;
    if (m.type === 'smartsDatasets') {
      const row = datasetRows.find(row => row.id === m.rowId);
      if (row && m.files.length) row.input.value = m.files[0];
      m.files.slice(row ? 1 : 0).forEach(file => addDataset(file));
    }
    if (m.type === 'smartsPatternsImported') {
      if (m.error) { el('smartsStatus').textContent = m.error; return; }
      for (const pattern of m.patterns) {
        if (queryRows.some(row => row.input.value.trim() === pattern.smarts.trim())) continue;
        const empty = queryRows.find(row => !row.input.value.trim());
        if (empty) { empty.input.value = pattern.smarts; empty.input.title = pattern.name; empty.name = pattern.name; empty.label.replaceChildren('Reactant SMARTS ' + (queryRows.indexOf(empty) + 1) + (pattern.name ? ' · ' + pattern.name : ''), empty.input); }
        else addQuery(pattern.smarts, pattern.name);
      }
      el('smartsStatus').textContent = 'Reaction patterns added.';
    }
    if (m.type === 'smartsCommandCopied') {
      el('smartsStatus').textContent = m.error || 'Command copied. Run from: ' + m.root;
      el('smartsCommand').textContent = m.command || '';
    }
    if (m.type !== 'smartsSearchResult') return;
    busy(false);
    el('smartsStatus').textContent = m.ok ? 'Search completed.' : m.error;
    if (!m.ok) return;
    if (!m.results) { renderResult(m.result, el('smartsResult')); return; }
    el('smartsResult').replaceChildren();
    for (const dataset of m.results) {
      const section = document.createElement('section'), title = document.createElement('h3'), result = document.createElement('div');
      title.textContent = dataset.file + ' · SMILES column: ' + dataset.column;
      section.append(title, result); el('smartsResult').append(section); renderResult(dataset.result, result);
    }
  });
  function renderResult(r, container) {
    const percent = v => v === null ? 'N/A' : v.toFixed(2) + '%';
    const table = document.createElement('table');
    const summaries = [{ label: 'Any reactant SMARTS (OR)', ...r },
      ...(r.patterns || []).map((pattern, index) => ({ ...pattern, label: 'Reactant SMARTS ' + (index + 1) + ': ' + pattern.smarts }))];
    const header = table.insertRow();
    for (const label of ['Query', 'Detected records / valid', 'Record percentage', 'Detected unique / valid', 'Unique percentage']) {
      const cell = document.createElement('th'); cell.textContent = label; header.append(cell);
    }
    for (const summary of summaries) {
      const row = table.insertRow();
      for (const value of [summary.label, summary.matched + ' / ' + summary.valid,
        percent(summary.percent), summary.uniqueMatched + ' / ' + summary.unique, percent(summary.uniquePercent)]) {
        const cell = row.insertCell(); cell.textContent = value; cell.style.overflowWrap = 'anywhere';
      }
    }
    const detail = document.createElement('p');
    detail.textContent = 'Total records: ' + r.total + ' · Missing SMILES: ' + r.missing + ' · Invalid SMILES: ' + r.invalid;
    container.replaceChildren(table, detail);
    const scopeLabel = document.createElement('label');
    scopeLabel.textContent = 'Compound lists for';
    const scope = document.createElement('select');
    summaries.forEach((summary, index) => {
      const option = document.createElement('option'); option.value = String(index - 1); option.textContent = summary.label; scope.append(option);
    });
    scope.value = '-1'; scopeLabel.append(scope);
    const lists = document.createElement('div');
    container.append(scopeLabel, lists);
    function renderLists() {
      lists.replaceChildren();
      const patternIndex = Number(scope.value);
      for (const matched of [true, false]) {
      const compounds = (r.compounds || []).filter(compound =>
        (patternIndex < 0 ? compound.matched : (compound.matchedPatterns || []).includes(patternIndex)) === matched);
      const section = document.createElement('details');
      section.open = true;
      const title = document.createElement('summary');
      title.textContent = (matched ? 'Detected compounds' : 'Not detected compounds') + ' (' + compounds.length + ')';
      const filter = document.createElement('input');
      filter.placeholder = 'Filter by SMILES';
      filter.setAttribute('aria-label', title.textContent + ': filter by SMILES');
      const list = document.createElement('table');
      list.style.tableLayout = 'fixed';
      list.style.width = '100%';
      const header = list.createTHead().insertRow();
      for (const label of ['Canonical SMILES', 'Records']) {
        const cell = document.createElement('th'); cell.textContent = label; header.append(cell);
      }
      const body = list.createTBody();
      const previous = document.createElement('button'), next = document.createElement('button');
      previous.textContent = 'Previous'; next.textContent = 'Next';
      previous.type = next.type = 'button';
      const pageLabel = document.createElement('span');
      pageLabel.setAttribute('aria-live', 'polite');
      let page = 0, filtered = compounds;
      function renderPage() {
        body.replaceChildren();
        for (const compound of filtered.slice(page * 50, (page + 1) * 50)) {
          const row = body.insertRow();
          const smiles = row.insertCell();
          smiles.textContent = compound.smiles; smiles.style.overflowWrap = 'anywhere';
          row.insertCell().textContent = compound.records;
        }
        const pages = Math.max(1, Math.ceil(filtered.length / 50));
        pageLabel.textContent = ' Page ' + (page + 1) + ' / ' + pages + ' · ' + filtered.length + ' compounds ';
        previous.disabled = page === 0; next.disabled = page + 1 >= pages;
      }
      filter.oninput = () => { filtered = compounds.filter(c => c.smiles.includes(filter.value.trim())); page = 0; renderPage(); };
      previous.onclick = () => { page--; renderPage(); };
      next.onclick = () => { page++; renderPage(); };
      section.append(title, filter, list, previous, pageLabel, next);
      lists.append(section);
      renderPage();
      }
    }
    scope.onchange = renderLists;
    renderLists();
  }
}
module.exports = { attach, html, script, buildArgs, shellDisplay };
