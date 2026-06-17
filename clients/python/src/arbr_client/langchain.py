"""Optional LangChain integration: the gateway as a real ``BaseChatModel``.

Requires ``langchain-core`` (install via ``pip install arbr-client[langchain]``).
The core ``arbr_client`` package stays zero-dependency; this module imports
LangChain lazily and fails with a clear message if it's missing.

    from arbr_client import create_client
    from arbr_client.langchain import ArbrChatModel

    client = create_client("http://localhost:4100", application="my-app")
    llm = ArbrChatModel(client=client, model_name="auto")   # or a pinned model id
    # Full Runnable compatibility: prompt | llm, .ainvoke(), batching, callbacks.

For apps that should NOT take a langchain-core dependency, use the zero-dep
duck-typed adapter instead: ``arbr_client.as_langchain_model(client, ...)``.
"""

from __future__ import annotations

from typing import Any, List, Optional

try:
    from langchain_core.callbacks import (
        AsyncCallbackManagerForLLMRun,
        CallbackManagerForLLMRun,
    )
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, BaseMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
except ImportError as _err:  # pragma: no cover
    raise ImportError(
        "arbr_client.langchain requires langchain-core — "
        "install it with: pip install arbr-client[langchain]"
    ) from _err

__all__ = ["ArbrChatModel", "KaryaChatModel"]


class ArbrChatModel(BaseChatModel):
    """A LangChain chat model that routes completions through the gateway.

    ``model_name`` follows the gateway's semantics: an explicit model id is
    honored as-is when its provider is connected; ``"auto"`` (or ``None``)
    lets the gateway's router decide (rules → automated routing → default).

    Out of gateway scope (keep on direct provider SDKs): tool calling /
    ``with_structured_output``, embeddings, token-level streaming.
    """

    client: Any  # arbr_client.Client
    model_name: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    workflow: Optional[str] = None
    task_type: Optional[str] = None

    @property
    def _llm_type(self) -> str:
        return "arbr-gateway"

    @property
    def _identifying_params(self) -> dict:
        return {"model_name": self.model_name, "gateway": self.client.base_url}

    def _call_kwargs(self) -> dict:
        return {
            "model": self.model_name,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "workflow": self.workflow,
            "task_type": self.task_type,
        }

    def _to_result(self, res: Any) -> ChatResult:
        usage = None
        if res.usage is not None:
            usage = {
                "input_tokens": res.usage.input_tokens,
                "output_tokens": res.usage.output_tokens,
                "total_tokens": res.usage.total_tokens,
            }
        message = AIMessage(
            content=res.text,
            usage_metadata=usage,
            response_metadata={
                "model": res.model,
                "provider": res.provider,
                "routingDecision": res.routing_decision,
                "classifiedBy": res.classified_by,
                "modelRequested": res.model_requested,
                "requestId": res.request_id,
                "gateway": True,
            },
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        res = self.client.chat(messages, **self._call_kwargs())
        return self._to_result(res)

    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[AsyncCallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        res = await self.client.achat(messages, **self._call_kwargs())
        return self._to_result(res)


# Backward-compatibility alias (Karya → Arbr rename).
KaryaChatModel = ArbrChatModel
