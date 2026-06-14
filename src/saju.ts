/**
 * saju.ts — 만세력(萬歲曆) 계산 모듈
 *
 * 검증된 `manseryeok`(MIT, KASI 절기 기반) 라이브러리를 감싸서
 * 천기누설 만신보감 답글 작성실에 필요한 형태의 사주 데이터를 만든다.
 *
 * 핵심 합의(v3.7):
 *  - 진태양시 미적용(KST 기준) → trueSolarTime 옵션을 넘기지 않는다.
 *  - 자정(00:00) 기준 자시 처리 → dayBoundary: 'midnight'
 *
 * 4가지 모드:
 *  - full        : 연·월·일·시 4기둥 모두 (시간 정확히 앎)
 *  - three_pillar: 시간 모름 → 시주 제외(연·월·일 3기둥)
 *  - estimate    : 시간 추정(대략) → 시주는 참고용으로만
 *  - guide       : 날짜 자체가 모호(음력 미변환 등) → 계산 보류, 안내
 */

import {
  calculateFourPillars,
  FIVE_ELEMENTS,
  lunarToSolar,
  type FiveElement,
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
  gender?: 'male' | 'female' | null
  calendar?: Calendar
  /** 음력 윤달 여부 */
  isLeapMonth?: boolean
  /** 시간 추정 여부(추정이면 estimate 모드) */
  hourEstimated?: boolean
}

export interface PillarOut {
  /** 한글 간지 (예: 경진) */
  korean: string
  /** 천간 (예: 경) */
  stem: string
  /** 지지 (예: 진) */
  branch: string
  /** 천간 오행 */
  stemElement: FiveElement
  /** 지지 오행 */
  branchElement: FiveElement
  /** 십신 — 천간 */
  stemTenGod: string
  /** 십신 — 지지 */
  branchTenGod: string
}

export interface ElementCount {
  목: number
  화: number
  토: number
  금: number
  수: number
}

export interface LuckPillarOut {
  age: number
  korean: string
}

export interface SajuResult {
  mode: SajuMode
  /** 계산에 실제로 쓰인 양력 날짜(음력 입력 시 변환 결과) */
  solar: { year: number; month: number; day: number }
  /** 입력 그대로(표시용) */
  input: SajuInput
  /** 8글자 문자열 (예: "경오 신사 경진 신사") — three_pillar면 시주 자리 '??' */
  eightChar: string
  /** 일간(日干) */
  dayMaster: string
  /** 일간 오행 */
  dayMasterElement: FiveElement
  pillars: {
    year: PillarOut
    month: PillarOut
    day: PillarOut
    hour: PillarOut | null
  }
  /** 오행 분포 (기둥 개수 기준) */
  elementCount: ElementCount
  /** 공망(空亡) 지지 */
  voidBranches: string[]
  /** 대운 — gender 가 있을 때만 */
  luck: {
    forward: boolean
    startAge: number
    pillars: LuckPillarOut[]
  } | null
  /** 사람이 읽는 경고/주석 */
  notes: string[]
}

const EMPTY_COUNT: ElementCount = { 목: 0, 화: 0, 토: 0, 금: 0, 수: 0 }

/** manseryeok FiveElement(목화토금수) → 카운트 키 */
function addElement(count: ElementCount, el: FiveElement) {
  // FIVE_ELEMENTS 는 ['목','화','토','금','수'] 형태
  if (el in count) (count as Record<string, number>)[el] += 1
}

/**
 * 사주 계산 메인 함수.
 *
 * @returns mode='guide' 면 pillars 가 비어있고 notes 로 안내만 제공.
 */
export function computeSaju(input: SajuInput): SajuResult {
  const notes: string[] = []
  const calendar: Calendar = input.calendar ?? 'solar'

  // ── 0) 날짜 모호성 검사 → guide 모드 ───────────────────────────
  if (
    !Number.isFinite(input.year) ||
    !Number.isFinite(input.month) ||
    !Number.isFinite(input.day) ||
    input.year < 1000 ||
    input.month < 1 ||
    input.month > 12 ||
    input.day < 1 ||
    input.day > 31
  ) {
    return guideResult(input, [
      '생년월일을 정확히 알 수 없어 계산을 보류했어요. (연·월·일을 확인해 주세요)',
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
    } catch (e) {
      return guideResult(input, [
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
  const gender: Gender | undefined =
    input.gender === 'male' || input.gender === 'female'
      ? input.gender
      : undefined

  // ── 3) manseryeok 호출 ────────────────────────────────────────
  //  진태양시 미적용(KST 기준): trueSolarTime 옵션을 넘기지 않는다.
  //  자정 기준 자시 처리: dayBoundary 'midnight'
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

  // ── 4) 기둥 매핑 ──────────────────────────────────────────────
  const yearP = toPillarOut(r, 'year')
  const monthP = toPillarOut(r, 'month')
  const dayP = toPillarOut(r, 'day')
  const hourP = mode === 'three_pillar' ? null : toPillarOut(r, 'hour')

  // ── 5) 오행 분포 (보이는 기둥 기준) ───────────────────────────
  const count: ElementCount = { ...EMPTY_COUNT }
  for (const p of [yearP, monthP, dayP, ...(hourP ? [hourP] : [])]) {
    addElement(count, p.stemElement)
    addElement(count, p.branchElement)
  }

  // ── 6) 8글자 문자열 ───────────────────────────────────────────
  const eightChar = [
    yearP.korean,
    monthP.korean,
    dayP.korean,
    hourP ? hourP.korean : '??',
  ].join(' ')

  // ── 7) 대운 ───────────────────────────────────────────────────
  let luck: SajuResult['luck'] = null
  if (r.luckPillars) {
    luck = {
      forward: r.luckPillars.forward,
      startAge: r.luckPillars.startAge,
      pillars: r.luckPillars.pillars.map((lp) => ({
        age: lp.age,
        korean: lp.korean,
      })),
    }
  } else if (!gender) {
    notes.push('성별을 알면 대운(大運)까지 볼 수 있어요.')
  }

  return {
    mode,
    solar: { year: sYear, month: sMonth, day: sDay },
    input,
    eightChar,
    dayMaster: r.day.heavenlyStem,
    dayMasterElement: dayP.stemElement,
    pillars: { year: yearP, month: monthP, day: dayP, hour: hourP },
    elementCount: count,
    voidBranches: [...r.voidBranches],
    luck,
    notes,
  }
}

function toPillarOut(
  r: ReturnType<typeof calculateFourPillars>,
  key: 'year' | 'month' | 'day' | 'hour',
): PillarOut {
  const pillar = r[key]
  const stringKey = `${key}String` as const
  const elementPair = r[`${key}Element` as const]
  const tg = r.tenGods[key]
  return {
    korean: r[stringKey] as string,
    stem: pillar.heavenlyStem,
    branch: pillar.earthlyBranch,
    stemElement: elementPair.stem,
    branchElement: elementPair.branch,
    stemTenGod: tg.stem,
    branchTenGod: tg.branch,
  }
}

function guideResult(input: SajuInput, notes: string[]): SajuResult {
  return {
    mode: 'guide',
    solar: { year: input.year, month: input.month, day: input.day },
    input,
    eightChar: '',
    dayMaster: '',
    dayMasterElement: '목',
    pillars: { year: null as any, month: null as any, day: null as any, hour: null },
    elementCount: { ...EMPTY_COUNT },
    voidBranches: [],
    luck: null,
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
