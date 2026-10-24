"""Backend contract tests; real pinned-model verification is a separate command."""
import unittest
from types import SimpleNamespace

import numpy as np

from embedding_onnx import check_features, normalized_embedding
from whisper_onnx import WhisperModel, decode_passages, log_probabilities, timestamp_logits


class EmbeddingContractTest(unittest.TestCase):
    def test_mismatched_or_nonfinite_media_never_reaches_model(self):
        features = {kind + '_features': np.empty((0, 512), np.float32)
                    for kind in ('image', 'video', 'audio')}
        ids = {'image': 11, 'video': 12, 'audio': 13}
        check_features(np.array([[2, 1]]), features, ids)
        for value in (np.zeros((1, 512)), np.full((0, 511), 0)):
            with self.assertRaises(ValueError):
                check_features(np.array([[2, 1]]), {**features, 'image_features': value}, ids)
        with self.assertRaises(ValueError):
            check_features(np.array([[11]]), {**features, 'image_features': np.full((1, 512), np.nan)}, ids)
        check_features(np.array([[11]]), {**features, 'image_features': np.ones((1, 512))}, ids)

    def test_embedding_output_must_be_finite_nonzero_and_768_dimensional(self):
        for value in (np.zeros((1, 768)), np.ones((768,)), np.full((1, 768), np.inf)):
            with self.assertRaises(ValueError):
                normalized_embedding(value)
        result = normalized_embedding(np.ones((1, 768)))
        self.assertAlmostEqual(float(np.linalg.norm(result)), 1, places=6)


class WhisperContractTest(unittest.TestCase):
    def test_timestamp_pairs_are_monotonic_and_initial_offset_is_bounded(self):
        logits = np.zeros(200)
        result = timestamp_logits(logits, [1], 1, 100, 90, 99, max_initial=5)
        self.assertTrue(np.isneginf(result[:100]).all())
        self.assertTrue(np.isfinite(result[100:106]).all())
        self.assertTrue(np.isneginf(result[106:]).all())
        # Start timestamp must be followed by text, not another timestamp.
        result = timestamp_logits(logits, [1, 104], 1, 100, 90, 99)
        self.assertTrue(np.isneginf(result[100:]).all())
        # End timestamps can be repeated to start the next segment, never move back.
        result = timestamp_logits(logits, [1, 104, 5, 112], 1, 100, 90, 99)
        self.assertTrue(np.isneginf(result[100:112]).all())
        self.assertTrue(np.isfinite(result[112]))
        with self.assertRaises(ValueError):
            log_probabilities(np.full(5, -np.inf))

    def test_passages_clip_to_audio_and_keep_unterminated_tail(self):
        tokenizer = SimpleNamespace(all_special_ids=[90], decode=lambda tokens, **kw: 'words' if tokens else '')
        result = decode_passages([100, 5, 150, 150, 6, 90], tokenizer, 100, 1.5)
        self.assertEqual([(p['start'], p['end']) for p in result], [(0, 1), (1, 1.5)])
        self.assertEqual(decode_passages([190, 5, 180], tokenizer, 100, 1), [])

    def test_decoder_reuses_encoder_cache_on_merged_cached_branch(self):
        model = WhisperModel.__new__(WhisperModel)
        model.cache_names = ['past_key_values.0.encoder.key', 'past_key_values.0.decoder.key']
        model.output_names = ['logits', 'present.0.encoder.key', 'present.0.decoder.key']
        calls = []

        def run(_, values):
            calls.append(values)
            cached = bool(values['use_cache_branch'][0])
            return [np.zeros((1, 1, 200)), np.zeros((1, 6, 0 if cached else 1500, 64)),
                    np.zeros((1, 6, 2 if cached else 1, 64))]

        model.decoder = SimpleNamespace(run=run)
        encoded = np.zeros((1, 1500, 384))
        _, cache = model.step([1, 2, 3], encoded)
        _, next_cache = model.step([1, 2, 3, 4], encoded, cache)
        self.assertEqual(calls[0]['input_ids'].tolist(), [[1, 2, 3]])
        self.assertEqual(calls[1]['input_ids'].tolist(), [[4]])
        self.assertIs(next_cache['past_key_values.0.encoder.key'], cache['past_key_values.0.encoder.key'])
        self.assertEqual(next_cache['past_key_values.0.decoder.key'].shape[2], 2)

class RuntimeAPITest(unittest.TestCase):
    def test_authorization_rejects_every_inference_route_before_loading_models(self):
        import os
        from unittest.mock import patch
        from fastapi import HTTPException
        import server
        with patch.dict(os.environ, {'INTERNAL_TOKEN': 'a' * 32}):
            for route in (server.encode, server.transcribe, server.tag):
                with self.assertRaises(HTTPException) as error:
                    route(server.Input(kind='image'), x_service_token='incorrect')
                self.assertEqual(error.exception.status_code, 401)
        self.assertIsNone(server.model)
        self.assertIsNone(server.whisper)
        self.assertIsNone(server.tagger)

    def test_query_prompt_and_model_identity_survive_backend_replacement(self):
        import os
        from unittest.mock import patch
        import server
        calls = []
        model = SimpleNamespace(encode=lambda kind, value: calls.append((kind, value)) or [1 / np.sqrt(768)] * 768)
        with patch.dict(os.environ, {'INTERNAL_TOKEN': 'a' * 32}), patch.object(server, 'model', model), patch.object(server, 'release_memory'):
            result = server.encode(server.Input(kind='text', text='synthetic', query=True), x_service_token='a' * 32)
        self.assertEqual(calls, [('text', 'task: search result | query: synthetic')])
        self.assertEqual(result['model_revision'], '914f7f89142e33e77833254d9c9b90c3cef7303b')
        self.assertEqual(server.health()['inference_backend'], 'onnxruntime')


if __name__ == '__main__':
    unittest.main()
