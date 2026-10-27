"""Multiple input datasets: assigned roles and canonical union splitting."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import pandas as pd

from fredis.ml.data_preparation.fragment_tree.dataset_plan import plan_datasets, validate_list_config
from fredis.ml.data_preparation.fragment_tree.datasets import canonical_keys
from fredis.ml.data_preparation.fragment_tree.context import create_preparation_context
from fredis.ml.data_preparation.fragment_tree.create_training_data import main
from .dataset_fixture import dataset
from .test_preparation_adapters import backend
from .reaction_config import chemistry


class TestDatasetListAdapters(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.config=chemistry()
        self.config['fragmenter_params']['fragment_ion_tree_builder']['max_reaction_count']=1
        self.context=create_preparation_context(self.config)

    def source(self,name,smiles,split='train',mapping=None):
        file=self.root/(name+'.msds');data=dataset(smiles)
        if mapping:
            for key,column in mapping.items():
                original={'smilesColumn':'SMILES','adductTypeColumn':'AdductType','collisionEnergyColumn':'CollisionEnergy','precursorMzColumn':'PrecursorMZ'}[key]
                data[column]=data[original]
        data.save(str(file))
        return dict(id='dataset-'+name,path=str(file),split=split,mapping=mapping or {})

    def plan(self,entries,mode,**kwargs):
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            return plan_datasets(entries,mode,self.context.fragmenter,self.config['symbols'],**kwargs)

    def test_cli_preflight_and_saved_list_agree_in_both_modes(self):
        for mode in ('automatic','assigned'):
            with self.subTest(mode=mode):
                entries=[self.source('a',['CCO','CCN']),self.source('v',['CCC'],'validation'),self.source('t',['COC'],'test')]
                output=self.root/mode
                payload=dict(datasets=entries,datasetMode=mode,fragmenterParams=self.config['fragmenter_params'],symbols=self.config['symbols'],validationRatio=0.25,testRatio=0.25,validationSeed=3)
                with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                    preview=backend.validate(payload)
                    main(['--datasets-json',json.dumps(entries),'--dataset-mode',mode,'--output-dir',str(output),
                          '--params-json',json.dumps(self.config),'--validation-ratio','0.25','--test-ratio','0.25','--validation-seed','3'])
                clickable=json.loads((output/'fragment-tree.training-data-config.pft').read_text())
                self.assertFalse((output/'preparation_config.json').exists())
                self.assertEqual(clickable['workbench_config']['datasetMode'],mode)
                manifest=json.loads((output/'split_manifest.json').read_text())
                self.assertEqual(manifest['mode'],mode)
                for name in ('train','validation','test'):
                    folder=output/(name+'_structures')
                    saved=json.loads((folder/'fragment-tree.training-data.pft').read_text())
                    self.assertEqual(saved['datasetMode'],mode)
                    self.assertEqual(len(saved['datasets']),3)
                    import torch
                    for file in (folder/'data').glob('*.preft.pt'):
                        metadata=torch.load(file,map_location='cpu',weights_only=False)['metadata']
                        self.assertTrue(metadata['source_records'])
                        self.assertTrue(all((file.parent / item['path']).resolve() in [Path(entry['path']).resolve() for entry in entries] for item in metadata['source_records']))
                    rows=pd.read_csv(folder/'manifest.tsv',sep='\t')
                    self.assertEqual(int(rows['num_input_records'].sum()),preview['splits'][name]['records'])

