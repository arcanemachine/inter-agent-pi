from __future__ import annotations

import tomllib
from pathlib import Path

import pytest

from inter_agent_pi.cli import main as pi_main

ROOT = Path(__file__).resolve().parents[1]


def test_pi_console_script_is_declared() -> None:
    config = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    scripts = config["project"]["scripts"]
    assert scripts == {"inter-agent-pi": "inter_agent_pi.cli:main"}


def test_inter_agent_pi_help_lists_program_name(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exc_info:
        pi_main(["--help"])

    assert exc_info.value.code == 0
    assert "inter-agent-pi" in capsys.readouterr().out
