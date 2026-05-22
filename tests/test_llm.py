"""Tests for the LLM adapter (core/llm/)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from career_planner.core.llm.config import (
    LLMAPIError,
    LLMConfig,
    LLMConfigError,
    load_config,
)
from career_planner.core.llm.client import complete
from career_planner.core.workspace import create_workspace

PATCH_HTTPX_POST = "career_planner.core.llm.client.httpx.post"


# --- fixtures & helpers ---


@pytest.fixture()
def ws(tmp_path: Path) -> Path:
    workspace = tmp_path / "ws"
    create_workspace(workspace)
    return workspace


def _write_config(ws: Path, yml: str) -> None:
    (ws / "config.yml").write_text(yml, encoding="utf-8")


def _cfg(
    provider: str = "anthropic",
    base_url: str = "https://api.anthropic.com/v1",
    model: str = "claude-sonnet-4-20250514",
    api_key: str = "sk-fake",
) -> LLMConfig:
    return LLMConfig(
        provider=provider, base_url=base_url, model=model, api_key=api_key,
    )


def _oai_cfg(api_key: str = "sk-fake") -> LLMConfig:
    return _cfg(
        provider="openai-compatible",
        base_url="https://api.example.ai/v1",
        model="some-model",
        api_key=api_key,
    )


def _anthropic_response(text: str) -> httpx.Response:
    return httpx.Response(
        200, json={"content": [{"type": "text", "text": text}]},
    )


def _openai_response(
    content: str = "ok",
    finish_reason: str = "stop",
    reasoning: str | None = None,
) -> httpx.Response:
    msg: dict = {"role": "assistant", "content": content}
    if reasoning is not None:
        msg["reasoning"] = reasoning
    return httpx.Response(
        200,
        json={"choices": [{"message": msg, "finish_reason": finish_reason}]},
    )


class _Capture(dict):
    """Thin wrapper so fake_post can record request details."""

    def fake_post(self, response: httpx.Response):
        def _post(url: str, **kwargs):
            self["url"] = url
            self["json"] = kwargs.get("json")
            self["headers"] = kwargs.get("headers")
            return response
        return _post


# --- load_config: error paths ---


def test_load_config_raises_when_llm_block_missing(ws: Path) -> None:
    _write_config(ws, "language: en\n")
    with pytest.raises(LLMConfigError, match="provider"):
        load_config(ws)


def test_load_config_raises_on_unsupported_provider(ws: Path) -> None:
    _write_config(ws, "llm:\n  provider: cohere\n  model: command-r\n")
    with pytest.raises(LLMConfigError, match="unsupported"):
        load_config(ws)


def test_load_config_raises_when_api_key_env_unset(
    ws: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(ws, (
        "llm:\n"
        "  provider: anthropic\n"
        "  model: claude-sonnet-4-20250514\n"
        "  api_key_env: TEST_NEVER_SET_KEY\n"
    ))
    monkeypatch.delenv("TEST_NEVER_SET_KEY", raising=False)
    with pytest.raises(LLMConfigError, match="unset"):
        load_config(ws)


def test_load_config_raises_when_model_missing(
    ws: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(ws, "llm:\n  provider: anthropic\n  api_key_env: TEST_KEY\n")
    monkeypatch.setenv("TEST_KEY", "sk-fake")
    with pytest.raises(LLMConfigError, match="model"):
        load_config(ws)


def test_load_config_returns_resolved_config(
    ws: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(ws, (
        "llm:\n"
        "  provider: anthropic\n"
        "  base_url: https://api.anthropic.com/v1\n"
        "  model: claude-sonnet-4-20250514\n"
        "  api_key_env: TEST_KEY\n"
    ))
    monkeypatch.setenv("TEST_KEY", "sk-fake-123")
    config = load_config(ws)
    assert config.provider == "anthropic"
    assert config.model == "claude-sonnet-4-20250514"
    assert config.api_key == "sk-fake-123"
    assert config.base_url == "https://api.anthropic.com/v1"


# --- complete: anthropic request shape + response parsing ---


def test_complete_sends_anthropic_shaped_request() -> None:
    cap = _Capture()
    with patch(PATCH_HTTPX_POST, side_effect=cap.fake_post(_anthropic_response("hello back"))):
        out = complete(_cfg(), system="you are a tester", user="hi")

    assert out == "hello back"
    assert cap["url"] == "https://api.anthropic.com/v1/messages"
    assert cap["headers"]["x-api-key"] == "sk-fake"
    assert cap["headers"]["anthropic-version"] == "2023-06-01"
    assert cap["json"]["messages"] == [{"role": "user", "content": "hi"}]


def test_complete_json_prefill_appends_assistant_brace() -> None:
    cap = _Capture()
    with patch(PATCH_HTTPX_POST, side_effect=cap.fake_post(_anthropic_response('"key": "value"}'))):
        text = complete(_cfg(), system="s", user="u", json_prefill=True)

    assert cap["json"]["messages"][-1] == {"role": "assistant", "content": "{"}
    assert text == '{"key": "value"}'


def test_complete_raises_on_http_error_status() -> None:
    def fake(url, **kw):
        return httpx.Response(401, text="invalid api key")

    with patch(PATCH_HTTPX_POST, side_effect=fake):
        with pytest.raises(LLMAPIError, match="401"):
            complete(_cfg(), system="s", user="u")


def test_complete_raises_on_network_error() -> None:
    with patch(PATCH_HTTPX_POST, side_effect=httpx.ConnectError("connection refused")):
        with pytest.raises(LLMAPIError, match="network"):
            complete(_cfg(), system="s", user="u")


def test_complete_raises_when_response_has_no_content() -> None:
    def fake(url, **kw):
        return httpx.Response(200, json={"content": []})

    with patch(PATCH_HTTPX_POST, side_effect=fake):
        with pytest.raises(LLMAPIError, match="content"):
            complete(_cfg(), system="s", user="u")


# --- load_config: openai-compatible provider ---


def test_load_config_accepts_openai_compatible_with_api_key(
    ws: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(ws, (
        "llm:\n"
        "  provider: openai-compatible\n"
        "  base_url: https://api.example.ai/v1\n"
        "  model: some-model\n"
        "  api_key_env: TEST_OAI_KEY\n"
    ))
    monkeypatch.setenv("TEST_OAI_KEY", "sk-fake")
    config = load_config(ws)
    assert config.provider == "openai-compatible"
    assert config.base_url == "https://api.example.ai/v1"
    assert config.api_key == "sk-fake"


def test_load_config_accepts_openai_compatible_without_api_key_env(ws: Path) -> None:
    _write_config(ws, (
        "llm:\n"
        "  provider: openai-compatible\n"
        "  base_url: http://localhost:11434/v1\n"
        "  model: llama3.1:8b\n"
    ))
    config = load_config(ws)
    assert config.provider == "openai-compatible"
    assert config.api_key == ""


def test_load_config_requires_base_url_for_openai_compatible(
    ws: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(ws, (
        "llm:\n"
        "  provider: openai-compatible\n"
        "  model: some-model\n"
        "  api_key_env: TEST_OAI_KEY\n"
    ))
    monkeypatch.setenv("TEST_OAI_KEY", "sk-fake")
    with pytest.raises(LLMConfigError, match="base_url"):
        load_config(ws)


def test_load_config_openai_compatible_raises_when_api_key_env_set_but_unbound(
    ws: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_config(ws, (
        "llm:\n"
        "  provider: openai-compatible\n"
        "  base_url: https://api.example.ai/v1\n"
        "  model: some-model\n"
        "  api_key_env: NEVER_SET_KEY\n"
    ))
    monkeypatch.delenv("NEVER_SET_KEY", raising=False)
    with pytest.raises(LLMConfigError, match="unset"):
        load_config(ws)


# --- complete: openai-compatible request shape + response parsing ---


def test_complete_openai_compatible_sends_chat_completions_request() -> None:
    cap = _Capture()
    with patch(PATCH_HTTPX_POST, side_effect=cap.fake_post(_openai_response("hello back"))):
        out = complete(_oai_cfg(), system="you are a tester", user="hi")

    assert out == "hello back"
    assert cap["url"] == "https://api.example.ai/v1/chat/completions"
    assert cap["headers"]["authorization"] == "Bearer sk-fake"
    assert "x-api-key" not in cap["headers"]
    assert "anthropic-version" not in cap["headers"]
    assert cap["json"]["messages"] == [
        {"role": "system", "content": "you are a tester"},
        {"role": "user", "content": "hi"},
    ]
    assert "response_format" not in cap["json"]


def test_complete_openai_compatible_json_prefill_sets_response_format() -> None:
    cap = _Capture()
    with patch(PATCH_HTTPX_POST, side_effect=cap.fake_post(_openai_response('{"key": "value"}'))):
        text = complete(_oai_cfg(), system="s", user="u", json_prefill=True)

    assert cap["json"]["response_format"] == {"type": "json_object"}
    assert text == '{"key": "value"}'


def test_complete_openai_compatible_omits_authorization_when_no_key() -> None:
    cap = _Capture()
    with patch(PATCH_HTTPX_POST, side_effect=cap.fake_post(_openai_response())):
        complete(_oai_cfg(api_key=""), system="s", user="u")

    assert "authorization" not in cap["headers"]


def test_complete_openai_compatible_raises_when_choices_empty() -> None:
    def fake(url, **kw):
        return httpx.Response(200, json={"choices": []})

    with patch(PATCH_HTTPX_POST, side_effect=fake):
        with pytest.raises(LLMAPIError, match="choices"):
            complete(_oai_cfg(), system="s", user="u")


def test_complete_openai_compatible_raises_when_content_empty() -> None:
    with patch(PATCH_HTTPX_POST, side_effect=lambda *a, **kw: _openai_response("   ")):
        with pytest.raises(LLMAPIError, match="empty"):
            complete(_oai_cfg(), system="s", user="u")


def test_complete_openai_compatible_reports_reasoning_token_exhaustion() -> None:
    resp = _openai_response(content="", finish_reason="length", reasoning="Let me think...")
    with patch(PATCH_HTTPX_POST, side_effect=lambda *a, **kw: resp):
        with pytest.raises(LLMAPIError, match="reasoning.*max_tokens"):
            complete(_oai_cfg(), system="s", user="u")


def test_complete_openai_compatible_reports_plain_token_exhaustion() -> None:
    resp = _openai_response(content="", finish_reason="length")
    with patch(PATCH_HTTPX_POST, side_effect=lambda *a, **kw: resp):
        with pytest.raises(LLMAPIError, match="max_tokens"):
            complete(_oai_cfg(), system="s", user="u")