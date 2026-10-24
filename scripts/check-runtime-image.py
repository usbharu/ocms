"""Check installed inference dependencies without downloading models (inside the image)."""
import importlib.metadata
import sys

import torch
import torchvision
import torchcodec
from sentence_transformers import SentenceTransformer
from faster_whisper import WhisperModel
import onnxruntime


variant = sys.argv[1]
assert variant in ('cpu', 'cuda'), 'expected cpu or cuda'
expected_build = '+cpu' if variant == 'cpu' else '+cu130'
for package in ('torch', 'torchvision', 'torchcodec'):
    assert importlib.metadata.version(package).endswith(expected_build), package
if variant == 'cpu':
    assert torch.version.cuda is None, 'CPU image includes CUDA-enabled torch'
    packages = [d.metadata['Name'].lower().replace('_', '-') for d in importlib.metadata.distributions()]
    assert not any(p.startswith('nvidia-') or p == 'triton' for p in packages), 'GPU dependencies in CPU image'
else:
    assert torch.version.cuda == '13.0', 'unexpected CUDA build'

# Exercise a compiled torchvision operation; import alone misses binary mismatches.
assert torchvision.ops.nms(torch.tensor([[0., 0., 1., 1.]]), torch.tensor([1.]), 0.5).tolist() == [0]
sys.path.insert(0, '/app')
import server
assert server.health()['status'] == 'ok'
assert server.model is None and server.whisper is None
print(f'Runtime {variant}: dependencies, native operation and app import passed; no models downloaded')
