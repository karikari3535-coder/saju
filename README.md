# 천기누설 만신보감 · 사주 답글 작성실

유튜브 사주 채널 운영자를 위한 **반자동(human-in-the-loop) 답글 작성 도구**.
시청자 댓글에서 생년월일을 추출 → 코드가 만세력(사주팔자)을 계산 → AI(Claude)가 답글 초안을 작성 → 운영자가 검토·수정 후 직접 게시합니다.

> "계산은 코드가, 글쓰기는 AI가, 최종 확인은 사람이."

## 프로젝트 개요
- **이름**: 천기누설 만신보감 · 사주 답글 작성실 (webapp)
- **목표**: 사주 상담 댓글에 대한 정확하고 따뜻한 답글 초안을 빠르게 생성
- **핵심 특징**:
  - 만세력 계산은 검증된 `manseryeok`(MIT, KASI 절기 기반) 라이브러리로 정확하게
  - 댓글에서 생년월일·시간·성별·관심사 자동 추출 (수동 보정 가능)
  - 4가지 분석 모드: `full`(4기둥) / `three_pillar`(시간 모름) / `estimate`(추정) / `guide`(정보 부족→되묻기), 단서 없음은 `none`
  - 유튜브 영상/채널 링크로 미답변 사주 댓글 자동 수집 + **일괄 답글 생성**
  - 영상 제목의 출생연도(○○년생)를 폴백으로 활용
  - **비밀번호 로그인**으로 운영자 전용 보호

## 아키텍처
- **프론트엔드**: SPA — 최소 HTML 셸(`<div id="app">`) + `/static/app.js`가 클라이언트에서 전부 렌더
- **백엔드**: Hono (Cloudflare Pages/Workers 엣지 런타임), TypeScript
- **AI**: Anthropic Claude Messages API (서버사이드 전용, 키 미노출), 기본 모델 `claude-sonnet-4-6`
- **유튜브**: YouTube Data API v3 (읽기 전용)

## 기능 진입 URI (경로 · 파라미터)
인증이 켜진 경우(`SITE_PASSWORD` 또는 `APP_PASSWORD` 설정) 모든 경로는 로그인 필요. 미인증 API는 `401 {auth_required:true}`.

| 메서드 | 경로 | 설명 | 주요 파라미터 |
|---|---|---|---|
| GET | `/` | 메인 SPA (미인증 시 로그인 화면, 401) | — |
| POST | `/login` | 로그인 (form) | `password` (x-www-form-urlencoded) → 성공 시 302 + `auth` 쿠키 |
| GET | `/logout` | 로그아웃 (쿠키 삭제) | — |
| GET | `/api/status` | 키 설정 여부 | → `{ok, anthropic_configured, youtube_configured, model}` |
| POST | `/api/analyze` | 댓글 파싱 + 만세력 계산 (AI 호출 X) | body: `comment`, (선택)`year/month/day/hour/gender(남/여)/calendar/videoBirthYear` |
| POST | `/api/draft` | AI 답글 초안 생성 | body: `comment, year, month, day, hour, minute, gender, calendar, yearFromTitle` → `{ok, draft}` |
| GET | `/api/youtube/comments` | 영상 미답변 사주 댓글 수집 | `videoId, maxPages, onlySaju, onlyUnanswered` → `{ok, comments, stats, video_title, video_birth_year}` |
| GET | `/api/youtube/channel` | 채널 스캔(답글 필요 영상만) | `link, maxVideos` → `{ok, videos, stats, channel_title}` |
| POST | `/api/batch` | 미답변 댓글 일괄 초안 생성(최대 20) | body: `items[], videoBirthYear` → `{ok, results, stats, truncated}` |

