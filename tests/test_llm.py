"""Tests for the LLM adapter (core/llm.py)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from career_planner.core import llm as llm_core
from career_planner.core.workspace import create_workspace


# --- load_config: error paths ---


def test_load_config_raises_when_llm_block_missing(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    (ws / "config.yml").write_text("language: en\n", encoding="utf-8")
    with pytest.raises(llm_core.LLMConfigError, match="provider"):
        llm_core.load_config(ws)


def test_load_config_raises_on_unsupported_provider(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    (ws / "config.yml").write_text(
        "llm:\n  provider: openai-compatible\n  model: gpt-4o\n",
        encoding="utf-8",
    )
    with pytest.raises(llm_core.LLMConfigError, match="unsupported"):
        llm_core.load_config(ws)


def test_load_config_raises_when_api_key_env_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    (ws / "config.yml").write_text(
        "llm:\n"
        "  provider: anthropic\n"
        "  model: claude-sonnet-4-20250514\n"
        "  api_key_env: TEST_NEVER_SET_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("TEST_NEVER_SET_KEY", raising=False)
    with pytest.raises(llm_core.LLMConfigError, match="unset"):
        llm_core.load_config(ws)


def test_load_config_raises_when_model_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    (ws / "config.yml").write_text(
        "llm:\n  provider: anthropic\n  api_key_env: TEST_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("TEST_KEY", "sk-fake")
    with pytest.raises(llm_core.LLMConfigError, match="model"):
        llm_core.load_config(ws)


def test_load_config_returns_resolved_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    (ws / "config.yml").write_text(
        "llm:\n"
        "  provider: anthropic\n"
        "  base_url: https://api.anthropic.com/v1\n"
        "  model: claude-sonnet-4-20250514\n"
        "  api_key_env: TEST_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("TEST_KEY", "sk-fake-123")
    config = llm_core.load_config(ws)
    assert config.provider == "anthropic"
    assert config.model == "claude-sonnet-4-20250514"
    assert config.api_key == "sk-fake-123"
    assert config.base_url == "https://api.anthropic.com/v1"


# --- complete: request shape + response parsing ---


def _ok_response(text: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={"content": [{"type": "text", "text": text}]},
    )


def _make_config() -> llm_core.LLMConfig:
    return llm_core.LLMConfig(
        provider="anthropic",
        base_url="https://api.anthropic.com/v1",
        model="claude-sonnet-4-20250514",
        api_key="sk-fake",
    )


def test_complete_sends_anthropic_shaped_request() -> None:
    captured: dict = {}

    def fake_post(url: str, **kwargs):
        captured["url"] = url
        captured["json"] = kwargs.get("json")
        captured["headers"] = kwargs.get("headers")
        return _ok_response("hello back")

    with patch.object(llm_core.httpx, "post", side_effect=fake_post):
        out = llm_core.complete(
            _make_config(),
            system="you are a tester",
            user="hi",
        )

    assert out == "hello back"
    assert captured["url"] == "https://api.anthropic.com/v1/messages"
    assert captured["headers"]["x-api-key"] == "sk-fake"
    assert captured["headers"]["anthropic-version"] == "2023-06-01"
    payload = captured["json"]
    assert payload["model"] == "claude-sonnet-4-20250514"
    assert payload["system"] == "you are a tester"
    assert payload["messages"] == [{"role": "user", "content": "hi"}]


def test_complete_json_prefill_appends_assistant_brace() -> None:
    captured: dict = {}

    def fake_post(url: str, **kwargs):
        captured["json"] = kwargs.get("json")
        return _ok_response('"key": "value"}')

    with patch.object(llm_core.httpx, "post", side_effect=fake_post):
        text = llm_core.complete(
            _make_config(),
            system="s",
            user="u",
            json_prefill=True,
        )

    # The "{" prefill is added to the assistant message and re-prepended
    # to the returned text so callers can json.loads(text) directly.
    assert captured["json"]["messages"][-1] == {"role": "assistant", "content": "{"}
    assert text.startswith("{")
    assert text == '{"key": "value"}'


def test_complete_raises_on_http_error_status() -> None:
    def fake_post(url: str, **kwargs):
        return httpx.Response(401, text="invalid api key")

    with patch.object(llm_core.httpx, "post", side_effect=fake_post):
        with pytest.raises(llm_core.LLMAPIError, match="401"):
            llm_core.complete(_make_config(), system="s", user="u")


def test_complete_raises_on_network_error() -> None:
    def fake_post(url: str, **kwargs):
        raise httpx.ConnectError("connection refused")

    with patch.object(llm_core.httpx, "post", side_effect=fake_post):
        with pytest.raises(llm_core.LLMAPIError, match="network"):
            llm_core.complete(_make_config(), system="s", user="u")


def test_complete_raises_when_response_has_no_content() -> None:
    def fake_post(url: str, **kwargs):
        return httpx.Response(200, json={"content": []})

    with patch.object(llm_core.httpx, "post", side_effect=fake_post):
        with pytest.raises(llm_core.LLMAPIError, match="content"):
            llm_core.complete(_make_config(), system="s", user="u")
