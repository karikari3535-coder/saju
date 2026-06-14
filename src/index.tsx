/**
 * index.tsx — 천기누설 만신보감 · 사주 답글 작성실 (Hono 엣지 앱)
 *
 * 반자동(human-in-the-loop): 코드가 계산하고 AI가 초안을 쓰면, 운영자가 검토 후 게시.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import { parseComment } from './parser'
import { computeSaju, type SajuInput, type Calendar } from './saju'
import { buildDataBlock, type RotationState } from './prompt'
import { generateDraft, DEFAULT_MODEL } from './claude'
import {
  extractYoutubeTarget,
  fetchVideoComments,
  scanChannelForReplyNeeds,
} from './youtube'
import { DASHBOARD_HTML } from './ui'

type Bindings = {
  ANTHROPIC_API_KEY?: string
  CLAUDE_MODEL?: string
  YOUTUBE_API_KEY?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', logger())
app.use('/api/*', cors())

// ─────────────────────────────────────────────────────────────────
// 입력 정규화 헬퍼
// ─────────────────────────────────────────────────────────────────
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 수동 입력(year..gender)이 있으면 파싱 결과보다 우선 적용 */
function mergeInput(parsed: ReturnType<typeof parseComment>, body: any): SajuInput {
  const calendar: Calendar =
    body.calendar === 'lunar' || body.calendar === 'solar'
      ? body.calendar
      : parsed.calendar

  const year = num(body.year) ?? parsed.year
  const month = num(body.month) ?? parsed.month
  const day = num(body.day) ?? parsed.day
  const hourBody = num(body.hour)
  const hour = hourBody !== null ? hourBody : parsed.hour
  const minute = num(body.minute) ?? parsed.minute ?? 0
  const gender =
    body.gender === 'male' || body.gender === 'female'
      ? body.gender
      : parsed.gender

  return {
    year: year as number,
    month: month as number,
    day: day as number,
    hour,
    minute,
    gender,
    calendar,
    isLeapMonth: body.isLeapMonth ?? parsed.isLeapMonth,
    hourEstimated: parsed.hourEstimated && hourBody === null,
  }
}

// ─────────────────────────────────────────────────────────────────
// /api/status — 키 설정 여부 (키 미노출)
// ─────────────────────────────────────────────────────────────────
app.get('/api/status', (c) => {
  const model = c.env.CLAUDE_MODEL || DEFAULT_MODEL
  return c.json({
    ok: true,
    anthropic_key_set: !!c.env.ANTHROPIC_API_KEY,
    youtube_key_set: !!c.env.YOUTUBE_API_KEY,
    model,
    prompt_version: 'v3.8',
  })
})

// ─────────────────────────────────────────────────────────────────
// /api/analyze — 파싱 + 만세력 계산 (AI 호출 X)
// ─────────────────────────────────────────────────────────────────
app.post('/api/analyze', async (c) => {
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: '잘못된 요청(JSON)이에요.' }, 400)
  }
  const comment: string = body.comment ?? ''
  const parsed = parseComment(comment)
  const input = mergeInput(parsed, body)
  const saju = computeSaju(input)

  return c.json({ ok: true, parsed, saju })
})

// ─────────────────────────────────────────────────────────────────
// /api/draft — AI 답글 초안 생성
// ─────────────────────────────────────────────────────────────────
app.post('/api/draft', async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json(
      { ok: false, error: 'ANTHROPIC_API_KEY가 설정되지 않았어요. (.dev.vars 또는 secret 설정)' },
      400,
    )
  }
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: '잘못된 요청(JSON)이에요.' }, 400)
  }
  const comment: string = body.comment ?? ''
  const parsed = parseComment(comment)
  const input = mergeInput(parsed, body)
  const saju = computeSaju(input)

  const rotation: RotationState = body.rotation_state ?? {}
  const block = buildDataBlock(comment, parsed, saju, rotation)
  const model = c.env.CLAUDE_MODEL || DEFAULT_MODEL

  try {
    const draft = await generateDraft(c.env.ANTHROPIC_API_KEY, model, block)
    return c.json({ ok: true, parsed, saju, draft, dataBlock: block })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? 'AI 호출 실패', saju, parsed }, 502)
  }
})

