"""Inventorie la fermeture des ressources statiques d'un front publié."""

from __future__ import annotations

import json
import pathlib
import posixpath
import re
import urllib.parse
from html.parser import HTMLParser
from collections.abc import Callable, Iterable


# Pages conservées même lorsqu'elles ne sont pas chargées par index.html.
FRONT_ROOT_FILES = (
    "index.html", "archives.html", "mentions-legales.html", "social.html", "og.png",
    "favicon.svg", "favicon.ico", "apple-touch-icon.png", "icon-192.png",
    "icon-512.png", "site.webmanifest", "robots.txt", "sitemap.xml",
)

# Les notices du lot 16 ne sont pas encore présentes sur les déploiements plus
# anciens ; les reprendre lorsqu'elles existent ne doit pas bloquer leur relève.
PRESERVED_FRONT_FILES = (
    "fonts/OFL.txt", "vendor/README.md", "vendor/gifenc/LICENSE.md",
    "vendor/maplibre-gl/LICENSE.txt",
)

CSS_URL = re.compile(r"url\(\s*(['\"]?)([^'\")]+)\1\s*\)", re.IGNORECASE)
JS_IMPORT = re.compile(
    r"\bfrom\s*['\"]([^'\"]+)['\"]|\bimport\s*(?:\(\s*)?['\"]([^'\"]+)['\"]"
)


class _HtmlReferences(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "script" and values.get("src"):
            self.references.append(values["src"])
        elif tag == "link" and values.get("href"):
            self.references.append(values["href"])


def local_path(reference: str, parent: str) -> str | None:
    """Retourne une référence locale normalisée, ou ignore URL et data URI."""
    parsed = urllib.parse.urlsplit(reference)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return None
    path = parsed.path
    if path.startswith("/"):
        candidate = path.lstrip("/")
    else:
        candidate = posixpath.join(posixpath.dirname(parent), path)
    normalized = posixpath.normpath(candidate)
    if normalized == "." or normalized == ".." or normalized.startswith("../"):
        raise ValueError(f"référence locale hors artefact : {reference}")
    return normalized


def references(name: str, payload: bytes) -> Iterable[str]:
    """Lit uniquement les dépendances locales déclarées par HTML, CSS, JS et manifest."""
    text = payload.decode("utf-8", errors="replace")
    suffix = pathlib.PurePosixPath(name).suffix
    if suffix == ".html":
        parser = _HtmlReferences()
        parser.feed(text)
        return parser.references
    if suffix == ".css":
        return [match.group(2) for match in CSS_URL.finditer(text)]
    if suffix == ".js":
        return [first or second for first, second in JS_IMPORT.findall(text)]
    if suffix == ".webmanifest":
        manifest = json.loads(text)
        return [item["src"] for item in manifest.get("icons", []) if "src" in item]
    return ()


def front_closure(
    read: Callable[[str], bytes],
    *,
    roots: Iterable[str] = FRONT_ROOT_FILES,
    read_many: Callable[[list[str]], dict[str, bytes]] | None = None,
) -> dict[str, bytes]:
    """Charge ou vérifie les ressources transitive du front sans lister ses modules."""
    pending = list(roots)
    found: dict[str, bytes] = {}
    while pending:
        current = list(dict.fromkeys(name for name in pending if name not in found))
        pending = []
        payloads = read_many(current) if read_many else {name: read(name) for name in current}
        for name in current:
            payload = payloads[name]
            found[name] = payload
            for reference in references(name, payload):
                local = local_path(reference, name)
                if local and local not in found:
                    pending.append(local)
    return found
