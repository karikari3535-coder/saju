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
  /**
   * 시청자가 사주 네 기둥을 간지(干支)로 직접 적어준 경우(예: '경술.신사.계사.계해').
   * 일주(day)가 있으면 saju 계산을 날짜 대신 이 간지로 바로 한다.
   * 없으면 null.
   */
  pillars?: GanjiPillars | null
}

/** 간지 한글 2글자 기둥 (예: '경술'). 모르면 null */
export interface GanjiPillars {
  year: string | null
  month: string | null
  day: string | null
  hour: string | null
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
    pillars: null,
  }

  if (!text) {
    ambiguity.push('댓글이 비어 있어요.')
    result.missingFields = ['태어난 연도(몇 년생)', '태어난 월', '태어난 일']
    return result
  }

  // ── 0) 간지(干支) 사주 네 기둥 직접 입력 인식 ──────────────────
  //   예: "경술.신사.계사.계해 여성" / "경술 신사 계사 계해"
  //   시청자가 사주를 간지로 이미 계산해서 적어준 경우. 날짜보다 먼저 본다.
  const pillars = extractGanjiPillars(text)
  if (pillars) {
    result.pillars = pillars
    // 성별·시각·질문·감정은 아래 공통 로직에서 계속 채운다.
    result.gender = extractGender(text)
    result.question = extractQuestion(text)
    const foundEmotion: string[] = []
    for (const w of EMOTION_WORDS) {
      if (text.includes(w) && !foundEmotion.includes(w)) foundEmotion.push(w)
      if (foundEmotion.length >= 6) break
    }
    result.emotionKeywords = foundEmotion
    if (CRISIS_WORDS.some((w) => text.includes(w))) {
      ambiguity.push('⚠️ 위기 신호가 감지됐어요. 답글에 자살예방상담전화 109 안내를 포함하세요.')
    }
    // 간지로 사주가 확정되므로 되묻기 대상이 아니다.
    result.found = true
    result.missingFields = []
    const pieces = [pillars.year, pillars.month, pillars.day, pillars.hour].filter(Boolean)
    ambiguity.push(`사주 네 기둥을 간지(${pieces.join('·')})로 직접 적어주셔서 그대로 풀었어요.`)
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

  // 패턴 A1b: "72년1015일생" / "1972년1015생" — 연도('X년') 뒤에 구분자 없이
  //   월·일을 3~4자리로 붙여 쓰고 '일생'/'생'으로 끝나는 형태.
  //   "1015" → 10월 15일, "315" → 3월 15일, "0315" → 3월 15일.
  //   4자리: MMDD, 3자리: MDD 로 해석한다. 월 1~12 / 일 1~31 검증.
  //   4자리 연도 우선.
  {
    const tryConcatMD = (
      year: number,
      digits: string,
      yearLabel: string | null,
    ): { year: number; month: number; day: number } | null => {
      let mo: number, da: number
      if (digits.length === 4) {
        mo = +digits.slice(0, 2)
        da = +digits.slice(2, 4)
      } else if (digits.length === 3) {
        mo = +digits.slice(0, 1)
        da = +digits.slice(1, 3)
      } else {
        return null
      }
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        if (yearLabel) {
          ambiguity.push(`연도를 2자리(${yearLabel})로 적어 ${year}년으로 추정했어요. 확인해 주세요.`)
        }
        ambiguity.push(`'${digits}'을(를) ${mo}월 ${da}일로 봤어요. 확인해 주세요.`)
        return { year, month: mo, day: da }
      }
      return null
    }
    // 4자리 연도 + 붙은 월일(3~4자리) + (선택)일/생
    let mc = text.match(/(?<!\d)(19\d{2}|20\d{2})\s*년\s*(\d{3,4})\s*일?\s*생/)
    if (!mc) mc = text.match(/(?<!\d)(19\d{2}|20\d{2})\s*년\s*(\d{3,4})\s*일/)
    if (mc) {
      const r = tryConcatMD(+mc[1], mc[2], null)
      if (r) return r
    }
    // 2자리 연도 + 붙은 월일(3~4자리) + (선택)일/생
    let mc2 = text.match(/(?<!\d)(\d{2})\s*년\s*(\d{3,4})\s*일?\s*생/)
    if (!mc2) mc2 = text.match(/(?<!\d)(\d{2})\s*년\s*(\d{3,4})\s*일/)
    if (mc2) {
      const yy = +mc2[1]
      const year = yy <= 25 ? 2000 + yy : 1900 + yy
      const r = tryConcatMD(year, mc2[2], mc2[1])
      if (r) return r
    }
  }

  // 패턴 A3: 혼합형 — "69년.4.17" / "1990년.5.15" (연도는 'X년', 월·일은 점·하이픈·슬래시)
  //   "69년.4.17(음력)" 처럼 연도 뒤에 점으로 월·일을 구분한 경우.
  //   4자리 연도 우선.
  m = text.match(/(?<!\d)(\d{4})\s*년\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/)
  if (m) return normalizeDate(+m[1], +m[2], +m[3], ambiguity)
  // 2자리 연도 + 'X년' + 점 구분 월·일
  m = text.match(/(?<!\d)(\d{2})\s*년\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/)
  if (m) {
    const yy = +m[1]
    const year = yy <= 25 ? 2000 + yy : 1900 + yy
    ambiguity.push(`연도를 2자리(${m[1]})로 적어 ${year}년으로 추정했어요. 확인해 주세요.`)
    return normalizeDate(year, +m[2], +m[3], ambiguity)
  }

  // 패턴 B: 1990.05.15 / 1990-5-15 / 1990/05/15
  m = text.match(/(\d{4})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/)
  if (m) return normalizeDate(+m[1], +m[2], +m[3], ambiguity)

  // 패턴 B3: 공백 구분 "1970 02 09" / "1970 2 9" (4자리 연도 + 공백 + 월 + 공백 + 일)
  //   "1970 02 09 음력 조자시 여자" 처럼 구분자 없이 공백으로만 연·월·일을 나눈 경우.
  //   오탐 방지: 월 1~12, 일 1~31 범위를 만족할 때만 인정한다.
  m = text.match(/(?<!\d)(19\d{2}|20\d{2})\s+(\d{1,2})\s+(\d{1,2})(?!\s*\d)/)
  if (m) {
    const mo = +m[2]
    const da = +m[3]
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      return normalizeDate(+m[1], mo, da, ambiguity)
    }
  }
  // 패턴 B3-2: 공백 구분 2자리 연도 "70 02 09" — 출생 맥락이 있을 때만(오탐 최소화)
  if (/(생|태어|태여|음력|양력|시|띠|여자|남자|재물|운)/.test(text)) {
    m = text.match(/(?<!\d)(\d{2})\s+(\d{1,2})\s+(\d{1,2})(?!\s*\d)/)
    if (m) {
      const mo = +m[2]
      const da = +m[3]
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        const yy = +m[1]
        const year = yy <= 25 ? 2000 + yy : 1900 + yy
        ambiguity.push(`연도를 2자리(${m[1]})로 적어 ${year}년으로 추정했어요. 확인해 주세요.`)
        return normalizeDate(year, mo, da, ambiguity)
      }
    }
  }

  // 패턴 B2: 76.04.12 / 76-4-12 / 76/04/12 (2자리 연도 + 구분자 2개)
  //   "76.04.12생" 처럼 점·하이픈·슬래시로 연·월·일을 모두 구분한 경우.
  //   구분자가 반드시 2개(세 묶음)여야 하므로 월·일만 있는 "4.12"와는 겹치지 않는다.
  //   첫 묶음이 2자리(연도)일 때만 적용 → 4자리는 위 패턴 B가 이미 처리.
  m = text.match(/(?<!\d)(\d{2})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?!\s*[.\-\/]?\s*\d)/)
  if (m) {
    const yy = +m[1]
    const year = yy <= 25 ? 2000 + yy : 1900 + yy
    ambiguity.push(`연도를 2자리(${m[1]})로 적어 ${year}년으로 추정했어요. 확인해 주세요.`)
    return normalizeDate(year, +m[2], +m[3], ambiguity)
  }

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
      //   단, "지금 6월 중순", "7월초", "6월까지" 처럼 출생이 아닌 '현재 시점/기간'을
      //   가리키는 월을 출생월로 오인하면 안 된다. 그런 정황의 월은 건너뛴다.
      //   텍스트 안의 모든 'N월' 후보를 보고, 출생월로 볼 수 없는 건 제외한다.
      const monthRe = /(?<!\d)(\d{1,2})\s*월/g
      let mob: RegExpExecArray | null
      while ((mob = monthRe.exec(text)) !== null) {
        const month = +mob[1]
        if (month < 1 || month > 12) continue
        // 'N월' 바로 뒤에 숫자(N월N… → 위에서 처리됨)면 건너뜀
        const after = text.slice(mob.index + mob[0].length, mob.index + mob[0].length + 8)
        const before = text.slice(Math.max(0, mob.index - 6), mob.index)
        // 현재 시점/기간 표현이 붙으면 출생월이 아님
        if (/^(중순|초순|초|말|말일|경|까지|부터|쯤|달|에는|에|중|안|내)/.test(after.trim())) continue
        if (/(지금|현재|올해|이번|다음|내년|작년|오는|요즘|최근)\s*$/.test(before)) continue
        // 살아남은 첫 번째 월만 출생월 후보로 채택
        return { year, month, day: null }
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

// ─────────────────────────────────────────────────────────────────
// 간지(干支) 사주 기둥 추출
// ─────────────────────────────────────────────────────────────────

/** 천간 10 / 지지 12 (한글) */
const STEMS_KO = ['갑', '을', '병', '정', '무', '기', '경', '신', '임', '계']
const BRANCHES_KO = ['자', '축', '인', '묘', '진', '사', '오', '미', '신', '유', '술', '해']

/**
 * "경술.신사.계사.계해 여성" 같은 댓글에서 사주 네(또는 세) 기둥의 간지를 추출한다.
 *
 * 인식 규칙:
 *  - 천간 1글자 + 지지 1글자로 된 유효한 간지("경술")가
 *    구분자(점·공백·쉼표·가운뎃점)로 이어 3개 이상 연달아 나올 때만 사주 기둥으로 본다.
 *  - 3개면 연·월·일주, 4개면 연·월·일·시주로 본다.
 *    (간지 사주는 보통 연→월→일→시 순서로 적는다.)
 *  - 2개 이하의 우연한 간지(예: '신사'='辛巳'가 문장 일부)는 오탐 방지를 위해 무시.
 *
 * @returns 기둥 객체(일주는 항상 존재). 사주 간지로 보이지 않으면 null.
 */
function extractGanjiPillars(text: string): GanjiPillars | null {
  // 간지 한 개 = 천간+지지. 전역으로 위치까지 함께 스캔한다.
  const stemClass = STEMS_KO.join('')
  const branchClass = BRANCHES_KO.join('')
  const ganjiRe = new RegExp(`[${stemClass}][${branchClass}]`, 'g')

  // 본문에서 간지 토큰과 그 위치를 모은다.
  const tokens: { ganji: string; index: number }[] = []
  let mm: RegExpExecArray | null
  while ((mm = ganjiRe.exec(text)) !== null) {
    tokens.push({ ganji: mm[0], index: mm.index })
  }
  if (tokens.length < 3) return null

  // 연속(인접) 간지 묶음 중 가장 긴 것을 찾는다.
  //   토큰 사이에 구분자(점·공백·쉼표·가운뎃점·하이픈·슬래시)만 있을 때 "연속"으로 본다.
  let best: { ganji: string; index: number }[] = []
  let run: { ganji: string; index: number }[] = [tokens[0]]
  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1]
    const cur = tokens[i]
    // 두 간지 사이의 글자
    const between = text.slice(prev.index + 2, cur.index)
    if (/^[\s.,·ㆍ\-\/]*$/.test(between)) {
      run.push(cur)
    } else {
      if (run.length > best.length) best = run
      run = [cur]
    }
  }
  if (run.length > best.length) best = run

  if (best.length < 3) return null

  // 최대 4개까지만 기둥으로 사용 (연·월·일·시)
  const ganjis = best.slice(0, 4).map((t) => t.ganji)

  if (ganjis.length === 3) {
    // 연·월·일주 (시주 없음)
    return { year: ganjis[0], month: ganjis[1], day: ganjis[2], hour: null }
  }
  // 4개: 연·월·일·시주
  return { year: ganjis[0], month: ganjis[1], day: ganjis[2], hour: ganjis[3] }
}
