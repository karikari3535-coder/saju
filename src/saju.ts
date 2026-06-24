/**
 * saju.ts — 만세력(萬歲曆) 계산 모듈
 *
 * 검증된 `manseryeok`(MIT, KASI 절기 기반) 라이브러리를 감싸서
 * 천기누설 만신보감 답글 작성실에 필요한 형태의 사주 데이터를 만든다.
 *
 * 핵심 합의:
 *  - 진태양시 미적용(KST 기준) → trueSolarTime 옵션을 넘기지 않는다.
 *  - 자정(00:00) 기준 자시 처리 → dayBoundary: 'midnight'
 *
 * 모드:
 *  - full        : 연·월·일·시 4기둥 모두 (시간 정확히 앎)
 *  - three_pillar: 시간 모름 → 시주 제외(연·월·일 3기둥)
 *  - estimate    : 시간 추정(대략)
 *  - guide       : 계산에 필요한 정보(연도 등) 부족 → 계산 보류, 되묻기 유도
 *
 * 프론트엔드(app.js)가 소비하는 정확한 형태:
 *  saju = {
 *    pillarsText:  { year, month, day, hour },     // '경오' / null / '?'
 *    pillarsHanja: { year, month, day, hour },     // '庚午' / null / '?'
 *    dayStem, dayBranch,
 *    fiveElements: { 목, 화, 토, 금, 수 },
 *    tenGods: { year, month, hour },               // 천간 십신
 *    voidBranches: [...],
 *    daewoon: { direction: '순행'|'역행', startAge, list:[{age, ganji}] } | null,
 *    mode, flags, notes
 *  }
 */

import {
  calculateFourPillars,
  FIVE_ELEMENTS,
  HEAVENLY_STEMS,
  HEAVENLY_STEMS_HANJA,
  EARTHLY_BRANCHES,
  EARTHLY_BRANCHES_HANJA,
  getHeavenlyStemElement,
  getEarthlyBranchElement,
  getTenGodChart,
  getVoidBranches,
  lunarToSolar,
  type Gender,
  type HeavenlyStem,
  type EarthlyBranch,
  type FourPillars,
  type Pillar,
} from 'manseryeok'

export type SajuMode = 'full' | 'three_pillar' | 'estimate' | 'guide'
export type Calendar = 'solar' | 'lunar'

export interface SajuInput {
  year: number
  month: number
  day: number
  /** 0~23 시(時). null/undefined면 시간 모름 */
  hour?: number | null
  minute?: number | null
  /** 원본 계약: 한글 '남'/'여' */
  gender?: '남' | '여' | null
  calendar?: Calendar
  /** 음력 윤달 여부 */
  isLeapMonth?: boolean
  /** 시간 추정 여부(추정이면 estimate 모드) */
  hourEstimated?: boolean
  /**
   * 간지(干支) 기둥 직접 입력.
   * 시청자가 사주 네 기둥을 간지로 적어준 경우(예: '경술.신사.계사.계해'),
   * 날짜 변환 없이 이 기둥들로 바로 사주를 계산한다.
   * 일주(day)는 필수, 그 외 기둥은 없으면 null.
   */
  pillars?: GanjiPillarsInput | null
}

/** 간지 한글 2글자 기둥 (예: '경술'). 모르면 null */
export interface GanjiPillarsInput {
  year: string | null
  month: string | null
  /** 일주는 일간 산출을 위해 필수 */
  day: string
  hour: string | null
}

export interface PillarTextMap {
  year: string | null
  month: string | null
  day: string | null
  hour: string | null
}

export interface FiveElements {
  목: number
  화: number
  토: number
  금: number
  수: number
}

export interface TenGodsOut {
  year: string | null
  month: string | null
  hour: string | null
}

export interface DaewoonOut {
  direction: '순행' | '역행'
  startAge: number
  list: { age: number; ganji: string }[]
}

export interface SajuFlags {
  mode: SajuMode
  timeKnown: boolean
  calendar: Calendar
  dayStemConfirmed: boolean
}

export interface SajuResult {
  pillarsText: PillarTextMap
  pillarsHanja: PillarTextMap
  dayStem: string
  dayBranch: string
  fiveElements: FiveElements
  tenGods: TenGodsOut
  voidBranches: string[]
  daewoon: DaewoonOut | null
  mode: SajuMode
  flags: SajuFlags
  notes: string[]
}

const EMPTY_ELEMENTS = (): FiveElements => ({ 목: 0, 화: 0, 토: 0, 금: 0, 수: 0 })

/** manseryeok '남'/'여' → 라이브러리 Gender('male'/'female') */
function toLibGender(g?: '남' | '여' | null): Gender | undefined {
  if (g === '남') return 'male'
  if (g === '여') return 'female'
  return undefined
}

