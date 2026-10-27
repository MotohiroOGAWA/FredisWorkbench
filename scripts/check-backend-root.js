const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fredis-backend-root-'));
let configured = '', selection, selectionError;
const updates = [];
const vscode = {
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => configured,
      update: async (...args) => updates.push(args) })
  },
  window: {
    showOpenDialog: async () => selection,
    showErrorMessage: async message => { selectionError = message; }
  },
  ConfigurationTarget: { Workspace: 2, Global: 1 }
};
const originalLoad = Module._load;
let host;
try {
  Module._load = function(name, ...args) {
    return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
  };
  host = require('../src/features/reaction-pattern-set/host');
} finally { Module._load = originalLoad; }

function backend(relative) {
  const root = path.join(temporary, relative);
  fs.mkdirSync(path.join(root, 'fredis'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname="fredis"\n');
  return root;
}
function workspace(root) { vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }]; }

async function main() {
  const previous = process.env.FREDIS_APPLICATION_ROOT;
  delete process.env.FREDIS_APPLICATION_ROOT;
  try {
    const extension = path.join(temporary, 'gui');
    fs.mkdirSync(extension);
    const context = { extensionPath: extension };
    const external = backend('external/backend');
    workspace(external);
    assert.equal(host.projectRoot(context), external, 'open backend directly');
    workspace(extension);
    configured = external;
    assert.equal(host.projectRoot(context), external, 'absolute setting');
    configured = '../external/backend';
    assert.equal(host.projectRoot(context), external, 'relative setting');
    process.env.FREDIS_APPLICATION_ROOT = '/missing';
    assert.equal(host.projectRoot(context), external, 'setting overrides environment');
    configured = '';
    process.env.FREDIS_APPLICATION_ROOT = external;
    assert.equal(host.projectRoot(context), external, 'development environment');
    configured = '/missing';
    assert.throws(() => host.projectRoot(context), /fredis.applicationRoot/);
    configured = '';
    delete process.env.FREDIS_APPLICATION_ROOT;
    for (const layout of ['FREDIS', 'fredis', 'mnt/fredis', 'mnt/app', 'app']) {
      const scenario = path.join('layouts', layout.replaceAll('/', '-'));
      const root = backend(path.join(scenario, layout));
      const gui = path.join(temporary, scenario);
      workspace(gui);
      assert.equal(host.projectRoot({ extensionPath: gui }), root, layout);
      workspace(path.join(temporary, 'unrelated'));
      assert.equal(host.projectRoot({ extensionPath: gui }), root, 'extension discovery');
    }
    workspace(extension);
    assert.throws(() => host.projectRoot(context), /Select Backend Folder/);
    selection = [{ fsPath: external }];
    assert.equal(await host.selectApplicationRoot(), true);
    assert.deepEqual(updates.pop(), ['applicationRoot', external, 2]);
    vscode.workspace.workspaceFolders = [];
    assert.equal(await host.selectApplicationRoot(), true);
    assert.deepEqual(updates.pop(), ['applicationRoot', external, 1]);
    selection = undefined;
    assert.equal(await host.selectApplicationRoot(), false);
    selection = [{ fsPath: extension }];
    assert.equal(await host.selectApplicationRoot(), false);
    assert.match(selectionError, /Not a FREDIS backend/);
    assert.equal(updates.length, 0);
    console.log('Backend discovery, explicit paths, and folder selection passed.');
  } finally {
    if (previous === undefined) delete process.env.FREDIS_APPLICATION_ROOT;
    else process.env.FREDIS_APPLICATION_ROOT = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
