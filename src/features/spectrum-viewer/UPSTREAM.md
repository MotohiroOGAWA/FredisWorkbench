# Shared spectrum viewer

`upstream/msentity-spectrum-viewer` is a source snapshot of the separate viewer
repository. `upstream/versions.json` records the source commits. Git metadata is
not included. Its nested `external/` snapshots provide the native data and
similarity libraries; the FREDIS Python repository never contains the viewer.

The Workbench uses the unmodified `ui/viewer.*` dataset component and
`ui/spectrum.*` comparison component. The host adapter loads
`vscode/extension.js`, supplies the VS Code API and wraps `host.BackendProcess`
to start an empty embedded workspace. Dataset messages remain scoped to the
Workbench iframe. Chemistry uses upstream RDKit WebAssembly; Python is not used
by the viewer. Training and prediction still use the configured FREDIS Python.

Build the C++ backend before `npm run build:spectrum-viewer`. Packaging copies
the UI, host, extension host adapter, licenses and the current platform's backend
to `vendor/msentity-spectrum-viewer`. For distribution to another machine, build
with the upstream static dependency settings, or use a released upstream
backend. The normal development build links local Arrow/Parquet/HDF5 libraries.
