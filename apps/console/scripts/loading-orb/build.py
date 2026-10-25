"""Builds the loading lens (public/loading/*.webp, *.png) from scene.html.

scene.html renders Toru's lens in three.js: a mirror sphere whose environment is derived from the icon's own gradient
(rings as cones around the direction that reflects at the icon's highlight), turned around the vertical axis. Headless
Chrome renders one linear turn into PNG data URLs (--dump-dom); they are cropped to the lens and saved as a seamless
animated WebP. Run: python3 apps/console/scripts/loading-orb/build.py
"""
import base64, functools, http.server, os, re, subprocess, threading
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'public', 'loading')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
FRAMES, FRAME_MS = 48, 33  # one turn in about 1.6 s

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE))
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/scene.html?bare=1&noshadow=1&linear=1&size=256&dump={FRAMES}'
dom = subprocess.run([CHROME, '--headless=new', '--hide-scrollbars', '--default-background-color=00000000', '--use-angle=swiftshader',
                      '--enable-unsafe-swiftshader', '--window-size=400,400', '--virtual-time-budget=20000', '--dump-dom', url],
                     capture_output=True, text=True, check=True).stdout
server.shutdown()
import io
frames = [Image.open(io.BytesIO(base64.b64decode(u))).convert('RGBA') for u in re.findall(r'data:image/png;base64,([A-Za-z0-9+/=]+)', dom)]
assert len(frames) == FRAMES, f'expected {FRAMES} frames, got {len(frames)}'
box = None
for im in frames:
    b = im.split()[3].point(lambda v: 255 if v > 8 else 0).getbbox()
    box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
half = max(box[2] - box[0], box[3] - box[1]) / 2 + 1
square = (round(cx - half), round(cy - half), round(cx + half), round(cy + half))
os.makedirs(OUT, exist_ok=True)
for size in (128, 256):
    out = [im.crop(square).resize((size, size), Image.LANCZOS) for im in frames]
    out[0].save(os.path.join(OUT, f'toru-orb-{size}.webp'), save_all=True, append_images=out[1:], duration=[FRAME_MS] * len(out), loop=0, quality=88, method=6)
frames[0].crop(square).resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, 'toru-orb-still.png'), optimize=True)
print('wrote', OUT)
