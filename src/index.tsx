/**
 * index.tsx — 천기누설 만신보감 · 사주 답글 작성실 (Hono 엣지 앱)
 *
 * 반자동(human-in-the-loop): 코드가 계산하고 AI가 초안을 쓰면, 운영자가 검토 후 게시.
 *
 * 보안: 운영자 전용 — 비밀번호 로그인.
 *   auth 쿠키 = sha256(비밀번호) 16진수. 모든 라우트(/api 포함) 보호.
 *   비밀번호 환경변수: SITE_PASSWORD 또는 APP_PASSWORD(둘 다 지원).
 *   미인증 시 API는 401 {auth_required:true}, 페이지는 로그인 화면.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { serveStatic } from 'hono/cloudflare-workers'

import { parseComment } from './parser'
import { computeSaju, type SajuInput, type Calendar } from './saju'
import { buildDataBlock } from './prompt'
import { generateDraft, DEFAULT_MODEL } from './claude'
import { fetchVideoComments, scanChannelForReplyNeeds, extractYoutubeTarget } from './youtube'
import { SHELL_HTML, loginPageHtml } from './ui'

type Bindings = {
  ANTHROPIC_API_KEY?: string
  CLAUDE_MODEL?: string
  YOUTUBE_API_KEY?: string
  /** 운영자 비밀번호 — SITE_PASSWORD 또는 APP_PASSWORD 둘 다 인식 */
  SITE_PASSWORD?: string
  APP_PASSWORD?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', logger())
app.use('/api/*', cors())

const COOKIE_NAME = 'auth'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30일

// ─────────────────────────────────────────────────────────────────
// 인증 헬퍼 (Web Crypto · 엣지 호환)
// ─────────────────────────────────────────────────────────────────
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 설정된 운영자 비밀번호 (SITE_PASSWORD 우선, 없으면 APP_PASSWORD) */
function sitePassword(c: any): string | undefined {
  return c.env.SITE_PASSWORD || c.env.APP_PASSWORD
}

/** 로그인 시스템이 켜져 있는지 (비밀번호 설정 시) */
function authEnabled(c: any): boolean {
  return !!sitePassword(c)
}

/** 현재 요청이 인증되었는지 */
async function isAuthed(c: any): Promise<boolean> {
  if (!authEnabled(c)) return true // 비밀번호 미설정이면 공개
  const cookie = getCookie(c, COOKIE_NAME)
  if (!cookie) return false
  const expected = await sha256Hex(sitePassword(c)!)
  return cookie === expected
}

// ─────────────────────────────────────────────────────────────────
// 로그인 / 로그아웃
// ─────────────────────────────────────────────────────────────────
app.post('/login', async (c) => {
  if (!authEnabled(c)) return c.redirect('/', 302)
  const body = await c.req.parseBody()
  const password = String(body.password ?? '')
  const expected = sitePassword(c)
  if (password && password === expected) {
    const token = await sha256Hex(expected!)
    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    })
    return c.redirect('/', 302)
  }
  // 실패 — 로그인 페이지 다시(에러 표시)
  return c.html(loginPageHtml(true), 401)
})

app.get('/logout', (c) => {
  deleteCookie(c, COOKIE_NAME, { path: '/' })
  return c.redirect('/', 302)
})

// ─────────────────────────────────────────────────────────────────
// 인증 미들웨어 — /api/* 와 / 보호 (정적 파일·login 제외)
// ─────────────────────────────────────────────────────────────────
app.use('/api/*', async (c, next) => {
  if (await isAuthed(c)) return next()
  return c.json({ ok: false, auth_required: true, error: '로그인이 필요합니다.' }, 401)
})

// ─────────────────────────────────────────────────────────────────
// 입력 정규화 헬퍼
// ─────────────────────────────────────────────────────────────────
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 응답용 parsed — 내부 필드(isLeapMonth/hourEstimated) 제거, 원본 계약 형태로 */
function publicParsed(p: ReturnType<typeof parseComment>) {
  return {
    found: p.found,
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    calendar: p.calendar,
    gender: p.gender,
    ageBand: p.ageBand,
    name: p.name,
    jobInComment: p.jobInComment,
    question: p.question,
    emotionKeywords: p.emotionKeywords,
    ambiguity: p.ambiguity,
    missingFields: p.missingFields,
    rawText: p.rawText,
    ...(p.yearFromTitle ? { yearFromTitle: true } : {}),
  }
}