// ─────────────────────────────────────────────────────────────────
// /api/youtube/comments — 영상 댓글 수집
// ─────────────────────────────────────────────────────────────────
app.get('/api/youtube/comments', async (c) => {
  if (!c.env.YOUTUBE_API_KEY) {
    return c.json({ ok: false, error: 'YOUTUBE_API_KEY가 설정되지 않았어요.' }, 400)
  }
  const videoIdRaw = c.req.query('videoId') ?? ''
  const target = extractYoutubeTarget(videoIdRaw)
  const videoId = target.kind === 'video' ? target.id : videoIdRaw
  if (!videoId) return c.json({ ok: false, error: 'videoId가 필요해요.' }, 400)

  const maxPages = parseInt(c.req.query('maxPages') ?? '3', 10)
  const onlySaju = c.req.query('onlySaju') !== 'false'
  const onlyUnanswered = c.req.query('onlyUnanswered') !== 'false'

  try {
    const comments = await fetchVideoComments(c.env.YOUTUBE_API_KEY, videoId, {
      maxPages,
      onlySaju,
      onlyUnanswered,
    })
    return c.json({ ok: true, videoId, count: comments.length, comments })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? 'YouTube 수집 실패' }, 502)
  }
})

// ─────────────────────────────────────────────────────────────────
// /api/youtube/channel — 채널 스캔 → 답글 필요한 영상만
// ─────────────────────────────────────────────────────────────────
app.get('/api/youtube/channel', async (c) => {
  if (!c.env.YOUTUBE_API_KEY) {
    return c.json({ ok: false, error: 'YOUTUBE_API_KEY가 설정되지 않았어요.' }, 400)
  }
  const link = c.req.query('link') ?? ''
  if (!link) return c.json({ ok: false, error: 'link가 필요해요.' }, 400)
  const maxVideos = parseInt(c.req.query('maxVideos') ?? '30', 10)

  try {
    const { channelId, videos } = await scanChannelForReplyNeeds(
      c.env.YOUTUBE_API_KEY,
      link,
      maxVideos,
    )
    return c.json({ ok: true, channelId, count: videos.length, videos })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? 'YouTube 채널 스캔 실패' }, 502)
  }
})

// ─────────────────────────────────────────────────────────────────
// /api/resolve-link — 링크 자동 판단(채널/영상)
// ─────────────────────────────────────────────────────────────────
app.get('/api/resolve-link', (c) => {
  const link = c.req.query('link') ?? ''
  return c.json({ ok: true, target: extractYoutubeTarget(link) })
})

// ─────────────────────────────────────────────────────────────────
// /api/batch — 미답변 댓글 일괄 초안 생성 (동시성 4, 최대 20)
// ─────────────────────────────────────────────────────────────────
app.post('/api/batch', async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ ok: false, error: 'ANTHROPIC_API_KEY가 설정되지 않았어요.' }, 400)
  }
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: '잘못된 요청(JSON)이에요.' }, 400)
  }
  const items: Array<{ comment_id: string; author: string; text: string; published_at?: string }> =
    Array.isArray(body.items) ? body.items.slice(0, 20) : []
  if (items.length === 0) {
    return c.json({ ok: false, error: '처리할 댓글(items)이 없어요.' }, 400)
  }
  const model = c.env.CLAUDE_MODEL || DEFAULT_MODEL
  const apiKey = c.env.ANTHROPIC_API_KEY

  const results: any[] = new Array(items.length)
  const CONCURRENCY = 4
  let cursor = 0

  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= items.length) break
      const item = items[i]
      try {
        const parsed = parseComment(item.text)
        const input = mergeInput(parsed, {})
        const saju = computeSaju(input)
        const block = buildDataBlock(item.text, parsed, saju, {})
        const draft = await generateDraft(apiKey, model, block)
        results[i] = {
          comment_id: item.comment_id,
          author: item.author,
          ok: true,
          mode: saju.mode,
          eightChar: saju.eightChar,
          draft: draft.text,
        }
      } catch (e: any) {
        results[i] = {
          comment_id: item.comment_id,
          author: item.author,
          ok: false,
          error: e?.message ?? '실패',
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  const success = results.filter((r) => r?.ok).length
  return c.json({ ok: true, total: items.length, success, results })
})

// ─────────────────────────────────────────────────────────────────
// 대시보드 (/) — 정적 HTML
// ─────────────────────────────────────────────────────────────────
app.get('/', (c) => c.html(DASHBOARD_HTML))

export default app
