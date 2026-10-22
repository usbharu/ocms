"""Local test IdP UI. Choosing a synthetic identity is not real identity verification.
Hydra signs tokens and enforces PKCE. Only the explicit test header enables automation.
"""
from html import escape
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import secrets
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

ADMIN='http://hydra:4445'
ORIGIN='http://localhost:4446'
STYLE='''body{font:16px/1.7 system-ui,sans-serif;background:#f5f6f8;color:#18202f;max-width:720px;margin:64px auto;padding:24px}main{background:white;border:1px solid #ddd;border-radius:16px;padding:32px}h1{line-height:1.35}button,a.button{display:inline-block;background:#2456ce;color:white;padding:12px 24px;border:0;border-radius:8px;cursor:pointer;margin:8px 8px 8px 0;font:inherit;text-decoration:none}small{color:#596174}code{background:#f1f3f6;padding:3px}a{color:#2456ce}'''

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def log_request(self,code='-',size='-'):
        path=urlparse(self.path).path
        print('fixture.request',self.command,path if path in ['/', '/login', '/consent', '/healthz'] else 'other',code,flush=True)
    def page(self,title,content,csrf=None):
        body=('''<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'''+escape(title)+'''</title><style>'''+STYLE+'''</style><main><small>OCMS ローカル検証</small><h1>'''+escape(title)+'''</h1>'''+content+'''</main></html>''').encode()
        self.send_response(200)
        self.send_header('Content-Type','text/html; charset=utf-8')
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
        if csrf:self.send_header('Set-Cookie','ocms_fixture_csrf='+csrf+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=300')
        self.end_headers();self.wfile.write(body)
    def details(self,kind,challenge):
        query=urlencode({kind+'_challenge':challenge})
        with urlopen(ADMIN+'/admin/oauth2/auth/requests/'+kind+'?'+query,timeout=10) as response:
            return json.load(response)
    def accept(self,kind,challenge,subject=None,deny=False):
        details=self.details(kind,challenge)
        if deny:payload={'error':'access_denied','error_description':'User declined consent'}
        elif kind=='login':payload={'subject':subject,'remember':False}
        else:payload={'grant_scope':details['requested_scope'],'remember':False,'session':{'id_token':{'fixture':'hydra-integration'}}}
        query=urlencode({kind+'_challenge':challenge})
        action='reject' if deny else 'accept'
        request=Request(ADMIN+'/admin/oauth2/auth/requests/'+kind+'/'+action+'?'+query,
            json.dumps(payload).encode(),method='PUT',headers={'Content-Type':'application/json'})
        with urlopen(request,timeout=10) as response:redirect=json.load(response)['redirect_to']
        self.send_response(303);self.send_header('Location',redirect);self.send_header('Cache-Control','no-store');self.end_headers()
    def do_GET(self):
        try:
            path=urlparse(self.path)
            if path.path=='/healthz':self.send_response(200);self.end_headers();return
            if path.path=='/':
                self.page('人が操作して確認する', '''<p>OIDCログインからアップロード・検索まで操作し、同じ操作のテレメトリをGrafanaで確認できます。</p><p><a class="button" href="http://localhost:8081/">OIDC版OCMSを開く</a><a class="button" href="http://localhost:3000/d/ocms-verification">Grafanaを開く</a></p><ol><li>OCMSのログインから、AliceかBobを選び、アクセスに同意します。</li><li>ファイルをアップロードし、プレビュー・検索を試します。</li><li>GrafanaでTrace・Metric・Logを確認します。</li><li>ログアウトして別ユーザーへ切り替え、非公開ファイルが見えないことを確認します。</li></ol><p><small>生成ユーザーを選ぶだけの検証用IdPです。実際の本人確認は行いません。通常の開発ログイン版は <a href="http://localhost:8080/">localhost:8080</a> にあります。</small></p>''')
                return
            if path.path not in ['/login','/consent']:self.send_error(404);return
            kind=path.path[1:];challenge=parse_qs(path.query)[kind+'_challenge'][0]
            details=self.details(kind,challenge)
            automatic=self.headers.get('X-Fixture-User')
            if automatic in ['alice','bob']:
                self.accept(kind,challenge,automatic);return
            csrf=secrets.token_urlsafe(32)
            hidden='<input type="hidden" name="challenge" value="'+escape(challenge,quote=True)+'"><input type="hidden" name="csrf" value="'+csrf+'">'
            if kind=='login':
                self.page('検証ユーザーを選ぶ','''<p>OCMSへログインするユーザーを選んでください。</p><form method="post" action="/login">'''+hidden+'''<button name="subject" value="alice">Aliceでログイン</button><button name="subject" value="bob">Bobでログイン</button></form><p><small>本人確認を省略したローカル検証用の画面です。</small></p>''',csrf)
            else:
                subject=escape(details['subject']);scopes=escape(' / '.join(details['requested_scope']))
                self.page('OCMSへのアクセスに同意','<p>ユーザー：<strong>'+subject+'</strong></p><p>要求された権限：<code>'+scopes+'</code></p><form method="post" action="/consent">'+hidden+'<button name="decision" value="allow">同意してOCMSへ進む</button><button name="decision" value="deny">拒否する</button></form>',csrf)
        except Exception:self.send_error(502,'OIDC fixture request failed')
    def do_POST(self):
        try:
            if self.path not in ['/login','/consent']:self.send_error(404);return
            if self.headers.get('Origin')!=ORIGIN:self.send_error(403);return
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=8192:self.send_error(400);return
            values=parse_qs(self.rfile.read(length).decode())
            cookie=SimpleCookie();cookie.load(self.headers.get('Cookie',''))
            expected=cookie.get('ocms_fixture_csrf')
            if expected is None or not secrets.compare_digest(expected.value,values.get('csrf',[''])[0]):self.send_error(403);return
            kind=self.path[1:];challenge=values['challenge'][0]
            subject=values.get('subject',[''])[0]
            if kind=='login' and subject not in ['alice','bob']:self.send_error(400);return
            self.accept(kind,challenge,subject,values.get('decision',['allow'])[0]=='deny')
        except Exception:self.send_error(502,'OIDC fixture request failed')

HTTPServer(('0.0.0.0',8080),Handler).serve_forever()
