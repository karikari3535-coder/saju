/**
 * prompt.ts — AI 답글 초안용 프롬프트 빌더 (v3.8)
 *
 * 구성:
 *   1) 시스템 프롬프트 — "천기누설 만신보감" 페르소나 + 작성 규칙
 *   2) 코드→AI 다리(JSON 데이터블록) — 계산된 사주를 구조화해 전달
 *   3) 유저 메시지 — 위 데이터블록 + 작성 지시
 *
 * 철학: 계산은 코드가(이 데이터블록), 글쓰기는 AI가.
 *       AI는 사주 글자를 다시 계산하지 말고 주어진 데이터만 해석한다.
 */

import type { ParsedComment } from './parser'
import type { SajuResult } from './saju'

export const PROMPT_VERSION = 'v3.8'

/**
 * 현재 연도/세운(歲運) 컨텍스트.
 * 시기·대운 풀이 시 AI가 "올해"를 정확히 인식하도록 시스템 프롬프트에 주입한다.
 * (모델 학습 시점과 무관하게 항상 올바른 현재 연도를 쓰게 함)
 */
function currentYearContext(): string {
  const now = new Date()
  const year = now.getFullYear()
  // 60갑자 세운: 1984=갑자(甲子) 기준
  const STEMS = ['갑', '을', '병', '정', '무', '기', '경', '신', '임', '계']
  const STEM_HJ = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
  const BRANCHES = ['자', '축', '인', '묘', '진', '사', '오', '미', '신', '유', '술', '해']
  const BRANCH_HJ = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥']
  const si = (year - 1984) % 10
  const bi = (year - 1984) % 12
  const s = (si + 10) % 10
  const b = (bi + 12) % 12
  const ganji = `${STEMS[s]}${BRANCHES[b]}년(${STEM_HJ[s]}${BRANCH_HJ[b]})`
  return `올해는 ${year}년 ${ganji}입니다. 시기·대운·세운을 말할 때 이 현재 연도를 기준으로 삼으세요.`
}

export const CURRENT_YEAR_CONTEXT = currentYearContext()

/** 답글 회전 상태(패턴 반복 회피용). 현재 무상태라 호출자가 주입. */
export interface RotationState {
  recentOpenings?: string[]
  recentClosings?: string[]
}

// ─────────────────────────────────────────────────────────────────
// 1) 시스템 프롬프트
// ─────────────────────────────────────────────────────────────────
export const SYSTEM_PROMPT = `당신은 유튜브 채널 "천기누설 만신보감"의 사주 상담 답글을 쓰는 글쓰기 보조자입니다.
운영자가 최종 검토·수정 후 직접 게시하므로, 당신은 "초안"을 작성합니다.

[정체성·말투]
- 따뜻하고 단단한, 경험 많은 명리 상담가의 어조. 존댓말.
- 점쟁이의 단정·협박("~하면 큰일난다")이 아니라, 흐름을 읽고 방향을 제시하는 조언.
- 시청자를 자연스러운 호칭으로 부르되 과하지 않게.
- 이모지는 절제(0~2개). 신비주의 과장 금지.

[절대 규칙]
1. 사주 글자(연·월·일·시주, 오행, 십성, 대운)는 **주어진 데이터블록의 값만** 사용한다.
   당신이 직접 만세력을 다시 계산하지 마라. 글자를 바꾸거나 새로 지어내지 마라.
2. 데이터에 없는 사실(직업·구체적 사건·이름 등)을 단정하지 마라. "~하신 편" 같은 경향으로 표현.
3. mode가 'three_pillar'면 시주가 없다는 점을 자연스럽게 인정하고, 시주 해석은 하지 않는다.
4. mode가 'estimate'면 시주는 "추정"임을 가볍게 덧붙인다.
5. mode가 'guide'면 사주 해석을 하지 말고, 생년월일시를 어떻게 알려주면 되는지 친절히 되묻는 답글만 쓴다.
6. year_from_title=true(영상 제목 연도로 추정)면, 답글 안에 "다른 연도시면 알려달라"는 확인 문구를 자연스럽게 넣는다.
7. 건강·의료·법률·투자에 대한 확정적 단언 금지(일반적 조언 수준).
8. 위기 신호(flags.crisis=true)가 있으면, 공감 후 자연스럽게 "자살예방 상담전화 109"를 안내한다(설교조 금지).
9. 운세는 '결정된 운명'이 아니라 '경향과 시기'로 말한다. 노력으로 바뀔 여지를 남긴다.

[구성·분량]
- 약 1,300~1,700자(한글 기준, 공백 포함). 너무 짧지 않게.
- 흐름: ① 공감/인사 → ② 사주 핵심 1~2가지(일간·오행 중심) → ③ 질문/관심사에 대한 풀이 →
  ④ 시기·대운 힌트 → ⑤ 따뜻한 마무리 + (필요시 위기안내).
- 전문용어는 쓰되 바로 쉬운 말로 풀어준다(예: "정관(正官) — 책임감과 질서를 상징해요").
- 같은 도입/마무리 패턴을 반복하지 마라.

[출력 형식]
- 유튜브 댓글에 그대로 붙여넣을 수 있는 **순수 텍스트 답글만** 출력한다.
- 머리말("다음은 답글입니다") · 코드블록 금지.

[현재 시점]
- ${CURRENT_YEAR_CONTEXT}
- "올해", "내년", "요즘 운" 등을 말할 때 절대 과거 연도를 쓰지 마라.`

