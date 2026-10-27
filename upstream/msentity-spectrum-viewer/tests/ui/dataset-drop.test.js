const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../../vscode/extension.js'), 'utf8');
const start = source.indexOf('        case "drop-datasets": {');
const end = source.indexOf('        case "add-dataset": {', start);
const body = source.slice(start, end).replace('        case "drop-datasets": {', '').replace(/\s*break;\s*}\s*$/, '');
async function run(message) {
  const requests = [], errors = [], directories = new Set();
  await vm.runInNewContext('(async () => {' + body + '})()', {
    message, fs, path, require, Buffer, disposed: false, droppedDirectories: directories,
    DATASET_FORMATS: { msds: '', msp: '', mgf: '', tsv: '', csv: '' },
    writeRequest: request => requests.push(request),
    vscode: { Uri: { parse: value => {const uri = new URL(value); return {scheme: uri.protocol.slice(0, -1), path: decodeURIComponent(uri.pathname), fsPath: decodeURIComponent(uri.pathname)};} }, window: {showErrorMessage: message => errors.push(message)} }
  });
  return {requests, errors, directories};
}
test('dropped paths and URI lists reuse add-dataset protocol', async () => {
  const {requests, errors} = await run({paths: ['/tmp/sample.msp'], uris: ['file:///tmp/library%20one.mgf']});
  assert.equal(errors.length, 0);
  assert.deepEqual(requests.map(r => [r.type, r.path]), [['add-dataset', '/tmp/sample.msp'], ['add-dataset', '/tmp/library one.mgf']]);
});
test('dropped file bytes are preserved in a temporary dataset with original name', async () => {
  const data = Buffer.from([0, 1, 255, 20]);
  const result = await run({files: [{name: 'sample.msds', data: data.toString('base64')}]});
  try {
    assert.equal(result.errors.length, 0); assert.equal(result.requests.length, 1);
    assert.equal(path.basename(result.requests[0].path), 'sample.msds');
    assert.deepEqual(fs.readFileSync(result.requests[0].path), data);
  } finally { for (const directory of result.directories) fs.rmSync(directory, {recursive: true, force: true}); }
});
test('invalid paths and file names are rejected', async () => {
  for (const message of [{paths: ['/tmp/a.txt']}, {files: [{name: '../sample.msp', data: ''}]}, {uris: ['https://example.com/a.msp']}]) {
    const result = await run(message); assert.equal(result.requests.length, 0); assert.equal(result.errors.length, 1);
  }
});
