# 천기누설 만신보감 · 사주 답글 작성실

유튜브 채널 "천기누설 만신보감"용 **사주 답글 초안 생성기** (반자동 · 사람 최종 확인).
시청자가 댓글에 생년월일시를 남기면, 코드가 만세력(8글자)을 계산하고 Claude가 약 1,500자 답글 초안을 작성합니다. 운영자(혜인)가 검토·수정 후 직접 게시합니다.

> ℹ️ **재구축 안내**: 원본 백업 `.gz` 파일이 전송 중 잘려(truncated) 소스 코드가 유실되었고,
> 온전히 복구된 README 사양을 기준으로 `saju.ts / parser.ts / prompt.ts / Hono API / 대시보드 UI`를
> 처음부터 다시 구현했습니다. (복구된 README·.gitignore·.dev.vars.example·ecosystem.config.cjs는 그대로 사용)

## 프로젝트 개요
- **이름**: 천기누설 만신보감 · 사주 답글 작성실
- **목표**: 사주 답글 작성 시간을 줄이고 품질을 일정하게 유지
- **핵심 철학**: 계산은 코드가, 글쓰기는 AI가 / 애매하면 추측하지 않는다
- **구조**: 반자동(human-in-the-loop) — 자동 게시 봇 아님

## 완성된 기능
- ✅ **댓글 파싱** (`src/parser.ts`): 생년월일·시간·성별·감정키워드·질문 자동 추출, 모호성 표시
  - 날짜: `1990년 5월 15일` / `1990.05.15` / `900515` / `19900515` / `85년 3월 2일`(2자리연도) 지원
  - 시각: `오전 10시 30분` / `14:20` / `자시·오시` 등 지지시각 / `3시쯤`(추정) 지원
  - 성별·감정키워드(연애/결혼/금전/직업/건강/가족/대인/운세)·질문·위기신호 감지
- ✅ **만세력 계산** (`src/saju.ts`): 검증된 `manseryeok`(MIT, KASI 기반) 라이브러리 사용 — Cloudflare 엣지 동작
  - **정밀 절기 시각**으로 연주·월주 경계 정확 처리 (입춘 등 경계일 출생 정확)
  - 일주 검증: **1990-05-15 → 경진 ✅** / 음력→양력 정확 변환(1992음8.15 → 양1992.9.11) ✅
  - 사주 8글자·일간·오행 분포·십성·공망(空亡)·대운 제공
  - 4가지 모드: `full`(4기둥) / `three_pillar`(시간모름) / `estimate`(추정) / `guide`(날짜모호)
  - 진태양시 미적용(KST 기준), 자정 기준 자시 처리 (`dayBoundary: 'midnight'`, v3.7 합의)
- ✅ **AI 초안 생성** (`src/prompt.ts` + `src/claude.ts` + `/api/draft`): v3.8 프롬프트 + JSON 데이터블록 → Claude 호출(서버사이드, 키 미노출)
- ✅ **통합 대시보드 UI** (`src/ui.ts` + `public/static/app.js`): 댓글 입력/보정 → 만세력 시각화 → AI 초안 → 편집/복사
- ✅ **YouTube 댓글 수집** (`src/youtube.ts` + `/api/youtube/comments`): 읽기 전용 commentThreads.list, 사주 포함 댓글만 필터, 미답변만
- ✅ **일괄 답글 생성** (`/api/batch`): 미답변 댓글 전체에 대해 답글 초안을 한 번에 생성(동시성 4, 최대 20)
- ✅ **채널 스캔** (`/api/youtube/channel`): 채널 링크/핸들만 넣으면 최근 N개(기본 30) 영상을 살펴 **답글 필요한 영상만 리스트업** → 영상 클릭 시 댓글 수집/일괄 생성으로 연결
- ✅ **링크 자동 판단** (`extractYoutubeTarget` / `/api/resolve-link`): 입력칸 하나에 채널 링크든 영상 링크든 붙여넣으면 알아서 분기

