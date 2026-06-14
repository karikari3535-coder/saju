// ============================================================
// 천기누설 만신보감 · 사주 답글 작성실 (프론트엔드)
// 흐름: 댓글 입력/수집 → 만세력 계산 → AI 초안 → 검토/복사
// ============================================================

const OHENG = ['목', '화', '토', '금', '수'];
const MODE_LABEL = {
  full: { t: '완전 (4기둥)', c: 'bg-green-100 text-green-700' },
  three_pillar: { t: '3기둥 (시간 모름)', c: 'bg-amber-100 text-amber-700' },
  estimate: { t: '추정', c: 'bg-orange-100 text-orange-700' },
  guide: { t: '안내 필요', c: 'bg-rose-100 text-rose-700' },
};

const state = {
  comment: '',
  analysis: null,   // /api/analyze 결과
  draft: '',
  loadingAnalyze: false,
  loadingDraft: false,
  status: null,
  error: '',
  // 수동 입력 오버라이드
  manual: { year: '', month: '', day: '', hour: '', gender: '', calendar: 'solar' },
  // 공용 입력칸: 채널 링크 또는 영상 링크 둘 다 허용
  linkInput: '',
  maxVideos: 30,
  youtube: { videoId: '', list: [], loading: false, onlyUnanswered: true, stats: null, videoTitle: null, videoBirthYear: null, open: false },
  // 채널 스캔
  channel: { scanning: false, videos: [], stats: null, channelTitle: null, error: '', open: false },
  pickedAuthor: '',
  // 일괄 생성
  batch: { running: false, results: [], stats: null, error: '' },
};

