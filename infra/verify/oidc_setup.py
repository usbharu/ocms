"""Register the browser client automatically when starting the local verification stack."""
import json
import os
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

for _ in range(90):
    try:
        with urlopen('http://hydra:4445/health/ready',timeout=3) as response:
            if response.status==200:break
    except (URLError,TimeoutError):pass
    time.sleep(1)
else:raise SystemExit('Hydra did not become ready')
client={'client_id':'ocms-verify','client_secret':os.environ['HYDRA_CLIENT_SECRET'],
    'grant_types':['authorization_code'],'response_types':['code'],'scope':'openid',
    'redirect_uris':['http://localhost:8081/auth/callback'],'token_endpoint_auth_method':'client_secret_basic'}
request=Request('http://hydra:4445/admin/clients',json.dumps(client).encode(),
    headers={'Content-Type':'application/json'},method='POST')
try:
    with urlopen(request) as response:assert response.status==201
except HTTPError as error:
    if error.code!=409:raise SystemExit('OIDC client registration failed') from None
print('Browser OIDC client ready at http://localhost:8081')
