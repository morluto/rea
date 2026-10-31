"""Opt-in local companion: an explicit file root and optional HTTP routing.

No shell, host desktop, ambient credentials or arbitrary filesystem access.
Pairing code arrives through stdin/private terminal entry, never command arguments.
"""
import argparse, getpass, hashlib, hmac, json, os, platform, secrets, sys, uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from urllib.parse import urlparse

def run():
    parser=argparse.ArgumentParser();parser.add_argument('--host',default='http://127.0.0.1:4317');parser.add_argument('--root',required=True);parser.add_argument('--allow-http-routing',action='store_true');parser.add_argument('--pair-stdin',action='store_true');args=parser.parse_args()
    root=Path(args.root).resolve(strict=True)
    if not root.is_dir():raise SystemExit('Choose a directory as the explicit workspace root')
    host=urlparse(args.host)
    if host.hostname not in ('127.0.0.1','localhost','::1'):raise SystemExit('This companion pairs only with a loopback host')
    code=sys.stdin.readline().strip() if args.pair_stdin else getpass.getpass('Private pairing code: ')
    token=secrets.token_hex(32);generation=str(uuid.uuid4())
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    opener=build_opener(NoRedirect())
    def target(name):
        path=Path(name)
        if path.is_absolute() or '..' in path.parts:raise ValueError('Use a relative path inside the selected root')
        current=root
        for part in path.parts:
            current=current/part
            if current.is_symlink():raise ValueError('Symlink traversal is not permitted')
        final=current.resolve()
        if final!=root and root not in final.parents:raise ValueError('Path escapes the selected root')
        return final
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def answer(self,status,value):
            data=json.dumps(value).encode();self.send_response(status);self.send_header('content-type','application/json');self.send_header('content-length',str(len(data)));self.end_headers();self.wfile.write(data)
        def authorized(self):return hmac.compare_digest(self.headers.get('authorization',''),'Bearer '+token) and self.headers.get('x-workshop-generation')==generation
        def do_GET(self):
            if not self.authorized():return self.answer(403,{'tag':'not_authorized'})
            if self.path!='/health':return self.answer(404,{'tag':'not_found'})
            self.answer(200,{'generation':generation,'os':platform.system(),'files':True,'httpRouting':args.allow_http_routing})
        def do_POST(self):
            if not self.authorized():return self.answer(403,{'tag':'not_authorized'})
            try:
                size=int(self.headers.get('content-length','0'))
                if size>1048576:raise ValueError('Request exceeds companion limit')
                body=json.loads(self.rfile.read(size))
                if self.path=='/files/read':
                    file=target(body['path'])
                    if file.stat().st_size>262144:raise ValueError('File exceeds 256 KiB inline text limit')
                    raw=file.read_bytes();return self.answer(200,{'path':body['path'],'content':raw.decode('utf-8'),'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'generation':generation})
                if self.path=='/files/write':
                    file=target(body['path']);raw=body['content'].encode()
                    if len(raw)>262144:raise ValueError('File exceeds 256 KiB write limit')
                    file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(raw);return self.answer(200,{'path':body['path'],'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'generation':generation})
                if self.path=='/fetch':
                    if not args.allow_http_routing:return self.answer(403,{'tag':'not_authorized','message':'HTTP routing was not enabled on this companion'})
                    parsed=urlparse(body['url'])
                    if parsed.scheme not in ('http','https') or parsed.username or parsed.password:raise ValueError('Use HTTP(S) without URL credentials')
                    request=Request(body['url'],data=body.get('body','').encode() if body.get('body') is not None else None,headers=body.get('headers',{}),method=body['method'])
                    try:response=opener.open(request,timeout=20)
                    except HTTPError as e:response=e
                    with response:
                        raw=response.read(1048577)
                        if len(raw)>1048576:raise ValueError('Routed response exceeds 1 MiB')
                        text=raw.decode('utf-8',errors='replace')
                        try:value=json.loads(text)
                        except ValueError:value={'text':text}
                        return self.answer(200,{'status':response.status,'ok':200<=response.status<300,'body':value,'generation':generation})
                return self.answer(404,{'tag':'not_found'})
            except (ValueError,KeyError,OSError) as e:self.answer(400,{'tag':'device_failure','message':str(e)})
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    payload={'code':code,'endpoint':'http://127.0.0.1:'+str(server.server_port),'generation':generation,'token':token,'os':platform.system(),'rootLabel':str(root),'capabilities':['files']+(['http-routing'] if args.allow_http_routing else [])}
    req=Request(args.host+'/api/devices/pair',data=json.dumps(payload).encode(),headers={'content-type':'application/json'})
    with urlopen(req,timeout=10) as response:paired=json.load(response)
    print(json.dumps({'paired':True,'deviceId':paired['id'],'generation':generation,'endpoint':payload['endpoint'],'root':str(root)}),flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
if __name__=='__main__':run()
