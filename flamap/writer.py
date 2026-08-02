"""Écriture préparée et publication ordonnée des données incendie."""

import json
import os
import shutil
import tempfile

from flamap.validation import ROOT_FILES, validate_export


def write_json(path, data, compact=True):
    with open(path, "w", encoding="utf-8") as output:
        json.dump(
            data,
            output,
            ensure_ascii=False,
            separators=(",", ":") if compact else None,
            indent=None if compact else 2,
        )


def stage_export(out, files, zones):
    """Écrit une génération complète dans un répertoire voisin non publié."""
    parent = os.path.dirname(os.path.abspath(out))
    root = tempfile.mkdtemp(prefix=".flamap-", dir=parent)
    staged = os.path.join(root, "data")
    try:
        os.makedirs(staged)
        zones_out = os.path.join(staged, "zones")
        if os.path.isdir(zones_out):
            shutil.rmtree(zones_out)
        os.makedirs(zones_out)
        for name, payload in files.items():
            write_json(
                os.path.join(staged, name), payload, compact=name != "manifest.json"
            )
        for name, payload in zones.items():
            write_json(os.path.join(zones_out, f"{name}.json"), payload)
        return root, staged
    except Exception:
        shutil.rmtree(root, ignore_errors=True)
        raise


def replace_export(staged, out):
    """Substitue une génération validée, avec manifeste remplacé en dernier."""
    root = os.path.dirname(staged)
    backup = os.path.join(root, "previous")
    os.makedirs(out, exist_ok=True)
    names = ["zones", *ROOT_FILES, "manifest.json"]
    replaced = []
    try:
        for name in names:
            source = os.path.join(staged, name)
            target = os.path.join(out, name)
            previous = os.path.join(backup, name)
            if os.path.exists(target):
                os.makedirs(os.path.dirname(previous), exist_ok=True)
                os.replace(target, previous)
                had_previous = True
            else:
                had_previous = False
            try:
                os.replace(source, target)
            except Exception:
                if had_previous:
                    os.replace(previous, target)
                raise
            replaced.append((target, previous, had_previous))
    except Exception:
        for target, previous, had_previous in reversed(replaced):
            if os.path.exists(target):
                if os.path.isdir(target):
                    shutil.rmtree(target)
                else:
                    os.unlink(target)
            if had_previous:
                os.replace(previous, target)
        raise


def publish_export(out, files, zones, *, validate=None):
    """Prépare, valide puis rend visible un export incendie cohérent."""
    validate = validate_export if validate is None else validate
    root, staged = stage_export(out, files, zones)
    try:
        validate(staged)
        replace_export(staged, out)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def publish_json(path, data, compact=True, *, validate=None):
    """Prépare un JSON autonome puis le remplace atomiquement après contrôle."""
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    descriptor, staged = tempfile.mkstemp(prefix=".flamap-", dir=parent)
    os.close(descriptor)
    try:
        write_json(staged, data, compact=compact)
        if validate is not None:
            validate(data)
        os.replace(staged, path)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)
