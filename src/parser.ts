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
  /**
   * 비판·시비·AI 여부 추궁 등 "사람이 직접 답해야 하는" 댓글이면 true.
   * (예: "이거 AI냐?", "계산 틀렸다", "사기 아니냐" 등)
   * true면 AI 답글을 자동 생성하지 않고 사장님 검토로 분리한다.
   */
  reviewNeeded?: boolean
  /** reviewNeeded가 true일 때 그 사유(사장님 안내용) */
  reviewReason?: string | null
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

/**
 * "사람이 직접 답해야 하는" 댓글(비판·시비·AI 추궁·계산오류 지적 등) 감지.
 *   AI가 어설프게 답하면 오히려 분란을 키우므로, 이런 댓글은 자동 답글을 만들지 않고
 *   "검토 필요(사장님 직접 답변 권장)"로 따로 분리한다.
 *   @returns 감지되면 그 사유 문자열, 아니면 null
 */
export function detectReviewNeeded(raw: string): string | null {
  const text = (raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (!text) return null

  // 1) AI 여부 추궁 — "이거 AI냐?", "ai가 쓴거 아니냐", "챗gpt", "복붙" 등
  const aiSuspicion =
    /\bai\b/.test(text) ||
    /에이아이|인공지능|챗\s*gpt|챗지피티|chatgpt|gpt|봇이|기계가|로봇이|자동\s*답글|복붙|복사\s*붙여|돌려막기|템플릿/.test(
      raw,
    )
  if (aiSuspicion) {
    return 'AI/자동응답 여부를 묻거나 의심하는 댓글이에요. 사장님이 직접 답하시는 게 좋아요.'
  }

  // 2) 계산·풀이 오류 지적 — "틀렸다", "잘못됐다", "아니지", "오류", "엉터리"
  //   ※ "안 맞다"(궁합·직업이 안 맞다 등)는 정상 사주 상담에서도 흔하므로 제외.
  const errorClaim =
    /틀렸|틀린|잘못\s*됐|잘못\s*된|잘못\s*됨|엉터리|말이\s*안\s*되|아니지|아니잖|어디서\s*배운|제대로\s*좀|공부\s*좀|모르면|풀이가?\s*이상|계산\s*(?:이|을)?\s*(?:틀|잘못|이상)/.test(
      raw,
    )
  if (errorClaim) {
    return '사주 풀이가 틀렸다고 지적하는 댓글이에요. 사장님이 직접 확인 후 답하시는 게 좋아요.'
  }

  // 3) 사기·불신·비난 — "사기", "돈벌이", "믿지마", "장사", "혹세무민", "신뢰"
  //   ※ "신뢰가 간다"(긍정)와 충돌하지 않도록 '신뢰가' 단독은 제외, '신뢰 안 간다'류만.
  //   '사기충천'(긍정어)는 오탐 방지로 제외.
  //   ★ '사기' 단어가 있어도 "사기를 당한 피해자"(상담 사연)는 불신·비난이 아니다.
  //     예: "4월에 사기도 당했네요", "사기 당해서 힘들어요", "사기 피해 봤어요"
  //     이런 경우는 정상 사주 상담 사연이므로 review로 빼면 안 된다(답글이 안 만들어짐).
  const sagiVictim =
    /사기\s*(?:를|도|당|피해|맞|쳤|쳐|꾼\s*한테|꾼\s*에게)?\s*(?:당했|당함|당해|당하|맞았|맞아|쳤|쳐|봤|보았|입었|피해|때문)/.test(
      raw,
    ) || /사기\s*(?:를|도)?\s*(?:당|피해|맞|쳤)/.test(raw)
  const sagiAccusation = /사기/.test(raw) && !/사기\s*충천/.test(raw) && !sagiVictim
  // '사기꾼' 단독 비난도 피해자 맥락이면 제외(예: "사기꾼한테 당했어요")
  const sagikkunAccusation = /사기꾼/.test(raw) && !sagiVictim
  const distrust =
    sagiAccusation ||
    sagikkunAccusation ||
    /혹세무민|돈벌이|돈\s*벌려|미신|사이비|구라|거짓말|믿지\s*마|믿을\s*수\s*없|신뢰\s*안|신뢰\s*(?:가|는)?\s*안|양심\s*(?:이|은)?\s*없|부끄러운\s*줄/.test(
      raw,
    )
  if (distrust) {
    return '불신·비난성 댓글이에요. 사장님이 직접 대응 방향을 정하시는 게 좋아요.'
  }

  // 4) 노골적 욕설·비방
  const insult = /시발|씨발|ㅅㅂ|개소리|병신|ㅄ|꺼져|닥쳐|미친|또라이|등신|멍청/.test(raw)
  if (insult) {
    return '공격적·욕설 댓글이에요. 사장님이 직접 판단하시는 게 좋아요.'
  }

  return null
}

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
    reviewNeeded: false,
    reviewReason: null,
  }

  // 비판·시비·AI 추궁 등은 사람이 직접 답해야 하므로 표시만 해 둔다.
  //   (사주 단서가 같이 있어도 우선 사장님 검토 대상으로 분리한다.)
  const reviewReason = detectReviewNeeded(text)
  if (reviewReason) {
    result.reviewNeeded = true
    result.reviewReason = reviewReason
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
  //   "음력"/"음달" 외에도 날짜 옆 괄호 단독 표기 "(음)" / "( 음 )" / "[음]" 도 음력으로 인식한다.
  //   (단독 "음"은 마음·처음·다음 등 오탐이 많으므로, 괄호로 감싼 경우만 인정)
  //   추가: "73.음.10.19" 처럼 점/공백/슬래시로 앞뒤가 구분된 단독 "음"/"양"도 인정한다.
  //   (숫자 사이에 구분자로 낀 형태라 마음·처음 등과 헷갈릴 위험이 낮음)
  let calendarMentioned = false
  if (/음력|음\s*달|陰曆|[(（[]\s*음\s*[)）\]]|[.\-\/\s]음[.\-\/\s]/.test(text)) { result.calendar = 'lunar'; calendarMentioned = true }
  if (/윤\s*달|윤달|閏/.test(text)) result.isLeapMonth = true
  if (/양력|陽曆|[(（[]\s*양\s*[)）\]]|[.\-\/\s]양[.\-\/\s]/.test(text)) { result.calendar = 'solar'; calendarMentioned = true }

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
// 한글(한자식) 숫자 → 정수 변환 (1~31 범위, 날짜용)
//   "이십육"=26, "십"=10, "이십"=20, "삼십일"=31, "육"=6, "일"=1 …
//   어르신 시청자들이 "유월이십육일"처럼 한글 숫자로 날짜를 쓰는 경우 대비.
// ─────────────────────────────────────────────────────────────────
const SINO_DIGIT: Record<string, number> = {
  일: 1, 이: 2, 삼: 3, 사: 4, 오: 5,
  육: 6, 칠: 7, 팔: 8, 구: 9,
}
/** "이십육"→26, "십"→10, "삼십"→30, "이십"→20, "구"→9, "삼십일"→31. 실패 시 null. */
function koreanNumToInt(s: string): number | null {
  const str = (s ?? '').trim()
  if (!str) return null
  // 순수 숫자가 섞여 들어오면 그대로 사용
  if (/^\d+$/.test(str)) {
    const n = +str
    return n >= 1 && n <= 31 ? n : null
  }
  // 허용 글자만으로 구성되었는지 확인 (일이삼사오육칠팔구십)
  if (!/^[일이삼사오육칠팔구십]+$/.test(str)) return null
  const idx = str.indexOf('십')
  let value: number
  if (idx === -1) {
    // 십이 없음 → 한 자리(또는 단독)
    value = SINO_DIGIT[str] ?? NaN
  } else {
    const tensPart = str.slice(0, idx) // 십 앞 (없으면 1)
    const onesPart = str.slice(idx + 1) // 십 뒤 (없으면 0)
    const tens = tensPart ? (SINO_DIGIT[tensPart] ?? NaN) : 1
    const ones = onesPart ? (SINO_DIGIT[onesPart] ?? NaN) : 0
    value = tens * 10 + ones
  }
  if (!Number.isFinite(value) || value < 1 || value > 31) return null
  return value
}

// 월(月) 한글 표기 → 숫자. 유월(6)·시월(10)은 불규칙(육월/십월 아님)이라 별도 매핑.
//   정월=1, 동짓달=11, 섣달=12 같은 전통 표현도 함께 인식.
const KOREAN_MONTH: Record<string, number> = {
  정월: 1, 일월: 1,
  이월: 2, 삼월: 3, 사월: 4, 오월: 5,
  유월: 6, 육월: 6, // 표준은 '유월'이지만 '육월'로 쓰는 경우도 받음
  칠월: 7, 팔월: 8, 구월: 9,
  시월: 10, 십월: 10, // 표준은 '시월'이지만 '십월'로 쓰는 경우도 받음
  십일월: 11, 동짓달: 11, 동지달: 11,
  십이월: 12, 섣달: 12,
}

// ─────────────────────────────────────────────────────────────────
// 날짜 추출
// ─────────────────────────────────────────────────────────────────
/**
 * 날짜 맥락의 흔한 '월' 오타를 교정한다.
 *   - "6위 20일" → "6월 20일"  ('월'을 인접 자판 '위'로 오타)
 *   - "6워 20일" → "6월 20일"  ('월' → '워')
 *   - "6올 20일" → "6월 20일"  ('월' → '올')
 *   ※ 반드시 "숫자 + (위/워/올) + (공백) + 숫자 + 일" 처럼 '날짜로밖에 볼 수 없는' 맥락에서만 교정한다.
 *     단독 '위/워/올'(예: "위에서", "워킹맘", "올해")은 절대 건드리지 않는다.
 *   ※ 원본 text는 손대지 않고, 날짜 추출에 쓰는 사본에만 적용한다.
 */
function normalizeMonthTypos(text: string): string {
  let t = text
  // (가) 연도 + 숫자 + (위/워/올) + 숫자 + 일   예: "1980년 6위 20일"
  t = t.replace(
    /(\d{1,4}\s*년\s*[^\d월위워올]{0,6}?\d{1,2})\s*[위워올](\s*\d{1,2}\s*일)/g,
    '$1월$2',
  )
  // (나) 숫자 + (위/워/올) + 숫자 + 일   예: "6위 20일" (연도 없이)
  t = t.replace(/(\d{1,2})\s*[위워올](\s*\d{1,2}\s*일)/g, '$1월$2')
  return t
}

function extractDate(
  textRaw: string,
  ambiguity: string[],
): { year: number | null; month: number | null; day: number | null } {
  // 날짜 맥락의 '월' 오타(위/워/올)를 먼저 교정한 사본으로 추출한다.
  const text = normalizeMonthTypos(textRaw)
  if (text !== textRaw) {
    ambiguity.push(
      `'월'을 다른 글자로 잘못 적으신 듯해 '월'로 보고 풀었어요(예: "6위"→"6월"). 혹시 다르면 알려주세요.`,
    )
  }
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

  // 패턴 A1c: 연도와 떨어진 "429일" / "1015일" — 3~4자리 숫자에 '일'만 붙인 월·일.
  //   "63년운세429일 새벽"처럼 '년'과 월·일 사이에 다른 글자('운세')가 끼어
  //   A1b(연도 바로 뒤)로는 못 잡는 경우를 보완한다.
  //   "429"→4월29일(MDD), "1015"→10월15일(MMDD). 월 1~12·일 1~31만 인정.
  //   오탐 방지: 출생 맥락(생/태어/음력/양력/시/새벽/띠/여자/남자/운세/운) 또는
  //   댓글에 '○○년'이 함께 있을 때만 월·일로 본다(예: "100일 잔치"는 배제).
  if (/(생|태어|태여|음력|양력|시|새벽|아침|저녁|밤|낮|정오|띠|여자|남자|운세|운)/.test(text)
      || /\d{2,4}\s*년/.test(text)) {
    const mc3 = text.match(/(?<!\d)(\d{3,4})\s*일(?!\s*\d)/)
    if (mc3) {
      const digits = mc3[1]
      let mo: number, da: number
      if (digits.length === 4) { mo = +digits.slice(0, 2); da = +digits.slice(2, 4) }
      else { mo = +digits.slice(0, 1); da = +digits.slice(1, 3) }
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        ambiguity.push(`'${digits}일'을(를) ${mo}월 ${da}일로 봤어요. 혹시 다르면 알려주세요.`)
        return { year: null, month: mo, day: da }
      }
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

  // 패턴 B: 1990.05.15 / 1990-5-15 / 1990/05/15 / 1969~10~21 / 1990,5,15 (쉼표 구분 포함)
  //   구분자에 틸드(~)·전각 물결(～·〜)·쉼표(,／，)·가운뎃점(·ㆍ)도 허용한다.
  //   (예: "1969~10~21 아침 10시" → 연1969 월10 일21 / "1990,5,15" → 연1990 월5 일15)
  m = text.match(/(\d{4})\s*[.\-\/~～〜,，·ㆍ]\s*(\d{1,2})\s*[.\-\/~～〜,，·ㆍ]\s*(\d{1,2})/)
  if (m) return normalizeDate(+m[1], +m[2], +m[3], ambiguity)

  // 패턴 B1: 연·월·일 사이에 음/양력 표기가 낀 점 구분형 — "73.음.10.19" / "73.양.10.19" / "1973.음력.10.19"
  //   연도(2~4자리) 뒤에 (음|양|음력|양력)이 구분자로 끼고, 그 뒤 월·일이 점/하이픈/슬래시/공백으로 구분된 경우.
  //   (달력 종류는 위 1) 단계에서 이미 감지됨)
  m = text.match(
    /(?<!\d)(\d{2,4})\s*[.\-\/\s]\s*(?:음력|양력|음|양)\s*[.\-\/\s]\s*(\d{1,2})\s*[.\-\/\s]\s*(\d{1,2})(?!\s*\d)/,
  )
  if (m) {
    const mo = +m[2]
    const da = +m[3]
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      let year = +m[1]
      if (m[1].length <= 2) {
        year = year <= 25 ? 2000 + year : 1900 + year
        ambiguity.push(`연도를 2자리(${m[1]})로 적어 ${year}년으로 추정했어요. 확인해 주세요.`)
      }
      return normalizeDate(year, mo, da, ambiguity)
    }
  }

  // 패턴 B3: 공백 구분 "1970 02 09" / "1970 2 9" (4자리 연도 + 공백 + 월 + 공백 + 일)
  //   "1970 02 09 음력 조자시 여자" 처럼 구분자 없이 공백으로만 연·월·일을 나눈 경우.
  //   오탐 방지: 월 1~12, 일 1~31 범위를 만족할 때만 인정한다.
  //   뒤에 숫자가 더 와도 그게 시각(예: "10시")이면 날짜의 일부가 아니므로 허용한다.
  //   (예: "1969 3 15 10시" → 연1969 월3 일15, 10시는 시간으로 따로 처리)
  //   순서 주의: "연 월 일 + 시각" 4묶음 형태를 먼저 시도해야 시작점(연도)이 흔들리지 않는다.
  //   (시각 포함 정규식을 뒤에 두면 "85 12 25 23시"에서 12부터 잘못 잡힐 수 있음)
  m = text.match(/(?<!\d)(19\d{2}|20\d{2})\s+(\d{1,2})\s+(\d{1,2})\s+\d{1,2}\s*시/)
    || text.match(/(?<!\d)(19\d{2}|20\d{2})\s+(\d{1,2})\s+(\d{1,2})(?!\s*\d)(?!\d)/)
  if (m) {
    const mo = +m[2]
    const da = +m[3]
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      return normalizeDate(+m[1], mo, da, ambiguity)
    }
  }
  // 패턴 B3-2: 공백 구분 2자리 연도 "70 02 09" — 출생 맥락이 있을 때만(오탐 최소화)
  //   B3와 마찬가지로 날짜 뒤에 "10시" 같은 시각이 붙어도 날짜를 잡는다.
  //   시각 포함 형태를 먼저 시도(시작점 고정).
  if (/(생|태어|태여|음력|양력|시|띠|여자|남자|재물|운)/.test(text)) {
    m = text.match(/(?<!\d)(\d{2})\s+(\d{1,2})\s+(\d{1,2})\s+\d{1,2}\s*시/)
      || text.match(/(?<!\d)(\d{2})\s+(\d{1,2})\s+(\d{1,2})(?!\s*\d)(?!\d)/)
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

  // 패턴 B3-2b: 맥락 키워드가 없어도, 댓글이 사실상 '숫자 나열'뿐이라 오탐 위험이 낮을 때
  //   2자리 연도 + (구분자) 월 + (구분자) 일 을 생년월일로 인정한다.
  //   구분자는 공백/마침표/하이픈/슬래시 등이 섞여도 된다.
  //   (예: "66 7 02", "66 7 2", "66 07 02", "66. 7 15", "66.7 15" — 생/음력/시 등 단서 없어도 됨)
  //   안전장치: 숫자·공백·구분자·흔한 조사/기호를 뺀 '실제 글자'가 거의 없어야(≤1자) 한다.
  {
    const nonNumeric = text
      .replace(/[\d\s.\-\/~～〜,，·ㆍ:()[\]]/g, '')
      .replace(/(생|태어|태여|음력|양력|양|음|시|분|여자|남자|여|남|띠|일|월|년|요|입니다|이에요|예요|고맙습니다|감사합니다|부탁|드립니다|해요|봐|주세요)/g, '')
      .trim()
    if (nonNumeric.length <= 1) {
      const SEP = '[.\\-\\/~～〜,，·ㆍ\\s]+'
      m = text.match(new RegExp(`(?<!\\d)(\\d{2})${SEP}(\\d{1,2})${SEP}(\\d{1,2})${SEP}\\d{1,2}\\s*시`))
        || text.match(new RegExp(`(?<!\\d)(\\d{2})${SEP}(\\d{1,2})${SEP}(\\d{1,2})(?!\\s*\\d)(?!\\d)`))
      if (m) {
        const mo = +m[2]
        const da = +m[3]
        if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
          const yy = +m[1]
          const year = yy <= 25 ? 2000 + yy : 1900 + yy
          ambiguity.push(`'${m[1]} ${m[2]} ${m[3]}'을(를) ${year}년 ${mo}월 ${da}일로 봤어요. 혹시 다르면 알려주세요.`)
          return normalizeDate(year, mo, da, ambiguity)
        }
      }
    }
  }

  // 패턴 B3-3: 일(日)을 한 자리씩 띄어 적은 경우 "69 3 1 5 10시" → 연69 월3 일15(1과5를 붙임)
  //   숫자가 연·월·일십·일일 4묶음으로 나뉘고 뒤에 시각/끝이 오는 경우.
  //   마지막 두 자리를 붙인 값(예: 1,5→15)이 유효한 일(1~31)일 때만 인정. 출생 맥락 필수.
  if (/(생|태어|태여|음력|양력|시|띠|여자|남자|재물|운)/.test(text)) {
    // 4자리 연도: "1969 3 1 5 10시"
    let mm =
      text.match(/(?<!\d)(19\d{2}|20\d{2})\s+(\d{1,2})\s+(\d)\s+(\d)\s+\d{1,2}\s*시/) ||
      text.match(/(?<!\d)(19\d{2}|20\d{2})\s+(\d{1,2})\s+(\d)\s+(\d)(?!\s*\d)(?!\d)/)
    if (mm) {
      const mo = +mm[2]
      const da = +(`${mm[3]}${mm[4]}`)
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        ambiguity.push(`일(日)을 "${mm[3]} ${mm[4]}"로 띄어 적으신 것 같아 ${da}일로 봤어요. 확인해 주세요.`)
        return normalizeDate(+mm[1], mo, da, ambiguity)
      }
    }
    // 2자리 연도: "69 3 1 5 10시"
    mm =
      text.match(/(?<!\d)(\d{2})\s+(\d{1,2})\s+(\d)\s+(\d)\s+\d{1,2}\s*시/) ||
      text.match(/(?<!\d)(\d{2})\s+(\d{1,2})\s+(\d)\s+(\d)(?!\s*\d)(?!\d)/)
    if (mm) {
      const mo = +mm[2]
      const da = +(`${mm[3]}${mm[4]}`)
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        const yy = +mm[1]
        const year = yy <= 25 ? 2000 + yy : 1900 + yy
        ambiguity.push(`연도 2자리(${mm[1]})→${year}년, 일(日)을 "${mm[3]} ${mm[4]}"로 띄어 적으신 듯해 ${da}일로 봤어요. 확인해 주세요.`)
        return normalizeDate(year, mo, da, ambiguity)
      }
    }
  }

  // 패턴 B2: 76.04.12 / 76-4-12 / 76/04/12 (2자리 연도 + 구분자 2개)
  //   "76.04.12생" 처럼 점·하이픈·슬래시로 연·월·일을 모두 구분한 경우.
  //   구분자가 반드시 2개(세 묶음)여야 하므로 월·일만 있는 "4.12"와는 겹치지 않는다.
  //   첫 묶음이 2자리(연도)일 때만 적용 → 4자리는 위 패턴 B가 이미 처리.
  //   구분자에 틸드(~)·전각 물결(～·〜)·쉼표(,／，)·가운뎃점(·ㆍ)도 허용한다. (예: "69~10~21", "72,6,7")
  //   뒤 lookahead: 같은 구분자로 4번째 숫자 묶음이 이어지면 거부(범위 등). 단, "10시"처럼 시각이 붙는 건 허용.
  m = text.match(/(?<!\d)(\d{2})\s*[.\-\/~～〜,，·ㆍ]\s*(\d{1,2})\s*[.\-\/~～〜,，·ㆍ]\s*(\d{1,2})(?!\s*[.\-\/~～〜,，·ㆍ]\s*\d)(?!\d)/)
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
  //   소수("175.5")·연.월.일 3묶음("1990.5.15")과 헷갈리지 않게,
  //   "구분자(.-/:) 바로 뒤에 숫자가 또 오는" 경우만 거부한다.
  //   ※ "5.8 05시"처럼 공백 뒤에 시각 숫자가 오는 건 정상 인정해야 하므로
  //     공백 묶음(\s*\d)은 거부 조건에서 제외한다. '시'가 바로 붙는 건 시각이므로 거부.
  if (/(생|태어|태여|음력|양력|시|때)/.test(text)) {
    m = text.match(/(?<![\d.])(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?![.\-\/:]\s*\d)(?!\s*시)/)
    if (m) {
      const month = +m[1]
      const day = +m[2]
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        ambiguity.push(`'${m[0].trim()}'을(를) ${month}월 ${day}일로 봤어요.`)
        return { year: null, month, day }
      }
    }
  }

  // 패턴 D2b: "음력 9 13" / "양력 5 8" 처럼 음/양력 표기 바로 뒤에
  //   월·일을 공백으로만 띄어 적은 경우(구분자 없음). 어르신 시청자들이
  //   "63. 음력 9 13. 방옥임. 해시요"처럼 적는 일이 흔하다. 연도는 null →
  //   영상연도 폴백 대상. 오탐 방지: '음력/양력' 키워드 직후일 때만 인정하고,
  //   '월'·'시'·'분'이 붙은 시각/명시형은 배제, 월 1~12·일 1~31만 받는다.
  //   (뒤에 숫자가 더 오면 거부해 "9 13 5" 같은 3묶음·범위 오인을 막는다)
  m = text.match(/(?:음력|양력|음|양)\s*(\d{1,2})\s+(\d{1,2})(?!\s*[.\-\/:]?\s*\d)(?!\s*[월일시분])/)
  if (m) {
    const month = +m[1]
    const day = +m[2]
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      ambiguity.push(`'${m[1]} ${m[2]}'을(를) ${month}월 ${day}일로 봤어요. 혹시 다르면 알려주세요.`)
      return { year: null, month, day }
    }
  }

  // 패턴 D3: 한글(한자식) 숫자 월·일 — "유월이십육일" / "정월 보름" 류
  //   "음력으로 유월이십육일 시는 모르겠어요." 처럼 한글 숫자로만 적은 어르신 댓글 대비.
  //   월은 KOREAN_MONTH(유월=6, 시월=10 등), 일은 koreanNumToInt로 변환.
  //   연도는 null → 영상연도(70년생=1970) 폴백 대상.
  {
    // 월 키를 길이 내림차순으로 정렬해 "십일월"이 "일월"보다 먼저 매칭되도록 한다.
    const monthKeys = Object.keys(KOREAN_MONTH).sort((a, b) => b.length - a.length)
    for (const mk of monthKeys) {
      // "유월이십육일" / "유월 이십육일" / "유월26일" 모두 허용. 일 글자수 1~4.
      const re = new RegExp(`${mk}\\s*([일이삼사오육칠팔구십\\d]{1,4})\\s*일`)
      const mm = text.match(re)
      if (mm) {
        const month = KOREAN_MONTH[mk]
        const day = koreanNumToInt(mm[1])
        if (month >= 1 && month <= 12 && day != null && day >= 1 && day <= 31) {
          ambiguity.push(`'${mm[0].trim()}'을(를) ${month}월 ${day}일로 봤어요. 확인해 주세요.`)
          return { year: null, month, day }
        }
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
        // 살아남은 첫 번째 월만 출생월 후보로 채택.
        //   단, 월을 잡았어도 텍스트 뒤쪽에 별도로 떨어진 'NN일'(예: "2월생. 27일")이 있으면
        //   그것을 태어난 일로 이어붙인다. (월생/월 다음에 일이 따로 오는 흔한 표기)
        const dm = text.match(/(?<![\d:.])(\d{1,2})\s*일(?![\d:.])/)
        if (dm) {
          const day = +dm[1]
          if (day >= 1 && day <= 31) {
            return normalizeDate(year, month, day, ambiguity)
          }
        }
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
    //   구분자(점·공백·쉼표 등) 외에 "년/월/일/시" 같은 기둥 라벨도 연속으로 본다.
    //   예: "을묘년경진월기유일임신시" → 을묘(년)경진(월)기유(일)임신(시)
    const between = text.slice(prev.index + 2, cur.index)
    if (/^[\s.,·ㆍ\-\/년월일시年月日時生]*$/.test(between)) {
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
