"""EmbeddingGemma 2 ONNX inference with NumPy/Pillow preprocessing and no torch imports."""
import json

import numpy as np
from huggingface_hub import hf_hub_download
from transformers import AutoTokenizer, Gemma4AudioFeatureExtractor
from transformers.models.gemma4.image_processing_pil_gemma4 import Gemma4ImageProcessorPil

from ort_support import model_session

MODEL_ID = 'google/embeddinggemma-2'
SOURCE_REVISION = '914f7f89142e33e77833254d9c9b90c3cef7303b'
ARTIFACT_REPO = 'onnx-community/embeddinggemma-2-ONNX'
ARTIFACT_REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
# Same fp32 weights, prompts and normalized pooling; all four modalities are checked
# against the previous backend by scripts/verify-onnx-runtime.py.
REVISION = SOURCE_REVISION
MAX_TOKENS = 8192


def check_features(input_ids, features, token_ids):
    for name, token_id in token_ids.items():
        value = features[name + '_features']
        if value.ndim != 2 or value.shape[1] != 512 or not np.isfinite(value).all():
            raise ValueError('invalid encoder features')
        if np.count_nonzero(input_ids == token_id) != len(value):
            raise ValueError('media placeholder count mismatch')


def normalized_embedding(value):
    value = np.asarray(value, dtype=np.float32)
    if value.shape != (1, 768) or not np.isfinite(value).all():
        raise ValueError('invalid embedding output')
    norm = np.linalg.norm(value.astype(np.float64), axis=-1, keepdims=True)
    if np.any(norm <= 0):
        raise ValueError('zero embedding')
    return (value / norm)[0].tolist()


class EmbeddingModel:
    def __init__(self, threads):
        self.threads = threads
        self.tokenizer = AutoTokenizer.from_pretrained(ARTIFACT_REPO, revision=ARTIFACT_REVISION)
        path = hf_hub_download(ARTIFACT_REPO, 'processor_config.json', revision=ARTIFACT_REVISION)
        with open(path) as file:
            config = json.load(file)
        self.images = Gemma4ImageProcessorPil(**config['image_processor'])
        self.video_images = Gemma4ImageProcessorPil(**{
            **config['image_processor'],
            'max_soft_tokens': config['video_processor']['max_soft_tokens'],
        })
        self.audio = Gemma4AudioFeatureExtractor(**config['feature_extractor'])
        self.text_session = model_session(ARTIFACT_REPO, ARTIFACT_REVISION, 'onnx/model.onnx', threads, True)
        self.vision_session = None
        self.audio_session = None
        self.token_ids = {
            kind: self.tokenizer.convert_tokens_to_ids('<|' + kind + '|>')
            for kind in ('image', 'video', 'audio')
        }

    def visual_features(self, images, video=False):
        if not images:
            raise ValueError('empty media input')
        processor = self.video_images if video else self.images
        inputs = processor(images=images, return_tensors='np')
        if self.vision_session is None:
            self.vision_session = model_session(ARTIFACT_REPO, ARTIFACT_REVISION, 'onnx/vision_encoder.onnx', self.threads, True)
        features = self.vision_session.run(['image_features'], {
            'pixel_values': np.asarray(inputs['pixel_values'], dtype=np.float32),
            'pixel_position_ids': np.asarray(inputs['image_position_ids'], dtype=np.int64),
        })[0]
        token = '<|video|>' if video else '<|image|>'
        text = ''.join(self.tokenizer.boi_token + token * int(count) + self.tokenizer.eoi_token
                       for count in inputs['num_soft_tokens_per_image'])
        return text, features

    def audio_features(self, samples):
        samples = np.asarray(samples, dtype=np.float32)
        if samples.ndim != 1 or not len(samples) or not np.isfinite(samples).all():
            raise ValueError('invalid audio samples')
        inputs = self.audio([samples], sampling_rate=16000, return_tensors='np')
        if self.audio_session is None:
            self.audio_session = model_session(ARTIFACT_REPO, ARTIFACT_REVISION, 'onnx/audio_encoder.onnx', self.threads, True)
        features = self.audio_session.run(['audio_features'], {
            'input_features': np.asarray(inputs['input_features'], dtype=np.float32),
            'input_features_mask': np.asarray(inputs['input_features_mask'], dtype=bool),
        })[0]
        text = self.tokenizer.boa_token + '<|audio|>' * len(features) + self.tokenizer.eoa_token
        return text, features

    def encode(self, kind, value):
        features = {name + '_features': np.empty((0, 512), dtype=np.float32)
                    for name in ('image', 'video', 'audio')}
        if kind == 'text':
            text = value
        elif kind in ('image', 'video'):
            text, features[kind + '_features'] = self.visual_features(value, video=kind == 'video')
        elif kind == 'audio':
            text, features['audio_features'] = self.audio_features(value)
        else:
            raise ValueError('invalid modality')
        # Truncate text as before, but never truncate expanded media placeholders.
        inputs = self.tokenizer(text, return_tensors='np', truncation=kind == 'text', max_length=MAX_TOKENS)
        input_ids = np.asarray(inputs['input_ids'], dtype=np.int64)
        if input_ids.shape[1] > MAX_TOKENS:
            raise ValueError('input exceeds context window')
        check_features(input_ids, features, self.token_ids)
        output = self.text_session.run(['sentence_embedding'], {
            'input_ids': input_ids,
            'attention_mask': np.asarray(inputs['attention_mask'], dtype=np.int64),
            **features,
        })[0]
        return normalized_embedding(output)
