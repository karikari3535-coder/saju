/**
 * parser.ts — 유튜브 댓글에서 사주 정보 추출
 *
 * 시청자가 자유 형식으로 남긴 댓글에서
 *  - 생년월일 (양/음력)
 *  - 태어난 시각
 *  - 성별
 *  - 감정 키워드 / 질문
 * 을 최대한 추출하고, 애매한 부분은 ambiguity 로 표시한다.
 *
 * 철학: "애매하면 추측하지 않는다." 확실하지 않으면 null + ambiguity 플래그.
 */

import type { Calendar } from './saju'

export interface ParsedComment {
  year: number | null
  month: number | null
  day: number | null
  /** 0~23 시. null이면 모름 */
  hour: number | null
  minute: number | null
  gender: 'male' | 'female' | null
  calendar: Calendar
  isLeapMonth: boolean
  /** 시각이 "오전/오후 경" 처럼 추정인지 */
  hourEstimated: boolean
  /** 추출한 질문 문장(있으면) */
  question: string | null
  /** 감정 키워드 */
  emotionKeywords: string[]
  /** 나이대 추정(예: '30대') — 직접 언급된 경우만 */
  ageBand: string | null
  /** 모호/주의 사항 목록 (사람이 확인) */
  ambiguity: string[]
}

const EMOTION_MAP: Record<string, string[]> = {
  연애: ['연애', '사랑', '남자친구', '여자친구', '애인', '짝사랑', '솔로', '재회', '이별'],
  결혼: ['결혼', '배우자', '혼인', '신랑', '신부', '청혼', '이혼'],
  금전: ['돈', '재물', '금전', '투자', '주식', '코인', '부동산', '빚', '대출', '사업'],
  직업: ['취업', '이직', '직장', '승진', '퇴사', '사업', '시험', '합격', '진로', '면접'],
  건강: ['건강', '병', '아프', '수술', '몸', '우울', '불안', '스트레스'],
  가족: ['가족', '부모', '엄마', '아빠', '자식', '아이', '임신', '출산', '형제'],
  대인: ['친구', '인간관계', '사람', '관계', '갈등', '배신'],
  운세: ['올해', '내년', '운', '대운', '시기', '언제', '미래', '앞으로'],
}

/** 위기 신호 키워드 (답글에서 109 안내가 필요할 수 있음) */
const CRISIS_WORDS = ['죽고싶', '죽고 싶', '자살', '극단적', '살기 싫', '살기싫', '끝내고싶', '사라지고싶']

export function parseComment(raw: string): ParsedComment {
  const text = (raw ?? '').trim()
  const ambiguity: string[] = []

  const result: ParsedComment = {
    year: null,
    month: null,
    day: null,
    hour: null,
    minute: null,
    gender: null,
    calendar: 'solar',
    isLeapMonth: false,
    hourEstimated: false,
    question: null,
    emotionKeywords: [],
    ageBand: null,
    ambiguity,
  }

  if (!text) {
    ambiguity.push('댓글이 비어 있어요.')
    return result
  }

  // ── 1) 음/양력 표기 ───────────────────────────────────────────
  if (/음력|음\s*달|陰曆|음력으로/.test(text)) result.calendar = 'lunar'
  if (/윤\s*달|윤달|閏/.test(text)) result.isLeapMonth = true
  if (/양력|陽曆/.test(text)) result.calendar = 'solar'

  // ── 2) 생년월일 추출 ──────────────────────────────────────────
  const date = extractDate(text, ambiguity)
  result.year = date.year
  result.month = date.month
  result.day = date.day

  // ── 3) 태어난 시각 ────────────────────────────────────────────
  const time = extractTime(text, ambiguity)
  result.hour = time.hour
  result.minute = time.minute
  result.hourEstimated = time.estimated
  if (result.hour === null && /(시간\s*모름|시\s*모름|시간을?\s*몰|태어난\s*시간\s*모름|모릅니다|몰라요)/.test(text)) {
    ambiguity.push('태어난 시각을 모른다고 했어요 → 세 기둥(시주 제외)으로 봅니다.')
  }

  // ── 4) 성별 ───────────────────────────────────────────────────
  result.gender = extractGender(text)
  if (!result.gender) ambiguity.push('성별이 분명하지 않아요(대운 계산에 필요).')

  // ── 5) 나이대(직접 언급) ──────────────────────────────────────
  const ageBand = text.match(/([1-9]\d)\s*대/)
  if (ageBand) result.ageBand = `${ageBand[1]}대`

  // ── 6) 감정 키워드 ────────────────────────────────────────────
  const found = new Set<string>()
  for (const [cat, words] of Object.entries(EMOTION_MAP)) {
    if (words.some((w) => text.includes(w))) found.add(cat)
  }
  result.emotionKeywords = [...found]

  // ── 7) 질문 추출 (마지막 물음표 문장 우선) ────────────────────
  result.question = extractQuestion(text)

  // ── 8) 위기 신호 ──────────────────────────────────────────────
  if (CRISIS_WORDS.some((w) => text.includes(w))) {
    ambiguity.push('⚠️ 위기 신호가 감지됐어요. 답글에 자살예방상담전화 109 안내를 포함하세요.')
  }

  // 날짜를 전혀 못 찾으면 명시
  if (result.year === null || result.month === null || result.day === null) {
    ambiguity.push('생년월일을 완전히 추출하지 못했어요. 직접 보정이 필요합니다.')
  }

  return result
}

