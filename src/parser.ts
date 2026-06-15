/**
 * parser.ts — 유튜브 댓글에서 사주 정보 추출
 *
 * 시청자가 자유 형식으로 남긴 댓글에서
 *  - 생년월일 (양/음력)
 *  - 태어난 시각
 *  - 성별 (남/여)
 *  - 감정 키워드 / 질문 / 직업 언급
 * 을 최대한 추출하고, 애매한 부분은 ambiguity 로 표시한다.
 *
 * 철학: "애매하면 추측하지 않는다." 확실하지 않으면 null + ambiguity 플래그.
 *
 * 출력(parsed) 형태는 프론트엔드(app.js) 및 원본 API 계약과 동일하게 맞춘다:
 *  { found, year, month, day, hour, minute, calendar, gender('남'|'여'),
 *    ageBand('30~40' 형식), name, jobInComment, question,
 *    emotionKeywords(원시 키워드), ambiguity, missingFields, rawText, yearFromTitle }
 */

import type { Calendar } from './saju'

export interface ParsedComment {
  /** 생년월일을 모두 찾았는지 (year+month+day) */
  found: boolean
  year: number | null
  month: number | null
  day: number | null
  /** 0~23 시. null이면 모름 */
  hour: number | null
  minute: number | null
  calendar: Calendar | 'unknown'
  gender: '남' | '여' | null
  /** 나이대 추정 (예: '30~40') — 연도로부터 계산 */
  ageBand: string | null
  /** 이름/호칭 (있으면) */
  name: string | null
  /** 댓글에 언급된 직업 */
  jobInComment: string | null
  /** 추출한 질문 문장(있으면) */
  question: string | null
  /** 감정/관심사 키워드 (원시 단어) */
  emotionKeywords: string[]
  /** 모호/주의 사항 목록 (사람이 확인) */
  ambiguity: string[]
  /** 사주 계산에 부족한 필드(되묻기용) */
  missingFields: string[]
  /** 원문 */
  rawText: string
  /** 음력 윤달 여부 (내부용) */
  isLeapMonth?: boolean
  /** 시각이 추정인지 (내부용) */
  hourEstimated?: boolean
  /** 영상 제목 연도로 연도를 채웠는지 (analyze 단계에서 세팅) */
  yearFromTitle?: boolean
}

/** 감정/관심사 키워드 — 매칭되면 그 단어를 그대로 수집 */
const EMOTION_WORDS = [
  '연애', '사랑', '남자친구', '여자친구', '애인', '짝사랑', '솔로', '재회', '이별', '썸',
  '결혼', '배우자', '혼인', '신랑', '신부', '청혼', '이혼', '재혼',
  '돈', '재물', '금전', '투자', '주식', '코인', '부동산', '빚', '대출', '사업', '재테크',
  '취업', '이직', '직장', '승진', '퇴사', '시험', '합격', '진로', '면접', '창업', '공무원',
  '건강', '병', '수술', '우울', '불안', '스트레스', '몸',
  '가족', '부모', '엄마', '아빠', '자식', '아이', '임신', '출산', '형제', '자녀',
  '친구', '인간관계', '관계', '갈등', '배신',
  '올해', '내년', '대운', '미래', '앞으로', '궁금', '걱정', '막막', '힘들', '답답', '고민',
]

/** 댓글에서 자주 보이는 직업 단어 */
const JOB_WORDS = [
  '회사원', '직장인', '공무원', '교사', '선생님', '간호사', '의사', '약사', '변호사',
  '사업가', '자영업', '프리랜서', '디자이너', '개발자', '엔지니어', '주부', '학생',
  '대학생', '취준생', '군인', '경찰', '소방', '요리사', '미용사', '농부', '작가',
]

/** 위기 신호 키워드 (답글에서 109 안내가 필요할 수 있음) */
const CRISIS_WORDS = ['죽고싶', '죽고 싶', '자살', '극단적', '살기 싫', '살기싫', '끝내고싶', '사라지고싶']

/** 현재 연도 (나이대 계산용) */
const NOW_YEAR = new Date().getFullYear()