/**
 * 사주 계산 메인 함수.
 *
 * @returns mode='guide' 면 pillars 가 비어 있고 notes 로 안내만 제공.
 */
export function computeSaju(input: SajuInput): SajuResult {
  const notes: string[] = []
  const calendar: Calendar = input.calendar ?? 'solar'

  // ── 0-A) 간지(干支) 기둥 직접 입력 → 날짜 변환 없이 바로 계산 ──
  //   시청자가 '경술.신사.계사.계해'처럼 사주 네 기둥을 간지로 적어준 경우.
  //   일주(일간)만 있으면 일간 기준 명리 데이터를 모두 역산할 수 있다.
  if (input.pillars && input.pillars.day) {
    const fromGanji = computeSajuFromGanji(input)
    if (fromGanji) return fromGanji
    // 간지 해석 실패 시 아래 일반 경로로 폴백
  }

  // ── 0) 연도 등 필수 정보 부족 → guide(되묻기) 모드 ─────────────
  const missing: string[] = []
  if (!Number.isFinite(input.year) || (input.year as number) < 1000) {
    missing.push('태어난 연도(몇 년생)')
  }
  if (!Number.isFinite(input.month) || input.month < 1 || input.month > 12) {
    missing.push('태어난 월')
  }
  if (!Number.isFinite(input.day) || input.day < 1 || input.day > 31) {
    missing.push('태어난 일')
  }
  if (missing.length) {
    return guideResult(input, calendar, [
      `사주 계산에 필요한 정보가 부족합니다: ${missing.join(', ')}.`,
    ])
  }

  // ── 1) 음력 → 양력 변환 ────────────────────────────────────────
  let sYear = input.year
  let sMonth = input.month
  let sDay = input.day
  if (calendar === 'lunar') {
    const wantLeap = input.isLeapMonth ?? false
    let solar: { year: number; month: number; day: number } | null = null
    let usedLeapFallback = false
    try {
      solar = lunarToSolar(input.year, input.month, input.day, wantLeap)
    } catch {
      // 윤달로 변환 실패 → 해당 해/월에 윤달이 없을 가능성.
      //   이런 경우(어르신 시청자들이 윤달/평달을 헷갈리는 일이 흔함)
      //   평달로 자동 재시도해서 막히지 않고 사주를 봐 드린다.
      if (wantLeap) {
        try {
          solar = lunarToSolar(input.year, input.month, input.day, false)
          usedLeapFallback = true
        } catch {
          solar = null
        }
      }
    }

    if (!solar) {
      return guideResult(input, calendar, [
        '음력 날짜를 양력으로 변환하지 못했어요. 양력 날짜를 알면 양력으로 입력해 주세요.',
      ])
    }

    sYear = solar.year
    sMonth = solar.month
    sDay = solar.day

    if (usedLeapFallback) {
      // 윤달이라 하셨지만 그 해엔 윤달이 없어 평달로 보고 변환한 경우.
      //   AI가 답글에서 부드럽게 확인 문구를 넣도록 안내 노트를 남긴다.
      notes.push(
        `말씀하신 음력 ${input.month}월은 ${input.year}년에는 윤달이 없어요. ` +
          `그래서 평달(음력 ${input.year}-${input.month}-${input.day})로 보고 ` +
          `양력 ${sYear}-${sMonth}-${sDay}로 변환했어요. ` +
          `혹시 다른 달의 윤달을 말씀하신 거라면 알려주시면 다시 봐 드릴게요.`,
      )
    } else {
      notes.push(
        `음력 ${input.year}-${input.month}-${input.day}${
          wantLeap ? '(윤달)' : ''
        } → 양력 ${sYear}-${sMonth}-${sDay} 로 변환했어요.`,
      )
    }
  }

  // ── 2) 모드 결정 ───────────────────────────────────────────────
  const timeKnown = input.hour !== null && input.hour !== undefined
  let mode: SajuMode
  if (!timeKnown) {
    mode = 'three_pillar'
    notes.push('태어난 시(時)를 몰라 시주(時柱)는 제외하고 세 기둥으로 봤어요.')
  } else if (input.hourEstimated) {
    mode = 'estimate'
    notes.push('태어난 시(時)가 추정이라 시주는 참고용으로만 보세요.')
  } else {
    mode = 'full'
  }

  const hour = timeKnown ? clampHour(input.hour as number) : 0
  const minute = clampMinute(input.minute ?? 0)
  const gender = toLibGender(input.gender)

  // ── 3) manseryeok 호출 ────────────────────────────────────────
  const r = calculateFourPillars({
    year: sYear,
    month: sMonth,
    day: sDay,
    hour,
    minute,
    isLunar: false, // 이미 양력으로 변환함
    dayBoundary: 'midnight',
    gender,
  })

  const ko = r.toObject() // { year, month, day, hour } 한글 간지
  const hj = r.toHanjaObject() // { year:{korean,hanja}, ... }

  const includeHour = mode !== 'three_pillar'

  const pillarsText: PillarTextMap = {
    year: ko.year,
    month: ko.month,
    day: ko.day,
    hour: includeHour ? ko.hour : null,
  }
  const pillarsHanja: PillarTextMap = {
    year: hj.year.hanja,
    month: hj.month.hanja,
    day: hj.day.hanja,
    hour: includeHour ? hj.hour.hanja : null,
  }

  // ── 4) 오행 분포 (보이는 기둥 기준) ───────────────────────────
  const fiveElements = EMPTY_ELEMENTS()
  const elementPairs = [r.yearElement, r.monthElement, r.dayElement, ...(includeHour ? [r.hourElement] : [])]
  for (const ep of elementPairs) {
    addElement(fiveElements, ep.stem)
    addElement(fiveElements, ep.branch)
  }

  // ── 5) 십성(천간 기준) ────────────────────────────────────────
  const tenGods: TenGodsOut = {
    year: r.tenGods.year.stem,
    month: r.tenGods.month.stem,
    hour: includeHour ? r.tenGods.hour.stem : null,
  }

  // ── 6) 대운 ───────────────────────────────────────────────────
  let daewoon: DaewoonOut | null = null
  if (r.luckPillars) {
    daewoon = {
      direction: r.luckPillars.forward ? '순행' : '역행',
      startAge: r.luckPillars.startAge,
      list: r.luckPillars.pillars.slice(0, 8).map((lp) => ({
        age: lp.age,
        ganji: lp.korean,
      })),
    }
  } else if (!gender) {
    notes.push('성별을 알면 대운(大運)까지 볼 수 있어요.')
  }

  return {
    pillarsText,
    pillarsHanja,
    dayStem: r.day.heavenlyStem,
    dayBranch: r.day.earthlyBranch,
    fiveElements,
    tenGods,
    voidBranches: [...r.voidBranches],
    daewoon,
    mode,
    flags: {
      mode,
      timeKnown,
      calendar,
      dayStemConfirmed: true,
    },
    notes,
  }
}

