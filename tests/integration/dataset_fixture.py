"""Canonical molecule partitioning and Workbench/CLI agreement."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import pandas as pd

from fredis.data import MSDataset
from fredis.data.core.PeakSeries import PeakSeries
from fredis.libs.mmkit.mmkit import Compound
from fredis.ml.data_preparation.fragment_tree.datasets import (
    canonical_keys, canonical_smiles, dedupe_validation, split_assignments, split_dataset,
)
from fredis.ml.data_preparation.fragment_tree.create_training_data import main
from .reaction_config import chemistry


def dataset(smiles):
    mzs=[Compound.from_smiles(value).formula.exact_mass+1.007276466 for value in smiles]
    metadata=pd.DataFrame({'SMILES':smiles,'AdductType':['[M+H]+']*len(smiles),
                           'CollisionEnergy':[20]*len(smiles),'PrecursorMZ':mzs})
    return MSDataset(metadata,PeakSeries(np.array([[mz,1] for mz in mzs]),np.arange(len(smiles)+1,dtype=np.int64)))