function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
function esc(s) { return (s ?? '').replace(/[&<>"]/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m])); }

// 스튜디오와 동일한 "○○ 전" 상대시간 표시
function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '방금 전';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  const wk = Math.floor(day / 7);
  if (day < 30) return `${wk}주 전`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}개월 전`;
  return `${Math.floor(day / 365)}년 전`;
}

// 세션 만료(401 + auth_required) 시 로그인 화면으로 자동 이동
// 무한 새로고침 방지: 직전에 이미 reload했으면 한 번만 수행
axios.interceptors.response.use(
  (r) => { sessionStorage.removeItem('__reloaded'); return r; },
  (err) => {
    if (err?.response?.status === 401 && err?.response?.data?.auth_required) {
      if (!sessionStorage.getItem('__reloaded')) {
        sessionStorage.setItem('__reloaded', '1');
        location.reload(); // 미들웨어가 로그인 페이지를 돌려줌
      }
    }
    return Promise.reject(err);
  }
);

async function loadStatus() {
  try { const { data } = await axios.get('/api/status'); state.status = data; } catch {}
  render();
}

async function doAnalyze() {
  state.error = '';
  state.loadingAnalyze = true; render();
  try {
    const payload = { comment: state.comment };
    const m = state.manual;
    if (m.year) payload.year = parseInt(m.year, 10);
    if (m.month) payload.month = parseInt(m.month, 10);
    if (m.day) payload.day = parseInt(m.day, 10);
    if (m.hour !== '') payload.hour = m.hour === 'unknown' ? null : parseInt(m.hour, 10);
    if (m.gender) payload.gender = m.gender;
    if (m.calendar) payload.calendar = m.calendar;
    // 영상 제목에서 뽑은 타겟 출생연도 폴백 (댓글에 연도 없을 때 사용)
    if (state.youtube.videoBirthYear != null) payload.videoBirthYear = state.youtube.videoBirthYear;

    const { data } = await axios.post('/api/analyze', payload);
    state.analysis = data;
    state.draft = '';
    // mode==='none' (사주 단서 전혀 없음) 일 때만 에러 안내.
    // mode==='guide' (연도 등 일부 누락)는 정상 흐름 → "되묻는 답글" 생성 가능.
    if (!data.ok && data.mode === 'none') {
      state.error = data.message || '생년월일을 확인할 수 없습니다.';
    }
  } catch (e) {
    state.error = e?.response?.data?.error || e.message;
  } finally {
    state.loadingAnalyze = false; render();
  }
}

async function doDraft() {
  // guide 모드 포함, 분석 결과(input)가 있으면 초안 생성 허용
  if (!state.analysis || !state.analysis.ok || !state.analysis.input) return;
  state.error = '';
  state.loadingDraft = true; render();
  try {
    const inp = state.analysis.input;
    const { data } = await axios.post('/api/draft', {
      comment: state.comment,
      year: inp.year, month: inp.month, day: inp.day,
      hour: inp.hour, minute: inp.minute,
      gender: inp.gender, calendar: inp.calendar,
      yearFromTitle: state.analysis.year_from_title ?? false,
    });
    if (data.ok) state.draft = data.draft;
    else state.error = data.error || 'AI 초안 생성 실패';
  } catch (e) {
    state.error = e?.response?.data?.error || e.message;
  } finally {
    state.loadingDraft = false; render();
  }
}

// 유튜브 링크/ID 무엇을 넣어도 11자리 영상 ID만 뽑아낸다
//  지원: youtu.be/ID, watch?v=ID, /shorts/ID, /embed/ID, /live/ID,
//        studio.youtube.com/video/ID, 그리고 ID만 입력한 경우
function extractVideoId(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  // 이미 순수 ID 형태(11자, URL 문자 없음)면 그대로
  if (/^[A-Za-z0-9_-]{11}$/.test(s) && !s.includes('/') && !s.includes('.')) return s;
  // 다양한 URL 패턴에서 ID 추출
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,                 // watch?v=ID
    /youtu\.be\/([A-Za-z0-9_-]{11})/,            // youtu.be/ID
    /\/shorts\/([A-Za-z0-9_-]{11})/,             // /shorts/ID
    /\/embed\/([A-Za-z0-9_-]{11})/,              // /embed/ID
    /\/live\/([A-Za-z0-9_-]{11})/,               // /live/ID
    /\/video\/([A-Za-z0-9_-]{11})/,              // studio.../video/ID
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  // 마지막 보루: 문자열 안의 첫 11자리 ID 후보
  const any = s.match(/([A-Za-z0-9_-]{11})/);
  return any ? any[1] : s;
}

// 입력 링크가 '채널'인지 '영상'인지 자동 판단 (서버 parser.ts와 동일 규칙)
function detectLinkKind(raw) {
  const s = (raw || '').trim();
  if (!s) return 'unknown';
  // 영상 단서 우선
  const videoRe = [/[?&]v=[A-Za-z0-9_-]{11}/, /youtu\.be\/[A-Za-z0-9_-]{11}/, /\/shorts\//, /\/embed\//, /\/live\//, /studio\.youtube\.com\/video\//];
  if (videoRe.some(re => re.test(s))) return 'video';
  // 채널 단서
  if (/\/channel\/UC[A-Za-z0-9_-]{20,}/.test(s)) return 'channel';
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(s)) return 'channel';
  if (/youtube\.com\/@[A-Za-z0-9_.\-]+/.test(s)) return 'channel';
  if (/^@[A-Za-z0-9_.\-]+$/.test(s)) return 'channel';
  if (/youtube\.com\/(user|c)\/[A-Za-z0-9_.\-]+/.test(s)) return 'channel';
  // 순수 11자리 → 영상
  if (/^[A-Za-z0-9_-]{11}$/.test(s) && !s.includes('/') && !s.includes('.')) return 'video';
  if (/youtube\.com|youtu\.be/.test(s)) return 'video';
  return 'unknown';
}

// 공용 입력칸 "불러오기": 채널이면 채널스캔, 영상이면 댓글수집으로 분기
async function handleLinkSubmit() {
  const raw = (state.linkInput || '').trim();
  if (!raw) { state.error = '채널 링크 또는 영상 링크를 입력해주세요.'; render(); return; }
  const kind = detectLinkKind(raw);
  if (kind === 'channel') {
    await scanChannel(raw);
  } else {
    // 영상(또는 unknown은 영상으로 시도)
    state.youtube.videoId = extractVideoId(raw);
    await fetchYoutube();
  }
}

// 채널 스캔: 답글 필요한 영상만 리스트업
async function scanChannel(link) {
  state.channel.scanning = true; state.channel.open = true; state.channel.error = '';
  state.channel.videos = []; state.channel.stats = null; state.error = '';
  // 영상 목록/일괄결과는 초기화 (다른 모드로 들어왔으므로)
  state.youtube.list = []; state.batch.results = []; render();
  try {
    const { data } = await axios.get('/api/youtube/channel', {
      params: { link, maxVideos: state.maxVideos },
    });
    if (data.ok) {
      state.channel.videos = data.videos || [];
      state.channel.stats = data.stats || null;
      state.channel.channelTitle = data.channel_title || null;
    } else {
      state.channel.error = data.error || '채널 스캔 실패';
    }
  } catch (e) {
    state.channel.error = e?.response?.data?.error || e.message;
  } finally {
    state.channel.scanning = false; render();
  }
}

// 채널 리스트에서 특정 영상 선택 → 댓글 수집 화면으로 진입
async function pickChannelVideo(videoId) {
  state.youtube.videoId = videoId;
  await fetchYoutube();
  // 댓글 수집 패널 위치로 스크롤
  setTimeout(() => {
    const elr = document.getElementById('yt-details');
    if (elr) elr.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

async function fetchYoutube() {
  const vid = extractVideoId(state.youtube.videoId);
  if (!vid) return;
  // 추출된 ID를 입력칸에도 반영해 사용자가 무엇으로 조회됐는지 보이게
  state.youtube.videoId = vid;
  state.youtube.open = true; // 불러오는 동안/후에도 패널이 닫히지 않게 유지
  state.youtube.loading = true; state.error = ''; render();
  try {
    const { data } = await axios.get('/api/youtube/comments', {
      params: { videoId: vid, maxPages: 3, onlySaju: true, onlyUnanswered: state.youtube.onlyUnanswered },
    });
    if (data.ok) {
      state.youtube.list = data.comments;
      state.youtube.stats = data.stats || null;
      state.youtube.videoTitle = data.video_title || null;
      state.youtube.videoBirthYear = data.video_birth_year ?? null;
    }
    else state.error = data.error;
  } catch (e) {
    state.error = e?.response?.data?.error || e.message;
  } finally {
    state.youtube.loading = false; render();
  }
}

function copyDraft() {
  navigator.clipboard.writeText(state.draft).then(() => {
    const btn = document.getElementById('copy-btn');
    if (btn) { btn.innerHTML = '<i class="fas fa-check mr-2"></i>복사됨!'; setTimeout(() => render(), 1500); }
  });
}

// ---------- 일괄 답글 생성 ----------
async function doBatchAll() {
  const list = state.youtube.list || [];
  if (!list.length) { state.error = '먼저 댓글을 불러와 주세요.'; render(); return; }
  state.batch.running = true; state.batch.error = ''; state.batch.results = []; state.batch.stats = null;
  state.error = ''; render();
  try {
    const items = list.map(c => ({
      comment_id: c.comment_id, author: c.author, text: c.text, published_at: c.published_at,
    }));
    const { data } = await axios.post('/api/batch', {
      items,
      videoBirthYear: state.youtube.videoBirthYear ?? null,
    });
    if (data.ok) {
      state.batch.results = data.results || [];
      state.batch.stats = data.stats || null;
      state.batch.truncated = data.truncated || 0;
    } else {
      state.batch.error = data.error || '일괄 생성 실패';
    }
  } catch (e) {
    state.batch.error = e?.response?.data?.error || e.message;
  } finally {
    state.batch.running = false; render();
    // 결과 영역으로 스크롤
    setTimeout(() => { const elx = document.getElementById('batch-results'); if (elx) elx.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
  }
}

// 일괄 결과 전체를 "댓글별 구분" 포맷으로 합쳐 복사
function buildBatchText() {
  const rows = (state.batch.results || []).filter(r => r.draft);
  const sep = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  return rows.map((r, i) => {
    const head = `【${i + 1}】 @${r.author || ''}  (원댓글: ${(r.text || '').replace(/\s+/g, ' ').slice(0, 60)})`;
    return `${head}\n\n${r.draft}`;
  }).join(sep);
}

function copyBatchAll() {
  const text = buildBatchText();
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('batch-copy-all');
    if (btn) { btn.innerHTML = '<i class="fas fa-check mr-2"></i>전체 복사됨!'; setTimeout(() => render(), 1500); }
  });
}

function copyOneBatch(idx) {
  const r = (state.batch.results || []).filter(x => x.draft)[idx];
  if (!r) return;
  navigator.clipboard.writeText(r.draft).then(() => {
    const btn = document.getElementById('batch-copy-' + idx);
    if (btn) { btn.innerHTML = '<i class="fas fa-check"></i>'; setTimeout(() => render(), 1200); }
  });
}

// ---------- 렌더 조각 ----------
// 천간/지지 → 오행 (색상용)
const GAN_OH = {갑:'목',을:'목',병:'화',정:'화',무:'토',기:'토',경:'금',신:'금',임:'수',계:'수'};
const JI_OH = {자:'수',축:'토',인:'목',묘:'목',진:'토',사:'화',오:'화',미:'토',신:'금',유:'금',술:'토',해:'수'};

function ganjiColored(gz) {
  if (!gz || gz === '?' || gz.length < 2) return '<span class="text-stone-300">?</span>';
  const g = gz[0], j = gz[1];
  return `<span class="oh-${GAN_OH[g]||''}">${esc(g)}</span><span class="oh-${JI_OH[j]||''}">${esc(j)}</span>`;
}

function pillarView(s) {
  const p = s.pillarsText;
  const h = s.pillarsHanja || {};
  const cells = [
    { label: '시주', v: p.hour, hj: h.hour }, { label: '일주', v: p.day, hj: h.day },
    { label: '월주', v: p.month, hj: h.month }, { label: '연주', v: p.year, hj: h.year },
  ];
  return `
  <div class="grid grid-cols-4 gap-2">
    ${cells.map(c => `
      <div class="pillar-card rounded-lg p-3 text-center">
        <div class="text-xs text-stone-400 mb-1">${c.label}</div>
        <div class="serif text-2xl font-bold">${ganjiColored(c.v)}</div>
        ${c.hj ? `<div class="text-xs text-stone-400 mt-1">${esc(c.hj)}</div>` : ''}
      </div>`).join('')}
  </div>`;
}

function ohengView(fe) {
  const total = OHENG.reduce((a, k) => a + (fe[k] || 0), 0) || 1;
  return `<div class="flex gap-2 flex-wrap">${OHENG.map(k => {
    const n = fe[k] || 0;
    return `<div class="oh-bg-${k} oh-${k} rounded-lg px-3 py-2 text-center min-w-[58px]">
      <div class="serif font-bold text-lg">${k}</div>
      <div class="text-sm font-semibold">${n}</div>
    </div>`;
  }).join('')}</div>`;
}

function analysisView() {
  const a = state.analysis;
  if (!a) return '';
  if (!a.ok) {
    return `<div class="parchment rounded-xl p-5 fade-in border-l-4 border-rose-400">
      <div class="flex items-center gap-2 text-rose-600 font-semibold mb-2"><i class="fas fa-circle-info"></i> 안내 모드</div>
      <p class="text-stone-600">${esc(a.message)}</p>
    </div>`;
  }
  const s = a.saju; const p = a.parsed;

  // 방법 B: guide 모드 — 정보가 일부 빠져 사주 계산은 미보류, "되묻는 답글" 유도
  if (s.mode === 'guide') {
    const miss = (p.missingFields && p.missingFields.length)
      ? p.missingFields
      : (s.notes && s.notes.length ? s.notes : ['생년월일 일부']);
    const got = [];
    if (p.month) got.push(`${p.month}월`);
    if (p.day) got.push(`${p.day}일`);
    if (p.hour != null) got.push(`${p.hour}시경`);
    if (p.calendar === 'lunar') got.push('음력');
    if (p.gender) got.push(`${p.gender}자`);
    return `
    <div class="parchment rounded-xl p-5 fade-in space-y-4 border-l-4 border-amber-400">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <h3 class="serif text-lg font-bold gold-text"><i class="fas fa-circle-question mr-2"></i>정보 부족 — 되묻기 모드</h3>
        <span class="badge bg-amber-100 text-amber-700 font-semibold">⚠️ 정보 부족</span>
      </div>
      <p class="text-sm text-stone-600">사주 8글자를 계산하려면 정보가 조금 부족해요. 답글로 자연스럽게 여쭤본 뒤, 답변이 오면 다시 분석하면 됩니다.</p>
      <div class="grid sm:grid-cols-2 gap-3 text-sm">
        <div class="bg-rose-50/70 rounded-lg p-3 border border-rose-100">
          <div class="text-xs text-rose-500 mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>빠진 정보</div>
          <div class="text-stone-700">${miss.map(esc).join(' · ')}</div>
        </div>
        <div class="bg-emerald-50/70 rounded-lg p-3 border border-emerald-100">
          <div class="text-xs text-emerald-600 mb-1"><i class="fas fa-check mr-1"></i>댓글에서 확인된 정보</div>
          <div class="text-stone-700">${got.length ? got.map(esc).join(' · ') : '없음'}</div>
        </div>
      </div>
      ${(p.emotionKeywords && p.emotionKeywords.length) ? `<div class="text-sm"><span class="text-xs text-stone-400">감정 키워드 </span>${p.emotionKeywords.map(k=>`<span class="badge bg-stone-200 text-stone-600 mr-1">${esc(k)}</span>`).join('')}</div>` : ''}
      <button onclick="window.__doDraft()" ${state.loadingDraft ? 'disabled' : ''}
        class="w-full gold-bg text-white font-bold py-3 rounded-xl hover:opacity-90 transition disabled:opacity-60 flex items-center justify-center gap-2">
        ${state.loadingDraft ? '<span class="spinner"></span> AI가 답글을 짓고 있어요…' : '<i class="fas fa-feather-pointed"></i> 되묻는 답글 초안 생성'}
      </button>
    </div>`;
  }

  const ml = MODE_LABEL[s.mode] || MODE_LABEL.full;
  const dw = s.daewoon;
  const fromTitle = a.year_from_title;
  return `
  <div class="parchment rounded-xl p-5 fade-in space-y-5">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <h3 class="serif text-lg font-bold gold-text"><i class="fas fa-yin-yang mr-2"></i>만세력 계산 결과</h3>
      <span class="badge ${ml.c} font-semibold">${ml.t}</span>
    </div>
    ${fromTitle ? `<div class="text-xs text-amber-700 bg-amber-50 rounded-lg p-3 border border-amber-200"><i class="fas fa-clapperboard mr-1"></i>댓글에 연도가 없어 <b>영상 제목의 ${a.input?.year}년생</b>으로 보고 계산했어요. 답글에 "다른 연도시면 알려달라"는 확인 문구가 자연스럽게 들어갑니다.</div>` : ''}
    ${pillarView(s)}
    <div>
      <div class="text-xs text-stone-400 mb-2">일간 · 오행 분포</div>
      <div class="flex items-center gap-4 flex-wrap">
        <div class="serif text-2xl font-bold gold-text">일간 ${esc(s.dayStem)} </div>
        ${ohengView(s.fiveElements)}
      </div>
    </div>
    <div class="grid sm:grid-cols-3 gap-3 text-sm">
      <div class="bg-white/60 rounded-lg p-3">
        <div class="text-xs text-stone-400 mb-1">십성</div>
        <div>${esc(s.tenGods.year || '-')} · ${esc(s.tenGods.month || '-')} · ${esc(s.tenGods.hour || '-')}</div>
      </div>
      <div class="bg-white/60 rounded-lg p-3">
        <div class="text-xs text-stone-400 mb-1">대운</div>
        <div class="text-stone-600">${dw ? esc(dw.direction + ', ' + dw.startAge + '세 시작') : '성별 입력 시 표시'}</div>
      </div>
      <div class="bg-white/60 rounded-lg p-3">
        <div class="text-xs text-stone-400 mb-1">공망(空亡)</div>
        <div class="text-stone-600">${(s.voidBranches && s.voidBranches.length) ? s.voidBranches.map(esc).join(' · ') : '-'}</div>
      </div>
    </div>
    ${dw && dw.list && dw.list.length ? `<div class="text-xs text-stone-500"><span class="text-stone-400">대운 흐름 </span>${dw.list.slice(0,6).map(d=>`<span class="badge bg-stone-100 text-stone-600 mr-1">${d.age}세 ${esc(d.ganji)}</span>`).join('')}</div>` : ''}
    ${(p.emotionKeywords && p.emotionKeywords.length) ? `<div class="text-sm"><span class="text-xs text-stone-400">감정 키워드 </span>${p.emotionKeywords.map(k=>`<span class="badge bg-stone-200 text-stone-600 mr-1">${esc(k)}</span>`).join('')}</div>` : ''}
    ${(s.notes && s.notes.length) ? `<div class="text-xs text-stone-500 bg-amber-50 rounded-lg p-3 border border-amber-100"><i class="fas fa-triangle-exclamation mr-1 text-amber-500"></i>${s.notes.map(esc).join('<br>')}</div>` : ''}
    <button onclick="window.__doDraft()" ${state.loadingDraft ? 'disabled' : ''}
      class="w-full gold-bg text-white font-bold py-3 rounded-xl hover:opacity-90 transition disabled:opacity-60 flex items-center justify-center gap-2">
      ${state.loadingDraft ? '<span class="spinner"></span> AI가 답글을 짓고 있어요…' : '<i class="fas fa-feather-pointed"></i> AI 답글 초안 생성'}
    </button>
  </div>`;
}

function draftView() {
  if (!state.draft) return '';
  const len = state.draft.length;
  return `
  <div class="parchment rounded-xl p-5 fade-in space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="serif text-lg font-bold gold-text"><i class="fas fa-scroll mr-2"></i>답글 초안</h3>
      <span class="text-xs text-stone-400">${len}자</span>
    </div>
    <textarea id="draft-edit" class="w-full border border-stone-200 rounded-lg p-4 draft-area bg-white/70" rows="16">${esc(state.draft)}</textarea>
    <div class="flex gap-2">
      <button id="copy-btn" onclick="window.__copy()" class="flex-1 bg-stone-800 text-white font-semibold py-3 rounded-xl hover:bg-stone-700 transition">
        <i class="fas fa-copy mr-2"></i>복사해서 유튜브에 붙여넣기
      </button>
      <button onclick="window.__doDraft()" class="px-5 bg-white border border-stone-300 rounded-xl hover:bg-stone-50 transition" title="다시 생성">
        <i class="fas fa-rotate gold-text"></i>
      </button>
    </div>
    <p class="text-xs text-stone-400"><i class="fas fa-circle-info mr-1"></i>이 초안은 검토·수정 후 직접 게시하세요. (반자동 · 사람이 최종 확인)</p>
  </div>`;
}

// 입력칸: 채널 링크 또는 영상 링크 둘 다 허용 (자동 판단)
function inputView() {
  const configured = state.status?.youtube_configured;
  const busy = state.youtube.loading || state.channel.scanning;
  const kind = detectLinkKind(state.linkInput);
  const hint = kind === 'channel'
    ? '<span class="text-amber-600"><i class="fas fa-tv mr-1"></i>채널로 인식 — 최근 영상을 스캔합니다</span>'
    : (kind === 'video' ? '<span class="text-emerald-600"><i class="fas fa-video mr-1"></i>영상으로 인식 — 댓글을 불러옵니다</span>' : '');
  return `
  <div class="parchment rounded-xl p-5 space-y-3">
    <div class="serif font-bold gold-text"><i class="fab fa-youtube mr-2 text-red-500"></i>링크 입력 ${configured ? '' : '<span class="text-xs text-rose-500 font-normal">(API 키 미설정)</span>'}</div>
    <div class="flex gap-2">
      <input id="link-input" value="${esc(state.linkInput)}" placeholder="채널 링크(@핸들/채널URL) 또는 영상 링크/ID 붙여넣기" class="flex-1 border border-stone-200 rounded-lg px-3 py-2" />
      <button onclick="window.__submitLink()" ${busy ? 'disabled' : ''} class="px-4 gold-bg text-white rounded-lg font-semibold disabled:opacity-60 whitespace-nowrap">
        ${busy ? '<span class="spinner"></span>' : '<i class="fas fa-magnifying-glass"></i> 불러오기'}
      </button>
    </div>
    <div class="flex items-center justify-between flex-wrap gap-2">
      <p class="text-xs text-stone-400">${hint || '<i class="fas fa-circle-info mr-1"></i>채널이든 영상이든 붙여넣으면 알아서 처리합니다.'}</p>
      <label class="text-xs text-stone-500 flex items-center gap-1">채널 스캔 영상 수
        <select id="max-videos" class="border border-stone-200 rounded px-1 py-0.5 text-xs">
          ${[10,15,30,50].map(n => `<option value="${n}" ${state.maxVideos===n?'selected':''}>${n}개</option>`).join('')}
        </select>
      </label>
    </div>
  </div>`;
}

// 채널 스캔 결과: 답글 필요한 영상 목록
function channelView() {
  const ch = state.channel;
  if (!ch.scanning && (!ch.videos || !ch.videos.length) && !ch.error && !ch.stats) return '';
  return `
  <div id="channel-results" class="parchment rounded-xl p-5 fade-in space-y-3">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <h3 class="serif text-lg font-bold gold-text"><i class="fas fa-tv mr-2"></i>${ch.channelTitle ? esc(ch.channelTitle) : '채널'} · 답글 필요한 영상</h3>
      ${ch.stats ? `<span class="text-xs text-stone-500">영상 ${ch.stats.scanned_videos}개 스캔 · <b class="gold-text">${ch.stats.videos_need_reply}개 영상</b> · 미답변 ${ch.stats.total_unanswered}건</span>` : ''}
    </div>
    ${ch.error ? `<div class="bg-rose-50 text-rose-700 rounded-lg p-3 text-sm"><i class="fas fa-circle-exclamation mr-2"></i>${esc(ch.error)}</div>` : ''}
    ${ch.scanning ? `<div class="text-sm text-stone-500"><span class="spinner"></span> 최근 ${state.maxVideos}개 영상을 살펴보는 중이에요. (30초~1분)</div>` : ''}
    ${(!ch.scanning && ch.stats && !ch.videos.length && !ch.error) ? '<p class="text-sm text-emerald-700"><i class="fas fa-circle-check mr-1"></i>답글이 필요한 미답변 사주 댓글이 있는 영상이 없어요. 모두 처리되었거나 해당 영상이 없습니다.</p>' : ''}
    ${ch.videos.length ? `<div class="space-y-2 max-h-96 overflow-y-auto">${ch.videos.map(v => `
      <div class="bg-white/70 border border-stone-200 rounded-lg p-3 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="text-sm text-stone-700 font-medium truncate">${esc(v.title)}</div>
          <div class="text-xs text-stone-400 mt-0.5">${timeAgo(v.published_at)} ${v.video_birth_year ? `· 제목연도 ${v.video_birth_year}` : ''}</div>
        </div>
        <div class="flex items-center gap-2 whitespace-nowrap">
          <span class="badge bg-rose-100 text-rose-600">미답변 ${v.unanswered_count}</span>
          <button onclick="window.__pickVideo('${v.video_id}')" class="text-xs gold-bg text-white rounded-lg px-3 py-1.5 font-semibold hover:opacity-90"><i class="fas fa-pen mr-1"></i>답글 달기</button>
        </div>
      </div>`).join('')}</div>` : ''}
    <p class="text-xs text-stone-400"><i class="fas fa-circle-info mr-1"></i>'답글 달기'를 누르면 아래에 그 영상의 미답변 댓글이 열리고, 한 번에 답글을 생성할 수 있어요.</p>
  </div>`;
}

function youtubeView() {
  const y = state.youtube;
  // 채널 스캔만 했고 아직 특정 영상을 고르지 않았으면 댓글 패널은 숨김
  if (!y.list.length && !y.loading && !y.videoTitle) return '';
  return `
  <details id="yt-details" class="parchment rounded-xl p-5" ${y.open ? 'open' : ''}>
    <summary class="serif font-bold gold-text cursor-pointer"><i class="fab fa-youtube mr-2 text-red-500"></i>${y.videoTitle ? esc(y.videoTitle.slice(0,40)) : '영상 댓글'} ${y.loading ? '' : `· 미답변 ${y.list.length}개`}</summary>
    <div class="mt-4 space-y-3">
      <label class="flex items-center gap-2 text-sm text-stone-600 cursor-pointer">
        <input type="checkbox" id="yt-unanswered" ${y.onlyUnanswered ? 'checked' : ''} class="accent-amber-600" />
        <i class="fas fa-inbox text-amber-600"></i> 내가 아직 답글 안 단 댓글만 보기
      </label>
      <p class="text-xs text-stone-400 -mt-1"><i class="fas fa-clock mr-1"></i>스튜디오와 동일하게 <b>최신순</b>으로 정렬됩니다.</p>
      ${y.stats ? `<div class="text-xs text-stone-500 bg-amber-50/60 rounded-lg px-3 py-2">스캔 ${y.stats.scanned}개 · 답변완료 ${y.stats.answered}개 · <b class="gold-text">미답변 ${y.stats.returned}개</b></div>` : ''}
      ${y.list.length ? `<div class="space-y-2 max-h-72 overflow-y-auto">${y.list.map(c => `
        <div class="bg-white/70 border border-stone-200 rounded-lg p-3 text-sm">
          <div class="flex justify-between text-xs text-stone-400 mb-1">
            <span>${esc(c.author)} <span class="text-stone-400">· ${timeAgo(c.published_at)}</span> ${c.owner_replied ? '<span class="text-emerald-600">✓ 답변완료</span>' : '<span class="text-rose-500">● 미답변</span>'}</span>
            <span>♥ ${c.like_count} · 답글 ${c.reply_count}</span>
          </div>
          <div class="text-stone-700">${esc(c.text).slice(0,180)}</div>
          <button onclick="window.__useComment(${y.list.indexOf(c)})" class="mt-2 text-xs gold-text font-semibold hover:underline"><i class="fas fa-arrow-up-right-from-square mr-1"></i>이 댓글로 하나만 작성</button>
        </div>`).join('')}</div>` : (y.loading ? '<p class="text-xs text-stone-400"><span class="spinner"></span> 댓글을 불러오는 중…</p>' : '<p class="text-xs text-stone-400">미답변 사주 댓글이 없습니다.</p>')}

      ${y.list.length ? `
      <div class="border-t border-stone-200 pt-3 mt-2">
        <button onclick="window.__doBatch()" ${state.batch.running ? 'disabled' : ''}
          class="w-full gold-bg text-white font-bold py-3 rounded-xl hover:opacity-90 transition disabled:opacity-60 flex items-center justify-center gap-2">
          ${state.batch.running
            ? '<span class="spinner"></span> 미답변 ' + y.list.length + '개 답글을 한꺼번에 짓는 중… (잠시만요)'
            : '<i class="fas fa-layer-group"></i> 미답변 ' + y.list.length + '개 답글 한 번에 생성'}
        </button>
        <p class="text-xs text-stone-400 mt-2"><i class="fas fa-circle-info mr-1"></i>위 목록의 미답변 댓글 전체에 대해 답글 초안을 한꺼번에 만들어, 아래에서 통째로 복사할 수 있어요. (한 번에 최대 20개)</p>
      </div>` : ''}
    </div>
  </details>`;
}

// 일괄 생성 결과 뷰
function batchView() {
  const b = state.batch;
  if (!b.running && (!b.results || !b.results.length) && !b.error) return '';
  const rows = (b.results || []);
  const withDraft = rows.filter(r => r.draft);
  return `
  <div id="batch-results" class="parchment rounded-xl p-5 fade-in space-y-4">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <h3 class="serif text-lg font-bold gold-text"><i class="fas fa-layer-group mr-2"></i>일괄 생성 결과</h3>
      ${b.stats ? `<span class="text-xs text-stone-500">생성 ${b.stats.generated} · 건너뜀 ${b.stats.skipped} · 실패 ${b.stats.failed}</span>` : ''}
    </div>
    ${b.error ? `<div class="bg-rose-50 text-rose-700 rounded-lg p-3 text-sm"><i class="fas fa-circle-exclamation mr-2"></i>${esc(b.error)}</div>` : ''}
    ${b.running ? `<div class="text-sm text-stone-500"><span class="spinner"></span> 답글을 짓고 있어요. 댓글 수에 따라 30초~1분 정도 걸릴 수 있어요.</div>` : ''}
    ${(!b.running && withDraft.length) ? `
      <button id="batch-copy-all" onclick="window.__copyBatchAll()" class="w-full bg-stone-800 text-white font-bold py-3 rounded-xl hover:bg-stone-700 transition">
        <i class="fas fa-copy mr-2"></i>${withDraft.length}개 답글 전체 복사 (댓글 구분선 포함)
      </button>` : ''}
    ${(!b.running && b.truncated) ? `<div class="text-xs text-amber-700 bg-amber-50 rounded-lg p-2"><i class="fas fa-triangle-exclamation mr-1"></i>댓글이 많아 앞에서 ${withDraft.length + (b.stats?.skipped||0)}개만 처리했어요. 나머지 ${b.truncated}개는 다시 불러와 처리해 주세요.</div>` : ''}
    <div class="space-y-3">
      ${rows.map((r) => {
        const idxDraft = withDraft.indexOf(r);
        if (r.skipped) {
          return `<div class="bg-stone-50 border border-stone-200 rounded-lg p-3 text-sm opacity-70">
            <div class="text-xs text-stone-400 mb-1">@${esc(r.author||'')} · <span class="text-stone-400">건너뜀(사주 정보 없음)</span></div>
            <div class="text-stone-600">${esc((r.text||'').slice(0,100))}</div>
          </div>`;
        }
        if (r.error) {
          return `<div class="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm">
            <div class="text-xs text-rose-500 mb-1">@${esc(r.author||'')} · 생성 실패</div>
            <div class="text-stone-600">${esc((r.text||'').slice(0,100))}</div>
            <div class="text-xs text-rose-500 mt-1">${esc(r.error)}</div>
          </div>`;
        }
        const modeBadge = r.mode === 'guide'
          ? '<span class="badge bg-amber-100 text-amber-700">되묻기</span>'
          : (r.year_from_title ? '<span class="badge bg-amber-100 text-amber-700">제목연도</span>' : '<span class="badge bg-green-100 text-green-700">풀이</span>');
        return `<div class="bg-white/70 border border-stone-200 rounded-lg p-3 text-sm space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-xs text-stone-500"><i class="fas fa-user mr-1"></i>${esc(r.author||'')} ${modeBadge} <span class="text-stone-400">${r.draft.length}자</span></div>
            <button id="batch-copy-${idxDraft}" onclick="window.__copyOneBatch(${idxDraft})" class="text-xs bg-stone-100 hover:bg-stone-200 rounded-lg px-2 py-1" title="이 답글만 복사"><i class="fas fa-copy"></i></button>
          </div>
          <div class="text-xs text-stone-400 bg-stone-50 rounded p-2">원댓글: ${esc((r.text||'').replace(/\\s+/g,' ').slice(0,120))}</div>
          <textarea class="w-full border border-stone-200 rounded-lg p-3 draft-area bg-white/70 text-sm" rows="8">${esc(r.draft)}</textarea>
        </div>`;
      }).join('')}
    </div>
    <p class="text-xs text-stone-400"><i class="fas fa-circle-info mr-1"></i>각 초안은 검토·수정 후 직접 게시하세요. '전체 복사'로 한 번에 옮긴 뒤, 댓글마다 나눠 붙여넣으면 편해요.</p>
  </div>`;
}

function render() {
  const aOk = state.status?.anthropic_configured;
  const app = document.getElementById('app');
  app.innerHTML = `
  <div class="max-w-3xl mx-auto px-4 py-8">
    <header class="text-center mb-8">
      <div class="serif text-3xl font-bold text-stone-800 mb-1">천기누설 만신보감</div>
      <div class="gold-text font-semibold tracking-wide"><i class="fas fa-feather-pointed mr-1"></i>사주 답글 작성실</div>
      <div class="mt-2 text-xs text-stone-400">계산은 코드가, 글쓰기는 ${state.status?.model || 'Claude'} · 반자동(사람 최종 확인)</div>
      ${!aOk ? `<div class="mt-3 text-xs bg-rose-50 text-rose-600 rounded-lg p-2 inline-block"><i class="fas fa-key mr-1"></i>Anthropic API 키 미설정 — .dev.vars 또는 secret으로 설정해 주세요</div>` : ''}
    </header>

    ${state.error ? `<div class="mb-4 bg-rose-50 text-rose-700 rounded-lg p-3 text-sm fade-in"><i class="fas fa-circle-exclamation mr-2"></i>${esc(state.error)}</div>` : ''}

    <div class="space-y-5">
      <div class="parchment rounded-xl p-5 space-y-4">
        <h3 class="serif text-lg font-bold gold-text"><i class="fas fa-comment-dots mr-2"></i>시청자 댓글 / 사연 ${state.pickedAuthor ? `<span class="text-xs font-normal text-stone-500 bg-amber-50 rounded-full px-2 py-0.5 ml-1"><i class="fas fa-user mr-1"></i>${esc(state.pickedAuthor)}</span>` : ''}</h3>
        <textarea id="comment" placeholder="예) 1990년 5월 15일 오후 3시에 태어난 여자입니다. 요즘 이직 때문에 너무 막막한데 올해 흐름이 어떨까요?" rows="4"
          class="w-full border border-stone-200 rounded-lg p-3">${esc(state.comment)}</textarea>

        <div class="grid grid-cols-2 sm:grid-cols-6 gap-2 text-sm">
          <input id="m-year" value="${state.manual.year}" placeholder="연(양력)" class="border border-stone-200 rounded-lg px-2 py-2" />
          <input id="m-month" value="${state.manual.month}" placeholder="월" class="border border-stone-200 rounded-lg px-2 py-2" />
          <input id="m-day" value="${state.manual.day}" placeholder="일" class="border border-stone-200 rounded-lg px-2 py-2" />
          <select id="m-hour" class="border border-stone-200 rounded-lg px-2 py-2">
            <option value="">시(자동)</option>
            <option value="unknown">시간모름</option>
            ${Array.from({length:24},(_,i)=>`<option value="${i}" ${state.manual.hour==String(i)?'selected':''}>${i}시</option>`).join('')}
          </select>
          <select id="m-gender" class="border border-stone-200 rounded-lg px-2 py-2">
            <option value="">성별</option>
            <option value="남" ${state.manual.gender==='남'?'selected':''}>남</option>
            <option value="여" ${state.manual.gender==='여'?'selected':''}>여</option>
          </select>
          <select id="m-cal" class="border border-stone-200 rounded-lg px-2 py-2">
            <option value="solar" ${state.manual.calendar==='solar'?'selected':''}>양력</option>
            <option value="lunar" ${state.manual.calendar==='lunar'?'selected':''}>음력</option>
          </select>
        </div>
        <p class="text-xs text-stone-400">댓글에서 자동 추출되며, 위 칸으로 직접 보정할 수 있어요. (수동 입력이 우선)</p>

        <button onclick="window.__doAnalyze()" ${state.loadingAnalyze ? 'disabled' : ''}
          class="w-full bg-stone-800 text-white font-bold py-3 rounded-xl hover:bg-stone-700 transition disabled:opacity-60 flex items-center justify-center gap-2">
          ${state.loadingAnalyze ? '<span class="spinner"></span> 계산 중…' : '<i class="fas fa-calculator"></i> 만세력 계산하기'}
        </button>
      </div>

      ${inputView()}
      ${channelView()}
      ${youtubeView()}
      ${batchView()}
      ${analysisView()}
      ${draftView()}
    </div>

    <footer class="text-center text-xs text-stone-400 mt-10 pb-6">
      천기누설 만신보감 · 사주 답글 작성실 — 위기 상담 109 (자살예방상담)
    </footer>
  </div>`;

  // 입력값 바인딩 (재렌더 시 보존)
  bind('comment', v => { state.comment = v; state.pickedAuthor = ''; });
  bind('m-year', v => state.manual.year = v);
  bind('m-month', v => state.manual.month = v);
  bind('m-day', v => state.manual.day = v);
  bindSel('m-hour', v => state.manual.hour = v);
  bindSel('m-gender', v => state.manual.gender = v);
  bindSel('m-cal', v => state.manual.calendar = v);
  bind('link-input', v => state.linkInput = v);
  const linkEl = document.getElementById('link-input');
  if (linkEl) linkEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); handleLinkSubmit(); } });
  bindSel('max-videos', v => state.maxVideos = parseInt(v, 10) || 30);
  const ytChk = document.getElementById('yt-unanswered');
  if (ytChk) ytChk.addEventListener('change', e => { state.youtube.onlyUnanswered = e.target.checked; });
  // 패널 열림/닫힘 상태를 기억 (재렌더해도 사용자가 연 상태 유지)
  const ytDet = document.getElementById('yt-details');
  if (ytDet) ytDet.addEventListener('toggle', e => { state.youtube.open = e.target.open; });
  const de = document.getElementById('draft-edit');
  if (de) de.addEventListener('input', e => state.draft = e.target.value);
}

function bind(id, fn) { const e = document.getElementById(id); if (e) e.addEventListener('input', ev => fn(ev.target.value)); }
function bindSel(id, fn) { const e = document.getElementById(id); if (e) e.addEventListener('change', ev => fn(ev.target.value)); }

// 전역 핸들러
window.__doAnalyze = doAnalyze;
window.__doDraft = doDraft;
window.__copy = copyDraft;
window.__fetchYt = fetchYoutube;
window.__submitLink = handleLinkSubmit;
window.__pickVideo = pickChannelVideo;
window.__doBatch = doBatchAll;
window.__copyBatchAll = copyBatchAll;
window.__copyOneBatch = copyOneBatch;
window.__useComment = (i) => {
  const c = state.youtube.list[i];
  state.comment = c.text;
  state.pickedAuthor = c.author || '';
  state.manual = { year:'',month:'',day:'',hour:'',gender:'',calendar:'solar' };
  render();
  // 분석 후 입력/결과 영역으로 부드럽게 스크롤 (유튜브 섹션이 아래에 있어 길 잃지 않도록)
  const top = document.getElementById('comment');
  if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
  doAnalyze();
};

loadStatus();
render();
