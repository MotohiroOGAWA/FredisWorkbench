from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil

import torch
import pytest

from fredis.ml.data_preparation.fragment_tree.pretrained_models import stage_pretrained_models, relocate_sources
from fredis.ml.data_preparation.fragment_tree.create_training_data import _reset_output
from fredis.ml.training.fragment_tree_training.pattern_models import inspect_model, export_pattern, prepare_pattern_models, initialize_imports
from fredis.ml.training.fragment_tree_training.sources import inherit_model_config
from fredis.ml.specgen.spectrum_generator import create_spectrum_generator
from fredis.ml.training.fragment_tree_training.model import ReactionFragmentTreeTrainingModel
from .checkpoint_fixture import checkpoints


@pytest.mark.parametrize('single_pattern',[True,False])
def test_dataset_moves_and_trains_without_original_models(checkpoints,tmp_path,single_pattern):
    source,_,_=checkpoints
    saved=torch.load(source,weights_only=False)
    params=saved['model_config']
    patterns=inspect_model(source)['patterns']
    single=tmp_path/'single.reaction-model.pt'
    export_pattern(source,patterns[0]['pattern']['pattern_id'],single)
    records=[dict(pattern=item['pattern'],source=str(single if index==0 and single_pattern else source),source_pattern_id=item['pattern']['pattern_id'])
             for index,item in enumerate(patterns)]
    chemistry=prepare_pattern_models(dict(fragmenter_params=params['fragmenter_params'],symbols=params['mol_encoder_params']['symbols']),records)
    root=tmp_path/'dataset'
    with stage_pretrained_models(chemistry) as staged:
        archived=staged.install(root)
    assert all(not Path(item['source']).is_absolute() for item in archived['reaction_models'])
    selected={Path(item['source']) for item in chemistry['reaction_models']}
    assert len(list((root/'pretrained_models').glob('*.pt')))==len(selected)
    for original in selected:
        digest=hashlib.sha256(original.read_bytes()).hexdigest()
        copied=next((root/'pretrained_models').glob(digest+'*.pt'))
        assert copied.read_bytes()==original.read_bytes()
    (root/'fragment-tree.training-data-config.pft').write_text(json.dumps({'chemistry_config':archived}))
    for name in ('train_structures','validation_structures'):
        directory=root/name;directory.mkdir()
        split=relocate_sources(archived,root,directory)
        (directory/'fragment-tree.pft').write_text(json.dumps(dict(fragmenterParams=split['fragmenter_params'],symbols=split['symbols'],reactionModels=split['reaction_models'])))
        (directory/'reaction_statistics.json').write_text(json.dumps({'chemistry_config':split}))
    moved=tmp_path/'relocated';root.rename(moved)
    source.unlink();single.unlink()
    from fredis.ml.training.fragment_tree_training.sources import prepared_dataset_paths
    inherited=inherit_model_config(params,*prepared_dataset_paths(moved))
    import importlib.util
    backend_file = Path(__file__).resolve().parents[2] / 'src/workbench/dataset_backend.py'
    spec = importlib.util.spec_from_file_location('prepared_training_backend', backend_file)
    backend = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend)
    inspected = backend.training_sources({'datasetDir': str(moved), 'modelConfig': params})
    assert inspected['modelConfig']['fine_tuning'] == inherited['fine_tuning']
    assert all(item['source'] for item in inspected['patternModels'])
    with pytest.raises(ValueError, match='dataset preparation'):
        backend.training_sources({'datasetDir': str(moved), 'modelConfig': params,
                                  'pretrainedPatterns': [{'path': 'other.pt'}]})
    for item in inherited['fine_tuning']['pattern_imports']:
        assert Path(item['path']).is_relative_to(moved)
    generator=create_spectrum_generator(inherited)
    model=ReactionFragmentTreeTrainingModel(generator.feature_model,spectrum_model=generator.spectrum_model)
    initialize_imports(model,inherited)
    for name,tensor in saved['model_state_dict'].items():
        if name.startswith(('feature_model.mol_encoder.','feature_model.reaction_instance_encoder.')):
            assert torch.equal(tensor,model.state_dict()[name])

