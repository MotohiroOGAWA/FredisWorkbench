from pathlib import Path

def test_workbench_descriptor_choices_match_supported_descriptors():
    import re
    from pathlib import Path
    from fredis.domain.molecule.descriptors import SUPPORTED_DESCRIPTOR_NAMES
    text=Path("src/workbench/mol-descriptors.js").read_text()
    assert tuple(re.findall(r"'([A-Za-z0-9]+)'",text))==SUPPORTED_DESCRIPTOR_NAMES

