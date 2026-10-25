import asyncio
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from recommendation_server import RecommendationInput, recommendations, invalid_request, slot


class RecommendationServerTests(unittest.TestCase):
    def test_isolated_entrypoint_authentication_and_bootstrap(self):
        # unittest discovery adds runtime/ to the parent sys.path only. Set the
        # child's directory explicitly so root-level CI runs import the sources.
        probe = subprocess.run([sys.executable, '-c',
            "import recommendation_server,sys; assert 'embedding_onnx' not in sys.modules; assert 'whisper_onnx' not in sys.modules; assert 'tagger' not in sys.modules"],
            cwd=Path(__file__).resolve().parent, capture_output=True)
        self.assertEqual(probe.returncode, 0, probe.stderr.decode('utf-8', errors='replace'))
        with patch.dict(os.environ, {'INTERNAL_TOKEN': 'r' * 32}):
            with self.assertRaises(HTTPException) as caught:
                recommendations(RecommendationInput(assets=[]), 'invalid')
            self.assertEqual(caught.exception.status_code, 401)
            self.assertEqual(recommendations(RecommendationInput(assets=[]), 'r' * 32)['status'],
                             'insufficient_information')

    def test_busy_and_failure_release_slot_without_private_errors(self):
        with patch.dict(os.environ, {'INTERNAL_TOKEN': 'r' * 32}):
            slot.acquire()
            try:
                with self.assertRaises(HTTPException) as caught:
                    recommendations(RecommendationInput(assets=[]), 'r' * 32)
                self.assertEqual(caught.exception.status_code, 503)
            finally:
                slot.release()
            with patch('recommendation_server.recommend', side_effect=ValueError('private label')):
                with self.assertRaises(HTTPException) as caught:
                    recommendations(RecommendationInput(assets=[]), 'r' * 32)
                self.assertNotIn('private', str(caught.exception))
            self.assertTrue(slot.acquire(blocking=False))
            slot.release()

    def test_validation_response_does_not_echo_input(self):
        result = asyncio.run(invalid_request(None, None))
        self.assertEqual(result.body, b'{"error":"INVALID_REQUEST"}')
