"""Provider implementations for LLM wire formats."""

from __future__ import annotations

import json
from typing import Any

from career_planner.core.llm.config import LLMConfig, LLMAPIError

ANTHROPIC_API_VERSION = "2023-06-01"


class Provider:
    def __init__(self, config: LLMConfig):
        self.config = config

    def headers(self) -> dict[str, str]:
        raise NotImplementedError

    def url(self) -> str:
        raise NotImplementedError

    def build_payload(
        self, *, messages: list[dict], system: str,
        max_tokens: int, **kwargs: Any,
    ) -> dict[str, Any]:
        raise NotImplementedError

    def extract_text(self, body: dict) -> str:
        raise NotImplementedError

    def extract_tool_calls(self, body: dict) -> list[tuple[str, str, dict]]:
        return []

    def wrap_initial_messages(
        self, *, system: str, user: str, json_prefill: bool,
    ) -> tuple[str, list[dict]]:
        raise NotImplementedError

    def append_tool_results(
        self, messages: list[dict], body: dict,
        results: list[tuple[str, str]],
    ) -> None:
        raise NotImplementedError


class Anthropic(Provider):

    def headers(self):
        return {
            "x-api-key": self.config.api_key,
            "anthropic-version": ANTHROPIC_API_VERSION,
            "content-type": "application/json",
        }

    def url(self):
        return f"{self.config.base_url}/messages"

    def build_payload(self, *, messages, system, max_tokens, **kwargs):
        p: dict[str, Any] = {
            "model": self.config.model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
        }
        if kwargs.get("tools"):
            p["tools"] = [
                {
                    "name": t["function"]["name"],
                    "description": t["function"]["description"],
                    "input_schema": t["function"]["parameters"],
                }
                for t in kwargs["tools"]
            ]
        return p

    def wrap_initial_messages(self, *, system, user, json_prefill):
        msgs: list[dict[str, Any]] = [{"role": "user", "content": user}]
        if json_prefill:
            msgs.append({"role": "assistant", "content": "{"})
        return system, msgs

    def extract_text(self, body):
        content = body.get("content")
        if not isinstance(content, list) or not content:
            raise LLMAPIError("LLM response has no content blocks")
        parts = [
            str(b.get("text", ""))
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        ]
        return "".join(parts).strip()

    def extract_tool_calls(self, body):
        if body.get("stop_reason") != "tool_use":
            return []
        return [
            (b["id"], b["name"], b.get("input", {}))
            for b in body.get("content", [])
            if isinstance(b, dict) and b.get("type") == "tool_use"
        ]

    def append_tool_results(self, messages, body, results):
        messages.append({"role": "assistant", "content": body["content"]})
        messages.append({
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": tid, "content": val}
                for tid, val in results
            ],
        })


class OpenAICompatible(Provider):

    def headers(self):
        h: dict[str, str] = {"content-type": "application/json"}
        if self.config.api_key:
            h["authorization"] = f"Bearer {self.config.api_key}"
        return h

    def url(self):
        return f"{self.config.base_url}/chat/completions"

    def build_payload(self, *, messages, system, max_tokens, **kwargs):
        p: dict[str, Any] = {
            "model": self.config.model,
            "max_tokens": max_tokens,
            "messages": messages,
        }
        if kwargs.get("json_mode"):
            p["response_format"] = {"type": "json_object"}
        if kwargs.get("tools"):
            p["tools"] = kwargs["tools"]
            p["stream"] = False
        return p

    def wrap_initial_messages(self, *, system, user, json_prefill):
        return system, [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

    def extract_text(self, body):
        choices = body.get("choices")
        if not isinstance(choices, list) or not choices:
            raise LLMAPIError("LLM response has no choices")
        choice = choices[0] if isinstance(choices[0], dict) else {}
        msg = choice.get("message", {})
        content = msg.get("content")
        if not isinstance(content, str) or not content.strip():
            finish_reason = choice.get("finish_reason")
            if finish_reason == "length":
                reasoning = msg.get("reasoning")
                in_reasoning = isinstance(reasoning, str) and reasoning.strip()
                where = "during reasoning " if in_reasoning else ""
                raise LLMAPIError(
                    f"model exhausted max_tokens {where}before producing "
                    "visible content; increase max_tokens"
                )
            raise LLMAPIError("LLM response has empty message content")
        return content.strip()

    def extract_tool_calls(self, body):
        msg = body.get("choices", [{}])[0].get("message", {})
        tcs = msg.get("tool_calls")
        if not tcs:
            return []
        return [
            (tc["id"], tc["function"]["name"], json.loads(tc["function"]["arguments"]))
            for tc in tcs
        ]

    def append_tool_results(self, messages, body, results):
        messages.append(body["choices"][0]["message"])
        for tid, val in results:
            messages.append({"role": "tool", "tool_call_id": tid, "content": val})


_PROVIDERS: dict[str, type[Provider]] = {
    "anthropic": Anthropic,
    "openai-compatible": OpenAICompatible,
}

def get_provider(config: LLMConfig) -> Provider:
    cls = _PROVIDERS.get(config.provider)
    if not cls:
        raise LLMAPIError(f"unsupported provider '{config.provider}'")
    return cls(config)