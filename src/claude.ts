/**
 * claude.ts — Anthropic Claude Messages API 호출 (서버사이드 전용)
 *
 * API 키는 절대 프론트엔드로 나가지 않는다. 이 함수는 Hono 서버(엣지)에서만 호출된다.
 */

import { buildClaudePayload, type DataBlock } from './prompt'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

export const DEFAULT_MODEL = 'claude-sonnet-4-6'

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

// ─────────────────────────────────────────────────────────────────
// 스크린샷(유튜브 커뮤니티/댓글 캡쳐)에서 댓글을 추출 (Claude Vision)
//   여러 댓글이 한 화면에 보이면 각각 {author, text} 로 분리해 읽어낸다.
// ─────────────────────────────────────────────────────────────────
export interface ExtractedComment {
  author: string
  text: string
}

const OCR_SYSTEM = [
  '너는 유튜브 댓글/커뮤니티 관리 화면 스크린샷에서 시청자 댓글을 정확히 읽어내는 OCR 도우미다.',
  '화면에는 여러 개의 댓글이 세로로 나열되어 있을 수 있다. 각 댓글을 하나씩 분리해서 읽어라.',
  '각 댓글에서 작성자 이름(author)과 댓글 본문(text)을 구분해 추출한다.',
  '- 작성자 이름 옆의 "· N개월 전 / N주 전" 같은 시간 표시, "답글", 좋아요 수, 하트, 메뉴(⋮) 같은 UI 요소는 본문에서 제외한다.',
  '- 오른쪽에 보이는 영상 썸네일/영상 제목 영역의 글자는 댓글 본문이 아니므로 무시한다.',
  '- 줄바꿈이 있는 댓글은 자연스럽게 한 덩어리로 합친다.',
  '- 글자가 잘렸거나 흐려서 확신이 없으면, 보이는 만큼만 최대한 정확히 옮긴다(추측해서 지어내지 마라).',
  '반드시 아래 JSON 형식만 출력한다. 설명·머리말·코드블록 표시 없이 JSON 객체 하나만:',
  '{"comments":[{"author":"작성자","text":"댓글 본문"}, ...]}',
  '읽을 수 있는 시청자 댓글이 하나도 없으면 {"comments":[]} 를 출력한다.',
].join('\n')

/** data URL("data:image/png;base64,XXXX") 또는 순수 base64를 받아 {media_type, data}로 분해 */
function splitDataUrl(input: string): { media_type: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(input.trim())
  if (m) return { media_type: m[1], data: m[2] }
  // 순수 base64로 들어온 경우 기본 png 가정
  return { media_type: 'image/png', data: input.trim() }
}

export async function extractCommentsFromImage(
  apiKey: string,
  model: string,
  imageDataUrl: string,
): Promise<ExtractedComment[]> {
  const { media_type, data } = splitDataUrl(imageDataUrl)

  const payload = {
    model,
    max_tokens: 2000,
    temperature: 0,
    system: OCR_SYSTEM,
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type, data },
          },
          {
            type: 'text',
            text: '이 스크린샷에 보이는 모든 시청자 댓글을 작성자와 본문으로 나눠 JSON으로 추출해줘.',
          },
        ],
      },
    ],
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
  })

  const resp: any = await res.json()
  if (!res.ok) {
    const msg = resp?.error?.message || res.statusText
    throw new Error(`Claude Vision 오류(${res.status}): ${msg}`)
  }

  const raw = (resp.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim()

  // JSON 본문만 추출 (혹시 코드블록/잡텍스트가 섞여도 견고하게 파싱)
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s >= 0 && e > s) {
      try {
        parsed = JSON.parse(raw.slice(s, e + 1))
      } catch {
        parsed = null
      }
    }
  }

  const list: any[] = Array.isArray(parsed?.comments) ? parsed.comments : []
  return list
    .map((it) => ({
      author: String(it?.author ?? '').trim(),
      text: String(it?.text ?? '').trim(),
    }))
    .filter((it) => it.text.length > 0)
}
