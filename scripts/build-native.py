"""Build source snapshots with the Arrow/Parquet shipped in pyarrow.

Requires CMake, a C++20 compiler, HDF5 development files and nlohmann-json.
Extra CMake options may be passed after --, e.g. -DCMAKE_PREFIX_PATH=/deps.
"""
import argparse
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--jobs', default='4')
args, extra = parser.parse_known_args()
extra = [x for x in extra if x != '--']
root = Path(__file__).resolve().parents[1]
import pyarrow
arrow = Path(pyarrow.__file__).parent
config = root / 'build/native-deps'
for name in ['Arrow', 'Parquet']:
    folder = config / name
    folder.mkdir(parents=True, exist_ok=True)
    library = name.lower()
    candidates = list(arrow.glob(f'lib{library}.so.*')) + list(arrow.glob(f'lib{library}.*.dylib'))
    if not candidates:
        raise SystemExit('This helper supports Linux/macOS pyarrow wheels; on Windows use the upstream CMake build.')
    (folder / f'{name}Config.cmake').write_text(f'''if(NOT TARGET {name}::{library}_shared)
add_library({name}::{library}_shared SHARED IMPORTED)
set_target_properties({name}::{library}_shared PROPERTIES IMPORTED_LOCATION "{candidates[0]}" INTERFACE_INCLUDE_DIRECTORIES "{arrow / 'include'}")
endif()
''')
source = root / 'upstream/msentity-spectrum-viewer'
build = source / 'build'
subprocess.run(['cmake', '-S', str(source), '-B', str(build),
    f'-DArrow_DIR={config / "Arrow"}', f'-DParquet_DIR={config / "Parquet"}',
    '-DMSENTITY_BUILD_TESTS=OFF', '-DMSENTITY_SIMILARITY_BUILD_TESTS=OFF', *extra], check=True)
subprocess.run(['cmake', '--build', str(build), '-j', args.jobs], check=True)