function addElement(count: FiveElements, el: string) {
  if (el in count) (count as Record<string, number>)[el] += 1
}

// ─────────────────────────────────────────────────────────────────
// 간지(干支) 직접 입력 → 사주 계산
// ─────────────────────────────────────────────────────────────────

/** '경술' 같은 한글 2글자 간지 → { stem, branch }. 유효하지 않으면 null */
function parseGanji(
  text: string | null | undefined,
): { stem: HeavenlyStem; branch: EarthlyBranch } | null {
  if (!text) return null
  const s = text.trim()
  if (s.length !== 2) return null
  const stem = s[0] as HeavenlyStem
  const branch = s[1] as EarthlyBranch
  if (!(HEAVENLY_STEMS as readonly string[]).includes(stem)) return null
  if (!(EARTHLY_BRANCHES as readonly string[]).includes(branch)) return null
  return { stem, branch }
}

/** 천간 한글 → 한자 */
function stemHanja(stem: HeavenlyStem): string {
  const i = (HEAVENLY_STEMS as readonly string[]).indexOf(stem)
  return i >= 0 ? HEAVENLY_STEMS_HANJA[i] : stem
}
/** 지지 한글 → 한자 */
function branchHanja(branch: EarthlyBranch): string {
  const i = (EARTHLY_BRANCHES as readonly string[]).indexOf(branch)
  return i >= 0 ? EARTHLY_BRANCHES_HANJA[i] : branch
}

/**
 * 간지 4기둥(연·월·일·시) 입력으로 사주 결과를 만든다.
 * 일주(일간/일지)는 필수, 나머지 기둥은 없으면 해당 칸을 비운다.
 * 대운(大運)은 출생 절기 정보가 필요해 간지 입력만으로는 계산하지 않는다.
 *
 * @returns 일주 파싱 실패 시 null (호출부에서 일반 경로로 폴백)
 */
