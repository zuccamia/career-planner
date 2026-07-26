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
        "llm:\n  provider: cohere\n  model: command-r\n",
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


# --- load_config: openai-compatible provider ---


def test_load_config_accepts_openai_compatible_with_api_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    (ws / "config.yml").write_text(
        "llm:\n"
        "  provider: openai-compatible\n"
        "  base_url: https://api.example.ai/v1\n"
        "  model: some-model\n"
        "  api_key_env: TEST_OAI_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("TEST_OAI_KEY", "sk-fake")
    config = llm_core.load_config(ws)
    assert config.provider == "openai-compatible"
    assert config.base_url == "https://api.example.ai/v1"
    assert config.model == "some-model"
    assert config.api_key == "sk-fake"


def test_load_config_accepts_openai_compatible_without_api_key_env(
    tmp_path: Path,
) -> None:
    # Local Ollama case: no auth needed, no env var configured.
    ws = tmp_path / "ws"
    create_workspace(ws)
    (ws / "config.yml").write_text(
        "llm:\n"
        "  provider: openai-compatible\n"
        "  base_url: http://localhost:11434/v1\n"
        "  model: llama3.1:8b\n",
        encoding="utf-8",
    )
    config = llm_core.load_config(ws)
    assert config.provider == "openai-compatible"
    assert config.api_key == ""


def test_load_config_requires_base_url_for_openai_compatible(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    (ws / "config.yml").write_text(
        "llm:\n"
        "  provider: openai-compatible\n"
        "  model: some-model\n"
        "  api_key_env: TEST_OAI_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("TEST_OAI_KEY", "sk-fake")
    with pytest.raises(llm_core.LLMConfigError, match="base_url"):
        llm_core.load_config(ws)


def test_load_config_openai_compatible_raises_when_api_key_env_set_but_unbound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Setting api_key_env but leaving the var unbound is still a config bug,
    # even for openai-compatible (the user clearly meant to use a key).
    ws = tmp_path / "ws"
    create_workspace(ws)
    (ws / "config.yml").write_text(
        "llm:\n"
        "  provider: openai-compatible\n"
        "  base_url: https://api.example.ai/v1\n"
        "  model: some-model\n"
        "  api_key_env: NEVER_SET_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("NEVER_SET_KEY", raising=False)
    with pytest.raises(llm_core.LLMConfigError, match="unset"):
        llm_core.load_config(ws)


# --- complete: openai-compatible request shape + response parsing ---


def _make_oai_config(api_key: str = "sk-fake") -> llm_core.LLMConfig:
    return llm_core.LLMConfig(
        provider="openai-compatible",
        base_url="https://api.example.ai/v1",
        model="some-model",
        api_key=api_key,
    )


def _oai_ok_response(content: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [
                {"message": {"role": "assistant", "content": content}}
            ]
        },
    )


def test_complete_openai_compatible_sends_chat_completions_request() -> None:
    captured: dict = {}

    def fake_post(url: str, **kwargs):
        captured["url"] = url
        captured["json"] = kwargs.get("json")
        captured["headers"] = kwargs.get("headers")
        return _oai_ok_response("hello back")

    with patch.object(llm_core.httpx, "post", side_effect=fake_post):
        out = llm_core.complete(
            _make_oai_config(),
            system="you are a tester",
            user="hi",
        )

    assert out == "hello back"
    assert captured["url"] == "https://api.example.ai/v1/chat/completions"
    assert captured["headers"]["authorization"] == "Bearer sk-fake"
    # No Anthropic-specific headers leak in.
    assert "x-api-key" not in captured["headers"]
    assert "anthropic-version" not in captured["headers"]
    payload = captured["json"]
    assert payload["model"] == "some-model"
    assert payload["messages"] == [
        {"role": "system", "content": "you are a tester"},
        {"role": "user", "content": "hi"},
    ]
    # No response_format unless json_prefill=True.
    assert "response_format" not in payload


def test_complete_openai_compatible_json_prefill_sets_response_format() -> None:
    captured: dict = {}

    def fake_post(url: str, **kwargs):
        captured["json"] = kwargs.get("json")
        return _oai_ok_response('{"key": "value"}')

    with patch.object(llm_core.httpx, "post", side_effect=fake_post):
        text = llm_core.complete(
            _make_oai_config(),
            system="s",
            user="u",
            json_prefill=True,
        )

    assert captured["json"]["response_format"] == {"type": "json_object"}
    assert text == '{"key": "value"}'


def test_complete_openai_compatible_omits_authorization_when_no_key() -> None:
    captured: dict = {}

    def fake_post(url: str, **kwargs):
        captured["headers"] = kwargs.get("headers")
        return _oai_ok_response("ok")

    with patch.object(llm_core.httpx, "post", side_effect=fake_post):
        llm_core.complete(_make_oai_config(api_key=""), system="s", user="u")

    assert "authorization" not in captured["headers"]


def test_complete_openai_compatible_raises_when_choices_empty() -> None:
    def fake_post(url: str, **kwargs):
        return httpx.Response(200, json={"choices": []})

    with patch.object(llm_core.httpx, "post", side_effect=fake_post):
        with pytest.raises(llm_core.LLMAPIError, match="choices"):
            llm_core.complete(_make_oai_config(), system="s", user="u")


def test_complete_openai_compatible_raises_when_content_empty() -> None:
    def fake_post(url: str, **kwargs):
        return httpx.Response(
            200,
            json={"choices": [{"message": {"role": "assistant", "content": "   "}}]},
        )

    with patch.object(llm_core.httpx, "post", side_effect=fake_post):
        with pytest.raises(llm_core.LLMAPIError, match="empty"):
            llm_core.complete(_make_oai_config(), system="s", user="u")


def test_complete_openai_compatible_reports_reasoning_token_exhaustion() -> None:
    # Reasoning models (e.g. gpt-oss on Ollama) emit `reasoning` first and
    # only then `content`. When max_tokens is too low the budget is spent
    # inside reasoning, content is empty, and finish_reason is "length".
    def fake_post(url: str, **kwargs):
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "reasoning": "Let me think about this...",
                        },
                        "finish_reason": "length",
                    }
                ]
            },
        )

    with patch.object(llm_core.httpx, "post", side_effect=fake_post):
        with pytest.raises(llm_core.LLMAPIError, match="reasoning.*max_tokens"):
            llm_core.complete(_make_oai_config(), system="s", user="u")


def test_complete_openai_compatible_reports_plain_token_exhaustion() -> None:
    # Non-reasoning models can also hit finish_reason="length" with empty
    # content — surface "increase max_tokens" instead of "empty message".
    def fake_post(url: str, **kwargs):
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {"role": "assistant", "content": ""},
                        "finish_reason": "length",
                    }
                ]
            },
        )

    with patch.object(llm_core.httpx, "post", side_effect=fake_post):
        with pytest.raises(llm_core.LLMAPIError, match="max_tokens"):
            llm_core.complete(_make_oai_config(), system="s", user="u")