/** 수동 입력(year..gender)이 있으면 파싱 결과보다 우선 적용 */
function mergeInput(parsed: ReturnType<typeof parseComment>, body: any): SajuInput {
  const calendar: Calendar =
    body.calendar === 'lunar' || body.calendar === 'solar'
      ? body.calendar
      : parsed.calendar === 'lunar' || parsed.calendar === 'solar'
        ? parsed.calendar
        : 'solar'

  const year = num(body.year) ?? parsed.year
  const month = num(body.month) ?? parsed.month
  const day = num(body.day) ?? parsed.day
  // hour: body.hour 가 null(시간모름) 로 명시되면 null 유지
  const hour = body.hour === null ? null : num(body.hour) ?? parsed.hour
  // 분은 명시되지 않으면 null 유지 (원본 계약)
  const minute = num(body.minute) ?? parsed.minute
  const gender =
    body.gender === '남' || body.gender === '여' ? body.gender : parsed.gender

  return {
    year: year as number,
    month: month as number,
    day: day as number,
    hour,
    minute,
    gender,
    calendar,
    isLeapMonth: body.isLeapMonth ?? parsed.isLeapMonth,
    hourEstimated: parsed.hourEstimated && body.hour == null && num(body.hour) === null,
  }
}

// ─────────────────────────────────────────────────────────────────
// /api/status — 키 설정 여부 (키 미노출)
// ─────────────────────────────────────────────────────────────────
app.get('/api/status', (c) => {
  return c.json({
    ok: true,
    anthropic_configured: !!c.env.ANTHROPIC_API_KEY,
    youtube_configured: !!c.env.YOUTUBE_API_KEY,
    model: c.env.CLAUDE_MODEL || DEFAULT_MODEL,
  })
})

// ─────────────────────────────────────────────────────────────────
// /api/analyze — 파싱 + 만세력 계산 (AI 호출 X)
//   응답: { ok, mode, saju, parsed, input, year_from_title }  (원본 계약)
//   - mode==='none'  : 사주 단서 전혀 없음 → ok:false, message
//   - mode==='guide' : 일부 정보 부족 → ok:true(되묻기 가능)
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

  // 영상 제목 출생연도 폴백 (댓글·수동입력에 연도 없을 때)
  let yearFromTitle = false
  const videoBirthYear = num(body.videoBirthYear)
  if (!num(body.year) && parsed.year == null && videoBirthYear != null) {
    parsed.year = videoBirthYear
    parsed.yearFromTitle = true
    yearFromTitle = true
    // missingFields / found 재계산
    parsed.missingFields = parsed.missingFields.filter((f) => !f.includes('연도'))
    parsed.found = parsed.missingFields.length === 0
    if (parsed.ageBand == null) {
      const age = new Date().getFullYear() - videoBirthYear
      if (age >= 0 && age < 120) {
        const lo = Math.floor(age / 10) * 10
        parsed.ageBand = `${lo}~${lo + 10}`
      }
    }
  }

  const input = mergeInput(parsed, body)

  // none 모드: 연·월·일 단서가 전혀 없음 → 계산 불가, 안내
  const noClue =
    input.year == null && input.month == null && input.day == null
  if (noClue) {
    return c.json({
      ok: false,
      mode: 'none',
      parsed: publicParsed(parsed),
      message:
        '생년월일을 찾지 못했습니다. 양력 생년월일(예: 1990-05-15)과 가능하면 태어난 시간을 입력해 주세요.',
    })
  }

  const saju = computeSaju(input)

  return c.json({
    ok: true,
    mode: saju.mode,
    saju,
    parsed: publicParsed(parsed),
    input: {
      year: input.year,
      month: input.month,
      day: input.day,
      hour: input.hour ?? null,
      minute: input.minute ?? null,
      gender: input.gender ?? null,
      calendar: input.calendar ?? 'solar',
    },
    year_from_title: yearFromTitle,
  })
})

// ─────────────────────────────────────────────────────────────────
// /api/draft — AI 답글 초안 생성
//   응답: { ok, draft }  (원본 계약)
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

  // 영상 제목 연도 폴백: 댓글에 연도가 없으면 영상 제목 연도(videoBirthYear)로 가정한다.
  //   (analyze / batch 와 동일 규칙으로 통일)
  let yearFromTitle = !!body.yearFromTitle
  const videoBirthYear = num(body.videoBirthYear)
  if (parsed.year == null && videoBirthYear != null) {
    parsed.year = videoBirthYear
    parsed.yearFromTitle = true
    yearFromTitle = true
    parsed.missingFields = parsed.missingFields.filter((f) => !f.includes('연도'))
    parsed.found = parsed.missingFields.length === 0
  } else if (yearFromTitle && body.year && parsed.year == null) {
    parsed.year = num(body.year)
    parsed.yearFromTitle = true
  }
  const input = mergeInput(parsed, body)
  const saju = computeSaju(input)

  const block = buildDataBlock(comment, parsed, saju, { yearFromTitle })
  const model = c.env.CLAUDE_MODEL || DEFAULT_MODEL

  try {
    const draft = await generateDraft(c.env.ANTHROPIC_API_KEY, model, block)
    return c.json({ ok: true, draft: draft.text, mode: saju.mode })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? 'AI 호출 실패' }, 502)
  }
})