// ─────────────────────────────────────────────────────────────────
// 날짜 추출
// ─────────────────────────────────────────────────────────────────
function extractDate(
  text: string,
  ambiguity: string[],
): { year: number | null; month: number | null; day: number | null } {
  // 패턴 A: 1990년 5월 15일 (4자리 연도)
  let m = text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?/)
  if (m) return normalizeDate(+m[1], +m[2], +m[3], ambiguity)

  // 패턴 A2: 85년 3월 2일 (2자리 연도 + 한글)
  m = text.match(/(?<!\d)(\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?/)
  if (m) {
    const yy = +m[1]
    const year = yy <= 25 ? 2000 + yy : 1900 + yy
    ambiguity.push(`연도를 2자리(${m[1]})로 적어 ${year}년으로 추정했어요. 확인해 주세요.`)
    return normalizeDate(year, +m[2], +m[3], ambiguity)
  }

  // 패턴 B: 1990.05.15 / 1990-5-15 / 1990/05/15
  m = text.match(/(\d{4})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/)
  if (m) return normalizeDate(+m[1], +m[2], +m[3], ambiguity)

  // 패턴 C: 900515 / 19900515 (붙여쓴 숫자)
  m = text.match(/(?<!\d)(\d{8})(?!\d)/)
  if (m) {
    const s = m[1]
    return normalizeDate(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8), ambiguity)
  }
  m = text.match(/(?<!\d)(\d{6})(?!\d)/)
  if (m) {
    const s = m[1]
    const yy = +s.slice(0, 2)
    // 2자리 연도: 00~25 → 2000년대 추정, 그 외 1900년대 — 추정이므로 표시
    const year = yy <= 25 ? 2000 + yy : 1900 + yy
    ambiguity.push(`연도를 2자리(${s.slice(0, 2)})로 적어 ${year}년으로 추정했어요. 확인해 주세요.`)
    return normalizeDate(year, +s.slice(2, 4), +s.slice(4, 6), ambiguity)
  }

  // 패턴 D: 월/일만 있고 연도 없음 → 추출 실패로 둠
  return { year: null, month: null, day: null }
}

function normalizeDate(
  year: number,
  month: number,
  day: number,
  ambiguity: string[],
): { year: number | null; month: number | null; day: number | null } {
  if (month < 1 || month > 12) {
    ambiguity.push(`월(${month})이 이상해요. 확인이 필요합니다.`)
    return { year, month: null, day: null }
  }
  if (day < 1 || day > 31) {
    ambiguity.push(`일(${day})이 이상해요. 확인이 필요합니다.`)
    return { year, month, day: null }
  }
  return { year, month, day }
}

