#!/usr/bin/env python3
"""Sert le dépôt sans cache pour les mesures de référence locales."""

from __future__ import annotations

import argparse
import http.server


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        # Un profil de navigateur peut conserver un validateur malgré
        # `no-store`. Le retirer garantit une réponse 200 et un corps complet.
        for header in ("If-Modified-Since", "If-None-Match"):
            if header in self.headers:
                del self.headers[header]
        super().do_GET()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8777)
    args = parser.parse_args()
    server = http.server.ThreadingHTTPServer(("", args.port), NoCacheHandler)
    print(f"Flamap sans cache sur http://127.0.0.1:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
