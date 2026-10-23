"""WD 1.4 general tags and separate character predictions; ratings are excluded."""
import csv
import math

MODEL_ID = 'SmilingWolf/wd-v1-4-convnext-tagger-v2'
REVISION = '4b34d1b07bdd8e95494072648960b8a6adcbc0ff'
THRESHOLD = 0.35


def select_tags(labels, scores, category=0, threshold=THRESHOLD):
    if len(labels) != len(scores) or not all(math.isfinite(float(x)) and 0 <= x <= 1 for x in scores):
        raise ValueError('invalid tagger output')
    tags = [{'name': label['name'], 'score': float(score)}
            for label, score in zip(labels, scores)
            if int(label['category']) == category and float(score) >= threshold]
    return sorted(tags, key=lambda tag: (-tag['score'], tag['name']))[:256]


def prepare_image(image, size):
    import numpy as np
    from PIL import Image
    image = image.convert('RGBA')
    canvas = Image.new('RGBA', image.size, 'white')
    canvas.alpha_composite(image)
    edge = max(image.size)
    square = Image.new('RGB', (edge, edge), 'white')
    square.paste(canvas.convert('RGB'), ((edge-image.width)//2, (edge-image.height)//2))
    square = square.resize((size, size), Image.Resampling.BICUBIC)
    return np.expand_dims(np.asarray(square, dtype=np.float32)[:, :, ::-1], 0)


class Tagger:
    def __init__(self, threads):
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.log_severity_level = 4
        path = hf_hub_download(MODEL_ID, 'model.onnx', revision=REVISION)
        labels = hf_hub_download(MODEL_ID, 'selected_tags.csv', revision=REVISION)
        with open(labels, newline='') as file:
            self.labels = list(csv.DictReader(file))
        self.session = ort.InferenceSession(path, sess_options=options, providers=['CPUExecutionProvider'])

    def predict(self, image):
        input = self.session.get_inputs()[0]
        value = prepare_image(image, input.shape[1])
        scores = self.session.run(None, {input.name: value})[0][0]
        return {'tags': select_tags(self.labels, scores),
                'characters': select_tags(self.labels, scores, category=4, threshold=0.85)}
