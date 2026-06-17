"""Unit tests — throwaway in-process mock gateway per test. No network deps."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from arbr_client import (
    ChatResponse,
    Client,
    GatewayError,
    as_langchain_model,
    create_client,
)

OK_RESPONSE = {
    "requestId": "req-1",
    "model": "gpt-4o-mini",
    "modelRequested": "auto",
    "provider": "openai",
    "routingDecision": "passthrough",
    "classifiedBy": "keyword",
    "cacheHit": False,
    "text": "hello from the gateway",
    "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
}


class MockGateway:
    """handler(method, path, body, call_number) -> (status, body_dict, delay_s)"""

    def __init__(self, handler=None):
        self.handler = handler
        self.seen: list[dict] = []
        outer = self

        class _Handler(BaseHTTPRequestHandler):
            def _respond(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw) if raw else None
                outer.seen.append({
                    "method": self.command, "path": self.path, "body": body,
                    "auth": self.headers.get("Authorization"),
                })
                out = outer.handler(self.command, self.path, body, len(outer.seen)) if outer.handler else None
                status, payload, delay = (out or (200, OK_RESPONSE, 0))
                if delay:
                    time.sleep(delay)
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = _respond
            do_POST = _respond

            def log_message(self, *args):  # quiet
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def gateway():
    gws: list[MockGateway] = []

    def make(handler=None) -> MockGateway:
        gw = MockGateway(handler)
        gws.append(gw)
        return gw

    yield make
    for gw in gws:
        gw.close()


def test_chat_returns_response_and_sends_merged_metadata(gateway):
    gw = gateway()
    karya = create_client(gw.base_url, application="unit-app", department="eng")
    res = karya.chat([{"role": "user", "content": "hi"}], task_type="faq")

    assert isinstance(res, ChatResponse)
    assert res.text == "hello from the gateway"
    assert res.routing_decision == "passthrough"
    assert res.classified_by == "keyword"
    assert res.usage and res.usage.total_tokens == 15

    sent = gw.seen[0]
    assert sent["path"] == "/v1/chat"
    assert sent["body"]["application"] == "unit-app"
    assert sent["body"]["department"] == "eng"
    assert sent["body"]["taskType"] == "faq"
    assert sent["body"]["messages"] == [{"role": "user", "content": "hi"}]


def test_normalizes_string_langchain_and_content_parts(gateway):
    gw = gateway()
    karya = create_client(gw.base_url)

    karya.chat("just a string")
    assert gw.seen[0]["body"]["messages"] == [{"role": "user", "content": "just a string"}]

    class FakeLC:
        def __init__(self, type_, content):
            self.type = type_
            self.content = content

    karya.chat([FakeLC("system", "be brief"), FakeLC("ai", [{"text": "prev "}, "answer"]), {"role": "user", "content": "next?"}])
    assert gw.seen[1]["body"]["messages"] == [
        {"role": "system", "content": "be brief"},
        {"role": "assistant", "content": "prev answer"},
        {"role": "user", "content": "next?"},
    ]


def test_per_call_override_beats_default(gateway):
    gw = gateway()
    karya = create_client(gw.base_url, application="default-app", workflow="default-wf")
    karya.chat("x", application="override-app")
    assert gw.seen[0]["body"]["application"] == "override-app"
    assert gw.seen[0]["body"]["workflow"] == "default-wf"


def test_retries_500_then_succeeds(gateway):
    gw = gateway(lambda m, p, b, n: (500, {"error": "boom"}, 0) if n == 1 else None)
    karya = create_client(gw.base_url, retries=2)
    res = karya.chat("x")
    assert res.text == OK_RESPONSE["text"]
    assert len(gw.seen) == 2


def test_retries_429_then_succeeds(gateway):
    gw = gateway(lambda m, p, b, n: (429, {"error": "rate_limited"}, 0) if n == 1 else None)
    karya = create_client(gw.base_url, retries=1)
    assert karya.chat("x").request_id == "req-1"
    assert len(gw.seen) == 2


def test_no_retry_on_400(gateway):
    gw = gateway(lambda m, p, b, n: (400, {"error": "messages array is required"}, 0))
    karya = create_client(gw.base_url, retries=3)
    with pytest.raises(GatewayError) as exc:
        karya.chat("x")
    assert exc.value.code == "bad_request"
    assert exc.value.status == 400
    assert not exc.value.retryable
    assert len(gw.seen) == 1


def test_503_demo_mode(gateway):
    gw = gateway(lambda m, p, b, n: (503, {"error": "demo_mode", "message": "No provider keys configured"}, 0))
    karya = create_client(gw.base_url, retries=0)
    with pytest.raises(GatewayError) as exc:
        karya.chat("x")
    assert exc.value.code == "demo_mode"
    assert exc.value.status == 503


def test_502_provider_error(gateway):
    gw = gateway(lambda m, p, b, n: (502, {"error": "provider_error", "message": "all providers failed"}, 0))
    karya = create_client(gw.base_url, retries=0)
    with pytest.raises(GatewayError) as exc:
        karya.chat("x")
    assert exc.value.code == "provider_error"


def test_timeout(gateway):
    gw = gateway(lambda m, p, b, n: (200, OK_RESPONSE, 0.5))
    karya = create_client(gw.base_url, retries=0, timeout_s=0.05)
    with pytest.raises(GatewayError) as exc:
        karya.chat("x")
    assert exc.value.code == "timeout"
    assert exc.value.retryable


def test_network_error():
    karya = create_client("http://127.0.0.1:9", retries=0, timeout_s=2)
    with pytest.raises(GatewayError) as exc:
        karya.chat("x")
    assert exc.value.code == "network"
    assert exc.value.retryable


def test_validates_input_before_network():
    karya = create_client("http://127.0.0.1:9")
    with pytest.raises(GatewayError) as exc:
        karya.chat(None)
    assert exc.value.code == "invalid_input"
    with pytest.raises(GatewayError):
        karya.chat([])
    with pytest.raises(GatewayError) as exc2:
        create_client("")
    assert exc2.value.code == "invalid_input"


def test_api_key_sends_authorization_header(gateway):
    gw = gateway()
    with_key = create_client(gw.base_url, api_key="ka_testkey123")
    with_key.chat("x")
    assert gw.seen[0]["auth"] == "Bearer ka_testkey123"

    without_key = create_client(gw.base_url)
    without_key.chat("x")
    assert gw.seen[1]["auth"] is None


def test_401_invalid_api_key_not_retried(gateway):
    gw = gateway(lambda m, p, b, n: (401, {"error": "invalid_api_key", "message": "Unknown key"}, 0))
    karya = create_client(gw.base_url, api_key="ka_bad", retries=3)
    with pytest.raises(GatewayError) as exc:
        karya.chat("x")
    assert exc.value.code == "invalid_api_key"
    assert exc.value.status == 401
    assert not exc.value.retryable
    assert len(gw.seen) == 1


def test_429_budget_exceeded_not_retried(gateway):
    gw = gateway(lambda m, p, b, n: (429, {"error": "budget_exceeded", "message": "over budget"}, 0))
    karya = create_client(gw.base_url, retries=3)
    with pytest.raises(GatewayError) as exc:
        karya.chat("x")
    assert exc.value.code == "budget_exceeded"
    assert not exc.value.retryable
    assert len(gw.seen) == 1


def test_stream_chunks_concat_to_full_text(gateway):
    gw = gateway()
    karya = create_client(gw.base_url)
    text = "".join(karya.stream("x"))
    assert text == OK_RESPONSE["text"]


def test_achat_and_astream_under_asyncio(gateway):
    gw = gateway()
    karya = create_client(gw.base_url)

    async def main():
        res = await karya.achat("x")
        assert res.text == OK_RESPONSE["text"]
        streamed = ""
        async for chunk in karya.astream("x"):
            streamed += chunk
        assert streamed == OK_RESPONSE["text"]

    asyncio.run(main())


def test_status(gateway):
    gw = gateway(
        lambda m, p, b, n: (200, {"demoMode": False, "liveProviders": ["openai"], "routingMode": "ai"}, 0)
        if p == "/api/status"
        else (404, {}, 0)
    )
    karya = create_client(gw.base_url)
    s = karya.status()
    assert s["routingMode"] == "ai"
    assert gw.seen[0]["method"] == "GET"


def test_as_langchain_model_shapes(gateway):
    gw = gateway()
    karya = create_client(gw.base_url, application="lc-app")
    model = as_langchain_model(karya, workflow="answer-drafting", task_type="support response")

    class FakeHuman:
        type = "human"
        content = "help"

    msg = model.invoke([FakeHuman()])
    assert msg.content == OK_RESPONSE["text"]
    assert msg.usage_metadata == {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
    assert msg.response_metadata["gateway"] is True
    assert msg.type == "ai"
    assert gw.seen[0]["body"]["workflow"] == "answer-drafting"
    assert gw.seen[0]["body"]["application"] == "lc-app"

    # PromptValue-style input (has .to_messages) — what `prompt | model` produces.
    class FakePromptValue:
        def to_messages(self):
            return [FakeHuman()]

    msg2 = model(FakePromptValue())
    assert msg2.content == OK_RESPONSE["text"]

    async def amain():
        msg3 = await model.ainvoke([FakeHuman()])
        assert msg3.content == OK_RESPONSE["text"]

    asyncio.run(amain())
