"""Authenticated desktop broker. Shell jobs belong to separate host-owned containers."""
import base64, hmac, json, os, signal, subprocess, tempfile, threading, time, socket, select
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from transport import probe_viewer
TOKEN = os.environ.pop('GUEST_TOKEN')
lock = threading.RLock()
controller = 'agent'
children = []
os.makedirs('/run/workshop',mode=0o700,exist_ok=True)
os.chmod('/run/workshop',0o700)
os.makedirs('/home/bot/workspace', exist_ok=True)
os.makedirs('/home/bot/.config/chromium', exist_ok=True)
CHROME = 'chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --user-data-dir=/home/bot/.config/chromium'
APPS = (
    ('orbit-chrome', 'Chrome', CHROME, 'chromium'),
    ('orbit-terminal', 'Terminal', 'lxterminal', 'utilities-terminal'),
    ('orbit-files', 'Files', 'pcmanfm', 'system-file-manager'),
    ('orbit-editor', 'Text Editor', 'mousepad', 'accessories-text-editor'),
)
def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', newline='\n') as handle:
        handle.write(text)
    os.chmod(path, mode)
def bot_write(path, text, mode=0o644):
    identity = {'user': 1000, 'group': 1000, 'extra_groups': []}
    subprocess.run(['mkdir', '-p', os.path.dirname(path)], check=True, **identity)
    subprocess.run(['tee', path], input=text.encode(), stdout=subprocess.DEVNULL, check=True, **identity)
    subprocess.run(['chmod', format(mode, 'o'), path], check=True, **identity)
for name, label, command, icon_name in APPS:
    entry = f'[Desktop Entry]\nType=Application\nName={label}\nExec={command}\nIcon={icon_name}\nTerminal=false\nStartupNotify=true\nCategories=Utility;\n'
    write(f'/usr/share/applications/{name}.desktop', entry)
    bot_write(f'/home/bot/Desktop/{label}.desktop', entry, 0o755)
bot_write('/home/bot/.fluxbox/init', 'session.screen0.toolbar.visible: false\nsession.screen0.workspaces: 1\nsession.menuFile: /home/bot/.fluxbox/menu\n')
bot_write('/home/bot/.fluxbox/overlay', 'background: none\n')
bot_write('/home/bot/.fluxbox/menu', '[begin] (Home)\n' + ''.join(f'  [exec] ({label}) {{{command}}}\n' for _, label, command, _ in APPS) + '[end]\n')
bot_write('/home/bot/.config/libfm/libfm.conf', '[config]\nquick_exec=1\nterminal=lxterminal\n')
bot_write('/home/bot/.config/pcmanfm/default/pcmanfm.conf', '[desktop]\nshow_documents=0\nshow_trash=0\nshow_mounts=0\n')
bot_write('/home/bot/.config/pcmanfm/default/desktop-items-0.conf', '[*]\nwallpaper_mode=color\ndesktop_bg=#1c1c1c\ndesktop_fg=#f4f4f4\ndesktop_shadow=#000000\ndesktop_font=DejaVu Sans 11\nshow_wm_menu=0\n')
launchers = ''.join(f'launcher_item_app = /usr/share/applications/{name}.desktop\n' for name, *_ in APPS)
bot_write('/home/bot/.config/tint2/tint2rc', f'''panel_items = LTS
panel_size = 100% 48
panel_margin = 0 0
panel_padding = 8 0 8
panel_background_id = 1
panel_position = bottom center horizontal
panel_dock = 0
panel_layer = top
rounded = 0
border_width = 0
background_color = #111111 100
border_color = #111111 0
launcher_padding = 8 4 4
launcher_background_id = 0
launcher_icon_size = 28
launcher_icon_theme = Adwaita
{launchers}taskbar_mode = single_desktop
taskbar_padding = 2 2 2
taskbar_background_id = 0
task_text = 1
task_maximum_size = 180 32
task_background_id = 0
task_font = DejaVu Sans 9
task_font_color = #f4f4f4 100
''')
def launch(args,desktop=True):
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,**({'user':1000,'group':1000,'extra_groups':[]} if desktop else {}))
    children.append(p)
    return p
