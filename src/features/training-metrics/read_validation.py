"""Read validation representatives directly from the shared MSDS library."""
import json
from pathlib import Path
import sys

from fredis.ml.training.fragment_tree_training.validation_storage import read_validation_msdataset

print(json.dumps(read_validation_msdataset(sys.argv[1]), allow_nan=False))
