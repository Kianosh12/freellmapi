/**
 * Platform registry for the Workers port: every seeded free-tier platform is
 * served through its OpenAI-compatible endpoint so one adapter covers the
 * whole pool (mirrors server/src/providers/openai-compat.ts endpoints).
 */

export interface PlatformEndpoint {
  baseUrl: string;
  /** Optional path rewriting for providers that expose model ids in the URL. */
  authHeader?: string;
  authPrefix?: string;
  extraHeaders?: Record<string, string>;
}

export const PLATFORM_ENDPOINTS: Record<string, PlatformEndpoint> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1' },
  sambanova: { baseUrl: 'https://api.sambanova.ai/v1' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1' },
  github: { baseUrl: 'https://models.github.ai/inference' },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1' },
  cohere: { baseUrl: 'https://api.cohere.ai/compatibility/v1' },
  moonshot: { baseUrl: 'https://api.moonshot.ai/v1' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  minimax: { baseUrl: 'https://api.minimax.chat/v1' },
  huggingface: { baseUrl: 'https://router.huggingface.co/v1' },
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  freemodel: { baseUrl: 'https://freemodel.in/v1' },
  cloudflare: { baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1' },
};

export function endpointFor(platform: string, accountId?: string): PlatformEndpoint | null {
  const endpoint = PLATFORM_ENDPOINTS[platform];
  if (!endpoint) return null;
  if (!endpoint.baseUrl.includes('{account_id}')) return endpoint;
  if (!accountId) return null;
  return { ...endpoint, baseUrl: endpoint.baseUrl.replace('{account_id}', accountId) };
}