// ─────────────────────────────────────────────────────────────────
// 시각 추출
// ─────────────────────────────────────────────────────────────────
const JISI_HOUR: Record<string, number> = {
  자시: 0, 축시: 1, 인시: 3, 묘시: 5, 진시: 7, 사시: 9,
  오시: 11, 미시: 13, 신시: 15, 유시: 17, 술시: 19, 해시: 21,
}

function extractTime(
  text: string,
  ambiguity: string[],
): { hour: number | null; minute: number | null; estimated: boolean } {
  // 지지 시각 (자시/오시 등)
  for (const [k, h] of Object.entries(JISI_HOUR)) {
    if (text.includes(k)) {
      ambiguity.push(`'${k}'(으)로 적어 ${h}시경으로 봤어요(2시간 범위 중앙).`)
      return { hour: h, minute: 0, estimated: true }
    }
  }

  // 오전/오후 + 시(분)
  let m = text.match(/(오전|오후|아침|저녁|밤|새벽|낮)?\s*(\d{1,2})\s*시\s*(?:(\d{1,2})\s*분)?/)
  if (m) {
    let h = +m[2]
    const min = m[3] ? +m[3] : 0
    const ampm = m[1]
    if (ampm === '오후' || ampm === '저녁' || ampm === '밤') {
      if (h < 12) h += 12
    } else if (ampm === '오전' || ampm === '아침' || ampm === '새벽') {
      if (h === 12) h = 0
    } else if (ampm === '낮') {
      if (h < 12) h += 12 > 12 ? 0 : 0 // 낮 1시 → 13
      if (+m[2] < 12 && +m[2] >= 1) h = +m[2] + 12
    }
    if (h > 23 || h < 0) {
      ambiguity.push(`시각(${m[0].trim()})을 해석하기 어려워요. 확인해 주세요.`)
      return { hour: null, minute: null, estimated: false }
    }
    if (!ampm && +m[2] <= 12) {
      ambiguity.push(`오전/오후 표시가 없어 ${h}시로 봤어요. 확인해 주세요.`)
      return { hour: h, minute: min, estimated: true }
    }
    return { hour: h, minute: min, estimated: false }
  }

  // HH:MM
  m = text.match(/(?<!\d)([01]?\d|2[0-3])\s*:\s*([0-5]\d)(?!\d)/)
  if (m) {
    return { hour: +m[1], minute: +m[2], estimated: false }
  }

  // "~쯤/경" 같은 추정 표현
  m = text.match(/(\d{1,2})\s*시\s*(쯤|경|정도)/)
  if (m) {
    const h = +m[1]
    if (h >= 0 && h <= 23) {
      ambiguity.push(`'${m[0].trim()}'(이)라 시각을 추정값으로 봤어요.`)
      return { hour: h, minute: 0, estimated: true }
    }
  }

  return { hour: null, minute: null, estimated: false }
}

// ─────────────────────────────────────────────────────────────────
// 성별 추출
// ─────────────────────────────────────────────────────────────────
function extractGender(text: string): 'male' | 'female' | null {
  const hasFemale = /여자|여성|여아|여아이|딸|엄마|아내|여자입니다|여자에요|여자예요|girl|female|♀/.test(text)
  const hasMale = /남자|남성|남아|남아이|아들|아빠|남편|남자입니다|남자에요|남자예요|male|♂/.test(text)
  // 양쪽 다 언급되면 모호 → null
  if (hasFemale && !hasMale) return 'female'
  if (hasMale && !hasFemale) return 'male'
  return null
}

// ─────────────────────────────────────────────────────────────────
// 질문 추출
// ─────────────────────────────────────────────────────────────────
function extractQuestion(text: string): string | null {
  // 물음표가 포함된 문장 중 마지막 것
  const sentences = text.split(/(?<=[?？.!\n])/).map((s) => s.trim()).filter(Boolean)
  const qs = sentences.filter((s) => /[?？]/.test(s))
  if (qs.length > 0) return qs[qs.length - 1].slice(0, 200)

  // 물음표 없이 "궁금/봐주세요/알고싶" 등
  const m = text.match(/[^.?!\n]*(궁금|봐\s*주|알고\s*싶|여쭤|문의|상담)[^.?!\n]*/)
  if (m) return m[0].trim().slice(0, 200)

  return null
}
