"""Whisper encoder/decoder inference and timestamp decoding using ONNX Runtime only."""
from dataclasses import dataclass
import json

import numpy as np
from huggingface_hub import hf_hub_download
from transformers import AutoTokenizer, WhisperFeatureExtractor

from ort_support import model_session

MODEL_REPO = 'onnx-community/whisper-tiny'
MODEL_REVISION = 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7'
SAMPLE_RATE = 16000
WINDOW_SAMPLES = 30 * SAMPLE_RATE


def log_probabilities(logits):
    values = np.asarray(logits, dtype=np.float64)
    peak = np.max(values)
    if not np.isfinite(peak):
        raise ValueError('all decoder tokens suppressed')
    return values - peak - np.log(np.exp(values - peak).sum())


def timestamp_logits(logits, tokens, begin, timestamp_begin, eos, no_timestamps,
                     suppressed=(), initial_suppressed=(), max_initial=50):
    """Whisper's paired, monotonic timestamp-token constraints, before beam expansion."""
    result = np.asarray(logits, dtype=np.float64).copy()
    result[list(suppressed)] = -np.inf
    result[no_timestamps] = -np.inf
    generated = tokens[begin:]
    if not generated:
        result[list(initial_suppressed)] = -np.inf
        result[:timestamp_begin] = -np.inf
        result[timestamp_begin + max_initial + 1:] = -np.inf
        return result
    last_timestamp = generated[-1] >= timestamp_begin
    previous_timestamp = len(generated) < 2 or generated[-2] >= timestamp_begin
    if last_timestamp:
        if previous_timestamp:
            result[timestamp_begin:] = -np.inf
        else:
            result[:eos] = -np.inf
    timestamps = [token for token in generated if token >= timestamp_begin]
    if timestamps:
        minimum = timestamps[-1] if last_timestamp and not previous_timestamp else timestamps[-1] + 1
        result[timestamp_begin:minimum] = -np.inf
    probabilities = log_probabilities(result)
    timestamp_mass = np.exp(probabilities[timestamp_begin:]).sum()
    max_text = np.exp(np.max(probabilities[:timestamp_begin]))
    if timestamp_mass > max_text:
        result[:timestamp_begin] = -np.inf
    return result


def decode_passages(tokens, tokenizer, timestamp_begin, duration):
    start = None
    text_tokens = []
    passages = []

    def append(end):
        if start is None or not text_tokens:
            return
        text = tokenizer.decode(text_tokens, skip_special_tokens=True).strip()
        left, right = max(0.0, min(start, duration)), max(0.0, min(end, duration))
        if text and right > left:
            passages.append({'start': left, 'end': right, 'text': text})

    special = set(tokenizer.all_special_ids)
    for token in tokens:
        if token >= timestamp_begin:
            timestamp = (token - timestamp_begin) * 0.02
            append(timestamp)
            start = timestamp
            text_tokens = []
        elif token not in special:
            text_tokens.append(token)
    append(duration)
    return passages


@dataclass
class Beam:
    tokens: list[int]
    score: float = 0.0
    cache: dict | None = None

    def normalized_score(self, prefix_length):
        return self.score / max(1, len(self.tokens) - prefix_length)


