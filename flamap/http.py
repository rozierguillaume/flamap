"""Primitives HTTP communes aux sources de donnees."""

import urllib.request


def get(url, timeout=300):
    req = urllib.request.Request(url, headers={"User-Agent": "flamap/0.2"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()
