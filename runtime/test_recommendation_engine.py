import unittest

from recommendation_engine import features, recommend


def asset(id, tags=(), characters=(), favorite=False, blob=None):
    return {'asset_id': id, 'tags': list(tags), 'characters': list(characters),
            'is_favorite': favorite, 'blob_id': blob}


class RecommendationTests(unittest.TestCase):
    def test_bootstrap_and_no_matches_are_different(self):
        for data in ([], [asset('a', favorite=True)], [asset('a', ['x'])]):
            self.assertEqual(recommend(data)['status'], 'insufficient_information')
        result = recommend([asset('f', ['x'], favorite=True), asset('a', ['y'])])
        self.assertEqual(result, {'status': 'ready', 'candidates': []})

    def test_whole_names_and_namespaces(self):
        self.assertNotEqual(features(asset('a', ['名前, with space'])),
                            features(asset('b', characters=['名前, with space'])))
        data = [asset('f', ['名前, with space'], favorite=True),
                asset('a', ['名前, with space']), asset('b', ['名前']),
                asset('c', characters=['名前, with space'])]
        self.assertEqual([a['asset_id'] for a in recommend(data)['candidates']], ['a'])

    def test_favorites_duplicates_and_stable_ties(self):
        data = [asset('f', characters=['character'], favorite=True, blob='original'),
                asset('same', characters=['character'], blob='original'),
                asset('b', characters=['character']), asset('a', characters=['character'])]
        out = recommend(data)
        self.assertEqual([a['asset_id'] for a in out['candidates']], ['a', 'b'])
        self.assertAlmostEqual(out['candidates'][0]['score'], 1)

    def test_relevance_and_limit(self):
        data = [asset('f', ['x'], favorite=True), asset('mixed', ['x', 'y'])]
        data += [asset(str(i).zfill(4), ['x']) for i in range(1001)]
        out = recommend(data)['candidates']
        self.assertEqual(len(out), 1000)
        self.assertEqual(out[0]['asset_id'], '0000')
        self.assertNotIn('mixed', [a['asset_id'] for a in out])


if __name__ == '__main__':
    unittest.main()
