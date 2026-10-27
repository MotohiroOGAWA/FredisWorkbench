// Browser test; skipped when Playwright is not installed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
(async () => {
  if (!chromium) { console.log('toolbar UI test skipped: Playwright is not installed'); return; }
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="app"></div>');
    await page.evaluate(() => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: m => messages.push(m) }); });
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../../ui/viewer.css'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../ui/viewer.js'), 'utf8') });
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const datasetPage = id => send({type: 'dataset-page', value: {dataset_id: id, dataset_path: '/sample.msds', columns: ['Name', 'SpecID'], rows: [{Name: 'sample', SpecID: '1'}], row_ids: [0], total_rows: 1, total_pages: 1, attributes: {}, tags: []}});
    await send({type: 'backend-ready', dataset: {id: 'original', name: 'sample.msds'}});
    await datasetPage('original');
    const open = () => page.locator('#more-actions-button').click();
    const visible = () => page.locator('#more-actions-menu').isVisible();
    const last = () => page.evaluate(() => messages.at(-1));
    assert.equal(await page.locator('#remove-dataset').isDisabled(), false);
    await page.locator('#dataset-select').click();
    await page.locator('#add-dataset').click(); assert.equal((await last()).type, 'add-dataset');
    await send({type: 'dataset-added', dataset: {id: 'added', name: 'added.msds'}}); await datasetPage('added');
    await page.locator('#dataset-select').click(); await page.locator('[data-dataset-id="original"]').click(); assert.equal((await last()).datasetId, 'original'); await datasetPage('original');
    await page.locator('#dataset-select').click(); await page.locator('[data-dataset-id="added"]').click(); await datasetPage('added');
    await page.locator('#dataset-select').click(); await page.locator('#remove-dataset').click(); assert.equal((await last()).type, 'remove-dataset');
    await send({type: 'dataset-removed', dataset_id: 'added'}); await datasetPage('original');
    await open(); assert.equal(await visible(), true);
    assert.deepEqual(await page.locator('#more-actions-menu button').allTextContents(), ['Metadata', 'Columns', 'Assign SpecID', 'Calculate similarity', 'Settings']);
    await page.locator('.summary').click(); assert.equal(await visible(), false);
    await open(); await page.keyboard.press('Escape'); assert.equal(await visible(), false);
    assert.equal(await page.locator('#more-actions-button').evaluate(e => e === document.activeElement), true);
    await page.keyboard.press('Enter'); await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#columns-button').evaluate(e => e === document.activeElement), true);
    await page.keyboard.press('Enter'); assert.equal(await page.locator('#column-menu').isVisible(), true); assert.equal(await visible(), false);
    await page.locator('#add-column-toggle').click(); assert.equal(await page.locator('#add-column-form').isVisible(), true);
    await page.locator('#new-column-name').fill('Note'); await page.locator('#add-column-form button').click(); assert.equal((await last()).type, 'add-column');
    await page.keyboard.press('Escape');
    await page.locator('#filter-button').click(); await page.locator('#add-filter').click(); await page.locator('#add-peak-filter').click();
    assert.equal(await page.locator('.filter-row').count(), 2);
    assert.equal(await page.locator('.peak-kind').count(), 1);
    await page.locator('[data-filter-field="mz"]').fill('123.45');
    await page.locator('[data-filter-field="tolerance"]').fill('10');
    await page.locator('[data-filter-field="tolerance_unit"]').selectOption('ppm');
    await page.locator('[data-intensity-slider]').fill('0.4');
    assert.equal(await page.locator('[data-filter-field="intensity"]').inputValue(), '0.4');
    const productIon = page.locator('input[value="spectrum_peak"]');
    const neutralLoss = page.locator('input[value="neutral_loss"]');
    assert.equal(await productIon.isChecked(), true);
    assert.equal(await neutralLoss.isChecked(), false);
    await neutralLoss.check();
    assert.equal(await productIon.isChecked(), false);
    assert.equal(await neutralLoss.isChecked(), true);
    await page.locator('#apply-filters').click(); assert.equal((await last()).filters.length, 2); await datasetPage('original');
    assert.equal((await last()).filters[1].operator, 'neutral_loss');
    assert.match(await page.locator('#filter-button').textContent(), /2/); await open();
    await page.locator('#metadata-button').click(); assert.equal(await page.locator('.metadata-panel').isVisible(), true); assert.equal(await visible(), false);
    await page.locator('#cancel-metadata').click();
    for (const [id, type] of [['assign-spec-id-button', 'assign-spec-id'], ['export-button', 'export-dataset'], ['similarity-button', 'calculate-similarity']]) {
      await open(); await page.locator('#' + id).click(); assert.equal((await last()).type, type); assert.equal(await visible(), false);
    }
    await send({type: 'export-cancelled'});
    await send({type: 'export-start'});
    await send({type: 'export-progress', processed: 1, total: 4, percent: 25});
    assert.match(await page.locator('#export-button').textContent(), /25\.0%/);
    await send({type: 'export-cancelled'});
    const beforeShortcut = await page.evaluate(() => messages.length);
    await page.keyboard.press('Control+s');
    assert.equal((await last()).type, 'export-dataset');
    assert.equal(await page.evaluate(() => messages.length), beforeShortcut + 1);
    await page.keyboard.press('Control+s');
    assert.equal(await page.evaluate(() => messages.length), beforeShortcut + 1);
    await send({type: 'export-cancelled'});
    await page.locator('#reload-button').click(); assert.equal((await last()).type, 'reload'); await datasetPage('original');
    for (const [theme, background, foreground] of [['dark', '#252526', '#cccccc'], ['light', '#ffffff', '#333333']]) {
      await page.evaluate(({background, foreground}) => { document.documentElement.style.setProperty('--vscode-menu-background', background); document.documentElement.style.setProperty('--vscode-menu-foreground', foreground); }, {background, foreground});
      await open(); const colors = await page.locator('#more-actions-menu').evaluate(e => ({bg: getComputedStyle(e).backgroundColor, fg: getComputedStyle(e).color}));
      assert.notEqual(colors.bg, colors.fg, theme); await page.keyboard.press('Escape');
    }
    await page.evaluate(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['Name\tmz\tintensity\nsample\t100\t10'], 'dropped.tsv'));
      document.dispatchEvent(new DragEvent('dragenter', {dataTransfer: transfer, bubbles: true, cancelable: true}));
      if (!document.getElementById('app').classList.contains('dataset-drop-active')) throw new Error('Missing drop feedback');
      document.dispatchEvent(new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true}));
    });
    await page.waitForFunction(() => messages.at(-1)?.type === 'drop-datasets');
    assert.equal((await last()).files[0].name, 'dropped.tsv');
    await page.evaluate(() => {
      const transfer = new DataTransfer(); transfer.setData('text/uri-list', 'file:///tmp/reference.msp\r\nfile:///tmp/library.mgf');
      document.dispatchEvent(new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true}));
    });
    assert.equal((await last()).uris.length, 2);
    await page.evaluate(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['text'], 'unsupported.txt'));
      document.dispatchEvent(new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true}));
    });
    assert.equal((await last()).type, 'edit-error-notification');
    await page.setViewportSize({width: 360, height: 800}); await open();
    const bounds = await page.locator('#more-actions-menu').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360);
    await page.keyboard.press('Escape');
    await send({type: 'dataset-added', dataset: {id: 'remaining', name: 'remaining.msp'}}); await datasetPage('remaining');
    await page.locator('#dataset-select').click(); await page.locator('[data-dataset-id="original"]').click(); await datasetPage('original');
    await page.locator('#dataset-select').click(); await page.locator('#remove-dataset').click();
    assert.equal((await last()).datasetId, 'original');
    await send({type: 'dataset-removed', dataset_id: 'original'});
    assert.equal((await last()).datasetId, 'remaining'); await datasetPage('remaining');
    await page.locator('#dataset-select').click(); await page.locator('#remove-dataset').click();
    await send({type: 'dataset-removed', dataset_id: 'remaining'});
    assert.equal(await page.getByText('No datasets loaded.', {exact: true}).isVisible(), true);
    await page.locator('#add-dataset').click(); assert.equal((await last()).type, 'add-dataset');
    await send({type: 'dataset-added', dataset: {id: 'new', name: 'new.msp'}}); await datasetPage('new');
    assert.equal(await page.locator('#dataset-select').textContent(), 'new.msp');
    await send({type: 'capabilities', chemistry: {backend: 'rdkit', structure_count: true}});
    await open();
    assert.equal(await page.locator('#structure-counts-button').isVisible(), true);
    await page.locator('#structure-counts-button').click();
    assert.equal((await last()).type, 'calculate-structure-counts');
    assert.equal((await last()).datasetId, 'new');
    await send({type: 'structure-counts', dataset_id: 'new', total_rows: 1, unique_smiles: 1, canonical_structures: 1});
    assert.match(await page.locator('.summary').textContent(), /1 spectra · 1 unique SMILES · 1 canonical structures/);
    console.log('Toolbar browser checks passed: actions, secondary popups, close behavior, keyboard navigation, themes, narrow viewport.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
