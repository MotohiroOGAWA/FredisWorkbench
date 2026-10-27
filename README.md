# FREDIS Workbench

A standalone VS Code GUI for the FREDIS Python backend. This repository owns the
extension, webviews, JSON adapters, file-format registry, tests and VSIX packaging.
The Python backend is a separate repository and is accessed through its CLI and
importable APIs. Neither repository needs to be nested inside the other.

## Backend environment

Install FREDIS and its scientific dependencies in a Python environment, following
the [backend installation guide](https://github.com/MotohiroOGAWA/FREDIS/blob/main/docs/guides/installation.md).
You can keep FREDIS as a submodule of this GUI repository:

```bash
git submodule add https://github.com/MotohiroOGAWA/FREDIS.git FREDIS
python FREDIS/scripts/install.py
```

For an existing checkout, initialize it with `git submodule update --init --recursive`.
The Workbench automatically discovers `FREDIS/` or `fredis/` under the workspace
or extension directory. It also recognizes `mnt/fredis` in the development
workspace. The backend can instead be any separate directory on disk:

```bash
cd /path/to/FREDIS
python scripts/install.py
```

Run **FREDIS: Select Backend Folder** from the Command Palette and select that
repository folder. The command saves `fredis.applicationRoot` and opens the
Workbench. Alternatively, configure workspace or user settings directly:

```json
{
  "fredis.applicationRoot": "/workspaces/FREDIS/mnt/fredis",
  "fredis.pythonPath": "python"
}
```

`fredis.applicationRoot` accepts an absolute path or a path relative to the first
workspace folder. Configure `fredis.pythonPath` with the interpreter in which
you ran the installer. Preparation, training and prediction use that environment.
For development launches, `FREDIS_APPLICATION_ROOT` is also accepted when no
`fredis.applicationRoot` setting is present. Explicit invalid paths report an
error instead of silently using another checkout.

## Build and run

From this repository root:

```bash
python scripts/build-native.py
(cd upstream/msentity-spectrum-viewer/host && npm ci)
npm ci
npm run build:spectrum-viewer
npm run dev
```

In VS Code, launch **Run FREDIS Workbench** from this repository's Run and Debug
panel, then run **FREDIS: Open Workbench** in the Extension Development Host.
Use **FREDIS: Select Backend Folder** there to change the backend checkout.
In the enclosing FREDIS development workspace, **Run FREDIS Workbench Extension
(no debugger)** loads `mnt/fredis_workbench` and opens `mnt/fredis` directly.

`upstream/msentity-spectrum-viewer` is a source snapshot of the separate viewer.
`upstream/versions.json` records all source commits. No Git submodules are required. Packaging
copies its UI, Node host, licenses and native backend into `vendor/msentity-spectrum-viewer`; it never reads
a viewer from the FREDIS source tree. For an installable extension:

```bash
npm run package
```

The VSIX is written under `artifacts/`. Install it with **Extensions: Install
from VSIX...** and run **FREDIS: Open Workbench**.

## Checks

Development checks locate the backend through the selected Python interpreter's
installed package metadata. Set `FREDIS_PYTHON` for a different interpreter or
`FREDIS_APPLICATION_ROOT` for an explicit backend checkout when running Node checks.

```bash
npm run check:training-ui
npm run check:workbench
npm run check:backend-root
npm run check:tuning
npm run check:spectrum-viewer
npm run check:prediction-ui
python -m pytest tests/integration -q
```

The migrated Python adapter tests live here, rather than in FREDIS. Backend unit
tests and backend documentation build independently of this repository. The
real-data integration verifier also uses this repository's command builder:

```bash
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 python tests/verify_gpu_pipeline.py \
  --source /path/to/mona_pos_cf_flavonoids.msds \
  --output .verification/shared --training-command fragment-tree --workbench
```

Use a fresh output directory and `fragment-tree-detailed` to verify the detailed
interface. The verifier selects four specific experimental MoNA records; see its
source for provenance and checks.

## Documentation and history

[Workbench guide](docs/workbench.md) describes the GUI. [Detailed reference](docs/reference.md)
retains the existing editor and workflow notes. Scientific concepts, CLI options
and model architecture belong to the backend documentation.

This repository was extracted from FREDIS with its Workbench commit history
preserved. The FREDIS extraction branch is `refactor/extract-workbench`. The local
GUI repository has no publishing remote configured; add the destination remote
when choosing where to host it.

## Native build dependencies

Use Node.js 20 or newer. Install CMake, a C++20 compiler, HDF5 development files,
`nlohmann-json3-dev` and `pyarrow>=20` before running the helper above. It uses
the Arrow/Parquet libraries from the selected Python environment. Extra CMake
options can be passed after `--`, for example
`python scripts/build-native.py -- -DCMAKE_PREFIX_PATH=/path/to/dependencies`.
Builds in this workspace use local shared libraries. For redistribution, use
the upstream static-dependency build or a released backend for the target OS.
The viewer uses C++ and RDKit WebAssembly; `fredis.pythonPath` is used only for
FREDIS operations. A different viewer backend can be selected through
`msentitySpectrumViewer.backendPath`.
