# Test screenshots without seeing the page: the game in a browser tab that isn't on screen (e.g. the Claude app's
# hidden Browser pane) can't be screenshotted, but it can still render. `await __bc.shot('name')` in the page posts the
# current frame here as a JPEG, and this writes it to .shots/name.jpg (git-ignored) to look at.
#   python tools/shot-server.py          (listens on 127.0.0.1:8798 only)
import http.server, os, re, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.shots')
os.makedirs(OUT, exist_ok=True)

class Handler(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_POST(self):
        name = re.sub(r'[^a-zA-Z0-9_.-]', '_', self.path.strip('/')) or 'shot.jpg'
        data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        with open(os.path.join(OUT, name), 'wb') as f:
            f.write(data)
        self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(b'ok')

    def log_message(self, *args):
        pass

print(f'writing shots to {OUT}', flush=True)
http.server.HTTPServer(('127.0.0.1', 8798), Handler).serve_forever()
