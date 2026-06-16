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

// 일시적(재시도 가능) 오류로 볼 HTTP 상태: 과부하·일시 장애·요청제한
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function generateDraft(
  apiKey: string,
  model: string,
  block: DataBlock,
): Promise<DraftResult> {
  const payload = buildClaudePayload(block, model)

  // 일시적 서버 오류(500/529 등)는 지수 백오프로 최대 3회까지 재시도한다.
  const maxAttempts = 4
  let lastErr: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(payload),
      })
    } catch (e: any) {
      // 네트워크 단절 등 — 재시도 대상
      lastErr = new Error(`Claude API 연결 실패: ${e?.message ?? e}`)
      if (attempt < maxAttempts) {
        await sleep(500 * 2 ** (attempt - 1)) // 0.5s, 1s, 2s
        continue
      }
      throw lastErr
    }

    const data: any = await res.json().catch(() => ({}))

    if (res.ok) {
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

    const msg = data?.error?.message || res.statusText
    lastErr = new Error(`Claude API 오류(${res.status}): ${msg}`)

    // 재시도 가능한 상태면 백오프 후 다시 시도, 아니면 즉시 실패
    if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
      await sleep(500 * 2 ** (attempt - 1)) // 0.5s, 1s, 2s
      continue
    }
    throw lastErr
  }

  throw lastErr ?? new Error('Claude API 호출 실패')
}

// ─────────────────────────────────────────────────────────────────
// 스크린샷(유튜브 커뮤니티/댓글 캡쳐)에서 댓글을 추출 (Claude Vision)
//   여러 댓글이 한 화면에 보이면 각각 {author, text} 로 분리해 읽어낸다.
// ─────────────────────────────────────────────────────────────────
export interface ExtractedComment {
  author: string
  text: string
  /** 댓글 오른쪽 영상 정보에서 읽어낸 "○○○○년생" 출생연도 (없으면 null) */
  videoYear?: number | null
}

const OCR_SYSTEM = [
  '너는 유튜브 댓글/커뮤니티 관리 화면 스크린샷에서 시청자 댓글을 정확히 읽어내는 OCR 도우미다.',
  '화면에는 여러 개의 댓글이 세로로 나열되어 있을 수 있다. 각 댓글을 하나씩 분리해서 읽어라.',
  '각 댓글에서 다음 3가지를 추출한다:',
  '1) author: 작성자 이름',
  '2) text: 댓글 본문 (작성자 옆 "· N개월 전" 시간 표시, "답글", 좋아요 수, 하트, 메뉴(⋮) 같은 UI 요소는 제외)',
  '3) video_year: 그 댓글 "오른쪽"에 붙어 있는 영상 썸네일/제목 영역에 출생연도가 보이면 그 숫자.',
  '   - "○○○○년생"(4자리, 예: "1969년생") 형태면 그 4자리(예: 1969).',
  '   - "○○년생"(2자리, 예: "79년생", "64년생", "77년생") 형태면 그 2자리 숫자 그대로(예: 79, 64, 77). 1900/2000을 붙이지 말고 본 그대로의 2자리만 넣어라.',
  '   - "79년생 양띠", "2026년 운세 64년생 닭띠"처럼 띠·운세 문구와 함께 있어도 "○○년생/○○○○년생" 부분의 연도만 뽑는다.',
  '   - 보이지 않거나 출생연도가 아니면 null.',
  '- video_year는 반드시 "년생"이 붙은 출생연도일 때만 채운다. 영상 업로드 연도(예: "2024년 운세"의 2024)·조회수·기타 숫자를 출생연도로 착각하지 마라. "2026년 6월"처럼 "년생"이 아닌 연도는 무시한다.',
  '- 각 댓글과 같은 가로줄(행)에 있는 영상 정보만 그 댓글의 video_year로 연결한다. 다른 줄의 영상과 섞지 마라.',
  '- 줄바꿈이 있는 댓글은 자연스럽게 한 덩어리로 합친다.',
  '- 글자가 잘렸거나 흐려서 확신이 없으면, 보이는 만큼만 최대한 정확히 옮긴다(추측해서 지어내지 마라).',
  '반드시 아래 JSON 형식만 출력한다. 설명·머리말·코드블록 표시 없이 JSON 객체 하나만:',
  '{"comments":[{"author":"작성자A","text":"댓글 본문","video_year":1969},{"author":"작성자B","text":"댓글 본문","video_year":79}, ...]}',
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
            text: '이 스크린샷에 보이는 모든 시청자 댓글을 작성자·본문으로 나누고, 오른쪽 영상 정보에 "○○○○년생" 출생연도가 있으면 video_year로 함께 JSON으로 추출해줘.',
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
    .map((it) => {
      // video_year: 4자리(1969) 또는 2자리(79→1979) 출생연도 채택
      let vy: number | null = null
      const rawVy = it?.video_year
      let n = typeof rawVy === 'number' ? rawVy : parseInt(String(rawVy ?? ''), 10)
      const nowY = new Date().getFullYear()
      // 2자리로 들어오면 세기 보정: 25 이하 → 20XX, 초과 → 19XX
      if (Number.isFinite(n) && n >= 0 && n <= 99) {
        n = n <= 25 ? 2000 + n : 1900 + n
      }
      if (Number.isFinite(n) && n >= 1900 && n <= nowY + 1) vy = n
      return {
        author: String(it?.author ?? '').trim(),
        text: String(it?.text ?? '').trim(),
        videoYear: vy,
      }
    })
    .filter((it) => it.text.length > 0)
}
