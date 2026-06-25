// Shared capability helpers used by both the gateway (/v1/models) and admin (/api/models)
// endpoints so toolCallSupported computation stays in one place.

const OPENAI_COMPAT_PROVIDERS = new Set(["openai", "deepseek", "moonshot", "xai", "groq", "litellm"]);

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

// Returns true when Arbr can route tool/function calls to this model:
//   • OpenAI-compat providers: proxied verbatim — upstream handles tools natively.
//   • bedrock-nova: matched against BEDROCK_TOOL_PATTERNS (Converse API tool use).
//   • Everything else (gemini, anthropic direct, etc.): no tool support today.
function supportsTools(provider, modelId) {
  if (OPENAI_COMPAT_PROVIDERS.has(provider)) return true;
  if (provider === "bedrock-nova") {
    const id = modelId || "";
    return BEDROCK_TOOL_PATTERNS.some((re) => re.test(id));
  }
  return false;
}

module.exports = { supportsTools };
