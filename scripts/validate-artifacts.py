#!/usr/bin/env python3
"""Validate the built inter-agent-pi npm and Python artifacts.

Standard library only. Reports filename/rule classifications and never prints
artifact contents. Exits non-zero on any boundary violation.

Usage: validate-artifacts.py <npm.tgz> <python.whl> <python.tar.gz>
"""

from __future__ import annotations

import json
import sys
import tarfile
import zipfile
from pathlib import Path

EXPECTED_NPM_NAME = "@arcanemachine/inter-agent-pi"
EXPECTED_NPM_VERSION = "0.2.1"
EXPECTED_PI_IMAGE = "https://raw.githubusercontent.com/arcanemachine/inter-agent-pi/main/logo.png"
EXPECTED_PY_NAME = "inter-agent-pi"
EXPECTED_PY_VERSION = "0.2.0"
EXPECTED_CORE_DEP = "inter-agent-core==0.2.0"
EXPECTED_WS_DEP = "websockets==16.0"
EXPECTED_PI_PEERS = {
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
}

NPM_ALLOWED_FILES = {
    "package/package.json",
    "package/src/index.ts",
    "package/src/mailbox.ts",
    "package/README.md",
    "package/CHANGELOG.md",
    "package/LICENSE.md",
}

# Content that must never ship in either artifact.
FORBIDDEN_NAME_PARTS = (
    "node_modules",
    "dist-tests",
    "tests/",
    "test_",
    "inter_agent/core",
    "inter_agent/adapters",
    "inter_agent_pi/listener.py",  # allowed in wheel (Pi source) but never in npm
    ".venv",
    "conftest.py",
    "pyproject.toml",  # npm must not ship Python metadata
    "package-lock.json",
    "tsconfig",
)


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def read_npm_manifest(tgz: Path) -> dict[str, object]:
    with tarfile.open(tgz, "r:gz") as tar:
        member = tar.getmember("package/package.json")
        return json.loads(tar.extractfile(member).read().decode("utf-8"))  # type: ignore[arg-type]


def validate_npm(tgz: Path) -> None:
    print(f"== npm tarball: {tgz.name} ==")
    with tarfile.open(tgz, "r:gz") as tar:
        names = [m.name for m in tar.getmembers() if m.isfile()]
    manifest = read_npm_manifest(tgz)
    if manifest.get("name") != EXPECTED_NPM_NAME:
        fail(f"npm name={manifest.get('name')!r} expected {EXPECTED_NPM_NAME!r}")
    if manifest.get("version") != EXPECTED_NPM_VERSION:
        fail(f"npm version={manifest.get('version')!r} expected {EXPECTED_NPM_VERSION!r}")
    if manifest.get("private") is True:
        fail("npm package is private")
    if manifest.get("publishConfig", {}).get("access") != "public":  # type: ignore[union-attr]
        fail("npm publishConfig.access must be public")
    dependencies = manifest.get("dependencies", {})
    if not isinstance(dependencies, dict):
        fail("npm dependencies must be an object")
    bundled_pi_dependencies = sorted(set(dependencies) & EXPECTED_PI_PEERS)
    if bundled_pi_dependencies:
        fail(f"npm bundles Pi-provided dependencies: {bundled_pi_dependencies!r}")
    peers = manifest.get("peerDependencies", {})
    if not isinstance(peers, dict):
        fail("npm peerDependencies must be an object")
    if set(peers) != EXPECTED_PI_PEERS or any(value != "*" for value in peers.values()):
        fail(f"npm peerDependencies={peers!r}; expected Pi peers at '*'")
    peer_meta = manifest.get("peerDependenciesMeta", {})
    if not isinstance(peer_meta, dict):
        fail("npm peerDependenciesMeta must be an object")
    if any(peer_meta.get(name, {}).get("optional") is not True for name in EXPECTED_PI_PEERS):  # type: ignore[union-attr]
        fail("all Pi peer dependencies must be optional")
    if manifest.get("pi", {}).get("extensions") != ["./src/index.ts"]:  # type: ignore[union-attr]
        fail(f"npm pi.extensions={manifest.get('pi', {}).get('extensions')!r}")  # type: ignore[union-attr]
    if manifest.get("pi", {}).get("image") != EXPECTED_PI_IMAGE:  # type: ignore[union-attr]
        fail(f"npm pi.image={manifest.get('pi', {}).get('image')!r}")  # type: ignore[union-attr]
    files = set(manifest.get("files", []))  # type: ignore[union-attr]
    if files != {"src/index.ts", "src/mailbox.ts", "README.md", "CHANGELOG.md", "LICENSE.md"}:
        fail(f"npm files allowlist={sorted(files)!r}")

    shipped = set(names)
    missing = NPM_ALLOWED_FILES - shipped
    if missing:
        fail(f"npm missing required files: {sorted(missing)!r}")
    extra = sorted(shipped - NPM_ALLOWED_FILES)
    if extra:
        fail(f"npm unexpected files: {extra!r}")

    for n in names:
        low = n.lower()
        if low.endswith(".py") or low.endswith(".pyc") or low.endswith(".lock"):
            fail(f"npm shipped non-npm file: {n}")
        if low in ("package/package-lock.json",):
            fail(f"npm shipped lockfile: {n}")
    print("  npm OK")


