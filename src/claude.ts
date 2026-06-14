/**
 * claude.ts — Anthropic Claude Messages API 호출 (서버사이드 전용)
 *
 * API 키는 절대 프론트엔드로 나가지 않는다. 이 함수는 Hono 서버(엣지)에서만 호출된다.
 */

import { buildClaudePayload, type DataBlock } from './prompt'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

export const DEFAULT_MODEL = 'claude-opus-4-20250514'

export interface DraftResult {
  text: string
  model: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

export async function generateDraft(
  apiKey: string,
  model: string,
  block: DataBlock,
): Promise<DraftResult> {
  const payload = buildClaudePayload(block, model)

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
  })

  const data: any = await res.json()
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText
    throw new Error(`Claude API 오류(${res.status}): ${msg}`)
  }

  // content: [{type:'text', text:'...'}]
  const text = (data.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim()

  return {
    text,
    model: data.model ?? model,
    usage: data.usage,
  }
}