function computeSajuFromGanji(input: SajuInput): SajuResult | null {
  const p = input.pillars!
  const dayP = parseGanji(p.day)
  if (!dayP) return null // 일주가 없거나 잘못되면 간지 경로 불가

  const yearP = parseGanji(p.year)
  const monthP = parseGanji(p.month)
  const hourP = parseGanji(p.hour)

  const notes: string[] = []
  notes.push('시청자가 사주 네 기둥을 간지(干支)로 직접 적어주셔서, 생년월일 변환 없이 그 간지로 바로 풀었어요.')

  // 시주 유무로 모드 결정 (간지 입력은 추정/estimate 개념 없이 명시값으로 본다)
  const timeKnown = !!hourP
  const mode: SajuMode = timeKnown ? 'full' : 'three_pillar'
  if (!timeKnown) {
    notes.push('시주(時柱) 간지가 없어 세 기둥으로 봤어요.')
  }
  if (!yearP) notes.push('연주(年柱) 간지가 없어 띠·연운 해석은 제한될 수 있어요.')
  if (!monthP) notes.push('월주(月柱) 간지가 없어 격국·월령 해석은 제한될 수 있어요.')

  const includeHour = timeKnown

  const pillarsText: PillarTextMap = {
    year: yearP ? yearP.stem + yearP.branch : null,
    month: monthP ? monthP.stem + monthP.branch : null,
    day: dayP.stem + dayP.branch,
    hour: includeHour && hourP ? hourP.stem + hourP.branch : null,
  }
  const pillarsHanja: PillarTextMap = {
    year: yearP ? stemHanja(yearP.stem) + branchHanja(yearP.branch) : null,
    month: monthP ? stemHanja(monthP.stem) + branchHanja(monthP.branch) : null,
    day: stemHanja(dayP.stem) + branchHanja(dayP.branch),
    hour: includeHour && hourP ? stemHanja(hourP.stem) + branchHanja(hourP.branch) : null,
  }

  // 오행 분포 — 존재하는 기둥의 천간·지지만 집계
  const fiveElements = EMPTY_ELEMENTS()
  const presentPillars: { stem: HeavenlyStem; branch: EarthlyBranch }[] = [dayP]
  if (yearP) presentPillars.push(yearP)
  if (monthP) presentPillars.push(monthP)
  if (includeHour && hourP) presentPillars.push(hourP)
  for (const pp of presentPillars) {
    addElement(fiveElements, getHeavenlyStemElement(pp.stem))
    addElement(fiveElements, getEarthlyBranchElement(pp.branch))
  }

  // 십신 — 일간 기준. 라이브러리는 FourPillars(4기둥) 전체를 요구하므로
  //   빠진 기둥은 일주로 채워 계산한 뒤, 없는 기둥의 십신은 null 로 비운다.
  const fill = (q: { stem: HeavenlyStem; branch: EarthlyBranch } | null): Pillar => ({
    heavenlyStem: (q ?? dayP).stem,
    earthlyBranch: (q ?? dayP).branch,
  })
  const fourForGods: FourPillars = {
    year: fill(yearP),
    month: fill(monthP),
    day: { heavenlyStem: dayP.stem, earthlyBranch: dayP.branch },
    hour: fill(includeHour ? hourP : null),
  }
  const chart = getTenGodChart(fourForGods)
  const tenGods: TenGodsOut = {
    year: yearP ? chart.year.stem : null,
    month: monthP ? chart.month.stem : null,
    hour: includeHour && hourP ? chart.hour.stem : null,
  }

  // 공망 — 일주 기준
  let voidBranches: string[] = []
  try {
    voidBranches = [...getVoidBranches(dayP.stem, dayP.branch)]
  } catch {
    voidBranches = []
  }

  return {
    pillarsText,
    pillarsHanja,
    dayStem: dayP.stem,
    dayBranch: dayP.branch,
    fiveElements,
    tenGods,
    voidBranches,
    daewoon: null, // 간지 입력만으로는 대운(절기 일수) 계산 불가
    mode,
    flags: {
      mode,
      timeKnown,
      calendar: input.calendar ?? 'solar',
      dayStemConfirmed: true,
    },
    notes,
  }
}

/** guide(되묻기) 결과 — 계산 보류 */
function guideResult(input: SajuInput, calendar: Calendar, notes: string[]): SajuResult {
  const timeKnown = input.hour !== null && input.hour !== undefined
  return {
    pillarsText: { year: null, month: null, day: '?', hour: null },
    pillarsHanja: { year: null, month: null, day: '?', hour: null },
    dayStem: '',
    dayBranch: '',
    fiveElements: EMPTY_ELEMENTS(),
    tenGods: { year: null, month: null, hour: null },
    voidBranches: [],
    daewoon: null,
    mode: 'guide',
    flags: {
      mode: 'guide',
      timeKnown,
      calendar,
      dayStemConfirmed: false,
    },
    notes,
  }
}

function clampHour(h: number): number {
  if (!Number.isFinite(h)) return 0
  return Math.min(23, Math.max(0, Math.floor(h)))
}
function clampMinute(m: number): number {
  if (!Number.isFinite(m)) return 0
  return Math.min(59, Math.max(0, Math.floor(m)))
}

/** 오행 한글 목록 (UI 표시용) */
export const ELEMENTS_KO = FIVE_ELEMENTS