write('/usr/local/bin/fbsetbg', '#!/bin/sh\nexit 0\n', 0o755)
launch(['Xvfb', ':1', '-screen', '0', '1440x900x24', '-nolisten', 'tcp','-ac'])
time.sleep(1)
launch(['fluxbox'])
launch(['tint2', '-c', '/home/bot/.config/tint2/tint2rc'])
launch(['pcmanfm', '--desktop', '--profile', 'default'])
launch(['x11vnc', '-display', ':1', '-noshm', '-rfbport', '0', '-unixsock', '/run/workshop/control.rfb', '-forever', '-shared', '-nopw', '-quiet'],False)
launch(['x11vnc', '-display', ':1', '-noshm', '-rfbport', '0', '-unixsock', '/run/workshop/watch.rfb', '-forever', '-shared', '-viewonly', '-nopw', '-quiet'],False)
launch(['/opt/transport/bin/websockify','--unix-listen','/run/workshop/control.ws','--unix-target','/run/workshop/control.rfb'],False)
launch(['/opt/transport/bin/websockify','--unix-listen','/run/workshop/watch.ws','--unix-target','/run/workshop/watch.rfb'],False)
def browser(url):
    return launch(['chromium', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--user-data-dir=/home/bot/.config/chromium', url])
class Handler(BaseHTTPRequestHandler):
    rbufsize = 0
    def log_message(self, *args): pass
    def response(self, code, value):
        data=json.dumps(value).encode(); self.send_response(code); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def authorized(self): return hmac.compare_digest(self.headers.get('Authorization',''), 'Bearer '+TOKEN)
    def do_GET(self):
        if not self.authorized():return self.response(401,{'tag':'unauthenticated'})
        if self.path in ('/viewer/watch','/viewer/control'):
            if self.path.endswith('control') and controller != 'human':return self.response(409,{'tag':'human_control'})
            target=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);target.settimeout(10)
            target.connect('/run/workshop/control.ws' if self.path.endswith('control') else '/run/workshop/watch.ws')
            headers='GET / HTTP/1.1\r\n'+''.join(k+': '+v+'\r\n' for k,v in self.headers.items() if k.lower()!='authorization')+'\r\n'
            target.sendall(headers.encode())
            try:
                while True:
                    readable,_,_=select.select([target,self.connection],[],[],30)
                    for source in readable:
                        data=source.recv(65536)
                        if not data:return
                        (self.connection if source is target else target).sendall(data)
            finally:target.close();self.close_connection=True
        if self.path == '/health':
            try:display=subprocess.run(['xdotool','getdisplaygeometry'],capture_output=True,timeout=2,user=1000,group=1000,extra_groups=[]).returncode==0
            except subprocess.TimeoutExpired:display=False
            return self.response(200,{'display':display,'controller':controller,'transport':probe_viewer('/run/workshop/watch.ws') and probe_viewer('/run/workshop/control.ws')})
        if self.path == '/screen':
            with lock:
                if controller != 'agent':return self.response(409,{'tag':'human_control','message':'Capture paused during human control'})
                fd, path = tempfile.mkstemp(prefix='shot-', suffix='.png', dir='/tmp')
                os.close(fd)
                os.unlink(path)
                try:
                    p=subprocess.run(['scrot',path],capture_output=True,timeout=10,user=1000,group=1000,extra_groups=[])
                    if p.returncode:return self.response(503,{'tag':'capture_failed'})
                    size=os.path.getsize(path)
                    if size == 0 or size > 16*1024*1024:return self.response(503,{'tag':'capture_failed'})
                    with open(path,'rb') as shot: data=shot.read()
                    if not data.startswith(b'\x89PNG\r\n\x1a\n'):return self.response(503,{'tag':'capture_failed'})
                    return self.response(200,{'mediaType':'image/png','base64':base64.b64encode(data).decode()})
                finally:
                    try:os.unlink(path)
                    except OSError:pass
        return self.response(404,{'tag':'not_found'})
    def do_POST(self):
        global controller
        if not self.authorized():return self.response(401,{'tag':'unauthenticated'})
        try:
            size=int(self.headers.get('Content-Length','0'))
            if size>65536:return self.response(413,{'tag':'capacity'})
            args=json.loads(self.rfile.read(size) or b'{}')
            with lock:
                if self.path in ('/quiesce','/resume'):
                    controller='human' if self.path=='/quiesce' else 'agent'
                    return self.response(200,{'controller':controller})
                if self.path!='/input':return self.response(404,{'tag':'not_found'})
                if controller!='agent':return self.response(409,{'tag':'human_control','message':'Input paused during human control'})
                action=args.get('action')
                if action in ('click','move'):
                    x,y=args['x'],args['y']
                    if type(x)!=int or type(y)!=int or not 0<=x<1440 or not 0<=y<900:raise ValueError('Coordinates outside display')
                    command=['xdotool','mousemove',str(x),str(y)]+(['click','1'] if action=='click' else [])
                elif action=='type':
                    text=args['text']
                    if not isinstance(text,str) or len(text)>16000:raise ValueError('Text exceeds input limit')
                    command=['xdotool','type','--clearmodifiers','--delay','0','--',text]
                elif action=='key':
                    key=args['key']
                    if not isinstance(key,str) or len(key)>100 or not all(c.isalnum() or c in '+_-' for c in key):raise ValueError('Invalid key combination')
                    command=['xdotool','key','--clearmodifiers',key]
                elif action=='scroll':
                    if args.get('direction') not in ('up','down'):raise ValueError('Invalid scroll direction')
                    command=['xdotool','click','--repeat','3','4' if args['direction']=='up' else '5']
                elif action=='navigate':
                    url=args['url'];parsed=urlparse(url)
                    if parsed.scheme not in ('http','https') or not parsed.hostname or len(url)>8000:raise ValueError('Use an http or https URL')
                    browser(url)
                    return self.response(200,{'action':action,'submitted':True})
                else:raise ValueError('Unsupported desktop action')
                p=subprocess.run(command,capture_output=True,timeout=15,user=1000,group=1000,extra_groups=[])
                return self.response(200,{'action':action,'exitCode':p.returncode})
        except (ValueError,KeyError,TypeError):return self.response(400,{'tag':'invalid_input','message':'Invalid desktop action arguments'})
        except subprocess.TimeoutExpired:return self.response(409,{'tag':'timeout','message':'Desktop action timed out; inspect current display'})
def shutdown(*_):
    for p in children:
        try:os.killpg(p.pid,signal.SIGTERM)
        except ProcessLookupError:pass
    raise SystemExit(0)
signal.signal(signal.SIGTERM,shutdown)
if __name__=='__main__':ThreadingHTTPServer(('0.0.0.0',6080),Handler).serve_forever()
