#!/usr/bin/env python3
"""Real Compose integration checks. Creates synthetic media and retains the stack."""
import concurrent.futures
import http.cookiejar
import hashlib
import json
import os
import subprocess
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get('OCMS_URL', 'http://localhost:8080')
ORIGIN = BASE

def compose(*args, binary=False):
    result = subprocess.run(['docker', 'compose', *args], check=True, capture_output=True)
    return result.stdout if binary else result.stdout.decode().strip()

def sql(query):
    return compose('exec', '-T', 'postgres', 'psql', '-U', 'ocms', '-d', 'ocms', '-tAc', query)

class Client:
    def __init__(self, user=None):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.csrf = ''
        if user:
            self.call('POST', '/auth/dev-login', {'user': user})
            self.me = self.call('GET', '/api/v1/me')[2]
            self.csrf = self.me['csrf_token']
    def call(self, method, path, data=None, headers=None, expected=200):
        raw = isinstance(data, bytes)
        body = data if raw else (json.dumps(data).encode() if data is not None else None)
        h = {'Origin': ORIGIN, 'X-CSRF-Token': self.csrf, 'Content-Type': 'application/octet-stream' if raw else 'application/json'}
        h.update(headers or {})
        req = urllib.request.Request(BASE + path, data=body, method=method, headers=h)
        try:
            response = self.opener.open(req, timeout=600)
        except urllib.error.HTTPError as error:
            response = error
        status, response_headers, content = response.code, response.headers, response.read()
        assert status == expected, (method, path, status, content[:200])
        if 'application/json' in response_headers.get('Content-Type', '') and content:
            content = json.loads(content)
        return status, response_headers, content
    def create(self, name, body, mime="image/png"):
        return self.call('POST', '/api/v1/uploads', {'filename': name, 'mime_type': mime, 'size_bytes': len(body)}, expected=201)[2]
    def put(self, u, body, **kwargs):
        return self.call('PUT', f"/api/v1/uploads/{u['upload_id']}/content", body, **kwargs)
    def asset(self, u):
        return self.call('GET', f"/api/v1/assets/{u['asset_id']}")[2]

def check(name):
    print('PASS', name, flush=True)
