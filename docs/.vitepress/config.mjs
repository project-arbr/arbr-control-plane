import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Arbr',
  description: 'AI control plane — route, observe, and govern every LLM call.',

  ignoreDeadLinks: [/localhost/],

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
          { text: 'OpenAI / LiteLLM proxy', link: '/providers/openai' },
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
          { text: 'Routing', link: '/routing' },
          { text: 'Model registry', link: '/models' },
          { text: 'Budgets & governance', link: '/budgets' },
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
          { text: 'Deployment', link: '/deployment' },
          { text: 'Deploy on GCP', link: '/deployment-gcp' },
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
