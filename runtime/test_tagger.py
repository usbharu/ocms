import unittest
from tagger import select_tags, select_rating, prepare_image


class TaggerTest(unittest.TestCase):
    def test_general_only_threshold_and_order(self):
        labels = [{'name': name, 'category': category} for name, category in
                  [('rating', '9'), ('character', '4'), ('below', '0'), ('z', '0'), ('a', '0')]]
        self.assertEqual(select_tags(labels, [1, 1, .349, .35, .9]),
                         [{'name': 'a', 'score': .9}, {'name': 'z', 'score': .35}])

    def test_characters_have_independent_category_threshold_and_limit(self):
        labels = [{'name': name, 'category': category} for name, category in
                  [('rating', '9'), ('general', '0'), ('low', '4'), ('character', '4')]]
        self.assertEqual(select_tags(labels, [1, 1, .849, .85], category=4, threshold=.85),
                         [{'name': 'character', 'score': .85}])
        labels = [{'name': str(i), 'category': '4'} for i in range(300)]
        self.assertEqual(len(select_tags(labels, [1] * 300, category=4, threshold=.85)), 256)

    def test_invalid_output_rejected(self):
        for scores in [[float('nan')], [float('inf')], [-1], [1.1], []]:
            with self.assertRaises(ValueError):
                select_tags([{'name': 'x', 'category': '0'}], scores)

    def test_rating_is_separate_and_uses_highest_score(self):
        labels = [{'name': name, 'category': '9'} for name in
                  ['general', 'sensitive', 'questionable', 'explicit']]
        labels.append({'name': 'other', 'category': '0'})
        self.assertEqual(select_rating(labels, [.1, .7, .15, .05, 1]), 'sensitive')
        self.assertEqual(select_rating(labels, [.25, .25, .25, .25, 1]), 'explicit')
        self.assertEqual(select_tags(labels, [.1, .7, .15, .05, 1]), [{'name': 'other', 'score': 1.0}])
        for scores in [[1], [.1, .2, float('nan'), .4, 1], [.1, .2, .3, 1.1, 1]]:
            with self.assertRaises(ValueError):
                select_rating(labels, scores)
        with self.assertRaises(ValueError):
            select_rating(labels[1:], [.2, .3, .4, 1])

    def test_white_alpha_square_bgr_and_raw_range(self):
        from PIL import Image
        image = Image.new('RGBA', (2, 4), (255, 0, 0, 255))
        image.putpixel((0, 0), (0, 0, 0, 0))
        value = prepare_image(image, 4)
        self.assertEqual(value.shape, (1, 4, 4, 3))
        self.assertEqual(value[0, 0, 0].tolist(), [255, 255, 255])
        self.assertEqual(value[0, 0, 1].tolist(), [255, 255, 255])
        self.assertEqual(value[0, 1, 1].tolist(), [0, 0, 255])


if __name__ == '__main__':
    unittest.main()