### `/api/analyze` 응답 형태 (full 모드 예)
```json
{
  "ok": true, "mode": "full",
  "saju": {
    "pillarsText": {"year":"경오","month":"신사","day":"경진","hour":"갑신"},
    "pillarsHanja": {"year":"庚午","month":"辛巳","day":"庚辰","hour":"甲申"},
    "dayStem": "경", "dayBranch": "진",
    "fiveElements": {"목":1,"화":2,"토":1,"금":4,"수":0},
    "tenGods": {"year":"비견","month":"겁재","hour":"편재"},
    "voidBranches": ["신","유"],
    "daewoon": {"direction":"역행","startAge":3,"list":[{"age":3,"ganji":"경진"}, ...]},
    "mode":"full", "flags":{...}, "notes":[]
  },
  "parsed": {"found":true,"year":1990,...,"gender":"여","ageBand":"30~40","emotionKeywords":["이직","궁금"],...},
  "input": {...}, "year_from_title": false
}
```

## 데이터 모델 / 저장
- **상태 비저장(stateless)**: 데이터베이스 없음. 모든 계산은 요청 시 즉석 처리.
- **인증**: `auth` 쿠키 = `sha256(SITE_PASSWORD)` 16진수 (HttpOnly · Secure · SameSite=Lax · 30일)
- **외부 API**: Anthropic Claude, YouTube Data API v3 (키는 환경변수/secret으로만 보관, 프론트 미노출)

## 사용 가이드
1. 로그인(운영자 비밀번호) 후 메인 화면 진입
2. **방법 A — 직접 입력**: 시청자 댓글/사연을 붙여넣고 (필요 시 연·월·일·시·성별·음양력 보정) → **만세력 계산하기** → **AI 답글 초안 생성** → 복사
3. **방법 B — 유튜브 연동**: 채널 링크(@핸들/채널URL) 또는 영상 링크를 붙여넣고 **불러오기**
   - 채널 → 미답변 사주 댓글이 있는 영상 목록 → **답글 달기**
   - 영상 → 미답변 댓글 목록 → 개별 작성 또는 **한 번에 일괄 생성**
4. 생성된 초안은 반드시 검토·수정 후 직접 게시 (반자동)

## 환경변수 (.dev.vars / Cloudflare secret)
| 변수 | 필수 | 설명 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅(초안 생성 시) | Claude API 키 |
| `CLAUDE_MODEL` | 선택 | 기본 `claude-sonnet-4-6` |
| `YOUTUBE_API_KEY` | 선택 | 유튜브 댓글/채널 수집용 |
| `SITE_PASSWORD` 또는 `APP_PASSWORD` | 권장 | 설정 시 로그인 보호 활성화 (미설정 시 공개). 두 이름 모두 인식하며 `SITE_PASSWORD` 우선 |

로컬: `cp .dev.vars.example .dev.vars` 후 값 채우기.
배포: `npx wrangler pages secret put ANTHROPIC_API_KEY` 등으로 등록.

## 개발 / 실행
```bash
npm install
npm run build
pm2 start ecosystem.config.cjs    # wrangler pages dev dist (port 3000)
curl http://localhost:3000        # 로그인 활성화 시 401(로그인 화면)
```

## 배포
- **플랫폼**: Cloudflare Pages
- **상태**: 로컬 검증 완료 (✅ 빌드/인증/analyze 전 모드/SPA 렌더 확인)
- **기술 스택**: Hono + TypeScript + Vite + manseryeok + TailwindCSS(CDN)
- **최종 수정**: 2026-06-14 (개발 로그 대조 보완: ① `APP_PASSWORD`/`SITE_PASSWORD` 양쪽 지원, ② "○○년생" 연도만 댓글 추출→guide 되묻기, ③ 시스템 프롬프트에 현재 연도·세운(올해 2026 병오년) 컨텍스트 동적 주입)

## 미구현 / 다음 단계
- 답글 패턴 회전(rotation) 상태 영속화 (현재 무상태)
- 일괄 생성 진행률 실시간 표시
- 영상 제목 외 설명/태그에서 연도 추출 보강
- 채널 스캔 비용 최적화(현재 영상별 1페이지 댓글 확인)
