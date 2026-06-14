/**
 * ui.ts — 대시보드 HTML 셸
 * 실제 동작 로직은 /static/app.js, 스타일은 /static/style.css.
 */
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>천기누설 만신보감 · 사주 답글 작성실</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet" />
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;600;700&family=Noto+Sans+KR:wght@400;500;700&display=swap" rel="stylesheet" />
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml" />
  <link href="/static/style.css" rel="stylesheet" />
</head>
<body class="min-h-screen text-stone-100">
  <header class="sangsil-header">
    <div class="max-w-6xl mx-auto px-4 py-5 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <span class="text-2xl">🪷</span>
        <div>
          <h1 class="font-serif text-xl sm:text-2xl font-bold tracking-tight">천기누설 만신보감</h1>
          <p class="text-xs sm:text-sm text-amber-200/80">사주 답글 작성실 · 반자동(사람 최종 확인)</p>
        </div>
      </div>
      <div id="status-chip" class="text-xs px-3 py-1.5 rounded-full bg-black/30 border border-amber-300/30">
        <i class="fas fa-circle-notch fa-spin"></i> 상태 확인중…
      </div>
    </div>
  </header>

  <main class="max-w-6xl mx-auto px-4 py-6">
    <!-- 탭 -->
    <nav class="flex gap-2 mb-5 flex-wrap" id="tabs">
      <button class="tab-btn active" data-tab="single"><i class="fas fa-feather-pointed mr-1"></i>단건 작성</button>
      <button class="tab-btn" data-tab="youtube"><i class="fab fa-youtube mr-1"></i>유튜브 수집/일괄</button>
    </nav>

    <!-- ===================== 단건 작성 탭 ===================== -->
    <section id="tab-single">
      <div class="grid lg:grid-cols-2 gap-5">
        <!-- 입력 -->
        <article class="panel">
          <h2 class="panel-title"><i class="fas fa-comment-dots"></i> 시청자 댓글</h2>
          <textarea id="comment" rows="5" class="field" placeholder="예) 1990년 5월 15일 오전 10시 30분에 태어난 여자입니다. 올해 이직운이 궁금해요!"></textarea>

          <div class="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
            <label class="lbl">연도<input id="in-year" type="number" class="field-sm" placeholder="1990" /></label>
            <label class="lbl">월<input id="in-month" type="number" class="field-sm" placeholder="5" /></label>
            <label class="lbl">일<input id="in-day" type="number" class="field-sm" placeholder="15" /></label>
            <label class="lbl">시(0~23)<input id="in-hour" type="number" class="field-sm" placeholder="비우면 시간모름" /></label>
            <label class="lbl">분<input id="in-minute" type="number" class="field-sm" placeholder="0" /></label>
            <label class="lbl">성별
              <select id="in-gender" class="field-sm">
                <option value="">미상</option>
                <option value="male">남</option>
                <option value="female">여</option>
              </select>
            </label>
            <label class="lbl">양/음력
              <select id="in-calendar" class="field-sm">
                <option value="solar">양력</option>
                <option value="lunar">음력</option>
              </select>
            </label>
            <label class="lbl">윤달
              <select id="in-leap" class="field-sm">
                <option value="false">평달</option>
                <option value="true">윤달</option>
              </select>
            </label>
          </div>
          <p class="hint mt-2"><i class="fas fa-circle-info"></i> 칸에 직접 적으면 댓글 파싱보다 <b>수동 입력이 우선</b>합니다.</p>

          <div class="flex gap-2 mt-4 flex-wrap">
            <button id="btn-analyze" class="btn-ghost"><i class="fas fa-calculator mr-1"></i>만세력 계산하기</button>
            <button id="btn-draft" class="btn-gold"><i class="fas fa-wand-magic-sparkles mr-1"></i>AI 답글 초안 생성</button>
          </div>
          <div id="ambiguity" class="mt-3"></div>
        </article>

        <!-- 만세력 결과 -->
        <article class="panel">
          <h2 class="panel-title"><i class="fas fa-yin-yang"></i> 만세력</h2>
          <div id="saju-view" class="text-stone-300 text-sm">
            <p class="text-stone-400">댓글을 입력하고 <b>만세력 계산하기</b>를 눌러보세요.</p>
          </div>
        </article>
      </div>

      <!-- AI 초안 -->
      <article class="panel mt-5">
        <div class="flex items-center justify-between">
          <h2 class="panel-title mb-0"><i class="fas fa-scroll"></i> AI 답글 초안</h2>
          <div class="flex gap-2">
            <span id="draft-meta" class="text-xs text-stone-400 self-center"></span>
            <button id="btn-copy" class="btn-ghost text-sm"><i class="far fa-copy mr-1"></i>복사</button>
          </div>
        </div>
        <textarea id="draft" rows="14" class="field mt-3 font-serif leading-relaxed" placeholder="여기에 AI 초안이 들어옵니다. 검토·수정 후 복사해서 유튜브에 게시하세요."></textarea>
        <p class="hint mt-2"><i class="fas fa-triangle-exclamation"></i> 자동 게시 아님 — 운영자(혜인)가 검토·수정 후 직접 게시. 위기 상담: <b>자살예방상담전화 109</b></p>
      </article>
    </section>

    <!-- ===================== 유튜브 탭 ===================== -->
    <section id="tab-youtube" class="hidden">
      <article class="panel">
        <h2 class="panel-title"><i class="fab fa-youtube text-red-400"></i> 채널/영상 링크</h2>
        <div class="flex gap-2 flex-wrap">
          <input id="yt-link" class="field flex-1 min-w-[240px]" placeholder="채널(@핸들 / channel/UC...) 또는 영상 링크/ID를 붙여넣기" />
          <button id="btn-yt-go" class="btn-gold"><i class="fas fa-magnifying-glass mr-1"></i>분석</button>
        </div>
        <p class="hint mt-2"><i class="fas fa-circle-info"></i> 채널이면 → 답글 필요한 영상 목록. 영상이면 → 미답변 사주 댓글 수집.</p>
        <div id="yt-result" class="mt-4"></div>
      </article>

      <article class="panel mt-5 hidden" id="batch-panel">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <h2 class="panel-title mb-0"><i class="fas fa-layer-group"></i> 일괄 답글 초안</h2>
          <div class="flex gap-2">
            <button id="btn-batch" class="btn-gold text-sm"><i class="fas fa-bolt mr-1"></i>선택 댓글 일괄 생성</button>
            <button id="btn-copy-all" class="btn-ghost text-sm"><i class="far fa-copy mr-1"></i>전체 복사</button>
          </div>
        </div>
        <div id="batch-result" class="mt-3 space-y-3"></div>
      </article>
    </section>
  </main>

  <footer class="text-center text-xs text-stone-500 py-6">
    천기누설 만신보감 · 사주 답글 작성실 — 계산은 코드가, 글쓰기는 AI가. (프롬프트 v3.8)
  </footer>

  <div id="toast" class="toast hidden"></div>

  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script src="/static/app.js"></script>
</body>
</html>`
