"""Request-local content recommendation; no model downloads or shared user state."""
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize

ENGINE_VERSION = 'tfidf-v1'


def features(asset):
    # Preserve whole labels, case, punctuation, and the label namespace.
    return sorted({f'{kind}:{name}' for kind in ('tags', 'characters')
                   for name in asset.get(kind, [])})


def identity(value):
    return value


def recommend(assets):
    documents = [features(asset) for asset in assets]
    favorites = [i for i, asset in enumerate(assets)
                 if asset.get('is_favorite') and documents[i]]
    if not favorites:
        return {'status': 'insufficient_information', 'candidates': []}
    matrix = TfidfVectorizer(analyzer=identity, binary=True, norm='l2').fit_transform(documents)
    profile = normalize(np.asarray(matrix[favorites].mean(axis=0)))
    scores = np.asarray(matrix @ profile.T).ravel()
    favorite_blobs = {a['blob_id'] for a in assets if a.get('is_favorite') and a.get('blob_id')}
    candidates = [{'asset_id': a['asset_id'], 'score': float(score)}
                  for a, score in zip(assets, scores)
                  if score > 0 and not a.get('is_favorite')
                  and (not a.get('blob_id') or a['blob_id'] not in favorite_blobs)]
    candidates.sort(key=lambda a: (-a['score'], a['asset_id']))
    return {'status': 'ready', 'candidates': candidates[:1000]}
