from copy import deepcopy
import json

import pytest
import torch

from fredis.ml.specgen.spectrum_generator import create_spectrum_generator
from fredis.ml.training.fragment_tree_training.model import ReactionFragmentTreeTrainingModel
from fredis.ml.training.fragment_tree_training.integration import integrate_checkpoints
from .reaction_config import config


@pytest.fixture
def checkpoints(tmp_path):
    params = config()
    generator = create_spectrum_generator(params)
    wrapper = ReactionFragmentTreeTrainingModel(generator.feature_model,spectrum_model=generator.spectrum_model)
    checkpoint = {'architecture':generator.architecture,'model_config':params,'model_state_dict':wrapper.state_dict()}
    a,b = tmp_path/'a.pt', tmp_path/'b.pt'
    torch.save(checkpoint,a);torch.save(checkpoint,b)
    return a,b,tmp_path/'combined.pt'

