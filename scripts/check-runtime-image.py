"""Check native ONNX inference and app imports without downloading model weights."""
import base64
import importlib.metadata
import sys

import numpy as np
import onnxruntime as ort

variant = sys.argv[1]
assert variant in ('cpu', 'cuda'), 'expected cpu or cuda'
packages = {d.metadata['Name'].lower().replace('_', '-'): d.version
            for d in importlib.metadata.distributions()}
expected = 'onnxruntime' if variant == 'cpu' else 'onnxruntime-gpu'
assert packages.get(expected) == '1.23.2', 'unexpected ONNX Runtime version'
assert ('onnxruntime-gpu' if variant == 'cpu' else 'onnxruntime') not in packages
for name in ('torch', 'torchvision', 'torchcodec', 'sentence-transformers',
             'faster-whisper', 'ctranslate2', 'triton', 'av'):
    assert name not in packages, f'unexpected inference dependency: {name}'
if variant == 'cpu':
    assert not any(name.startswith('nvidia-') for name in packages), 'GPU dependencies in CPU image'
else:
    assert 'CUDAExecutionProvider' in ort.get_available_providers()

# Tiny Add graph (IR 10, opset 13) exercises the native library, not only imports.
graph = base64.b64decode('CAo6UwoQCgF4CgNvbmUSAXkiA0FkZBIMbmF0aXZlLXNtb2tlKg8IARABIgQAAIA/QgNvbmVaDwoBeBIKCggIARIECgIIAWIPCgF5EgoKCAgBEgQKAggBQgQKABAN')
session = ort.InferenceSession(graph, providers=['CPUExecutionProvider'])
assert session.run(None, {'x': np.asarray([1], dtype=np.float32)})[0].tolist() == [2.0]
sys.path.insert(0, '/app')
import server
assert server.health()['status'] == 'ok'
assert server.health()['inference_backend'] == 'onnxruntime'
assert server.model is None and server.whisper is None
print(f'Runtime {variant}: single ONNX engine, native operation and app import passed; no models downloaded')

# Verify the dedicated app in a fresh interpreter: no media model modules.
import subprocess
subprocess.run([sys.executable, '-c',
    "import recommendation_server,sys; assert recommendation_server.health()['status']=='ok'; "
    "assert 'embedding_onnx' not in sys.modules; assert 'whisper_onnx' not in sys.modules; "
    "assert 'tagger' not in sys.modules"], check=True)
from recommendation_engine import recommend
assert recommend([{'asset_id': 'f', 'tags': ['x'], 'is_favorite': True},
                  {'asset_id': 'c', 'tags': ['x']}])['candidates'][0]['asset_id'] == 'c'
