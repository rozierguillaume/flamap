#!/usr/bin/env python3
"""Vérifie la syntaxe des sources actuelles sans dépendance externe."""

from __future__ import annotations

import html.parser
import pathlib
import py_compile
import shutil
import subprocess
import tempfile


ROOT = pathlib.Path(__file__).resolve().parent.parent
PYTHON_FILES = tuple(sorted(
    [ROOT / "fetch_fires.py", ROOT / "notify_telegram.py", ROOT / "make_og.py",
     ROOT / "make_icons.py"]
    + list((ROOT / "scripts").glob("*.py"))
    + list((ROOT / "flamap").glob("*.py"))
))
HTML_FILES = (
    ROOT / "index.html",
    ROOT / "archives.html",
    ROOT / "social.html",
    ROOT / "mentions-legales.html",
    ROOT / "scripts" / "benchmark_lot0.html",
)


class ScriptCollector(html.parser.HTMLParser):
    """Collecte les scripts JavaScript inline, hors données structurées."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.current: list[str] | None = None
        self.scripts: list[str] = []

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        if tag != "script":
            return
        attributes = dict(attrs)
        script_type = attributes.get("type", "text/javascript")
        if "src" not in attributes and script_type in {
            "text/javascript",
            "application/javascript",
            "module",
        }:
            self.current = []

    def handle_data(self, data: str) -> None:
        if self.current is not None:
            self.current.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self.current is not None:
            self.scripts.append("".join(self.current))
            self.current = None


def check_python(temp_dir: pathlib.Path) -> None:
    for source in PYTHON_FILES:
        target = temp_dir / f"{source.stem}.pyc"
        py_compile.compile(str(source), cfile=str(target), doraise=True)
        print(f"Python OK  {source.relative_to(ROOT)}")


def check_javascript(temp_dir: pathlib.Path) -> None:
    node = shutil.which("node")
    if node is None:
        raise SystemExit("Node.js est requis pour vérifier le JavaScript inline.")

    for page in HTML_FILES:
        collector = ScriptCollector()
        collector.feed(page.read_text(encoding="utf-8"))
        for index, source in enumerate(collector.scripts, start=1):
            target = temp_dir / f"{page.stem}-{index}.js"
            target.write_text(source, encoding="utf-8")
            subprocess.run((node, "--check", str(target)), check=True)
        print(
            f"JavaScript OK  {page.relative_to(ROOT)} "
            f"({len(collector.scripts)} bloc(s) inline)"
        )

    js_dir = ROOT / "js"
    if js_dir.is_dir():
        for source in sorted(js_dir.rglob("*.js")):
            subprocess.run(
                (node, "--input-type=module", "--check"),
                input=source.read_text(encoding="utf-8"),
                text=True,
                check=True,
            )
            print(f"JavaScript OK  {source.relative_to(ROOT)}")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="flamap-syntax-") as directory:
        temp_dir = pathlib.Path(directory)
        check_python(temp_dir)
        check_javascript(temp_dir)


if __name__ == "__main__":
    main()
