import json
import os
import tempfile
import unittest
from tagger import load_vocabulary, select_tags, select_rating, prepare_image


class TaggerTest(unittest.TestCase):
    def test_general_only_threshold_and_order(self):
        labels = [{'name': name, 'category': category} for name, category in
                  [('rating', 'rating'), ('character', 'character'), ('below', 'general'), ('z', 'general'), ('a', 'general')]]
        self.assertEqual(select_tags(labels, [1, 1, .549, .55, .9]),
                         [{'name': 'a', 'score': .9}, {'name': 'z', 'score': .55}])

    def test_characters_have_independent_category_threshold_and_limit(self):
        labels = [{'name': name, 'category': category} for name, category in
                  [('rating', 'rating'), ('general', 'general'), ('low', 'character'), ('character', 'character')]]
        self.assertEqual(select_tags(labels, [1, 1, .549, .55], category='character', threshold=.55),
                         [{'name': 'character', 'score': .55}])
        labels = [{'name': str(i), 'category': 'character'} for i in range(300)]
        self.assertEqual(len(select_tags(labels, [1] * 300, category='character', threshold=.55)), 256)

    def test_names_use_underscores_and_collisions_keep_highest_score(self):
        labels = [{'name': name, 'category': category} for name, category in
                  [('long hair', 'general'), ('long_hair', 'general'), ('blue eyes', 'character')]]
        self.assertEqual(select_tags(labels, [.8, .9, .7]),
                         [{'name': 'long_hair', 'score': .9}])
        self.assertEqual(select_tags(labels, [.8, .9, .7], category='character', threshold=.55),
                         [{'name': 'blue_eyes', 'score': .7}])

    def test_invalid_output_rejected(self):
        for scores in [[float('nan')], [float('inf')], [-1], [1.1], []]:
            with self.assertRaises(ValueError):
                select_tags([{'name': 'x', 'category': 'general'}], scores)

    def test_rating_is_separate_and_uses_highest_score(self):
        labels = [{'name': name, 'category': 'rating'} for name in
                  ['general', 'sensitive', 'questionable', 'explicit']]
        labels.append({'name': 'other', 'category': 'general'})
        self.assertEqual(select_rating(labels, [.1, .7, .15, .05, 1]), 'sensitive')
        self.assertEqual(select_rating(labels, [.25, .25, .25, .25, 1]), 'explicit')
        self.assertEqual(select_tags(labels, [.1, .7, .15, .05, 1]), [{'name': 'other', 'score': 1.0}])
        for scores in [[1], [.1, .2, float('nan'), .4, 1], [.1, .2, .3, 1.1, 1]]:
            with self.assertRaises(ValueError):
                select_rating(labels, scores)
        with self.assertRaises(ValueError):
            select_rating(labels[1:], [.2, .3, .4, 1])

    def test_vocabulary_loads_categories_and_rejects_bad_indexes(self):
        vocabulary = {
            'num_tags': 3,
            'idx_to_tag': {'0': 'general', '1': 'character', '2': 'safe'},
            'tag_to_idx': {'general': 0, 'character': 1, 'safe': 2},
            'tag_to_category': {'general': 'General', 'character': 'Character', 'safe': 'Rating'},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'model_vocabulary.json')
            with open(path, 'w', encoding='utf-8') as file:
                json.dump(vocabulary, file)
            self.assertEqual(load_vocabulary(path), [
                {'name': 'general', 'category': 'general'},
                {'name': 'character', 'category': 'character'},
                {'name': 'safe', 'category': 'rating'},
            ])
            vocabulary['num_tags'] = 4
            with open(path, 'w', encoding='utf-8') as file:
                json.dump(vocabulary, file)
            with self.assertRaises(ValueError):
                load_vocabulary(path)

    def test_white_alpha_rgb_resize_and_normalization(self):
        from PIL import Image
        image = Image.new('RGBA', (4, 4), (255, 0, 0, 255))
        value = prepare_image(image, 4)
        self.assertEqual(value.shape, (1, 3, 4, 4))
        self.assertEqual(value[0, 0, 0, 0], 1.0)
        self.assertEqual(value[0, 1, 0, 0], -1.0)
        self.assertEqual(value[0, 2, 0, 0], -1.0)
        transparent = Image.new('RGBA', (4, 4), (0, 0, 0, 0))
        white = prepare_image(transparent, 4)
        self.assertEqual(white[0, :, 0, 0].tolist(), [1.0, 1.0, 1.0])


if __name__ == '__main__':
    unittest.main()
