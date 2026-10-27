const fs = require('fs');
const path = require('path');

let configuredRoot = '';

function isViewerRoot(candidate) {
  return Boolean(candidate) && [
    'vscode/extension.js', 'ui/viewer.js', 'ui/viewer.css',
    'ui/spectrum.js', 'host/index.js'
  ].every(file => fs.existsSync(path.join(candidate, file)));
}

function configure(context, vscode) {
  const repository = path.resolve(__dirname, '../../../upstream/msentity-spectrum-viewer');
  const bundled = context?.extensionPath
    ? path.join(context.extensionPath, 'vendor/msentity-spectrum-viewer') : '';
  // Always use submodule source when it is available. Packaged Workbenches
  // carry a snapshot built from that same source; no installed msentity VSIX.
  configuredRoot = [repository, bundled].find(isViewerRoot) || '';
  if (!configuredRoot) {
    throw new Error('msentity viewer source was not found. Restore upstream/msentity-spectrum-viewer or rebuild Workbench with npm run build:spectrum-viewer.');
  }
  return configuredRoot;
}

function root(context, vscode) {
  if (configuredRoot && isViewerRoot(configuredRoot)) return configuredRoot;
  return configure(context, vscode);
}

function file(...parts) {
  return path.join(root(), ...parts);
}

module.exports = { configure, root, file };
