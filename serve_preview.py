#!/usr/bin/env python3
"""
Local preview server for mmc-ai dashboard (standalone demo v2).

Serves index.html at /mmc-ai/workspace so the public-preview gate is
bypassed, and serves the bundle + demo-backend + assets at their absolute
paths so the page's <script src="/mmc-ai-bundle.js"> tags resolve.

The bundle + demo-backend implement every /api/mmc-ai/* endpoint in
browser-side JS (including boq-imports), so creating projects, uploading DXF,
running takeoff, classifying by discipline, applying quantity rules, and
importing BOQ CSVs all work without any Node.js / SQLite / v13 server.

Usage:
    python3 serve_preview.py
Then open: http://localhost:8807/mmc-ai/workspace

Data is per-browser (localStorage). Clear site data to reset.
"""
import http.server
import socketserver
from pathlib import Path

HTML_DIR = Path(__file__).resolve().parent / 'webpages' / 'technical-proposal-kit_v5' / 'mmc-ai'

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HTML_DIR), **kwargs)

    def do_GET(self):
        # Only the exact route /mmc-ai/workspace maps to index.html.
        # Everything else (/mmc-ai-bundle.js, /mmc-ai-demo-backend.js,
        # /assets/*.jpg, etc.) is served normally from the directory.
        if self.path == '/mmc-ai/workspace':
            self.path = '/index.html'
        elif self.path == '/':
            self.path = '/index.html'
        return super().do_GET()

    def end_headers(self):
        # Disable caching so edits show up on refresh
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

PORT = 8812
with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f"Preview server running (standalone demo v2).")
    print(f"Open in browser:  http://localhost:{PORT}/mmc-ai/workspace")
    print(f"Serving from:     {HTML_DIR}")
    print(f"Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