class WhisperModel:
    def __init__(self, threads):
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_REPO, revision=MODEL_REVISION)
        self.features = WhisperFeatureExtractor.from_pretrained(MODEL_REPO, revision=MODEL_REVISION)
        path = hf_hub_download(MODEL_REPO, 'generation_config.json', revision=MODEL_REVISION)
        with open(path) as file:
            self.config = json.load(file)
        self.encoder = model_session(MODEL_REPO, MODEL_REVISION, 'onnx/encoder_model.onnx', threads)
        self.decoder = model_session(MODEL_REPO, MODEL_REVISION, 'onnx/decoder_model_merged.onnx', threads)
        self.start = self.config['decoder_start_token_id']
        self.eos = self.config['eos_token_id']
        self.no_timestamps = self.config['no_timestamps_token_id']
        self.timestamp_begin = self.no_timestamps + 1
        self.no_speech = self.tokenizer.convert_tokens_to_ids('<|nospeech|>')
        self.languages = list(self.config['lang_to_id'].values())
        self.output_names = [output.name for output in self.decoder.get_outputs()]
        self.cache_names = [value.name for value in self.decoder.get_inputs() if value.name.startswith('past_key_values.')]

    def step(self, tokens, encoder_output, cache=None):
        values = {
            'input_ids': np.asarray([tokens if cache is None else tokens[-1:]], dtype=np.int64),
            'encoder_hidden_states': encoder_output,
            'use_cache_branch': np.asarray([cache is not None], dtype=bool),
        }
        if cache is None:
            for name in self.cache_names:
                values[name] = np.empty((1, 6, 0, 64), dtype=np.float32)
        else:
            values.update(cache)
        output = dict(zip(self.output_names, self.decoder.run(None, values)))
        next_cache = {}
        for name in self.cache_names:
            present = output[name.replace('past_key_values.', 'present.')]
            # Merged decoder emits empty encoder-cache outputs on cached iterations.
            next_cache[name] = cache[name] if cache is not None and '.encoder.' in name else present
        return output['logits'][0, -1], next_cache

    def generate(self, encoder_output, beam_size=3):
        language_logits, _ = self.step([self.start], encoder_output)
        if np.exp(log_probabilities(language_logits)[self.no_speech]) > 0.6:
            return []
        language = max(self.languages, key=lambda token: language_logits[token])
        prefix = [self.start, language, self.config['task_to_id']['transcribe']]
        begin = len(prefix)
        active, finished = [Beam(prefix)], []
        for _ in range(self.config['max_length'] - begin):
            candidates = []
            for beam in active:
                logits, cache = self.step(beam.tokens, encoder_output, beam.cache)
                logits = timestamp_logits(
                    logits, beam.tokens, begin, self.timestamp_begin, self.eos, self.no_timestamps,
                    self.config.get('suppress_tokens', ()), self.config.get('begin_suppress_tokens', ()),
                    self.config.get('max_initial_timestamp_index', 50),
                )
                scores = log_probabilities(logits)
                best = np.argpartition(scores, -beam_size * 2)[-beam_size * 2:]
                for token in best:
                    if not np.isfinite(scores[token]):
                        continue
                    candidate = Beam(beam.tokens + [int(token)], beam.score + float(scores[token]), cache)
                    if token == self.eos:
                        finished.append(candidate)
                    else:
                        candidates.append(candidate)
            active = sorted(candidates, key=lambda beam: beam.score, reverse=True)[:beam_size]
            finished = sorted(finished, key=lambda beam: beam.normalized_score(begin), reverse=True)[:beam_size]
            if not active:
                break
            if len(finished) == beam_size and active[0].normalized_score(begin) <= finished[-1].normalized_score(begin):
                break
        beams = finished or active
        if not beams:
            return []
        return max(beams, key=lambda beam: beam.normalized_score(begin)).tokens[begin:]

    def transcribe(self, samples):
        samples = np.asarray(samples, dtype=np.float32)
        if samples.ndim != 1 or not np.isfinite(samples).all():
            raise ValueError('invalid mono audio')
        passages = []
        position = 0
        while position < len(samples):
            window = samples[position:position + WINDOW_SAMPLES]
            # Do not let the language model invent words for digital silence.
            if np.max(np.abs(window)) < 1e-5:
                position += len(window)
                continue
            features = self.features(window, sampling_rate=SAMPLE_RATE, return_tensors='np')['input_features']
            encoded = self.encoder.run(None, {'input_features': np.asarray(features, dtype=np.float32)})[0]
            tokens = self.generate(encoded)
            segments = decode_passages(tokens, self.tokenizer, self.timestamp_begin, len(window) / SAMPLE_RATE)
            for segment in segments:
                passages.append({
                    'kind': 'transcript', 'ordinal': len(passages),
                    'start_ms': round((position / SAMPLE_RATE + segment['start']) * 1000),
                    'end_ms': round((position / SAMPLE_RATE + segment['end']) * 1000),
                    'content': segment['text'],
                })
            # Revisit an unfinished tail of a full 30-second window.
            covered = round(segments[-1]['end'] * SAMPLE_RATE) if segments else len(window)
            advance = covered if len(window) == WINDOW_SAMPLES and covered >= SAMPLE_RATE else len(window)
            position += advance
        return passages
