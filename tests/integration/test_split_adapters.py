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
from .test_preparation_adapters import backend
from .reaction_config import chemistry


def dataset(smiles):
    mzs=[Compound.from_smiles(value).formula.exact_mass+1.007276466 for value in smiles]
    metadata=pd.DataFrame({'SMILES':smiles,'AdductType':['[M+H]+']*len(smiles),
                           'CollisionEnergy':[20]*len(smiles),'PrecursorMZ':mzs})
    return MSDataset(metadata,PeakSeries(np.array([[mz,1] for mz in mzs]),np.arange(len(smiles)+1,dtype=np.int64)))


class TestDatasetSplitsAdapters(unittest.TestCase):
    def test_preflight_matches_three_split_outputs_and_saved_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/'input.msds';output=root/'out'
            data=dataset(['CCO','OCC','CCN','CCC','COC']);data.save(str(source))
            config=chemistry()
            config['fragmenter_params']['fragment_ion_tree_builder']['max_reaction_count']=1
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                preview=backend.validate({'input':str(source),'fragmenterParams':config['fragmenter_params'],
                    'symbols':config['symbols'],'validationRatio':0.2,'testRatio':0.2,'validationSeed':17})
                main(['--input',str(source),'--output-dir',str(output),'--params-json',json.dumps(config),
                      '--validation-ratio','0.2','--test-ratio','0.2','--validation-seed','17'])
            manifest=json.loads((output/'split_manifest.json').read_text())
            _, expected=split_assignments(data['SMILES'],0.2,0.2,17)
            self.assertEqual(manifest['assignments'],expected)
            saved=json.loads((output/'fragment-tree.training-data-config.pft').read_text())
            self.assertEqual(saved['test_ratio'],0.2)
            self.assertEqual(saved['workbench_config']['testRatio'],0.2)
            for name in ('train','validation','test'):
                folder=output/f'{name}_structures'
                saved=json.loads((folder/'fragment-tree.training-data.pft').read_text())
                self.assertEqual(saved['split'],name)
                self.assertEqual(saved['testRatio'],0.2)
                rows=pd.read_csv(folder/'manifest.tsv',sep='\t')
                self.assertEqual(len(set(canonical_keys(rows['smiles']))),preview['splits'][name]['molecules'])
                self.assertEqual(int(rows['num_input_records'].sum()),preview['splits'][name]['records'])

    def test_preflight_rejects_canonical_overlap_in_different_files(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'train.msds';validation=Path(directory)/'val.msds'
            dataset(['CCO','CCC']).save(str(source));dataset(['OCC']).save(str(validation))
            with self.assertRaisesRegex(ValueError,'share SMILES'):
                backend.validate({'input':str(source),'validationInput':str(validation),**{
                    'fragmenterParams':chemistry()['fragmenter_params'],'symbols':chemistry()['symbols']}})

