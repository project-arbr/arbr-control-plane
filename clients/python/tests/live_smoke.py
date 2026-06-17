"""Live smoke test against a running gateway (default http://localhost:4100).

NOT collected by pytest (filename doesn't match test_*). Run explicitly:
    python tests/live_smoke.py
Makes real (billable) provider calls; tags traffic application="sdk-smoke-py".
"""

from __future__ import annotations

import asyncio
import os
import sys

from arbr_client import GatewayError, as_langchain_model, create_client

BASE = os.environ.get("ARBR_GATEWAY_URL", "http://localhost:4100")


def main() -> None:
    karya = create_client(BASE, application="sdk-smoke-py")

    print(f"gateway: {BASE}")
    s = karya.status()
    print(f"status: live={s['liveProviders']} routingMode={s['routingMode']} default={s.get('defaultProvider')}/{s.get('defaultModel')}")
    if s["demoMode"]:
        raise SystemExit("gateway is in demo mode — add a provider key first")

    auto = karya.chat("Reply with exactly: pong", model="auto", max_tokens=200)
    print(f"auto:     served={auto.model} routing={auto.routing_decision} classifiedBy={auto.classified_by}")

    pin = karya.chat("Reply with exactly: pong", model=s["defaultModel"], max_tokens=200)
    print(f"explicit: served={pin.model} routing={pin.routing_decision}")
    assert pin.routing_decision == "explicit", "expected explicit for a pinned live model"

    async def amain():
        res = await karya.achat("Reply with exactly: pong", model="auto", max_tokens=200)
        print(f"achat:    served={res.model} text={res.text.strip()[:20]!r}")

    asyncio.run(amain())

    model = as_langchain_model(karya, workflow="smoke", max_tokens=200)
    msg = model.invoke([{"role": "user", "content": "Reply with exactly: pong"}])
    print(f"adapter:  content={msg.content.strip()[:20]!r} tokens={msg.usage_metadata['total_tokens']}")

    print("\nsmoke OK")


if __name__ == "__main__":
    try:
        main()
    except GatewayError as err:
        print(f"smoke FAILED: {err.code} {err}", file=sys.stderr)
        sys.exit(1)
