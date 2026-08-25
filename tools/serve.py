#!/usr/bin/env python3
"""Local dev server for live-translate.

Why this exists instead of `python -m http.server`: on Windows, Python reads
MIME types from the registry, where .js is frequently mapped to text/plain.
Browsers refuse to execute an ES module served as text/plain, so the app loads
its HTML and CSS and then silently does nothing. GitHub Pages serves .js
correctly, so this only bites in local development -- which is exactly where it
is most confusing.

Usage:
    python tools/serve.py [port]      # default 8000
"""

import sys
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Override whatever the registry claims.
SimpleHTTPRequestHandler.extensions_map.update({
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wav": "audio/wav",
    ".svg": "image/svg+xml",
})


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # getUserMedia and AudioWorklet want a fresh copy while iterating.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            super().log_message(fmt, *args)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = partial(Handler, directory=str(ROOT))
    server = HTTPServer(("127.0.0.1", port), handler)
    print(f"live-translate -> http://localhost:{port}/   (ctrl-c to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
