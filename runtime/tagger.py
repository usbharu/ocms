"""CL Tagger v2 general tags, characters and separate content rating."""
import json
import math
import os

MODEL_ID = 'cella110n/cl_tagger_v2'
REVISION = 'b57909b8e9c63f71e208a26473e7aabdf45ed6b6'
MODEL_DIR = 'v2_00'
MODEL_SIZE = 384
THRESHOLD = 0.55
CHARACTER_THRESHOLD = 0.55
CATEGORIES = {'general', 'character', 'copyright', 'meta', 'rating', 'quality'}
RATINGS = ['general', 'sensitive', 'questionable', 'explicit']


def sigmoid(logits):
    import numpy as np
    values = np.asarray(logits, dtype=np.float32)
    if not np.isfinite(values).all():
        raise ValueError('invalid tagger output')
    return 1 / (1 + np.exp(-np.clip(values, -30, 30)))


def load_vocabulary(path):
    with open(path, encoding='utf-8') as file:
        data = json.load(file)
    if not isinstance(data, dict):
        raise ValueError('invalid tagger vocabulary')
    count = data.get('num_tags')
    index_to_tag = data.get('idx_to_tag')
    tag_to_category = data.get('tag_to_category')
    if (not isinstance(count, int) or count <= 0
            or not isinstance(index_to_tag, dict) or not isinstance(tag_to_category, dict)):
        raise ValueError('invalid tagger vocabulary')
    if len(index_to_tag) != count:
        raise ValueError('invalid tagger vocabulary')
    labels = []
    seen = set()
    for index in range(count):
        name = index_to_tag.get(str(index))
        category = tag_to_category.get(name)
        if not isinstance(name, str) or not name or name in seen or not isinstance(category, str):
            raise ValueError('invalid tagger vocabulary')
        category = category.casefold()
        if category not in CATEGORIES:
            raise ValueError('invalid tagger vocabulary')
        seen.add(name)
        labels.append({'name': name, 'category': category})
    return labels


def normalize_tag(name):
    return name.strip().replace(' ', '_')


def select_tags(labels, scores, category='general', threshold=THRESHOLD):
    if len(labels) != len(scores):
        raise ValueError('invalid tagger output')
    tags = {}
    for label, score in zip(labels, scores):
        score = float(score)
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError('invalid tagger output')
        if label['category'] == category and score >= threshold:
            name = normalize_tag(label['name'])
            if not name:
                raise ValueError('invalid tagger output')
            tags[name] = max(tags.get(name, 0.0), score)
    selected = [{'name': name, 'score': score} for name, score in tags.items()]
    return sorted(selected, key=lambda tag: (-tag['score'], tag['name']))[:256]


def select_rating(labels, scores):
    ratings = select_tags(labels, scores, category='rating', threshold=0)
    if len(ratings) != 4 or {rating['name'] for rating in ratings} != set(RATINGS):
        raise ValueError('invalid rating output')
    # A score tie selects the more restrictive rating.
    return max(ratings, key=lambda rating: (rating['score'], RATINGS.index(rating['name'])))['name']


def prepare_image(image, size=MODEL_SIZE):
    import numpy as np
    from PIL import Image
    image = image.convert('RGBA')
    canvas = Image.new('RGBA', image.size, 'white')
    canvas.alpha_composite(image)
    square = canvas.convert('RGB').resize((size, size), Image.Resampling.BICUBIC)
    value = np.asarray(square, dtype=np.float32) / 255.0
    value = (value - 0.5) / 0.5
    return np.ascontiguousarray(value.transpose(2, 0, 1)[None, ...])


class Tagger:
    def __init__(self, threads):
        from huggingface_hub import hf_hub_download
        from ort_support import session
        token = os.environ.get('HF_TOKEN') or None

        def download(name):
            return hf_hub_download(MODEL_ID, MODEL_DIR + '/' + name, revision=REVISION, token=token)

        path = download('model.onnx')
        download('model.onnx.data')
        self.labels = load_vocabulary(download('model_vocabulary.json'))
        self.session = session(path, threads)
        self.input = self.session.get_inputs()[0]
        shape = self.input.shape
        if len(shape) != 4 or shape[1] != 3:
            raise ValueError('invalid tagger input')
        if isinstance(shape[2], int) and isinstance(shape[3], int) and shape[2] != shape[3]:
            raise ValueError('invalid tagger input')
        self.size = shape[2] if isinstance(shape[2], int) else MODEL_SIZE

    def predict(self, image):
        value = prepare_image(image, self.size)
        result = self.session.run(None, {self.input.name: value})[0]
        if getattr(result, 'shape', None) != (1, len(self.labels)):
            raise ValueError('invalid tagger output')
        scores = sigmoid(result[0])
        return {'rating': select_rating(self.labels, scores),
                'tags': select_tags(self.labels, scores),
                'characters': select_tags(self.labels, scores, category='character', threshold=CHARACTER_THRESHOLD)}