// ─────────────────────────────────────────────────────────────────
// /api/youtube/comments — 영상 댓글 수집
//   응답: { ok, comments, stats, video_title, video_birth_year }
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
    const res = await fetchVideoComments(c.env.YOUTUBE_API_KEY, videoId, {
      maxPages,
      onlySaju,
      onlyUnanswered,
    })
    return c.json({
      ok: true,
      comments: res.comments,
      stats: res.stats,
      video_title: res.videoTitle,
      video_birth_year: res.videoBirthYear,
    })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? 'YouTube 수집 실패' }, 502)
  }
})

// ─────────────────────────────────────────────────────────────────
// /api/youtube/channel — 채널 스캔 → 답글 필요한 영상만
//   응답: { ok, videos, stats, channel_title }
// ─────────────────────────────────────────────────────────────────
app.get('/api/youtube/channel', async (c) => {
  if (!c.env.YOUTUBE_API_KEY) {
    return c.json({ ok: false, error: 'YOUTUBE_API_KEY가 설정되지 않았어요.' }, 400)
  }
  const link = c.req.query('link') ?? ''
  if (!link) return c.json({ ok: false, error: 'link가 필요해요.' }, 400)
  const maxVideos = parseInt(c.req.query('maxVideos') ?? '30', 10)

  try {
    const res = await scanChannelForReplyNeeds(c.env.YOUTUBE_API_KEY, link, maxVideos)
    return c.json({
      ok: true,
      videos: res.videos,
      stats: res.stats,
      channel_title: res.channelTitle,
    })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? 'YouTube 채널 스캔 실패' }, 502)
  }
})

// ─────────────────────────────────────────────────────────────────
// /api/batch — 미답변 댓글 일괄 초안 생성 (동시성 4, 최대 20)
//   응답: { ok, results:[{author,text,draft,mode,year_from_title,skipped,error}], stats, truncated }
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
  const allItems: Array<{ comment_id?: string; author?: string; text?: string; published_at?: string }> =
    Array.isArray(body.items) ? body.items : []
  const MAX = 20
  const items = allItems.slice(0, MAX)
  const truncated = Math.max(0, allItems.length - MAX)
  if (items.length === 0) {
    return c.json({ ok: false, error: '처리할 댓글(items)이 없어요.' }, 400)
  }

  const videoBirthYear = num(body.videoBirthYear)
  const model = c.env.CLAUDE_MODEL || DEFAULT_MODEL
  const apiKey = c.env.ANTHROPIC_API_KEY!

  const results: any[] = new Array(items.length)
  const CONCURRENCY = 4
  let cursor = 0
  let generated = 0
  let skipped = 0
  let failed = 0

  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= items.length) break
      const item = items[i]
      const text = item.text ?? ''
      const author = item.author ?? ''
      try {
        const parsed = parseComment(text)

        // 영상 제목 연도 폴백
        let yearFromTitle = false
        if (parsed.year == null && videoBirthYear != null) {
          parsed.year = videoBirthYear
          parsed.yearFromTitle = true
          yearFromTitle = true
          parsed.missingFields = parsed.missingFields.filter((f) => !f.includes('연도'))
          parsed.found = parsed.missingFields.length === 0
        }

        // 사주 단서가 전혀 없으면 건너뜀
        if (parsed.year == null && parsed.month == null && parsed.day == null) {
          results[i] = { comment_id: item.comment_id, author, text, skipped: true }
          skipped++
          continue
        }

        const input = mergeInput(parsed, {})
        const saju = computeSaju(input)
        const block = buildDataBlock(text, parsed, saju, { yearFromTitle })
        const draft = await generateDraft(apiKey, model, block)
        results[i] = {
          comment_id: item.comment_id,
          author,
          text,
          mode: saju.mode,
          year_from_title: yearFromTitle,
          draft: draft.text,
        }
        generated++
      } catch (e: any) {
        results[i] = {
          comment_id: item.comment_id,
          author,
          text,
          error: e?.message ?? '실패',
        }
        failed++
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))

  return c.json({
    ok: true,
    results,
    stats: { generated, skipped, failed },
    truncated,
  })
})

// ─────────────────────────────────────────────────────────────────
// 정적 파일 (/static/*)
// ─────────────────────────────────────────────────────────────────
app.use('/static/*', serveStatic({ root: './public' }))
app.get('/favicon.svg', serveStatic({ path: './public/static/favicon.svg' }))

// ─────────────────────────────────────────────────────────────────
// 메인 (/) — 인증되면 SPA 셸, 아니면 로그인 페이지(401)
// ─────────────────────────────────────────────────────────────────
app.get('/', async (c) => {
  if (await isAuthed(c)) return c.html(SHELL_HTML)
  return c.html(loginPageHtml(false), 401)
})

export default app
