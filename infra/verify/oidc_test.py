"""Private Compose test: sensitive JSON stdout must be captured by verify-oidc.py."""
import http.cookiejar as cookies
from http.cookies import SimpleCookie
import json
import os
import secrets
import time
import urllib.error
import urllib.parse as url
import urllib.request as http

BFF='http://localhost:8081'
sensitive=[]
class NoRedirect(http.HTTPRedirectHandler):
    def redirect_request(self,*args):return None

def call(opener,method,target,data=None,headers=None):
    parts=url.urlsplit(target)
    private={'localhost:8081':'hydra:8080','localhost:4444':'hydra:4444','localhost:4446':'oidc-login:8080'}
    target=url.urlunsplit(parts._replace(netloc=private.get(parts.netloc,parts.netloc)))
    req=http.Request(target,method=method,data=json.dumps(data).encode() if data is not None else None,
        headers={'Content-Type':'application/json',**(headers or {})})
    try:res=opener.open(req,timeout=30)
    except urllib.error.HTTPError as e:res=e
    body=res.read()
    for value in res.headers.get_all('Set-Cookie',[]):
        parsed=SimpleCookie();parsed.load(value)
        sensitive.extend(item.value for item in parsed.values() if item.value)
    return res.code,res.headers,body

def browser(user='alice'):
    opener=http.build_opener(http.HTTPCookieProcessor(cookies.CookieJar()),NoRedirect())
    opener.addheaders=[('X-Fixture-User',user)]
    return opener

def start(opener,return_to=None):
    target=BFF+'/auth/login'
    if return_to is not None:target+='?'+url.urlencode({'return_to':return_to})
    status,headers,_=call(opener,'GET',target);assert status==302
    location=headers['Location'];params=url.parse_qs(url.urlsplit(location).query)
    assert params['response_type']==['code'] and params['code_challenge_method']==['S256']
    assert all(params.get(k) for k in ['state','nonce','code_challenge'])
    sensitive.extend([params['state'][0],params['nonce'][0]])
    cookie=headers['Set-Cookie'];assert 'HttpOnly' in cookie and 'SameSite=Lax' in cookie
    return location,params

def callback(opener,location):
    for _ in range(20):
        if location.startswith(BFF+'/auth/callback'):
            sensitive.append(url.parse_qs(url.urlsplit(location).query)['code'][0]);return location
        status,headers,_=call(opener,'GET',location);assert status in [302,303],status
        location=url.urljoin(location,headers['Location'])
    raise AssertionError('redirect loop')

def changed(location,key,value):
    parts=url.urlsplit(location);params=url.parse_qs(parts.query);params[key]=[value]
    return url.urlunsplit(parts._replace(query=url.urlencode(params,doseq=True)))

admin=http.build_opener()
# Wait for actual Hydra startup; no production endpoints or stored clients are touched.
for _ in range(60):
    try:
        if call(admin,'GET','http://hydra:4445/health/ready')[0]==200:break
    except OSError:pass
    time.sleep(1)
else:raise AssertionError('Hydra unavailable')
client={'client_id':'ocms-verify','client_secret':os.environ['HYDRA_CLIENT_SECRET'],
    'grant_types':['authorization_code'],'response_types':['code'],'scope':'openid',
    'redirect_uris':[BFF+'/auth/callback'],'token_endpoint_auth_method':'client_secret_basic'}
status,_,_=call(admin,'POST','http://hydra:4445/admin/clients',client)
assert status in [201,409],status
for _ in range(60):
    try:
        if call(admin,'GET',BFF+'/healthz')[0]==200:break
    except OSError:pass
    time.sleep(1)
else:raise AssertionError('OIDC BFF unavailable')

