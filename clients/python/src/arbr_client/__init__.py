"""Official Python client for the AI control-plane gateway.

Zero dependencies — Python >= 3.11, stdlib only (urllib for HTTP; async via
``asyncio.to_thread``). The gateway owns provider keys, routing policy, logging
and cost attribution; this client is a thin, robust pipe to it:

    from arbr_client import create_client

    arbr = create_client(base_url="http://localhost:4100", application="my-app")
    res = arbr.chat("Summarise this ticket: ...")          # sync
    res = await arbr.achat("Summarise this ticket: ...")   # async
    # res.text, res.model, res.routing_decision ("explicit" | "rule" | "ai" | ...)
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Iterator, Optional

__all__ = [
    "create_client",
    "Client",
    "ChatResponse",
    "Usage",
    "GatewayError",
    "as_langchain_model",
]

_RETRY_BASE_S = 0.25
_RETRY_CAP_S = 4.0
_STREAM_CHUNK_CHARS = 24


# ── errors ────────────────────────────────────────────────────────────────────


class GatewayError(Exception):
    """Typed gateway error.

    code: "invalid_input" | "bad_request" | "demo_mode" | "provider_error"
        | "http_error" | "network" | "timeout"
    """

    def __init__(
        self,
        message: str,
        *,
        status: int = 0,
        code: str = "http_error",
        request_id: Optional[str] = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.retryable = retryable


def _invalid(message: str) -> GatewayError:
    return GatewayError(message, code="invalid_input", status=0, retryable=False)


# ── response shapes ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cached_read_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass(frozen=True)
class ChatResponse:
    """The gateway's routed completion.

    model is what actually served the call; model_requested is what you asked
    for ("auto" when you deferred); routing_decision says why
    ("explicit" | "passthrough" | "rule" | "auto" | "ai" | "cache" | "fallback");
    classified_by says how the task type was determined ("provided" | "keyword" | "ai").
    """

    text: str
    model: str
    model_requested: str
    provider: str
    routing_decision: str
    classified_by: str
    cache_hit: bool
    request_id: str
    usage: Optional[Usage] = None
    raw: dict = field(repr=False, default_factory=dict)

    @staticmethod
    def _from_dict(d: dict) -> "ChatResponse":
        u = d.get("usage") or None
        usage = (
            Usage(
                input_tokens=int(u.get("inputTokens") or 0),
                output_tokens=int(u.get("outputTokens") or 0),
                total_tokens=int(u.get("totalTokens") or 0),
                cached_read_tokens=int(u.get("cachedReadTokens") or 0),
                cache_write_tokens=int(u.get("cacheWriteTokens") or 0),
            )
            if isinstance(u, dict)
            else None
        )
        return ChatResponse(
            text=d.get("text") or "",
            model=d.get("model") or "",
            model_requested=d.get("modelRequested") or "",
            provider=d.get("provider") or "",
            routing_decision=d.get("routingDecision") or "",
            classified_by=d.get("classifiedBy") or "",
            cache_hit=bool(d.get("cacheHit")),
            request_id=d.get("requestId") or "",
            usage=usage,
            raw=d,
        )


# ── message normalization ─────────────────────────────────────────────────────


def _content_to_str(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, (list, tuple)):
        parts = []
        for c in content:
            if isinstance(c, str):
                parts.append(c)
            elif isinstance(c, dict) and c.get("text"):
                parts.append(str(c["text"]))
            elif getattr(c, "text", None):
                parts.append(str(c.text))
        return "".join(parts)
    return "" if content is None else str(content)


def _normalize_messages(messages: Any) -> list[dict]:
    """Accepts a bare string, ``{"role","content"}`` dicts, or duck-typed
    LangChain messages (objects with ``.type`` and ``.content``)."""
    if isinstance(messages, str):
        return [{"role": "user", "content": messages}]
    if not isinstance(messages, (list, tuple)):
        messages = [messages]
    if len(messages) == 0:
        raise _invalid("`messages` must not be empty")
    out: list[dict] = []
    for i, m in enumerate(messages):
        if m is None:
            raise _invalid(f"message at index {i} is None")
        if isinstance(m, str):
            out.append({"role": "user", "content": m})
        elif isinstance(m, dict):
            out.append({"role": m.get("role") or "user", "content": _content_to_str(m.get("content"))})
        elif hasattr(m, "type") and hasattr(m, "content"):
            t = str(getattr(m, "type"))
            role = "system" if t == "system" else "assistant" if t == "ai" else "user"
            out.append({"role": role, "content": _content_to_str(m.content)})
        else:
            raise _invalid(f"message at index {i} is not a str, dict, or LangChain-style message")
    return out


# ── HTTP plumbing (stdlib) ────────────────────────────────────────────────────


def _http_once(
    url: str, *, method: str, body: Optional[dict], timeout_s: float, headers: Optional[dict] = None
) -> tuple[int, Optional[dict]]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as res:
            payload = res.read()
            try:
                return res.status, json.loads(payload) if payload else None
            except (json.JSONDecodeError, ValueError):
                return res.status, None
    except urllib.error.HTTPError as err:  # non-2xx WITH a response
        payload = err.read()
        try:
            parsed = json.loads(payload) if payload else None
        except (json.JSONDecodeError, ValueError):
            parsed = None
        return err.code, parsed
    except (TimeoutError, urllib.error.URLError, OSError) as err:
        reason = getattr(err, "reason", err)
        if isinstance(err, TimeoutError) or isinstance(reason, TimeoutError) or "timed out" in str(reason).lower():
            raise GatewayError(
                f"request timed out after {timeout_s}s", code="timeout", retryable=True
            ) from err
        raise GatewayError(f"network error: {reason}", code="network", retryable=True) from err


def _error_from_response(status: int, body: Optional[dict]) -> GatewayError:
    message = (body or {}).get("message") or (body or {}).get("error") or f"gateway responded {status}"
    code = "http_error"
    err_field = (body or {}).get("error")
    if err_field == "demo_mode":
        code = "demo_mode"
    elif err_field == "provider_error":
        code = "provider_error"
    elif err_field == "invalid_api_key":
        code = "invalid_api_key"
    elif err_field == "budget_exceeded":
        code = "budget_exceeded"
    elif err_field == "rate_limited":
        code = "rate_limited"
    elif status == 400:
        code = "bad_request"
    # budget_exceeded is a 429, but retrying won't help until the window rolls past.
    retryable = code != "budget_exceeded" and (status == 429 or status >= 500)
    return GatewayError(
        str(message),
        status=status,
        code=code,
        request_id=(body or {}).get("requestId"),
        retryable=retryable,
    )


def _request_with_retries(
    url: str, *, method: str, body: Optional[dict], timeout_s: float, retries: int,
    headers: Optional[dict] = None,
) -> dict:
    last_err: Optional[GatewayError] = None
    for attempt in range(retries + 1):
        if attempt > 0:
            exp = min(_RETRY_CAP_S, _RETRY_BASE_S * (2 ** (attempt - 1)))
            time.sleep(exp / 2 + random.random() * (exp / 2))
        try:
            status, parsed = _http_once(url, method=method, body=body, timeout_s=timeout_s, headers=headers)
        except GatewayError as err:  # network / timeout
            last_err = err
            if err.retryable and attempt < retries:
                continue
            raise
        if 200 <= status < 300:
            return parsed or {}
        gerr = _error_from_response(status, parsed)
        last_err = gerr
        if gerr.retryable and attempt < retries:
            continue
        raise gerr
    raise last_err if last_err else GatewayError("request failed")  # pragma: no cover


# ── the client ────────────────────────────────────────────────────────────────


class Client:
    """Gateway client. Create via :func:`create_client`."""

    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        application: Optional[str] = None,
        workflow: Optional[str] = None,
        department: Optional[str] = None,
        user_id: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout_s: float = 60.0,
        retries: int = 2,
    ) -> None:
        url = (base_url or os.environ.get("ARBR_GATEWAY_URL") or "").rstrip("/")
        if not url:
            raise _invalid("`base_url` is required (or set ARBR_GATEWAY_URL)")
        self.base_url = url
        self._defaults = {
            "application": application,
            "workflow": workflow,
            "department": department,
            "userId": user_id,
        }
        # Gateway API key ("ka_…", Settings → API keys). Binds attribution server-side.
        key = api_key or os.environ.get("ARBR_API_KEY")
        self._headers = {"Authorization": f"Bearer {key}"} if key else {}
        self._timeout_s = timeout_s
        self._retries = max(0, retries)

    # — chat —

    def chat(
        self,
        messages: Any,
        *,
        model: Optional[str] = None,
        provider: Optional[str] = None,
        task_type: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        application: Optional[str] = None,
        workflow: Optional[str] = None,
        department: Optional[str] = None,
        user_id: Optional[str] = None,
        timeout_s: Optional[float] = None,
        retries: Optional[int] = None,
    ) -> ChatResponse:
        """One routed completion. ``model=None`` or ``"auto"`` → the gateway's
        router decides (rules → automated routing → default); an explicit model
        whose provider is connected is honored as-is."""
        if messages is None:
            raise _invalid("`messages` is required")
        body: dict[str, Any] = {k: v for k, v in self._defaults.items() if v is not None}
        overrides = {
            "application": application,
            "workflow": workflow,
            "department": department,
            "userId": user_id,
            "model": model,
            "provider": provider,
            "taskType": task_type,
            "temperature": temperature,
            "maxTokens": max_tokens,
        }
        body.update({k: v for k, v in overrides.items() if v is not None})
        body["messages"] = _normalize_messages(messages)
        raw = _request_with_retries(
            f"{self.base_url}/v1/chat",
            method="POST",
            body=body,
            timeout_s=timeout_s if timeout_s is not None else self._timeout_s,
            retries=retries if retries is not None else self._retries,
            headers=self._headers,
        )
        return ChatResponse._from_dict(raw)

    async def achat(self, messages: Any, **kwargs: Any) -> ChatResponse:
        """Async :meth:`chat` (runs the blocking call in a worker thread)."""
        return await asyncio.to_thread(self.chat, messages, **kwargs)

    # — stream (honest shim) —

    def stream(self, messages: Any, **kwargs: Any) -> Iterator[str]:
        """Yield the answer in small text chunks.

        NOTE: the gateway is non-streaming today — this makes ONE buffered
        :meth:`chat` call and chunks the text out (near-streaming UX, not
        token-by-token). Use :meth:`chat` when you need the full metadata."""
        res = self.chat(messages, **kwargs)
        text = res.text
        for i in range(0, len(text), _STREAM_CHUNK_CHARS):
            yield text[i : i + _STREAM_CHUNK_CHARS]

    async def astream(self, messages: Any, **kwargs: Any) -> AsyncIterator[str]:
        """Async :meth:`stream` (same buffered-shim caveat)."""
        res = await self.achat(messages, **kwargs)
        text = res.text
        for i in range(0, len(text), _STREAM_CHUNK_CHARS):
            yield text[i : i + _STREAM_CHUNK_CHARS]

    # — status —

    def status(self) -> dict:
        """Gateway healthcheck — GET /api/status."""
        return _request_with_retries(
            f"{self.base_url}/api/status",
            method="GET",
            body=None,
            timeout_s=self._timeout_s,
            retries=self._retries,
            headers=self._headers,
        )

    async def astatus(self) -> dict:
        return await asyncio.to_thread(self.status)

    # — model/provider discovery —

    def models(self) -> dict:
        """List all models available on this Arbr instance — GET /v1/models.

        Returns an OpenAI-compatible list dict::

            {
              "object": "list",
              "data": [
                {
                  "id": "gpt-4o",
                  "provider": "openai",
                  "label": "GPT-4o",
                  "tier": "premium",
                  "inputPer1M": 2.5,
                  "outputPer1M": 10.0,
                },
                ...
              ]
            }

        Uses the same gateway API key as chat calls — no admin key required.
        """
        return _request_with_retries(
            f"{self.base_url}/v1/models",
            method="GET",
            body=None,
            timeout_s=self._timeout_s,
            retries=self._retries,
            headers=self._headers,
        )

    async def amodels(self) -> dict:
        """Async :meth:`models`."""
        return await asyncio.to_thread(self.models)

    def providers(self) -> dict:
        """List configured live providers — GET /v1/providers.

        Returns ``{"object": "list", "data": [{"id": ..., "models": [...]}]}``.
        No credentials or keys are exposed.
        """
        return _request_with_retries(
            f"{self.base_url}/v1/providers",
            method="GET",
            body=None,
            timeout_s=self._timeout_s,
            retries=self._retries,
            headers=self._headers,
        )

    async def aproviders(self) -> dict:
        """Async :meth:`providers`."""
        return await asyncio.to_thread(self.providers)

    def task_types(self) -> dict:
        """List all supported task types — GET /v1/task-types.

        Returns a list of task type objects::

            {
              "object": "list",
              "data": [
                {
                  "id": "coding",
                  "tier": "mid",
                  "label": "Code generation",
                  "description": "Write a function, class, or script from a natural language description",
                },
                ...
              ]
            }

        Pass ``id`` values as the ``task_type`` argument in :meth:`chat` calls
        to enable smart routing. Task types in the ``light`` tier route to cheap
        fast models; ``premium`` routes to the most capable model available.
        """
        return _request_with_retries(
            f"{self.base_url}/v1/task-types",
            method="GET",
            body=None,
            timeout_s=self._timeout_s,
            retries=self._retries,
            headers=self._headers,
        )

    async def atask_types(self) -> dict:
        """Async :meth:`task_types`."""
        return await asyncio.to_thread(self.task_types)


def create_client(
    base_url: Optional[str] = None,
    *,
    application: Optional[str] = None,
    workflow: Optional[str] = None,
    department: Optional[str] = None,
    user_id: Optional[str] = None,
    api_key: Optional[str] = None,
    timeout_s: float = 60.0,
    retries: int = 2,
) -> Client:
    """Create a gateway client. ``base_url`` falls back to $ARBR_GATEWAY_URL,
    ``api_key`` to $ARBR_API_KEY."""
    return Client(
        base_url=base_url,
        application=application,
        workflow=workflow,
        department=department,
        user_id=user_id,
        api_key=api_key,
        timeout_s=timeout_s,
        retries=retries,
    )


# ── LangChain-style adapter (duck-typed; no LangChain dependency) ─────────────


class _AiMessageShape:
    """AIMessage-shaped result: .content, .usage_metadata, .response_metadata,
    .type == "ai". Attribute access only — not a real LangChain object."""

    def __init__(self, res: ChatResponse) -> None:
        u = res.usage or Usage()
        self.content = res.text
        self.usage_metadata = {
            "input_tokens": u.input_tokens,
            "output_tokens": u.output_tokens,
            "total_tokens": u.total_tokens,
        }
        self.response_metadata = {
            "model": res.model,
            "provider": res.provider,
            "routingDecision": res.routing_decision,
            "classifiedBy": res.classified_by,
            "modelRequested": res.model_requested,
            "requestId": res.request_id,
            "gateway": True,
        }
        self.additional_kwargs: dict = {}
        self.type = "ai"


def _coerce_lc_input(value: Any) -> Any:
    # A LangChain PromptValue (from `prompt | model` chains) → messages.
    if hasattr(value, "to_messages"):
        return value.to_messages()
    return value


class _LangChainishModel:
    """Minimal LangChain-style chat model backed by the gateway (duck-typed).

    Supports .invoke() / .ainvoke() and is itself callable, so simple
    `prompt | model` chains coerce it via RunnableLambda. For FULL Runnable
    compatibility (callbacks, batch, with_structured_output), wrap the client
    in a real BaseChatModel subclass in your app instead."""

    def __init__(self, client: Client, meta: dict) -> None:
        self._client = client
        self._meta = meta

    def invoke(self, messages: Any, _config: Any = None, **_: Any) -> _AiMessageShape:
        res = self._client.chat(_coerce_lc_input(messages), **self._meta)
        return _AiMessageShape(res)

    async def ainvoke(self, messages: Any, _config: Any = None, **_: Any) -> _AiMessageShape:
        res = await self._client.achat(_coerce_lc_input(messages), **self._meta)
        return _AiMessageShape(res)

    # Callable → coercible to RunnableLambda in `prompt | model` chains.
    def __call__(self, messages: Any, **_: Any) -> _AiMessageShape:
        return self.invoke(messages)

    def stream(self, messages: Any, **_: Any) -> Iterator[_AiMessageShape]:
        res = self._client.chat(_coerce_lc_input(messages), **self._meta)
        text = res.text
        for i in range(0, len(text), _STREAM_CHUNK_CHARS):
            chunk = _AiMessageShape(res)
            chunk.content = text[i : i + _STREAM_CHUNK_CHARS]
            yield chunk


def as_langchain_model(client: Client, **meta: Any) -> _LangChainishModel:
    """Wrap a client as a minimal LangChain-style chat model (no LangChain
    dependency). ``meta`` (workflow, task_type, model, temperature,
    max_tokens, ...) is merged into every call."""
    return _LangChainishModel(client, meta)
