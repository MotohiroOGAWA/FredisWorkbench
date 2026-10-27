msentity Spectrum Viewer @VERSION@ for VS Code.

## Install

Download the VSIX for your platform and install it with
`code --install-extension <file>.vsix`, or in VS Code with
**Extensions → Views and More Actions (...) → Install from VSIX...**.

| Platform | Standard (with RDKit) | Without RDKit |
|---|---|---|
| Linux x64 | `msentity-spectrum-viewer-@VERSION@-linux-x64.vsix` | `msentity-spectrum-viewer-no-rdkit-@VERSION@-linux-x64.vsix` |
| Windows x64 | `msentity-spectrum-viewer-@VERSION@-win32-x64.vsix` | `msentity-spectrum-viewer-no-rdkit-@VERSION@-win32-x64.vsix` |

The standard package includes RDKit (SMARTS filters, structure previews,
structure counts). The package without RDKit is smaller and has everything
else. Nothing else needs to be installed.

Files without the version in their name are the same packages, for links that
always point to the latest release, e.g.
`https://github.com/MotohiroOGAWA/msentity-spectrum-viewer/releases/latest/download/msentity-spectrum-viewer-linux-x64.vsix`.