def wheel_metadata(whl: Path) -> str:
    with zipfile.ZipFile(whl) as z:
        meta = next(n for n in z.namelist() if n.endswith(".dist-info/METADATA"))
        return z.read(meta).decode("utf-8")


def wheel_entry_points(whl: Path) -> str:
    with zipfile.ZipFile(whl) as z:
        ep = next((n for n in z.namelist() if n.endswith("entry_points.txt")), None)
        return z.read(ep).decode("utf-8") if ep else ""


def validate_wheel(whl: Path) -> None:
    print(f"== python wheel: {whl.name} ==")
    with zipfile.ZipFile(whl) as z:
        names = z.namelist()
    meta = wheel_metadata(whl)
    if f"Name: {EXPECTED_PY_NAME}" not in meta:
        fail(f"wheel Name not {EXPECTED_PY_NAME!r}")
    if f"Version: {EXPECTED_PY_VERSION}" not in meta:
        fail(f"wheel Version not {EXPECTED_PY_VERSION!r}")
    if EXPECTED_CORE_DEP not in meta:
        fail(f"wheel missing Requires-Dist {EXPECTED_CORE_DEP!r}")
    # No path source or old inter-agent dependency leaked into built metadata.
    for bad in (
        "file://",
        "../../tmp",
        "Requires-Dist: inter-agent ==",
        "Requires-Dist: inter-agent==",
    ):
        if bad in meta:
            fail(f"wheel metadata contains forbidden string {bad!r}")

    ep = wheel_entry_points(whl)
    if "inter-agent-pi = inter_agent_pi.cli:main" not in ep:
        fail(f"wheel entry points: {ep!r}")
    core_scripts = [ln for ln in ep.splitlines() if "inter_agent.core" in ln]
    if core_scripts:
        fail(f"wheel leaked core scripts: {core_scripts!r}")

    py_files = [n for n in names if n.startswith("inter_agent_pi/") and n.endswith(".py")]
    if not py_files:
        fail("wheel has no inter_agent_pi source")
    for n in names:
        low = n.lower()
        if low.endswith(".ts") or low.endswith(".json") and "dist-info" not in low:
            if "dist-info" not in low:
                fail(f"wheel shipped non-python file: {n}")
        if low.startswith("inter_agent/core") or low.startswith("tests/"):
            fail(f"wheel leaked forbidden path: {n}")
    print("  wheel OK")


def validate_sdist(sdist: Path) -> None:
    print(f"== python sdist: {sdist.name} ==")
    with tarfile.open(sdist, "r:gz") as tar:
        names = [m.name for m in tar.getmembers() if m.isfile()]
        pkginfo = next((m for m in tar.getmembers() if m.name.endswith("PKG-INFO")), None)
        body = tar.extractfile(pkginfo).read().decode("utf-8") if pkginfo else ""  # type: ignore[arg-type]
    if f"Name: {EXPECTED_PY_NAME}" not in body:
        fail(f"sdist Name not {EXPECTED_PY_NAME!r}")
    if f"Version: {EXPECTED_PY_VERSION}" not in body:
        fail(f"sdist Version not {EXPECTED_PY_VERSION!r}")
    if not any(n.endswith("inter_agent_pi/__init__.py") for n in names):
        fail("sdist has no inter_agent_pi source")
    for n in names:
        low = n.lower()
        if low.startswith("inter_agent/core") or low.startswith("tests/"):
            fail(f"sdist leaked forbidden path: {n}")
    print("  sdist OK")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(
            "usage: validate-artifacts.py <npm.tgz> <python.whl> <python.tar.gz>",
            file=sys.stderr,
        )
        return 2
    npm_tgz, whl, sdist = (Path(p) for p in argv)
    for p in (npm_tgz, whl, sdist):
        if not p.is_file():
            fail(f"missing artifact: {p}")
    validate_npm(npm_tgz)
    validate_wheel(whl)
    validate_sdist(sdist)
    print("== all artifacts OK ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
