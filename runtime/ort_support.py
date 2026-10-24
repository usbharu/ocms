"""Shared ONNX session policy; model artifacts are pinned and cached outside the image."""
from huggingface_hub import hf_hub_download
import onnxruntime as ort


def session(path, threads):
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.log_severity_level = 4
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    return ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])


def model_session(repo, revision, filename, threads, external_data=False):
    path = hf_hub_download(repo, filename, revision=revision)
    if external_data:
        hf_hub_download(repo, filename + '_data', revision=revision)
    return session(path, threads)
