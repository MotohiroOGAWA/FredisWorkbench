const fs = require('fs');
const path = require('path');

// Package the upstream UI and host unchanged. Native binaries must be built
// for the deployment platform, or selected through the viewer's backendPath.
function build(source = path.resolve(__dirname, '../upstream/msentity-spectrum-viewer'),
  target = path.resolve(__dirname, '../vendor/msentity-spectrum-viewer')) {
  for (const entry of ['vscode/extension.js', 'ui/viewer.js', 'host/index.js', 'LICENSE']) {
    if (!fs.existsSync(path.join(source, entry))) throw new Error('Missing viewer source: ' + entry);
  }
  if (path.resolve(source) === path.resolve(target)) throw new Error("Source and target must differ");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const entry of ['ui', 'host', 'vscode/extension.js', 'vscode/media', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']) {
    const destination = path.join(target, entry);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(source, entry), destination, { recursive: true,
      filter: file => !file.includes('__pycache__') && !file.endsWith('.pyc') });
  }
  const host = require(path.join(source, 'host'));
  const binary = host.findBackendExecutable({ roots: [source] });
  if (binary) {
    const bin = path.join(target, 'bin', process.platform + '-' + process.arch);
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(binary, path.join(bin, path.basename(binary)));
    fs.chmodSync(path.join(bin, path.basename(binary)), 0o755);
  } else {
    throw new Error('Build upstream/msentity-spectrum-viewer with CMake or set MSENTITY_VIEWER_BACKEND before packaging.');
  }
  return target;
}
if (require.main === module) console.log('Built viewer: ' + build());
module.exports = { build };
