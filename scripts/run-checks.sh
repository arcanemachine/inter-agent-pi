#!/usr/bin/env bash
# Run the package-local gate for inter-agent-pi from the child root.
# Fail-fast. No publish, no global install, no registry mutation, no state deletion.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== npm test =="
npm test

echo "== npm run typecheck =="
npm run typecheck

echo "== npm run build =="
npm run build

echo "== prettier --check =="
npx prettier --check .

echo "== python pytest =="
uv run pytest -q

echo "== ruff =="
# --no-respect-gitignore: the dst/dir-finding uses the workspace git tree before
# the child repo is initialized; ruff's built-in exclude still skips generated trees.
uv run ruff check --no-respect-gitignore src tests

echo "== black --check =="
uv run black --check src tests

echo "== mypy =="
uv run mypy src tests

echo "== npm pack (build tarball for validation) =="
rm -f inter-agent-pi-*.tgz arcanemachine-inter-agent-pi-*.tgz
npm pack

echo "== python build =="
rm -rf dist && uv build

echo "== artifact validation =="
NPM_TGZ=$(ls arcanemachine-inter-agent-pi-*.tgz)
WHL=$(ls dist/inter_agent_pi-*.whl)
SDIST=$(ls dist/inter_agent_pi-0.2.0.tar.gz)
uv run python scripts/validate-artifacts.py "$NPM_TGZ" "$WHL" "$SDIST"

echo "== run-checks OK =="