// ─────────────────────────────────────────────────────────────────
// 2) 데이터블록 (코드 → AI 다리)
// ─────────────────────────────────────────────────────────────────
export interface DataBlock {
  prompt_version: string
  viewer_comment: string
  flags: {
    mode: SajuResult['mode']
    time_known: boolean
    calendar: 'solar' | 'lunar'
    crisis: boolean
    year_from_title: boolean
    ambiguity: string[]
  }
  parsed: {
    age_band: string | null
    gender: string | null
    job: string | null
    question: string | null
    emotion_keywords: string[]
    missing_fields: string[]
  }
  saju: {
    pillars_text: SajuResult['pillarsText']
    pillars_hanja: SajuResult['pillarsHanja']
    day_stem: string
    day_branch: string
    five_elements: SajuResult['fiveElements']
    ten_gods: SajuResult['tenGods']
    void_branches: string[]
    daewoon: SajuResult['daewoon']
  } | null
  rotation_state: RotationState
}

export interface BuildDataBlockOpts {
  yearFromTitle?: boolean
  rotation?: RotationState
}

export function buildDataBlock(
  comment: string,
  parsed: ParsedComment,
  saju: SajuResult,
  opts: BuildDataBlockOpts = {},
): DataBlock {
  const crisis =
    saju.notes.some((n) => n.includes('위기')) ||
    parsed.ambiguity.some((a) => a.includes('위기'))

  const sajuBlock =
    saju.mode === 'guide'
      ? null
      : {
          pillars_text: saju.pillarsText,
          pillars_hanja: saju.pillarsHanja,
          day_stem: saju.dayStem,
          day_branch: saju.dayBranch,
          five_elements: saju.fiveElements,
          ten_gods: saju.tenGods,
          void_branches: saju.voidBranches,
          daewoon: saju.daewoon,
        }

  return {
    prompt_version: PROMPT_VERSION,
    viewer_comment: comment,
    flags: {
      mode: saju.mode,
      time_known: saju.flags.timeKnown,
      calendar: saju.flags.calendar,
      crisis,
      year_from_title: opts.yearFromTitle ?? false,
      ambiguity: [...parsed.ambiguity, ...saju.notes],
    },
    parsed: {
      age_band: parsed.ageBand,
      gender: parsed.gender,
      job: parsed.jobInComment,
      question: parsed.question,
      emotion_keywords: parsed.emotionKeywords,
      missing_fields: parsed.missingFields,
    },
    saju: sajuBlock,
    rotation_state: opts.rotation ?? {},
  }
}

// ─────────────────────────────────────────────────────────────────
// 3) 유저 메시지
// ─────────────────────────────────────────────────────────────────
export function buildUserMessage(block: DataBlock): string {
  const guide =
    block.flags.mode === 'guide'
      ? `\n[작성 지시] 이 시청자는 사주 계산에 필요한 정보가 일부 부족합니다(parsed.missing_fields 참고). ` +
        `사주 풀이를 하지 말고, 댓글에서 이미 알려준 정보는 짚어주며 ` +
        `부족한 정보(특히 ${(block.parsed.missing_fields || []).join(', ') || '생년월일'})를 ` +
        `자연스럽게 되묻는 따뜻한 답글을 약 400~600자로 작성하세요. ` +
        `답변이 오면 다시 봐드리겠다는 안내로 마무리하세요.`
      : `\n[작성 지시] 위 데이터블록의 사주 값만 사용해, 시청자의 질문·관심사(parsed.question / emotion_keywords)에 ` +
        `초점을 맞춘 답글 초안을 약 1,300~1,700자로 작성하세요.` +
        (block.flags.year_from_title
          ? ` 단, 연도가 영상 제목 추정값이므로 "다른 연도시면 알려달라"는 확인 문구를 자연스럽게 넣으세요.`
          : ``) +
        (block.flags.crisis
          ? ` 위기 신호가 있으니 공감 후 자연스럽게 자살예방 상담전화 109를 안내하세요.`
          : ``)

  return (
    `아래는 코드가 계산한 시청자 사주 데이터입니다(JSON). 이 값만 신뢰하고 해석하세요.\n\n` +
    '```json\n' +
    JSON.stringify(block, null, 2) +
    '\n```' +
    guide
  )
}

/** Claude messages API용 payload 조립 (모델·max_tokens 포함) */
export function buildClaudePayload(block: DataBlock, model: string) {
  return {
    model,
    max_tokens: 2048,
    temperature: 0.8,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user' as const,
        content: buildUserMessage(block),
      },
    ],
  }
}
