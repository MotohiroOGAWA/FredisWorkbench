# msentity-spectrum-viewer

Viewer for mass-spectrometry datasets (MSDS, MSP, MGF, TSV, CSV) and spectrum
similarity results (`.mssim`), built on the C++ libraries
[msentity](https://github.com/MotohiroOGAWA/msentity) and
msentity-similarity. It is distributed as a **VS Code extension**, and the
repository is designed to be added to other projects as a **Git submodule**:
the UI components, the backend, and msentity / msentity-similarity can each be
used on their own.

```text
external/msentity/              msentity (Git submodule): data model, MSDS/MSP/MGF/TSV/CSV
external/msentity-similarity/   msentity-similarity (Git submodule): scores, .mssim
backend/                        msentity-viewer-backend (C++): answers the UI over stdin/stdout
ui/                             UI components: dataset table, spectrum, similarity result
host/                           Node.js host library: runs the backend; RDKit (WebAssembly) for chemistry
vscode/                         the VS Code extension
tests/                          backend protocol, host, and UI tests (npm test)
docs/                           protocol and embedding guides
```

```text
 VS Code / other host ──▶ ui/*.js (webview) ── messages ──▶ host/ ──▶ msentity-viewer-backend
                                                              │        (msentity + msentity-similarity)
                                                              └──▶ host/chemistry (RDKit WebAssembly, worker thread)
```

## Documentation

* [vscode/README.md](vscode/README.md) — using the extension
* [docs/embedding.md](docs/embedding.md) — using this repository as a submodule:
  msentity from C++/Python/Java/C#, the UI components, the host library
* [docs/protocol.md](docs/protocol.md) — messages between UI, host, and backend

## Building

```console
git clone --recurse-submodules <url>/msentity-spectrum-viewer.git
cd msentity-spectrum-viewer
cmake -S . -B build -G Ninja           # dependencies: see external/msentity/README.md
cmake --build build                    # build/backend/msentity-viewer-backend
(cd host && npm install)               # RDKit WebAssembly (optional; chemistry features)
```

## Tests

```console
npm test                                         # backend protocol, host library, UI (Node ≥ 20)
```

`tests/ui/toolbar-ui.test.js` and the browser part of
`tests/ui/similarity-ui.test.js` run only when Playwright is installed
(`npm install --no-save playwright && npx playwright install chromium`).

## Running the extension from the repository

Open the repository in VS Code and start **Run Extension** (F5). The extension
in `vscode/` finds the UI and host one directory up and the backend in
`build/backend/`; `msentitySpectrumViewer.backendPath` or the environment
variable `MSENTITY_VIEWER_BACKEND` selects another backend.

## Packaging

```console
(cd host && npm install)                         # RDKit, bundled into the standard package
(cd vscode && npm ci)                            # vsce
node vscode/scripts/package-vsix.js              # dist/msentity-spectrum-viewer-<version>-<platform>.vsix
node vscode/scripts/package-vsix.js --no-rdkit   # dist/msentity-spectrum-viewer-no-rdkit-<version>-<platform>.vsix
```

`--backend` selects the backend executable and `--target` its platform
(`linux-x64`, `win32-x64`). Packages for distribution need a
backend built with `-DMSENTITY_STATIC_DEPS=ON` and vcpkg, so that it does not
depend on Arrow/Parquet/HDF5 libraries on the user's machine;
`.github/workflows/release.yml` builds them for every platform:
`npm run release:build` builds and downloads them, and `npm run release:publish`
publishes them (`scripts/release.js`).

## Updating msentity and msentity-similarity

```console
git -C external/msentity fetch && git -C external/msentity checkout <commit>
git -C external/msentity-similarity fetch && git -C external/msentity-similarity checkout <commit>
cmake --build build && npm test
git add external/msentity external/msentity-similarity
git commit -m "Update msentity and msentity-similarity"
```

msentity-similarity pins its own msentity commit for standalone builds; keep
both submodules on matching commits.

## License

MIT — see [LICENSE](LICENSE). The VS Code package includes RDKit (BSD-3-Clause);
see [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
