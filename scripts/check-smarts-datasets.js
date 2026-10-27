const assert = require('assert');
const { JSDOM } = require('jsdom');
const Module = require('module');
const original = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let handler, picked, copied;
const posted = [];
Module._load = function(name, ...args) {
  if (name === 'vscode') return {
    window: { showOpenDialog: async () => picked },
    workspace: { getConfiguration: () => ({ get: () => 'python' }) },
    env: { clipboard: { writeText: async value => { copied = value; } } }
  };
  return original.call(this, name, ...args);
};
const editor = require('../src/features/smarts-search/editor');
const messages = [];
const dom = new JSDOM(editor.html(), { runScripts: 'outside-only' });
dom.window.vscode = { postMessage: message => messages.push(message) };
dom.window.eval(editor.script());
const document = dom.window.document;
const click = id => document.getElementById(id).click();
const receive = data => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
click('smartsAddDataset');
let rows = document.getElementById('smartsDatasets').children;
assert.equal(rows.length, 2);
rows[0].querySelector('input[data-path-kind]').value = 'first.msds';
rows[1].querySelector('input[data-path-kind]').value = 'second.msds';
rows[1].querySelector('details input').value = 'canonical';
receive({ type: 'smartsPatternsImported', patterns: [{name:'Carbon',smarts:'C'}, {name:'Oxygen',smarts:'O'}, {name:'Duplicate',smarts:'C'}] });
assert.equal(document.getElementById('smartsQueries').children.length, 2);
click('smartsCopy');
const payload = messages.at(-1).payload;
assert.deepEqual(JSON.parse(JSON.stringify(payload.datasets)), [{file:'first.msds',column:'SMILES'}, {file:'second.msds',column:'canonical'}]);
assert.equal(rows[0].querySelector('details').open, false);
const enabled = rows[1].querySelector('input[type=checkbox]');
enabled.checked = false; enabled.onchange();
assert.equal(rows[1].querySelector('input[data-path-kind]').disabled, true);
rows[1].querySelector('input[data-path-kind]').value = '';
click('smartsCopy');
assert.equal(messages.at(-1).payload.datasets.length, 1);
const firstEnabled = rows[0].querySelector('input[type=checkbox]');
firstEnabled.checked = false; firstEnabled.onchange();
const count = messages.length;
click('smartsCopy');
assert.equal(messages.length, count);
assert(document.getElementById('smartsStatus').textContent.includes('Enable at least one'));
firstEnabled.checked = true; firstEnabled.onchange();
enabled.checked = true; enabled.onchange();
rows[1].querySelector('input[data-path-kind]').value = 'second.msds';
rows[1].querySelector('button').click();
receive({type:'smartsDatasets',rowId:messages.at(-1).rowId,files:['replacement.msds','third.msds']});
assert.equal(rows.length, 3);
assert.equal(rows[1].querySelector('input[data-path-kind]').value,'replacement.msds');
assert.equal(rows[1].querySelector('details input').value,'canonical');
const result = {total:0,missing:0,invalid:0,valid:0,matched:0,unique:0,uniqueMatched:0,percent:null,uniquePercent:null,compounds:[],patterns:[]};
receive({type:'smartsSearchResult',ok:true,results:[{file:'first.msds',column:'SMILES',result},{file:'second.msds',column:'canonical',result}]});
assert.equal(document.querySelectorAll('#smartsResult > section').length,2);
assert(document.getElementById('smartsResult').textContent.includes('second.msds · SMILES column: canonical'));
async function main() {
  const root = require('./paths').applicationRoot;
  editor.attach({onDidDispose(){},webview:{onDidReceiveMessage(fn){handler=fn;},postMessage(message){posted.push(message);}}}, {}, () => root);
  await handler({type:'copySmartsCommand',payload});
  assert.equal(copied.split('\n').length,2);
  assert(copied.includes('--smiles-column canonical'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'fredis-smarts-'));
  try {
    const file = path.join(tmp,'patterns.pft');
    fs.writeFileSync(file, JSON.stringify({reaction_pattern_set:{patterns:[{name:'Carbon',reactant_smarts:'C'}]}}));
    picked=[{fsPath:file}];
    await handler({type:'importSmartsPatterns'});
    assert.deepEqual(posted.at(-1).patterns,[{name:'Carbon',smarts:'C'}]);
    fs.writeFileSync(file,'{}');
    await handler({type:'importSmartsPatterns'});
    assert(posted.at(-1).error.includes('No Reactant SMARTS'));
    const filePath='tests/fixtures/msentity/sample.msds';
    await handler({type:'smartsSearch',payload:{datasets:[{file:filePath,column:'SMILES'},{file:filePath,column:'SMILES'}],smarts:['C']}});
    const response=posted.at(-1);
    assert.equal(response.ok,true,response.error);
    assert.equal(response.results.length,2);
    assert.deepEqual(response.results.map(dataset=>dataset.result.matched),[6,6]);
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); dom.window.close(); }
  console.log('Multiple datasets, per-dataset columns/results, pattern import and copied commands passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
