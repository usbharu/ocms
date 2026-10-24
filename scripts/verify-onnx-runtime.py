#!/usr/bin/env python3
"""Verify pinned ONNX models against synthetic PyTorch reference embeddings.

Run with Runtime dependencies and PYTHONPATH=runtime. Model weights use HF_HOME;
no private media, credentials, request text or recognized text are printed.
"""
import argparse
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
import soundfile as sf

from embedding_onnx import EmbeddingModel, MODEL_ID, SOURCE_REVISION
from whisper_onnx import WhisperModel


def inputs():
    images = []
    for color in ('red', 'blue'):
        image = Image.new('RGB', (224, 224), color)
        ImageDraw.Draw(image).ellipse((10, 10, 100, 100), fill='white')
        images.append(image)
    # Match the PCM16 waveform that the previous HTTP implementation decoded.
    wav = io.BytesIO()
    sf.write(wav, .1 * np.sin(np.arange(32000) * 2 * np.pi * 440 / 16000), 16000, format='WAV')
    wav.seek(0)
    audio, _ = sf.read(wav, dtype='float32')
    values = [('text', 'task: search result | query: red circle'),
              ('text', 'title: none | text: A blue ocean and white clouds.'),
              ('image', images[:1]), ('image', images[1:]), ('video', images), ('audio', audio)]
    rng = np.random.default_rng(42)
    for shape in ((96, 67), (640, 400)):
        image = Image.fromarray(rng.integers(0, 256, (*shape, 3), dtype=np.uint8))
        values.extend([('image', [image]), ('video', [image, image])])
    return values


def verify_embeddings(threads):
    reference = json.loads((Path(__file__).resolve().parents[1] /
                            'runtime/testdata/embedding-pytorch-reference.json').read_text())
    assert reference['source_model'] == MODEL_ID and reference['source_revision'] == SOURCE_REVISION
    model = EmbeddingModel(threads)
    values = inputs()
    assert len(values) == len(reference['vectors'])
    for index, ((kind, value), expected) in enumerate(zip(values, reference['vectors'])):
        actual = np.array(model.encode(kind, value))
        expected = np.array(expected)
        cosine = float(actual @ expected / np.linalg.norm(expected))
        difference = float(np.max(np.abs(actual - expected)))
        assert cosine > .9999 and difference < .002, (index, kind, cosine, difference)
        print(f'Embedding case={index} kind={kind} cosine={cosine:.8f} max_abs={difference:.8f}', flush=True)
    # Check retrieval order as well as individual vector closeness.
    old = np.array(reference['vectors'])
    new = np.array([model.encode(kind, value) for kind, value in values[:2]])
    assert np.array_equal(np.argsort(new @ old.T, axis=1), np.argsort(old[:2] @ old.T, axis=1))
    print('Embedding: 10 references, all modalities and query ranking passed', flush=True)


def verify_asr(threads, speech_path):
    model = WhisperModel(threads)
    assert model.transcribe(np.zeros(16000, dtype=np.float32)) == []
    if not speech_path:
        print('ASR: digital silence passed; speech verification not requested', flush=True)
        return
    samples, rate = sf.read(speech_path, dtype='float32')
    assert rate == 16000 and samples.ndim == 1 and 16000 <= len(samples) <= 8 * 16000
    # Use the documented synthetic utterance; never print recognized content.
    def verify(passages, duration):
        words = ' '.join(p['content'] for p in passages).lower()
        assert sum(word in words for word in ('quick', 'brown', 'fox', 'lazy', 'dog', 'speech', 'recognition')) >= 5
        assert all(0 <= p['start_ms'] < p['end_ms'] <= duration * 1000 for p in passages)
        assert all(left['end_ms'] <= right['start_ms'] for left, right in zip(passages, passages[1:]))
    verify(model.transcribe(samples), len(samples) / rate)
    long_audio = np.zeros(40 * rate, dtype=np.float32)
    long_audio[rate:rate + len(samples)] = samples
    long_audio[32 * rate:32 * rate + len(samples)] = samples
    passages = model.transcribe(long_audio)
    verify(passages, 40)
    assert any(p['start_ms'] < 30000 for p in passages) and any(p['start_ms'] >= 30000 for p in passages)
    print('ASR: synthetic speech, silence, timestamps and 30-second boundary passed', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--speech-wav', type=Path)
    args = parser.parse_args()
    verify_embeddings(args.threads)
    verify_asr(args.threads, args.speech_wav)
