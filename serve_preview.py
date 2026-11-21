#!/usr/bin/env python3
"""
Local preview server for the MMC AI dashboard (standalone demo mode).

Serves the dashboard at /mmc-ai/workspace and also exposes the browser
bundle + demo backend at the root paths the page expects, so the whole
takeoff pipeline runs with no Node.js, no SQLite and no backend.

Usage:
    python3 serve_preview.py
Then open: http://localhost:8812/mmc-ai/workspace

Data is per-browser (localStorage). Clear site data to reset.
"""
import http.server
import socketserver
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HTML_DIR = ROOT / 'webpages' / 'technical-proposal-kit_v5' / 'mmc-ai'
PORT = 8807

# Root-level assets the page requests by absolute path.
ROOT_ASSETS = {
    '/mmc-ai-bundle.js': ROOT / 'mmc-ai-bundle.js',
    '/mmc-ai-demo-backend.js': ROOT / 'mmc-ai-demo-backend.js',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HTML_DIR), **kwargs)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path in ('/mmc-ai/workspace', '/mmc-ai/workspace/', '/'):
            self.path = '/index.html'
        elif path in ROOT_ASSETS:
            self._serve_file(ROOT_ASSETS[path])
            return
        return super().do_GET()

    def _serve_file(self, file_path):
        try:
            data = file_path.read_bytes()
        except OSError:
            self.send_error(404, 'Not found')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/javascript; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the console quiet


if __name__ == '__main__':
    with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
        print('Preview server running (standalone demo mode).')
        print(f'Open in browser:  http://localhost:{PORT}/mmc-ai/workspace')
        print(f'Serving from:     {HTML_DIR}')
        print('Press Ctrl+C to stop.')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nStopped.')