export function parseComment(raw: string): ParsedComment {
  const text = (raw ?? '').trim()
  const ambiguity: string[] = []

  const result: ParsedComment = {
    found: false,
    year: null,
    month: null,
    day: null,
    hour: null,
    minute: null,
    calendar: 'unknown',
    gender: null,
    ageBand: null,
    name: null,
    jobInComment: null,
    question: null,
    emotionKeywords: [],
    ambiguity,
    missingFields: [],
    rawText: text,
    isLeapMonth: false,
    hourEstimated: false,
  }

  if (!text) {
    ambiguity.push('댓글이 비어 있어요.')
    result.missingFields = ['태어난 연도(몇 년생)', '태어난 월', '태어난 일']
    return result
  }

  // ── 1) 음/양력 표기 ───────────────────────────────────────────
  let calendarMentioned = false
  if (/음력|음\s*달|陰曆/.test(text)) { result.calendar = 'lunar'; calendarMentioned = true }
  if (/윤\s*달|윤달|閏/.test(text)) result.isLeapMonth = true
  if (/양력|陽曆/.test(text)) { result.calendar = 'solar'; calendarMentioned = true }

  // ── 2) 생년월일 추출 ──────────────────────────────────────────
  const date = extractDate(text, ambiguity)
  result.year = date.year
  result.month = date.month
  result.day = date.day

  // 날짜를 하나라도 찾았는데 음/양 표기가 없으면 양력 가정
  if (!calendarMentioned) {
    result.calendar = 'solar'
    if (date.year || date.month || date.day) {
      ambiguity.push('양력/음력 미표기 — 양력으로 가정함')
    }
  }

  // ── 3) 태어난 시각 ────────────────────────────────────────────
  const time = extractTime(text, ambiguity)
  result.hour = time.hour
  result.minute = time.minute
  result.hourEstimated = time.estimated

  // ── 4) 성별 (남/여) ───────────────────────────────────────────
  result.gender = extractGender(text)

  // ── 5) 나이대 — 연도로부터 10년 구간 계산 (예: 1990 → '30~40') ─
  if (result.year) {
    const age = NOW_YEAR - result.year
    if (age >= 0 && age < 120) {
      const lo = Math.floor(age / 10) * 10
      result.ageBand = `${lo}~${lo + 10}`
    }
  } else {
    // 직접 '30대' 언급이 있으면 그것을 사용
    const band = text.match(/([1-9]\d)\s*대/)
    if (band) {
      const lo = parseInt(band[1], 10)
      result.ageBand = `${lo}~${lo + 10}`
    }
  }

  // ── 6) 직업 언급 ──────────────────────────────────────────────
  for (const j of JOB_WORDS) {
    if (text.includes(j)) { result.jobInComment = j; break }
  }

  // ── 7) 감정/관심사 키워드 (원시 단어, 중복 제거, 최대 6개) ─────
  const found: string[] = []
  for (const w of EMOTION_WORDS) {
    if (text.includes(w) && !found.includes(w)) found.push(w)
    if (found.length >= 6) break
  }
  result.emotionKeywords = found

  // ── 8) 질문 추출 (마지막 물음표 문장 우선) ────────────────────
  result.question = extractQuestion(text)

  // ── 9) 위기 신호 ──────────────────────────────────────────────
  if (CRISIS_WORDS.some((w) => text.includes(w))) {
    ambiguity.push('⚠️ 위기 신호가 감지됐어요. 답글에 자살예방상담전화 109 안내를 포함하세요.')
  }

  // ── 10) found / missingFields 계산 ────────────────────────────
  const missing: string[] = []
  if (!result.year) missing.push('태어난 연도(몇 년생)')
  if (!result.month) missing.push('태어난 월')
  if (!result.day) missing.push('태어난 일')
  result.missingFields = missing
  result.found = missing.length === 0

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
  //   "년"과 "월" 사이에 음력/양력 등 다른 글자가 끼어 있어도 잡도록
  //   사이에 '월'이 아닌 글자(공백·한글 등)를 0~6자 허용한다.
  //   예: "1971년 음력 10월 8일"
  let m = text.match(/(\d{4})\s*년\s*[^\d월]{0,6}?(\d{1,2})\s*월\s*(\d{1,2})\s*일?/)
  if (m) return normalizeDate(+m[1], +m[2], +m[3], ambiguity)

  // 패턴 A2: 85년 3월 2일 (2자리 연도 + 한글)
  //   마찬가지로 "년"과 "월" 사이 음력/양력 등 허용. 예: "71년 음력11월 6일"
  m = text.match(/(?<!\d)(\d{2})\s*년\s*[^\d월]{0,6}?(\d{1,2})\s*월\s*(\d{1,2})\s*일?/)
  if (m) {
    const yy = +m[1]
    const year = yy <= 25 ? 2000 + yy : 1900 + yy
    ambiguity.push(`연도를 2자리(${m[1]})로 적어 ${year}년으로 추정했어요. 확인해 주세요.`)
    return normalizeDate(year, +m[2], +m[3], ambiguity)
  }

  // 패턴 B: 1990.05.15 / 1990-5-15 / 1990/05/15
  m = text.match(/(\d{4})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/)
  if (m) return normalizeDate(+m[1], +m[2], +m[3], ambiguity)

  // 패턴 C: 19900515 (붙여쓴 8자리)
  m = text.match(/(?<!\d)(\d{8})(?!\d)/)
  if (m) {
    const s = m[1]
    return normalizeDate(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8), ambiguity)
  }
  // 패턴 C2: 900515 (붙여쓴 6자리)
  m = text.match(/(?<!\d)(\d{6})(?!\d)/)
  if (m) {
    const s = m[1]
    const yy = +s.slice(0, 2)
    const year = yy <= 25 ? 2000 + yy : 1900 + yy
    ambiguity.push(`연도를 2자리(${s.slice(0, 2)})로 적어 ${year}년으로 추정했어요. 확인해 주세요.`)
    return normalizeDate(year, +s.slice(2, 4), +s.slice(4, 6), ambiguity)
  }

  // 패턴 D: 연도 없이 "5월 15일"만 → 월·일만 추출 (연도는 null → 영상연도 폴백 대상)
  m = text.match(/(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/)
  if (m) {
    const month = +m[1]
    const day = +m[2]
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year: null, month, day }
    }
  }

  // 패턴 D2: 연도 없이 "4.12" / "4-12" / "4/12" (점·하이픈·슬래시 월·일)
  //   "4.12음력 아침6~7시생" 같은 댓글을 잡는다. 오탐을 줄이기 위해
  //   출생 맥락 단어(생/태어/음력/양력/시/때)가 댓글에 함께 있을 때만 월·일로 인정한다.
  //   또 시각(6~7시)·소수와 헷갈리지 않게 '시'·':'·추가 숫자가 바로 뒤따르지 않는
  //   1~12 / 1~31 조합만 받는다.
  if (/(생|태어|태여|음력|양력|시|때)/.test(text)) {
    m = text.match(/(?<![\d.])(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?!\s*[.\-\/:]?\s*\d)(?!\s*시)/)
    if (m) {
      const month = +m[1]
      const day = +m[2]
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        ambiguity.push(`'${m[0].trim()}'을(를) ${month}월 ${day}일로 봤어요.`)
        return { year: null, month, day }
      }
    }
  }

  // 패턴 E: 연도만 — "1990년생", "69년생", "69년 생" (월·일 없음 → guide 유도)
  //   "저 69년생 닭띠 여자예요" 처럼 연도만 있는 경우를 잡는다.
  //   4자리 연도 우선.
  m = text.match(/(?<!\d)(19\d{2}|20\d{2})\s*년\s*생/)
  if (m) {
    return { year: +m[1], month: null, day: null }
  }
  // 2자리 연도 + 년생 (예: 69년생)
  m = text.match(/(?<!\d)(\d{2})\s*년\s*생/)
  if (m) {
    const yy = +m[1]
    const year = yy <= 25 ? 2000 + yy : 1900 + yy
    ambiguity.push(`연도를 2자리(${m[1]})로 적어 ${year}년으로 추정했어요. 확인해 주세요.`)
    return { year, month: null, day: null }
  }

  // 폴백: 위 결합 패턴이 모두 실패했지만 텍스트 어딘가에 "○○○○년"/"○○년"이
  //   있으면 연도만 따로 잡고, 월·일은 독립 패턴으로 채운다.
  //   "71년  음력  10월 08일" 처럼 사이 간격이 넓거나 글자가 많이 끼어든 경우 대비.
  {
    let year: number | null = null
    const y4 = text.match(/(?<!\d)(19\d{2}|20\d{2})\s*년/)
    if (y4) {
      year = +y4[1]
    } else {
      const y2 = text.match(/(?<!\d)(\d{2})\s*년(?!\s*(?:전|후|째|간|동안))/)
      if (y2) {
        const yy = +y2[1]
        year = yy <= 25 ? 2000 + yy : 1900 + yy
        ambiguity.push(`연도를 2자리(${y2[1]})로 적어 ${year}년으로 추정했어요. 확인해 주세요.`)
      }
    }
    if (year != null) {
      // 월·일 독립 추출 ("음력10월08일" 등)
      const md = text.match(/(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/)
      if (md) {
        const month = +md[1]
        const day = +md[2]
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          return normalizeDate(year, month, day, ambiguity)
        }
      }
      // 월만 있고 일이 없는 경우: 연도+월만이라도 살린다(일은 null → guide/3주 유도)
      const mo = text.match(/(?<!\d)(\d{1,2})\s*월(?!\s*\d)/)
      if (mo) {
        const month = +mo[1]
        if (month >= 1 && month <= 12) {
          return { year, month, day: null }
        }
      }
      // 월·일 모두 없으면 연도만
      return { year, month: null, day: null }
    }
  }

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
    // 분이 명시되지 않으면 null 유지 (원본 계약)
    const min = m[3] ? +m[3] : null
    const ampm = m[1]
    if (ampm === '오후' || ampm === '저녁' || ampm === '밤') {
      if (h < 12) h += 12
    } else if (ampm === '오전' || ampm === '아침' || ampm === '새벽') {
      if (h === 12) h = 0
    } else if (ampm === '낮') {
      if (+m[2] < 12 && +m[2] >= 1) h = +m[2] + 12
    }
    if (h > 23 || h < 0) {
      ambiguity.push(`시각(${m[0].trim()})을 해석하기 어려워요. 확인해 주세요.`)
      return { hour: null, minute: null, estimated: false }
    }
    // 오전/오후 표시가 없으면 24시간제로 그대로 해석한다.
    //   (예: "5시"=오전 5시, "17시"=오후 5시) → 되묻지 않고 확정값으로 사용.
    if (!ampm) {
      return { hour: h, minute: min, estimated: false }
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
// 성별 추출 (남/여)
// ─────────────────────────────────────────────────────────────────
function extractGender(text: string): '남' | '여' | null {
  const hasFemale = /여자|여성|여아|딸|아내|와이프|여자입니다|여자에요|여자예요|female|♀/.test(text)
  const hasMale = /남자|남성|남아|아들|남편|남자입니다|남자에요|남자예요|male|♂/.test(text)
  if (hasFemale && !hasMale) return '여'
  if (hasMale && !hasFemale) return '남'
  return null
}

// ─────────────────────────────────────────────────────────────────
// 질문 추출
// ─────────────────────────────────────────────────────────────────
function extractQuestion(text: string): string | null {
  const sentences = text.split(/(?<=[?？.!\n])/).map((s) => s.trim()).filter(Boolean)
  const qs = sentences.filter((s) => /[?？]/.test(s))
  if (qs.length > 0) return qs[qs.length - 1].slice(0, 200)

  const m = text.match(/[^.?!\n]*(궁금|봐\s*주|알고\s*싶|여쭤|문의|상담)[^.?!\n]*/)
  if (m) return m[0].trim().slice(0, 200)

  return null
}
