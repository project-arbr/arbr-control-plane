// Shared capability helpers used by both the gateway (/v1/models) and admin (/api/models)
// endpoints so toolCallSupported computation stays in one place.

const pricing = require("../pricing/registry");

const OPENAI_COMPAT_PROVIDERS = new Set(["openai", "deepseek", "moonshot", "xai", "groq", "litellm", "mistral"]);

// Bedrock models that support tool use via the Converse API.
// Source: AWS Bedrock model cards (https://docs.aws.amazon.com/bedrock/latest/userguide/).
// Models NOT listed here (Mistral 7B, Mixtral 8x7B, DeepSeek R1 on Bedrock) do not expose
// tool use through the Converse API.
const BEDROCK_TOOL_PATTERNS = [
  /amazon\.nova/i,            // Nova micro / lite / pro / premier
  /anthropic\.claude-3/i,     // All Claude 3.x on Bedrock (Haiku, Sonnet, Opus, 3.5, 3.7)
  /moonshotai\.kimi/i,        // Kimi K2.5 — supports Converse + Chat Completions
  /meta\.llama3/i,            // Llama 3.x (all variants on Bedrock support tool use via Converse)
  /cohere\.command-r/i,       // Command R and R+
  /mistral\.mistral-large/i,  // Mistral Large
  /mistral\.mistral-small/i,  // Mistral Small
  /ai21\.jamba/i,             // Jamba 1.5 Mini and Large
  /writer\.palmyra-x5/i,      // Palmyra X5 (agentic capabilities)
];

// Returns true when Arbr's /v1/chat/completions endpoint can actually route tool/function
// calls for this model — i.e. what a client selecting a model by `toolCallSupported` will
// get. This is a PROVIDER-first check on purpose: the endpoint only has a tool path for an
// OpenAI-compatible provider (proxied) or a native-tool model (bedrock-nova via Converse).
// Any other provider — notably gemini — returns 501 for tools even when the model itself is
// function-calling capable, so the flag must be false there or it lies about the endpoint.
// Keep this in lockstep with the endpoint gate in openaiCompat.js (openAICompatBaseURL +
// isNativeToolModel); trusting the raw model capability flag was the bug it replaced.
function supportsTools(provider, modelId) {
  if (provider === "bedrock-nova") {
    return BEDROCK_TOOL_PATTERNS.some((re) => re.test(modelId || ""));
  }
  // No endpoint tool path for any non-compat provider (gemini, native anthropic, etc.).
  if (!OPENAI_COMPAT_PROVIDERS.has(provider)) return false;
  // Provider can proxy tools; respect an explicit "not capable" from the LiteLLM sync when
  // known, otherwise assume yes (the compat endpoint forwards tools to the upstream as-is).
  const entry = pricing.getModel(modelId);
  return entry?.supportsFunctionCalling !== false;
}

module.exports = { supportsTools };
