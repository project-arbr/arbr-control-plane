"""Tests for the optional LangChain integration (skipped if langchain-core absent)."""

from __future__ import annotations

import asyncio

import pytest

langchain_core = pytest.importorskip("langchain_core")

from langchain_core.messages import AIMessage, HumanMessage  # noqa: E402
from langchain_core.prompts import ChatPromptTemplate  # noqa: E402

from arbr_client import create_client  # noqa: E402
from arbr_client.langchain import ArbrChatModel  # noqa: E402

from test_client import MockGateway, OK_RESPONSE  # noqa: E402


@pytest.fixture
def gateway():
    gw = MockGateway()
    yield gw
    gw.close()


def _model(gw, **kwargs):
    client = create_client(gw.base_url, application="lc-test")
    return ArbrChatModel(client=client, **kwargs)


def test_invoke_returns_real_aimessage(gateway):
    llm = _model(gateway, model_name="auto", workflow="wf-1")
    msg = llm.invoke([HumanMessage(content="hi")])

    assert isinstance(msg, AIMessage)
    assert msg.content == OK_RESPONSE["text"]
    assert msg.usage_metadata["total_tokens"] == 15
    assert msg.response_metadata["gateway"] is True
    assert msg.response_metadata["routingDecision"] == "passthrough"

    sent = gateway.seen[0]["body"]
    assert sent["application"] == "lc-test"
    assert sent["workflow"] == "wf-1"
    assert sent["model"] == "auto"
    assert sent["messages"] == [{"role": "user", "content": "hi"}]


def test_ainvoke_async(gateway):
    llm = _model(gateway)

    async def main():
        return await llm.ainvoke([HumanMessage(content="hi")])

    msg = asyncio.run(main())
    assert isinstance(msg, AIMessage)
    assert msg.content == OK_RESPONSE["text"]


def test_prompt_pipe_chain_composes(gateway):
    llm = _model(gateway)
    prompt = ChatPromptTemplate.from_messages([("system", "Answer briefly."), ("user", "{q}")])
    chain = prompt | llm

    out = chain.invoke({"q": "ping?"})
    assert isinstance(out, AIMessage)
    assert out.content == OK_RESPONSE["text"]

    sent = gateway.seen[0]["body"]["messages"]
    assert sent[0] == {"role": "system", "content": "Answer briefly."}
    assert sent[1] == {"role": "user", "content": "ping?"}

    out2 = asyncio.run(chain.ainvoke({"q": "ping again?"}))
    assert out2.content == OK_RESPONSE["text"]
