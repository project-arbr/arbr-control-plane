import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Arbr',
  description: 'Self-hosted model optimisation and governance — discover, evaluate, approve, and verify better LLM routes.',

  ignoreDeadLinks: [/localhost/],

  // Internal-only — not linked from the sidebar, and excluded here so it's
  // genuinely file-only: not built, not in the local search index, not
  // reachable by a direct /competitive-analysis-portkey URL.
  srcExclude: ['competitive-analysis-portkey.md'],

  themeConfig: {
    siteTitle: 'ARBR',

    nav: [
      { text: 'Docs', link: '/quickstart' },
      { text: 'SDKs', link: '/sdk/js' },
      { text: 'API Reference', link: '/api-reference' },
      { text: 'GitHub', link: 'https://github.com/project-arbr/arbr-control-plane' },
    ],

    sidebar: [
      {
        text: 'Get Started',
        items: [
          { text: 'Quickstart', link: '/quickstart' },
        ]
      },
      {
        text: 'Gateway',
        items: [
          { text: 'Overview', link: '/gateway/overview' },
          { text: 'Native endpoint', link: '/gateway/native' },
          { text: 'OpenAI-compatible endpoint', link: '/gateway/openai-compat' },
          { text: 'Streaming', link: '/gateway/streaming' },
          { text: 'Observe-only ingestion', link: '/gateway/observe-only-ingestion' },
        ]
      },
      {
        text: 'Integrations',
        items: [
          { text: 'Connect LibreChat', link: '/integrations/librechat' },
          { text: 'Connect OpenCode', link: '/integrations/opencode' },
          { text: 'Connect NVIDIA', link: '/integrations/nvidia' },
        ]
      },
      {
        text: 'Providers',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/providers/overview' },
          { text: 'OpenAI', link: '/providers/openai' },
          { text: 'LiteLLM Proxy', link: '/providers/litellm' },
          { text: 'Anthropic', link: '/providers/anthropic' },
          { text: 'Google Gemini', link: '/providers/gemini' },
          { text: 'Amazon Bedrock', link: '/providers/bedrock' },
          { text: 'DeepSeek', link: '/providers/deepseek' },
          { text: 'Moonshot AI', link: '/providers/moonshot' },
          { text: 'xAI (Grok)', link: '/providers/xai' },
          { text: 'Groq', link: '/providers/groq' },
        ]
      },
      {
        text: 'Features',
        items: [
          { text: 'Feature reference (everything, one page)', link: '/features' },
          { text: 'Routing', link: '/routing' },
          { text: 'Model registry', link: '/models' },
          { text: 'Budgets & governance', link: '/budgets' },
          { text: 'Accountable admin access', link: '/auth' },
          { text: 'OpenTelemetry tracing', link: '/opentelemetry' },
          { text: 'Cloud secret-manager integration', link: '/secret-manager' },
          { text: 'Design-partner demo fixture', link: '/demo-fixture' },
        ]
      },
      {
        text: 'SDKs',
        items: [
          { text: 'JavaScript', link: '/sdk/js' },
          { text: 'Python', link: '/sdk/python' },
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'API reference', link: '/api-reference' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Data privacy & retention', link: '/privacy' },
          { text: 'Deployment', link: '/deployment' },
          { text: 'Deploy on GCP', link: '/deployment-gcp' },
          { text: 'Operational readiness', link: '/operational-readiness' },
        ]
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/project-arbr/arbr-control-plane' }
    ],

    search: {
      provider: 'local'
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Project Arbr Contributors'
    },

    editLink: {
      pattern: 'https://github.com/project-arbr/arbr-control-plane/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    }
  }
})
