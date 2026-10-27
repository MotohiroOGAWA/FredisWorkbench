"""Run the separate viewer's native backend protocol checks (Node >= 20)."""
from pathlib import Path
import os
import subprocess
root = Path(__file__).resolve().parents[1] / 'upstream/msentity-spectrum-viewer'
subprocess.run([os.environ.get('NODE', 'node'), '--test',
                *map(str, sorted((root / 'tests/backend').glob('*.test.js')))],
               cwd=root, check=True)