checks=[]
a=browser();auth,params=start(a)
status,_,_=call(a,'GET',BFF+'/auth/callback?state=wrong&code=wrong');assert status==400
assert call(a,'GET',BFF+'/api/v1/me')[0]==401
checks.append('state mismatch rejected')
cb=callback(a,auth)
status,headers,_=call(a,'GET',cb);assert status==303,status
assert 'HttpOnly' in headers['Set-Cookie'] and 'SameSite=Lax' in headers['Set-Cookie']
status,_,body=call(a,'GET',BFF+'/api/v1/me');assert status==200
alice=json.loads(body);sensitive.append(alice['csrf_token'])
assert call(a,'GET',cb)[0]==400
assert call(a,'POST',BFF+'/auth/dev-login',{'user':'alice'})[0]==404
checks.append('Hydra discovery, signed ID Token, Code Flow + PKCE, session, callback replay rejection')

for field,value,expected in [('nonce','wrong-nonce',401),('code_challenge','x'*43,401)]:
    test=browser();auth,_=start(test);cb=callback(test,changed(auth,field,value))
    status,_,body=call(test,'GET',cb);assert status==expected,(field,status)
    assert call(test,'GET',BFF+'/api/v1/me')[0]==401
    checks.append(field+' tampering rejected')

b=browser('bob');auth,_=start(b);call(b,'GET',callback(b,auth))
status,_,body=call(b,'GET',BFF+'/api/v1/me');assert status==200
bob=json.loads(body);assert alice['principal_id']!=bob['principal_id'];sensitive.append(bob['csrf_token'])
# Catalog ownership uses the OIDC issuer+subject mapping, through the real BFF session.
headers={'Origin':BFF,'X-CSRF-Token':alice['csrf_token']}
status,_,body=call(a,'POST',BFF+'/api/v1/uploads',{'filename':'oidc-acl.png','mime_type':'image/png','size_bytes':0},headers);assert status==201
upload=json.loads(body)
assert call(b,'GET',BFF+'/api/v1/assets/'+upload['asset_id'])[0]==404
assert call(a,'POST',BFF+'/api/v1/uploads',{}, {'Origin':BFF})[0]==403
checks.append('two OIDC identities, ACL isolation and CSRF enforcement')
# Exercise production redirects and HTML fallback through the actual Hydra flow.
for target in ['/favorites?page=2', '/tags?'+url.urlencode({'q':'日本語 & + #?','view':'graph'}),
               '/assets/'+upload['asset_id']+'/view?from=favorites', '/recommendations']:
    test=browser();auth,_=start(test,target)
    status,return_headers,_=call(test,'GET',callback(test,auth))
    assert status==303 and return_headers['Location']==target
    status,return_headers,body=call(test,'GET',BFF+target)
    assert status==200 and return_headers.get('Content-Type','').startswith('text/html')
    assert return_headers.get('Content-Security-Policy') and b'<html' in body
    status,_,body=call(test,'HEAD',BFF+target)
    assert status==200 and not body
checks.append('deep-link login return, encoded Japanese conditions, GET/HEAD SPA fallback')
for target in ['https://outside.example/library','//outside.example/library','/auth/login','/assets/%00']:
    assert call(browser(),'GET',BFF+'/auth/login?'+url.urlencode({'return_to':target}))[0]==400
assert call(browser(),'GET',BFF+'/missing-page')[0]==404
status,return_headers,_=call(browser(),'GET',BFF+'/assets/missing.js')
assert status==404 and not return_headers.get('Content-Type','').startswith('text/html')
checks.append('invalid return targets and missing static assets rejected')
canary='private-query-'+secrets.token_hex(16);sensitive.append(canary)
call(a,'GET',BFF+'/api/v1/assets?q='+canary)
assert call(a,'POST',BFF+'/auth/logout',headers=headers)[0]==204
assert call(a,'GET',BFF+'/api/v1/me')[0]==401
checks.append('logout invalidates session')
# Final JSON is consumed privately by the host runner for the evidence leak scan.
print(json.dumps({'checks':checks,'sensitive':sensitive}))