## 기능 진입 URI (API)
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/` | 대시보드 화면 |
| GET | `/api/status` | 키 설정 여부·모델 확인 (키 미노출) |
| POST | `/api/analyze` | 댓글 파싱 + 만세력 계산 (AI 호출 X). body: `{comment, year?, month?, day?, hour?, minute?, gender?, calendar?, isLeapMonth?}` |
| POST | `/api/draft` | AI 답글 초안 생성. body: `{comment, year?, …, rotation_state?}` |
| GET | `/api/youtube/comments?videoId=...&maxPages=3&onlySaju=true&onlyUnanswered=true` | 영상 댓글 수집(미답변 사주 댓글) |
| GET | `/api/youtube/channel?link=...&maxVideos=30` | 채널 최근 영상 스캔 → 답글 필요한 영상만 반환 |
| GET | `/api/resolve-link?link=...` | 링크가 채널인지 영상인지 자동 판단 |
| POST | `/api/batch` | 미답변 댓글 일괄 초안 생성. body: `{items:[{comment_id,author,text,published_at}]}` |

## 데이터 구조
- **코드 → AI 다리(JSON 데이터블록, `prompt.ts`)**: `viewer_comment`, `saju`(8글자·일간·오행·십성·공망·대운), `flags`(mode·time_known·calendar·crisis·ambiguity), `parsed`(age_band·gender·question·emotion_keywords), `rotation_state`(패턴 반복 회피용)
- **저장소**: 현재 무상태(stateless). 추후 처리이력/회전상태는 Cloudflare KV 또는 D1로 확장 가능

## 사용 방법
1. **채널 링크**(@핸들/채널URL)를 넣으면 → 답글 필요한 영상 목록이 나오고, 영상별 '댓글 달기'로 진입
   또는 **영상 링크/ID**를 넣으면 → 그 영상의 미답변 사주 댓글을 바로 수집
   (입력칸 하나로 채널/영상 자동 판단)
2. 영상의 미답변 댓글을 **한 번에 답글 생성** 후 통째로 복사, 또는 댓글별 개별 복사
3. 시청자 댓글을 직접 붙여넣어 단건 작성도 가능
   - 필요 시 연·월·일·시·분·성별·양음력 칸으로 직접 보정 (**수동 입력이 우선**)
   - **만세력 계산하기** → 8글자/오행/십성/대운 확인
   - **AI 답글 초안 생성** → Claude가 약 1,300~1,700자 작성
   - 초안을 검토·수정 후 **복사**해서 유튜브에 직접 게시

## 환경 변수 (보안)
- `ANTHROPIC_API_KEY` — Claude API 키 (https://console.anthropic.com)
- `CLAUDE_MODEL` — 기본 `claude-opus-4-20250514`
- `YOUTUBE_API_KEY` — YouTube Data API v3 키 (댓글 수집용, 선택)

> 로컬: `.dev.vars` 파일 사용 (git 제외됨). `cp .dev.vars.example .dev.vars` 후 키 입력
> 배포: `npx wrangler pages secret put ANTHROPIC_API_KEY` 등으로 설정 (프론트엔드에 절대 노출 안 됨)

## 로컬 실행 (샌드박스)
```bash
npm install
npm run build
pm2 start ecosystem.config.cjs   # http://localhost:3000
# 로그 확인(비차단): pm2 logs webapp --nostream
```

## 아직 구현 안 된 것 / 다음 단계
- [ ] rotation_state 영속화(KV/D1)로 답글 패턴 반복 실제 추적
- [ ] 대운 시작 나이 절기 정밀 계산 (현재 manseryeok 제공값 사용)
- [ ] 진태양시 보정 (현재 KST 기준, v3.7 합의에 따라 미적용)
- [ ] 답글 대상 선정 규칙(선착순/좋아요순) 자동 정렬
- [ ] 채널 주인 답글 판별 정밀화 (현재 휴리스틱 + 운영자 최종 확인)
- [ ] 모델 비교 테스트(Opus vs Sonnet vs Gemini)
- [ ] Cloudflare Pages 배포

## 기술 스택
- Hono + TypeScript + Vite (Cloudflare Pages)
- TailwindCSS (CDN), Noto Serif KR
- `manseryeok` v2 (만세력 계산)
- Anthropic Claude API (서버사이드)
- YouTube Data API v3

## 배포 상태
- **플랫폼**: Cloudflare Pages (예정)
- **현재**: 샌드박스 로컬 실행 중 (PM2, `wrangler pages dev`)
- **위기 상담**: 자살예방상담전화 109
- **최종 수정일**: 2026-06-14
