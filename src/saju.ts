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
  lunarToSolar,
  type Gender,
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
    try {
      const solar = lunarToSolar(
        input.year,
        input.month,
        input.day,
        input.isLeapMonth ?? false,
      )
      sYear = solar.year
      sMonth = solar.month
      sDay = solar.day
      notes.push(
        `음력 ${input.year}-${input.month}-${input.day}${
          input.isLeapMonth ? '(윤달)' : ''
        } → 양력 ${sYear}-${sMonth}-${sDay} 로 변환했어요.`,
      )
    } catch {
      return guideResult(input, calendar, [
        '음력 날짜를 양력으로 변환하지 못했어요. 양력 날짜를 알면 양력으로 입력해 주세요.',
      ])
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
