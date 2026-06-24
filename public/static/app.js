// ============================================================
// 천기누설 만신보감 · 사주 답글 작성실 (프론트엔드)
// 흐름: 댓글 입력/수집 → 만세력 계산 → AI 초안 → 검토/복사
// ============================================================

// 모든 axios 요청 기본 타임아웃(안전망). AI 호출이 멈춰도 "생성중"에서 영원히
//   매달리지 않도록 한다. 개별 호출은 아래 상수로 더 길게 덮어쓴다.
axios.defaults.timeout = 60_000; // 60초 (기본)
const AI_TIMEOUT = 120_000;       // AI 답글 1건 / OCR: 120초
const BATCH_TIMEOUT = 300_000;    // 배치(여러 댓글 묶음): 300초
// 타임아웃·네트워크 오류를 사장님이 알아볼 수 있는 한국어 메시지로 변환
function friendlyAxiosError(e) {
  if (e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message || ''))
    return '⏱️ 시간이 초과됐어요. 잠시 후 버튼을 다시 눌러 주세요. (서버가 응답하지 않거나 너무 오래 걸렸어요)';
  return e?.response?.data?.error || e?.message || '알 수 없는 오류가 발생했어요. 다시 시도해 주세요.';
}

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
  // 일괄 생성 (단일 영상)
  batch: { running: false, results: [], stats: null, error: '' },
  // 채널 전체 일괄 생성 — 영상별 결과 묶음
  //   running: 전체 실행 중 여부, total/done: 진행률, current: 현재 처리 영상 제목
  //   videos: [{ video_id, title, published_at, video_birth_year, status, unanswered, results, stats, error, open }]
  channelBatch: { running: false, total: 0, done: 0, current: '', videos: [] },
  // 무시 목록 관리 패널 펼침 여부
  ignorePanelOpen: false,
  // 수동 입력(댓글 직접 붙여넣기) 박스 펼침 여부 — 기본 접힘
  manualOpen: false,
  // 스크린샷에서 댓글 추출 → 검토 → 일괄 생성
  //   image: 미리보기용 data URL, items: 추출/편집 중인 댓글 [{author,text}]
  //   extracting: OCR 진행 중, error: 오류 메시지
  ocr: { image: '', items: null, extracting: false, error: '', batch: { running: false, results: [], stats: null, error: '' } },
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

// ============================================================
// 무시 목록 (이미 답글 단/위치를 못 찾는 댓글) — 브라우저 localStorage 저장
//   운영자가 "무시"로 체크한 댓글을 모아두고(comment_id 키), 댓글을 다시
//   불러올 때 목록에서 걸러낸다. 한 기기/브라우저 안에서만 공유된다.
//   값에는 나중에 관리 패널에서 알아보기 쉽게 작성자·미리보기·시각도 함께 저장.
// ============================================================
const IGNORE_KEY = 'saju_ignored_comments_v2';

function loadIgnoreMap() {
  try {
    const raw = localStorage.getItem(IGNORE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') return new Map(Object.entries(obj));
    }
    // v1(배열) 마이그레이션: id 배열만 있던 옛 형식
    const old = localStorage.getItem('saju_ignored_comment_ids_v1');
    if (old) {
      const arr = JSON.parse(old);
      if (Array.isArray(arr)) return new Map(arr.map(id => [id, { author: '', text: '', at: 0 }]));
    }
  } catch {}
  return new Map();
}

// 메모리 캐시(렌더마다 localStorage 파싱 안 하도록): Map<comment_id, {author,text,at}>
let ignoreMap = loadIgnoreMap();

function saveIgnoreMap() {
  try { localStorage.setItem(IGNORE_KEY, JSON.stringify(Object.fromEntries(ignoreMap))); } catch {}
}
function isIgnored(id) { return !!id && ignoreMap.has(id); }
function addIgnore(comment) {
  const id = typeof comment === 'string' ? comment : comment?.comment_id;
  if (!id) return;
  const meta = typeof comment === 'object' && comment
    ? { author: comment.author || '', text: (comment.text || '').slice(0, 80), at: Date.now() }
    : { author: '', text: '', at: Date.now() };
  ignoreMap.set(id, meta);
  saveIgnoreMap();
}
function removeIgnore(id) { if (id) { ignoreMap.delete(id); saveIgnoreMap(); } }
function clearIgnore() { ignoreMap = new Map(); saveIgnoreMap(); }
function ignoreCount() { return ignoreMap.size; }

/** comment_id 가 무시 목록에 없는 댓글만 남긴다 */
function filterIgnored(comments) {
  return (comments || []).filter(c => !isIgnored(c.comment_id));
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
    // mode==='review' (비판·시비·AI 질문) → AI 답글 생성 금지, 사장님 직접 답변 권장.
    if (!data.ok && data.mode === 'review') {
      state.error = '🛑 검토 필요 (사장님 직접 답변 권장): ' +
        (data.message || '비판·시비·AI 질문 등 사람이 직접 답해야 하는 댓글이에요.');
    } else if (!data.ok && data.mode === 'none') {
      state.error = data.message || '생년월일을 확인할 수 없습니다.';
    }
  } catch (e) {
    state.error = friendlyAxiosError(e);
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
      videoBirthYear: state.youtube.videoBirthYear ?? null,
    }, { timeout: AI_TIMEOUT });
    if (data.ok) state.draft = data.draft;
    else if (data.mode === 'review')
      state.error = '🛑 검토 필요 (사장님 직접 답변 권장): ' +
        (data.message || '비판·시비·AI 질문 등 사람이 직접 답해야 하는 댓글이에요.');
    else state.error = data.error || 'AI 초안 생성 실패';
  } catch (e) {
    state.error = friendlyAxiosError(e);
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

// 입력 링크가 '채널'인지 '영상'인지 자동 판단 (서버 youtube.ts와 동일 규칙)
function detectLinkKind(raw) {
  let s = (raw || '').trim();
  if (!s) return 'unknown';
  // 퍼센트 인코딩된 한글 핸들(@%EC%B2%...)을 디코드해서 판별 (실패해도 원본 사용)
  try { if (/%[0-9A-Fa-f]{2}/.test(s)) s = decodeURIComponent(s); } catch (_) {}
  // 영상 단서 우선
  const videoRe = [/[?&]v=[A-Za-z0-9_-]{11}/, /youtu\.be\/[A-Za-z0-9_-]{11}/, /\/shorts\//, /\/embed\//, /\/live\//, /studio\.youtube\.com\/video\//];
  if (videoRe.some(re => re.test(s))) return 'video';
  // 채널 단서 — 핸들에는 한글(가-힣)도 올 수 있다(예: @천기누설만신보감2)
  if (/\/channel\/UC[A-Za-z0-9_-]{20,}/.test(s)) return 'channel';
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(s)) return 'channel';
  if (/youtube\.com\/@[\w.\-가-힣]+/.test(s)) return 'channel';
  if (/^@[\w.\-가-힣]+$/.test(s)) return 'channel';
  if (/youtube\.com\/(user|c)\/[\w.\-가-힣]+/.test(s)) return 'channel';
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
  state.youtube.list = []; state.batch.results = [];
  state.channelBatch = { running: false, total: 0, done: 0, current: '', videos: [] };
  render();
  try {
    const { data } = await axios.get('/api/youtube/channel', {
      params: { link, maxVideos: state.maxVideos },
      timeout: AI_TIMEOUT,
    });
    if (data.ok) {
      state.channel.videos = data.videos || [];
      state.channel.stats = data.stats || null;
      state.channel.channelTitle = data.channel_title || null;
    } else {
      state.channel.error = data.error || '채널 스캔 실패';
    }
  } catch (e) {
    state.channel.error = friendlyAxiosError(e);
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
      timeout: AI_TIMEOUT,
    });
    if (data.ok) {
      // 무시 목록에 있는 댓글은 빼고 표시
      state.youtube.list = filterIgnored(data.comments);
      state.youtube.stats = data.stats || null;
      state.youtube.videoTitle = data.video_title || null;
      state.youtube.videoBirthYear = data.video_birth_year ?? null;
    }
    else state.error = data.error;
  } catch (e) {
    state.error = friendlyAxiosError(e);
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
    }, { timeout: BATCH_TIMEOUT });
    if (data.ok) {
      state.batch.results = data.results || [];
      state.batch.stats = data.stats || null;
      state.batch.truncated = data.truncated || 0;
    } else {
      state.batch.error = data.error || '일괄 생성 실패';
    }
  } catch (e) {
    state.batch.error = friendlyAxiosError(e);
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

// ============================================================
// 스크린샷에서 댓글 추출 (Claude Vision) → 검토 → 일괄 생성
//   유튜브 관리자 커뮤니티/댓글 화면을 캡쳐해 붙여넣으면, 화면 속 여러
//   댓글을 각각 인식해서 사주 답글을 한꺼번에 지어준다.
// ============================================================

// 파일/클립보드 이미지(Blob)를 data URL 로 변환
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function handleOcrFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { state.ocr.error = '이미지 파일만 올릴 수 있어요.'; render(); return; }
  try {
    const dataUrl = await fileToDataUrl(file);
    state.ocr.image = dataUrl;
    state.ocr.items = null;
    state.ocr.error = '';
    state.ocr.batch = { running: false, results: [], stats: null, error: '' };
    render();
    await runOcrExtract();
  } catch (e) {
    state.ocr.error = '이미지를 읽지 못했어요.'; render();
  }
}

// 붙여넣기(Ctrl+V) 이벤트에서 이미지 추출 (문서 전역 리스너)
async function handleGlobalPaste(ev) {
  const items = ev.clipboardData && ev.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type && it.type.indexOf('image') === 0) {
      const file = it.getAsFile();
      if (file) { ev.preventDefault(); await handleOcrFile(file); return; }
    }
  }
}

// 이미지 → /api/ocr-comments → 추출 댓글 목록
async function runOcrExtract() {
  if (!state.ocr.image) return;
  state.ocr.extracting = true; state.ocr.error = ''; render();
  try {
    const { data } = await axios.post('/api/ocr-comments', { image: state.ocr.image }, { timeout: AI_TIMEOUT });
    if (data.ok) {
      state.ocr.items = (data.comments || []).map(c => ({
        author: c.author || '',
        text: c.text || '',
        videoYear: (c.videoYear != null ? String(c.videoYear) : ''),
      }));
      if (!state.ocr.items.length) state.ocr.error = '이미지에서 읽을 수 있는 댓글을 찾지 못했어요. 더 선명하게(글자가 크게 보이게) 캡쳐해 주세요.';
    } else {
      state.ocr.error = data.error || '이미지 분석 실패';
    }
  } catch (e) {
    state.ocr.error = friendlyAxiosError(e);
  } finally {
    state.ocr.extracting = false; render();
  }
}

function ocrClear() {
  state.ocr = { image: '', items: null, extracting: false, error: '', batch: { running: false, results: [], stats: null, error: '' } };
  render();
}

function ocrAddItem() {
  if (!state.ocr.items) state.ocr.items = [];
  state.ocr.items.push({ author: '', text: '', videoYear: '' });
  render();
}

function ocrRemoveItem(i) {
  if (!state.ocr.items) return;
  state.ocr.items.splice(i, 1);
  render();
}

// 검토 완료된 댓글들을 일괄 생성 (영상 제목 연도 폴백 없음 — 댓글 자체 정보로만)
async function ocrGenerate() {
  const items = (state.ocr.items || [])
    .filter(it => (it.text || '').trim())
    .map(it => {
      const vy = parseInt((it.videoYear || '').trim(), 10);
      return {
        author: it.author || '',
        text: it.text || '',
        videoBirthYear: (Number.isFinite(vy) && vy >= 1900 && vy <= new Date().getFullYear() + 1) ? vy : null,
      };
    });
  if (!items.length) { state.ocr.error = '생성할 댓글이 없어요.'; render(); return; }
  state.ocr.batch = { running: true, results: [], stats: null, error: '' };
  state.ocr.error = ''; render();
  try {
    const { data } = await axios.post('/api/batch', { items }, { timeout: BATCH_TIMEOUT });
    if (data.ok) {
      state.ocr.batch.results = data.results || [];
      state.ocr.batch.stats = data.stats || null;
      state.ocr.batch.truncated = data.truncated || 0;
    } else {
      state.ocr.batch.error = data.error || '일괄 생성 실패';
    }
  } catch (e) {
    state.ocr.batch.error = friendlyAxiosError(e);
  } finally {
    state.ocr.batch.running = false; render();
    setTimeout(() => { const elx = document.getElementById('ocr-results'); if (elx) elx.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
  }
}

function buildOcrBatchText() {
  const rows = (state.ocr.batch.results || []).filter(r => r.draft);
  const sep = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  return rows.map((r, i) => {
    const head = `【${i + 1}】 @${r.author || ''}  (원댓글: ${(r.text || '').replace(/\s+/g, ' ').slice(0, 60)})`;
    return `${head}\n\n${r.draft}`;
  }).join(sep);
}

function copyOcrBatchAll() {
  const text = buildOcrBatchText();
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('ocr-copy-all');
    if (btn) { btn.innerHTML = '<i class="fas fa-check mr-2"></i>전체 복사됨!'; setTimeout(() => render(), 1500); }
  });
}

function copyOcrOne(idx) {
  const r = (state.ocr.batch.results || []).filter(x => x.draft)[idx];
  if (!r) return;
  navigator.clipboard.writeText(r.draft).then(() => {
    const btn = document.getElementById('ocr-copy-' + idx);
    if (btn) { btn.innerHTML = '<i class="fas fa-check"></i>'; setTimeout(() => render(), 1200); }
  });
}

// ============================================================
// 채널 전체 일괄 생성 (영상별로 미답변 댓글 → 답글 초안 한꺼번에)
// ============================================================

// 채널 목록의 한 영상에 대해: 미답변 댓글 수집 → 일괄 초안 생성
// channelBatch.videos[i] 항목을 진행상황에 맞게 갱신하며 render() 한다.
async function processOneVideo(entry) {
  entry.status = 'loading'; entry.error = ''; render();
  try {
    // 1) 미답변 사주 댓글 수집
    const { data: cd } = await axios.get('/api/youtube/comments', {
      params: { videoId: entry.video_id, maxPages: 3, onlySaju: true, onlyUnanswered: true },
      timeout: AI_TIMEOUT,
    });
    if (!cd.ok) { entry.status = 'error'; entry.error = cd.error || '댓글 수집 실패'; render(); return; }
    const list = filterIgnored(cd.comments); // 무시 목록 제외
    const birthYear = (cd.video_birth_year ?? entry.video_birth_year) ?? null;
    if (cd.video_title) entry.title = cd.video_title;
    entry.unanswered = list.length;
    if (!list.length) { entry.status = 'empty'; entry.results = []; entry.stats = { generated: 0, skipped: 0, failed: 0 }; render(); return; }

    // 2) 초안 생성 — 댓글을 "1건씩 순차"로 처리하며 진행률을 실시간 표시.
    //    한 번에 다 던지면 답글 1건당 수십 초가 걸려 화면이 "멈춘 것처럼" 보이므로,
    //    한 건 끝날 때마다 결과를 바로 화면에 채우고 "n/총 완료"를 보여준다.
    entry.status = 'generating';
    entry.results = [];
    entry.stats = { generated: 0, skipped: 0, failed: 0, review: 0 };
    entry.truncated = 0;
    entry.progress = { done: 0, total: list.length };
    render();

    const MAX_ITEMS = 20; // 서버와 동일한 상한
    const work = list.slice(0, MAX_ITEMS);
    entry.truncated = Math.max(0, list.length - MAX_ITEMS);

    for (const c of work) {
      const item = { comment_id: c.comment_id, author: c.author, text: c.text, published_at: c.published_at };
      try {
        const { data: bd } = await axios.post('/api/batch', { items: [item], videoBirthYear: birthYear }, { timeout: AI_TIMEOUT });
        if (bd.ok && Array.isArray(bd.results) && bd.results.length) {
          const r = bd.results[0];
          entry.results.push(r);
          if (bd.stats) {
            entry.stats.generated += bd.stats.generated || 0;
            entry.stats.skipped += bd.stats.skipped || 0;
            entry.stats.failed += bd.stats.failed || 0;
            entry.stats.review += bd.stats.review || 0;
          }
        } else {
          entry.results.push({ comment_id: c.comment_id, author: c.author, text: c.text, error: bd.error || '생성 실패' });
          entry.stats.failed++;
        }
      } catch (e) {
        // 한 건이 실패/시간초과해도 멈추지 말고 다음 댓글로 진행
        entry.results.push({ comment_id: c.comment_id, author: c.author, text: c.text, error: friendlyAxiosError(e) });
        entry.stats.failed++;
      }
      entry.progress.done++;
      render(); // 매 건마다 화면 갱신 → 진행이 눈에 보임
    }
    entry.status = 'done';
  } catch (e) {
    entry.status = 'error';
    entry.error = friendlyAxiosError(e);
  } finally {
    render();
  }
}

// 채널 목록의 특정 영상 1개만 "바로 생성" (개별 버튼)
async function generateForVideo(videoId) {
  const v = (state.channel.videos || []).find(x => x.video_id === videoId);
  if (!v) return;
  // 이미 channelBatch에 있으면 그 항목을 재사용, 없으면 새로 추가
  let entry = state.channelBatch.videos.find(x => x.video_id === videoId);
  if (!entry) {
    entry = {
      video_id: v.video_id, title: v.title, published_at: v.published_at,
      video_birth_year: v.video_birth_year ?? null,
      status: 'pending', unanswered: v.unanswered_count ?? 0,
      results: [], stats: null, error: '', open: true, truncated: 0, progress: null,
    };
    state.channelBatch.videos.unshift(entry); // 최신 작업이 위로
  } else {
    entry.open = true;
  }
  render();
  await processOneVideo(entry);
  // 결과 영역으로 스크롤
  setTimeout(() => {
    const elx = document.getElementById('cbatch-' + entry.video_id);
    if (elx) elx.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

// 채널의 "모든 영상" 한 번에: 각 영상 순차 처리(미답변 수집 + 초안 생성)
async function generateForAllVideos() {
  const videos = state.channel.videos || [];
  if (!videos.length) { state.error = '먼저 채널을 스캔해 주세요.'; render(); return; }
  const totalUnanswered = videos.reduce((s, v) => s + (v.unanswered_count || 0), 0);
  const ok = window.confirm(
    `답글 필요한 영상 ${videos.length}개의 미답변 댓글 약 ${totalUnanswered}건에 대해\n` +
    `답글 초안을 한꺼번에 생성합니다.\n\n` +
    `시간이 다소 걸릴 수 있어요(영상·댓글 수에 따라 수 분).\n진행할까요?`
  );
  if (!ok) return;

  // 모든 영상을 channelBatch에 등록(기존 결과는 초기화)
  state.channelBatch.videos = videos.map(v => ({
    video_id: v.video_id, title: v.title, published_at: v.published_at,
    video_birth_year: v.video_birth_year ?? null,
    status: 'pending', unanswered: v.unanswered_count ?? 0,
    results: [], stats: null, error: '', open: true, truncated: 0, progress: null,
  }));
  state.channelBatch.running = true;
  state.channelBatch.total = videos.length;
  state.channelBatch.done = 0;
  state.channelBatch.current = '';
  state.error = '';
  render();
  // 첫 결과 영역으로 스크롤
  setTimeout(() => {
    const elx = document.getElementById('channel-batch-results');
    if (elx) elx.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);

  // 영상은 순차 처리(서버 rate limit 보호). 영상 내부는 서버가 동시성 4로 처리.
  for (const entry of state.channelBatch.videos) {
    state.channelBatch.current = entry.title || entry.video_id;
    render();
    await processOneVideo(entry);
    state.channelBatch.done++;
    render();
  }
  state.channelBatch.running = false;
  state.channelBatch.current = '';
  render();
}

// 영상 하나의 결과를 "댓글 구분선" 포맷으로 합쳐 복사
function copyVideoBatch(videoId) {
  const entry = state.channelBatch.videos.find(x => x.video_id === videoId);
  if (!entry) return;
  const rows = (entry.results || []).filter(r => r.draft);
  if (!rows.length) return;
  const sep = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  const text = rows.map((r, i) => {
    const head = `【${i + 1}】 @${r.author || ''}  (원댓글: ${(r.text || '').replace(/\s+/g, ' ').slice(0, 60)})`;
    return `${head}\n\n${r.draft}`;
  }).join(sep);
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('cbatch-copy-' + videoId);
    if (btn) { btn.innerHTML = '<i class="fas fa-check mr-2"></i>복사됨!'; setTimeout(() => render(), 1500); }
  });
}

// 영상 하나의 특정 초안 1개 복사
function copyVideoOne(videoId, draftIdx) {
  const entry = state.channelBatch.videos.find(x => x.video_id === videoId);
  if (!entry) return;
  const r = (entry.results || []).filter(x => x.draft)[draftIdx];
  if (!r) return;
  navigator.clipboard.writeText(r.draft).then(() => {
    const btn = document.getElementById('cbatch-one-' + videoId + '-' + draftIdx);
    if (btn) { btn.innerHTML = '<i class="fas fa-check"></i>'; setTimeout(() => render(), 1200); }
  });
}

// 채널 전체 결과를 영상 구분까지 포함해 통째로 복사
function copyChannelBatchAll() {
  const blocks = [];
  for (const entry of state.channelBatch.videos) {
    const rows = (entry.results || []).filter(r => r.draft);
    if (!rows.length) continue;
    const videoSep = '\n\n\n════════════════════════════════════\n';
    const inner = rows.map((r, i) => {
      const head = `【${i + 1}】 @${r.author || ''}  (원댓글: ${(r.text || '').replace(/\s+/g, ' ').slice(0, 60)})`;
      return `${head}\n\n${r.draft}`;
    }).join('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');
    blocks.push(`▶ ${entry.title || entry.video_id}\n${videoSep}\n${inner}`);
  }
  const text = blocks.join('\n\n\n');
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('cbatch-copy-all');
    if (btn) { btn.innerHTML = '<i class="fas fa-check mr-2"></i>전체 복사됨!'; setTimeout(() => render(), 1500); }
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
  if (!a.ok && a.mode === 'review') {
    return `<div class="parchment rounded-xl p-5 fade-in border-l-4 border-rose-500 bg-rose-50/40">
      <div class="flex items-center gap-2 text-rose-600 font-bold mb-2"><i class="fas fa-flag"></i> 검토 필요 — 사장님 직접 답변 권장</div>
      <p class="text-stone-700">${esc(a.message)}</p>
      <p class="text-xs text-stone-500 mt-2"><i class="fas fa-circle-info mr-1"></i>비판·시비·AI 질문 같은 댓글은 AI가 어설프게 답하면 오히려 분란이 커질 수 있어, 자동 답글을 만들지 않았어요. 사장님이 직접 상황에 맞게 답해 주세요.</p>
    </div>`;
  }
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
    ${ch.videos.length ? `
    <div class="border border-amber-200 bg-amber-50/60 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
      <div class="text-sm text-stone-700">
        <i class="fas fa-bolt text-amber-600 mr-1"></i>
        <b>영상 ${ch.videos.length}개</b>의 미답변 댓글 ${ch.stats ? ch.stats.total_unanswered : ''}건을 <b>한 번에</b> 모두 생성합니다.
      </div>
      <button onclick="window.__genAllVideos()" ${state.channelBatch.running ? 'disabled' : ''}
        class="text-sm gold-bg text-white rounded-lg px-4 py-2 font-bold hover:opacity-90 disabled:opacity-60 flex items-center gap-2">
        ${state.channelBatch.running
          ? `<span class="spinner"></span> 생성 중… (${state.channelBatch.done}/${state.channelBatch.total})`
          : '<i class="fas fa-layer-group"></i> 전체 영상 답글 한 번에 생성'}
      </button>
    </div>` : ''}
    ${ch.videos.length ? `<div class="space-y-2 max-h-96 overflow-y-auto">${ch.videos.map(v => {
      const cb = state.channelBatch.videos.find(x => x.video_id === v.video_id);
      const busy = state.channelBatch.running || (cb && (cb.status === 'loading' || cb.status === 'generating'));
      let stLabel = '';
      if (cb) {
        if (cb.status === 'loading') stLabel = '<span class="text-xs text-amber-600"><span class="spinner"></span> 댓글 수집…</span>';
        else if (cb.status === 'generating') { const pg = cb.progress; stLabel = `<span class="text-xs text-amber-600"><span class="spinner"></span> 답글 생성…${pg && pg.total ? ` ${pg.done}/${pg.total}` : ''}</span>`; }
        else if (cb.status === 'done') stLabel = `<span class="text-xs text-emerald-600">✓ ${(cb.results||[]).filter(r=>r.draft).length}개 생성</span>`;
        else if (cb.status === 'empty') stLabel = '<span class="text-xs text-stone-400">대상 없음</span>';
        else if (cb.status === 'error') stLabel = '<span class="text-xs text-rose-500">실패</span>';
      }
      return `
      <div class="bg-white/70 border border-stone-200 rounded-lg p-3 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="text-sm text-stone-700 font-medium truncate">${esc(v.title)}</div>
          <div class="text-xs text-stone-400 mt-0.5">${timeAgo(v.published_at)} ${v.video_birth_year ? `· 제목연도 ${v.video_birth_year}` : ''} ${stLabel ? '· ' + stLabel : ''}</div>
        </div>
        <div class="flex items-center gap-1.5 whitespace-nowrap">
          <span class="badge bg-rose-100 text-rose-600">미답변 ${v.unanswered_count}</span>
          <button onclick="window.__genVideo('${v.video_id}')" ${busy ? 'disabled' : ''} title="이 영상 미답변 답글 바로 생성"
            class="text-xs gold-bg text-white rounded-lg px-3 py-1.5 font-semibold hover:opacity-90 disabled:opacity-60"><i class="fas fa-bolt mr-1"></i>바로 생성</button>
          <button onclick="window.__pickVideo('${v.video_id}')" title="댓글을 열어 하나씩 검토"
            class="text-xs bg-stone-100 hover:bg-stone-200 text-stone-600 rounded-lg px-3 py-1.5 font-semibold"><i class="fas fa-list-ul mr-1"></i>열기</button>
        </div>
      </div>`;
    }).join('')}</div>` : ''}
    <p class="text-xs text-stone-400"><i class="fas fa-circle-info mr-1"></i>'바로 생성'은 그 영상의 미답변 답글을 즉시 만들어요. '전체 영상 한 번에'는 모든 영상을 순서대로 처리합니다. '열기'는 댓글을 하나씩 검토할 때 쓰세요.</p>
  </div>
  ${channelBatchView()}`;
}

// 채널 전체/영상별 일괄 생성 결과 (영상마다 카드)
function channelBatchView() {
  const cb = state.channelBatch;
  if (!cb.videos.length) return '';
  const totalDrafts = cb.videos.reduce((s, e) => s + (e.results || []).filter(r => r.draft).length, 0);
  return `
  <div id="channel-batch-results" class="parchment rounded-xl p-5 fade-in space-y-4 mt-5">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <h3 class="serif text-lg font-bold gold-text"><i class="fas fa-layer-group mr-2"></i>영상별 일괄 생성 결과</h3>
      <span class="text-xs text-stone-500">
        ${cb.running ? `진행 ${cb.done}/${cb.total}` : `영상 ${cb.videos.length}개`} · 답글 ${totalDrafts}개
      </span>
    </div>
    ${cb.running ? `<div class="text-sm text-stone-500"><span class="spinner"></span> ${esc(cb.current || '')} 처리 중… (영상 ${cb.done}/${cb.total})</div>` : ''}
    ${(!cb.running && totalDrafts > 0) ? `
      <button id="cbatch-copy-all" onclick="window.__copyChannelBatchAll()" class="w-full bg-stone-800 text-white font-bold py-3 rounded-xl hover:bg-stone-700 transition">
        <i class="fas fa-copy mr-2"></i>전체 ${totalDrafts}개 답글 복사 (영상·댓글 구분선 포함)
      </button>` : ''}
    <div class="space-y-4">
      ${cb.videos.map(entry => channelBatchVideoCard(entry)).join('')}
    </div>
    <p class="text-xs text-stone-400"><i class="fas fa-circle-info mr-1"></i>각 초안은 검토·수정 후 직접 게시하세요. 영상마다 '이 영상 전체 복사'로 옮긴 뒤, 댓글마다 나눠 붙여넣으면 편해요.</p>
  </div>`;
}

// 영상 1개의 결과 카드 (2번째 스크린샷 형태)
function channelBatchVideoCard(entry) {
  const rows = entry.results || [];
  const withDraft = rows.filter(r => r.draft);
  const reviewRows = rows.filter(r => r.mode === 'review');
  let statusLine = '';
  if (entry.status === 'pending') statusLine = '<span class="text-xs text-stone-400">대기 중…</span>';
  else if (entry.status === 'loading') statusLine = '<span class="text-xs text-amber-600"><span class="spinner"></span> 미답변 댓글 수집 중…</span>';
  else if (entry.status === 'generating') {
    const pg = entry.progress;
    const pgText = pg && pg.total ? ` (${pg.done}/${pg.total}건 완료)` : '';
    statusLine = `<span class="text-xs text-amber-600"><span class="spinner"></span> 답글을 짓는 중…${pgText} <span class="text-stone-400">— 한 건당 40~60초 걸려요</span></span>`;
  }
  else if (entry.status === 'empty') statusLine = '<span class="text-xs text-emerald-700"><i class="fas fa-circle-check mr-1"></i>미답변 사주 댓글이 없어요.</span>';
  else if (entry.status === 'error') statusLine = `<span class="text-xs text-rose-500"><i class="fas fa-circle-exclamation mr-1"></i>${esc(entry.error||'실패')}</span>`;
  else if (entry.status === 'done') statusLine = entry.stats ? `<span class="text-xs text-stone-500">생성 ${entry.stats.generated} · 건너뜀 ${entry.stats.skipped}${entry.stats.review ? ` · <span class="text-rose-600 font-semibold">검토필요 ${entry.stats.review}</span>` : ''} · 실패 ${entry.stats.failed}</span>` : '';

  return `
  <div id="cbatch-${entry.video_id}" class="border border-stone-200 rounded-xl p-4 bg-white/50 space-y-3">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <div class="min-w-0">
        <div class="serif font-bold text-stone-700 truncate"><i class="fab fa-youtube text-red-500 mr-1"></i>${esc((entry.title||entry.video_id).slice(0,50))}</div>
        <div class="mt-0.5">${statusLine}</div>
      </div>
      ${withDraft.length ? `<button id="cbatch-copy-${entry.video_id}" onclick="window.__copyVideoBatch('${entry.video_id}')" class="text-xs bg-stone-100 hover:bg-stone-200 rounded-lg px-3 py-1.5 font-semibold whitespace-nowrap"><i class="fas fa-copy mr-1"></i>이 영상 전체 복사</button>` : ''}
    </div>
    ${withDraft.length ? `<div class="space-y-3">
      ${rows.map(r => {
        const idxDraft = withDraft.indexOf(r);
        if (r.skipped) return `<div class="bg-stone-50 border border-stone-200 rounded-lg p-3 text-sm opacity-70"><div class="text-xs text-stone-400 mb-1">@${esc(r.author||'')} · 건너뜀(사주 정보 없음)</div><div class="text-stone-600">${esc((r.text||'').slice(0,100))}</div></div>`;
        if (r.error) return `<div class="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm"><div class="text-xs text-rose-500 mb-1">@${esc(r.author||'')} · 생성 실패</div><div class="text-stone-600">${esc((r.text||'').slice(0,100))}</div></div>`;
        const modeBadge = r.mode === 'guide'
          ? '<span class="badge bg-amber-100 text-amber-700">되묻기</span>'
          : (r.year_from_title ? '<span class="badge bg-amber-100 text-amber-700">제목연도</span>' : '<span class="badge bg-green-100 text-green-700">풀이</span>');
        return `<div class="bg-white/80 border border-stone-200 rounded-lg p-3 text-sm space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-xs text-stone-500"><i class="fas fa-user mr-1"></i>${esc(r.author||'')} ${modeBadge} <span class="text-stone-400">${r.draft.length}자</span></div>
            <button id="cbatch-one-${entry.video_id}-${idxDraft}" onclick="window.__copyVideoOne('${entry.video_id}',${idxDraft})" class="text-xs bg-stone-100 hover:bg-stone-200 rounded-lg px-2 py-1" title="이 답글만 복사"><i class="fas fa-copy"></i></button>
          </div>
          <div class="text-xs text-stone-400 bg-stone-50 rounded p-2">원댓글: ${esc((r.text||'').replace(/\s+/g,' ').slice(0,120))}</div>
          <textarea class="w-full border border-stone-200 rounded-lg p-3 draft-area bg-white/70 text-sm" rows="8">${esc(r.draft)}</textarea>
        </div>`;
      }).join('')}
    </div>` : ''}
    ${reviewRows.length ? `<div class="space-y-2">
      <div class="text-xs font-semibold text-rose-600"><i class="fas fa-flag mr-1"></i>검토 필요 — 사장님 직접 답변 권장 (${reviewRows.length}개)</div>
      ${reviewRows.map(r => `<div class="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm space-y-1">
        <div class="text-xs text-rose-500"><i class="fas fa-user mr-1"></i>${esc(r.author||'')} · <span class="font-semibold">${esc(r.reviewReason||'사람이 직접 답해야 하는 댓글')}</span></div>
        <div class="text-stone-700 bg-white/70 rounded p-2">${esc((r.text||'').replace(/\s+/g,' ').slice(0,200))}</div>
      </div>`).join('')}
    </div>` : ''}
    ${(entry.status === 'done' && entry.truncated) ? `<div class="text-xs text-amber-700 bg-amber-50 rounded-lg p-2"><i class="fas fa-triangle-exclamation mr-1"></i>댓글이 많아 앞에서 일부만 처리했어요. 나머지 ${entry.truncated}개는 '열기'로 다시 처리해 주세요.</div>` : ''}
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
          <div class="mt-2 flex items-center gap-3 flex-wrap">
            <button onclick="window.__useComment(${y.list.indexOf(c)})" class="text-xs gold-text font-semibold hover:underline"><i class="fas fa-arrow-up-right-from-square mr-1"></i>이 댓글로 하나만 작성</button>
            <button onclick="window.__ignoreComment(${y.list.indexOf(c)})" class="text-xs text-stone-400 hover:text-rose-500 font-medium" title="이미 답글을 달았거나 답글 위치를 못 찾는 댓글입니다. 다음부터 불러오지 않습니다."><i class="fas fa-eye-slash mr-1"></i>무시(이미 답글 달았어요)</button>
          </div>
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

// 무시 목록 관리 뷰 — 무시한 댓글이 1건이라도 있을 때만 표시
function ignoreListView() {
  const n = ignoreCount();
  if (!n) return '';
  const open = state.ignorePanelOpen;
  const entries = [...ignoreMap.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  return `
  <div class="parchment rounded-xl p-5">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <button onclick="window.__toggleIgnorePanel()" class="serif font-bold text-stone-600 hover:text-stone-800 flex items-center gap-2">
        <i class="fas fa-eye-slash text-stone-400"></i>
        무시한 댓글 <span class="badge bg-stone-200 text-stone-600">${n}건</span>
        <i class="fas fa-chevron-${open ? 'up' : 'down'} text-xs text-stone-400"></i>
      </button>
      ${open ? `<button onclick="window.__clearIgnore()" class="text-xs text-rose-500 hover:underline font-medium"><i class="fas fa-trash-can mr-1"></i>모두 해제</button>` : ''}
    </div>
    <p class="text-xs text-stone-400 mt-1"><i class="fas fa-circle-info mr-1"></i>여기 있는 댓글은 다음에 영상을 다시 불러와도 목록에 나타나지 않아요. (이 브라우저에만 저장됩니다)</p>
    ${open ? `
    <div class="mt-3 space-y-2 max-h-64 overflow-y-auto">
      ${entries.map(([id, m]) => `
        <div class="bg-white/70 border border-stone-200 rounded-lg p-3 text-sm flex justify-between items-start gap-3">
          <div class="min-w-0">
            <div class="text-xs text-stone-400">${m.author ? esc(m.author) : '(작성자 정보 없음)'}${m.at ? ' · ' + timeAgo(new Date(m.at).toISOString()) + ' 무시함' : ''}</div>
            <div class="text-stone-600 truncate">${m.text ? esc(m.text) : '<span class=\"text-stone-400\">(미리보기 없음)</span>'}</div>
          </div>
          <button onclick="window.__unignoreComment('${esc(id)}')" class="text-xs gold-text font-semibold hover:underline whitespace-nowrap"><i class="fas fa-rotate-left mr-1"></i>해제</button>
        </div>`).join('')}
    </div>` : ''}
  </div>`;
}

// ── 수동 입력(댓글 직접 붙여넣기) — 접이식, 기본 접힘 ──
//   "이 댓글로 하나만 작성" 등으로 댓글이 채워지면 자동으로 펼친다.
function manualView() {
  const open = state.manualOpen || !!state.comment || !!state.pickedAuthor;
  return `
  <div class="parchment rounded-xl p-5 space-y-4">
    <button onclick="window.__toggleManual()" class="w-full flex items-center justify-between">
      <h3 class="serif text-lg font-bold gold-text"><i class="fas fa-keyboard mr-2"></i>댓글 하나 직접 입력 ${state.pickedAuthor ? `<span class="text-xs font-normal text-stone-500 bg-amber-50 rounded-full px-2 py-0.5 ml-1"><i class="fas fa-user mr-1"></i>${esc(state.pickedAuthor)}</span>` : ''}</h3>
      <i class="fas fa-chevron-${open ? 'up' : 'down'} text-stone-400"></i>
    </button>
    ${open ? `
    <div class="space-y-4 fade-in">
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
    </div>` : `<p class="text-xs text-stone-400 -mt-2">댓글 하나만 직접 붙여넣어 풀고 싶을 때 펼치세요.</p>`}
  </div>`;
}

// ── 스크린샷 붙여넣기 입력 영역 (노란 구역 자리) ──
function ocrInputView() {
  const o = state.ocr;
  const hasImg = !!o.image;
  return `
  <div class="parchment rounded-xl p-5 space-y-4">
    <h3 class="serif text-lg font-bold gold-text"><i class="fas fa-image mr-2"></i>스크린샷으로 한 번에 답글 짓기</h3>
    <p class="text-sm text-stone-500 -mt-1">유튜브 관리자 <b>커뮤니티/댓글 화면을 캡쳐</b>해서 아래에 <b>붙여넣기(Ctrl+V)</b> 하거나 이미지를 올리면, 화면 속 댓글들을 각각 사주로 인식해 답글을 한꺼번에 지어드려요.</p>

    ${!hasImg ? `
    <label id="ocr-drop" class="block border-2 border-dashed border-stone-300 rounded-xl p-8 text-center cursor-pointer hover:border-amber-400 hover:bg-amber-50/40 transition">
      <input id="ocr-file" type="file" accept="image/*" class="hidden" />
      <div class="text-stone-400"><i class="fas fa-paste text-3xl mb-2"></i></div>
      <div class="text-stone-600 font-semibold">여기에 캡쳐 이미지를 붙여넣기 (Ctrl+V)</div>
      <div class="text-xs text-stone-400 mt-1">또는 클릭해서 이미지 파일 선택 · PNG/JPG, 8MB 이하 권장</div>
    </label>` : `
    <div class="space-y-3">
      <div class="relative">
        <img src="${o.image}" class="w-full rounded-lg border border-stone-200 max-h-72 object-contain bg-stone-50" />
        <button onclick="window.__ocrClear()" class="absolute top-2 right-2 bg-white/90 border border-stone-300 rounded-lg px-2 py-1 text-xs hover:bg-rose-50 hover:text-rose-600"><i class="fas fa-xmark mr-1"></i>지우기</button>
      </div>
      ${o.extracting ? `<div class="text-sm text-stone-500"><span class="spinner"></span> 이미지에서 댓글을 읽고 있어요…</div>` : ''}
      ${(!o.extracting && o.items) ? `<button onclick="window.__ocrRetry()" class="text-xs gold-text font-semibold hover:underline"><i class="fas fa-rotate mr-1"></i>다시 읽기</button>` : ''}
    </div>`}

    ${o.error ? `<div class="bg-rose-50 text-rose-700 rounded-lg p-3 text-sm"><i class="fas fa-circle-exclamation mr-2"></i>${esc(o.error)}</div>` : ''}

    ${ocrReviewView()}
  </div>`;
}

// 추출된 댓글 검토/편집 영역 (일괄 생성 전 확인 단계)
function ocrReviewView() {
  const o = state.ocr;
  if (!o.items || !o.items.length) return '';
  const valid = o.items.filter(it => (it.text || '').trim()).length;
  return `
  <div class="space-y-3 border-t border-stone-200 pt-4">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <h4 class="serif font-bold text-stone-700"><i class="fas fa-list-check mr-2 gold-text"></i>읽어낸 댓글 ${o.items.length}건 <span class="text-xs font-normal text-stone-400">— 보내기 전에 확인·수정하세요</span></h4>
      <button onclick="window.__ocrAdd()" class="text-xs gold-text font-semibold hover:underline"><i class="fas fa-plus mr-1"></i>댓글 추가</button>
    </div>
    <div class="space-y-2">
      ${o.items.map((it, i) => `
        <div class="bg-white/70 border border-stone-200 rounded-lg p-3 space-y-2">
          <div class="flex items-center gap-2">
            <span class="text-xs text-stone-400 whitespace-nowrap">#${i + 1}</span>
            <input data-ocr-author="${i}" value="${esc(it.author)}" placeholder="작성자" class="flex-1 border border-stone-200 rounded-lg px-2 py-1.5 text-sm" />
            <button onclick="window.__ocrRemove(${i})" class="text-stone-400 hover:text-rose-500 px-2" title="이 댓글 삭제"><i class="fas fa-trash-can"></i></button>
          </div>
          <textarea data-ocr-text="${i}" rows="2" placeholder="댓글 본문 (생년월일·질문 등)" class="w-full border border-stone-200 rounded-lg p-2 text-sm">${esc(it.text)}</textarea>
          <div class="flex items-center gap-2 text-xs">
            <label class="text-stone-500 whitespace-nowrap"><i class="fas fa-clapperboard mr-1 text-amber-500"></i>영상 출생연도</label>
            <input data-ocr-vyear="${i}" value="${esc(it.videoYear || '')}" placeholder="연도 (선택)" maxlength="4" inputmode="numeric" class="w-28 border border-stone-200 rounded-lg px-2 py-1.5" />
            ${it.videoYear ? `<span class="badge bg-amber-100 text-amber-700">OCR 인식</span>` : `<span class="text-stone-400">댓글에 연도 없으면 이 연도로 풀어요</span>`}
          </div>
        </div>`).join('')}
    </div>
    <p class="text-xs text-stone-400"><i class="fas fa-circle-info mr-1"></i>OCR이 글자를 잘못 읽었을 수 있어요. 특히 <b>생년월일·연도</b>가 정확한지 꼭 확인해 주세요. <b>댓글에 연도가 없어도 '영상 출생연도'가 있으면 그 연도(연주)로 풀이</b>하고, 월·일까지 없으면 어쩔 수 없이 '되묻기' 답글이 만들어져요.</p>
    <button onclick="window.__ocrGenerate()" ${o.batch.running ? 'disabled' : ''}
      class="w-full gold-bg text-white font-bold py-3 rounded-xl hover:opacity-90 transition disabled:opacity-60 flex items-center justify-center gap-2">
      ${o.batch.running ? '<span class="spinner"></span> 답글 짓는 중…' : `<i class="fas fa-wand-magic-sparkles"></i> ${valid}건 답글 한꺼번에 짓기`}
    </button>
  </div>
  ${ocrResultsView()}`;
}

// 스크린샷 일괄 생성 결과 뷰
function ocrResultsView() {
  const b = state.ocr.batch;
  if (!b.running && (!b.results || !b.results.length) && !b.error) return '';
  const rows = (b.results || []);
  const withDraft = rows.filter(r => r.draft);
  return `
  <div id="ocr-results" class="border-t border-stone-200 pt-4 mt-4 space-y-4 fade-in">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <h4 class="serif font-bold gold-text"><i class="fas fa-layer-group mr-2"></i>생성 결과</h4>
      ${b.stats ? `<span class="text-xs text-stone-500">생성 ${b.stats.generated} · 되묻기/건너뜀 ${b.stats.skipped}${b.stats.review ? ` · <span class="text-rose-600 font-semibold">검토필요 ${b.stats.review}</span>` : ''} · 실패 ${b.stats.failed}</span>` : ''}
    </div>
    ${b.error ? `<div class="bg-rose-50 text-rose-700 rounded-lg p-3 text-sm"><i class="fas fa-circle-exclamation mr-2"></i>${esc(b.error)}</div>` : ''}
    ${b.running ? `<div class="text-sm text-stone-500"><span class="spinner"></span> 답글을 짓고 있어요. 댓글 수에 따라 30초~1분 걸릴 수 있어요.</div>` : ''}
    ${(!b.running && withDraft.length) ? `
      <button id="ocr-copy-all" onclick="window.__copyOcrAll()" class="w-full bg-stone-800 text-white font-bold py-3 rounded-xl hover:bg-stone-700 transition">
        <i class="fas fa-copy mr-2"></i>${withDraft.length}개 답글 전체 복사 (댓글 구분선 포함)
      </button>` : ''}
    <div class="space-y-3">
      ${rows.map((r) => {
        const idxDraft = withDraft.indexOf(r);
        if (r.mode === 'review') {
          return `<div class="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm space-y-1">
            <div class="text-xs text-rose-500"><i class="fas fa-flag mr-1"></i>@${esc(r.author||'')} · <span class="badge bg-rose-100 text-rose-700">검토 필요</span> <span class="font-semibold">${esc(r.reviewReason||'사장님 직접 답변 권장')}</span></div>
            <div class="text-stone-700 bg-white/70 rounded p-2">${esc((r.text||'').replace(/\s+/g,' ').slice(0,200))}</div>
          </div>`;
        }
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
          : (r.year_from_title ? '<span class="badge bg-amber-100 text-amber-700">영상연도</span>' : '<span class="badge bg-green-100 text-green-700">풀이</span>');
        return `<div class="bg-white/70 border border-stone-200 rounded-lg p-3 text-sm space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-xs text-stone-500"><i class="fas fa-user mr-1"></i>${esc(r.author||'')} ${modeBadge} <span class="text-stone-400">${r.draft.length}자</span></div>
            <button id="ocr-copy-${idxDraft}" onclick="window.__copyOcrOne(${idxDraft})" class="text-xs bg-stone-100 hover:bg-stone-200 rounded-lg px-2 py-1" title="이 답글만 복사"><i class="fas fa-copy"></i></button>
          </div>
          <div class="text-xs text-stone-400 bg-stone-50 rounded p-2">원댓글: ${esc((r.text||'').replace(/\s+/g,' ').slice(0,120))}</div>
          <textarea class="w-full border border-stone-200 rounded-lg p-3 draft-area bg-white/70 text-sm" rows="8">${esc(r.draft)}</textarea>
        </div>`;
      }).join('')}
    </div>
  </div>`;
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
      ${b.stats ? `<span class="text-xs text-stone-500">생성 ${b.stats.generated} · 건너뜀 ${b.stats.skipped}${b.stats.review ? ` · <span class="text-rose-600 font-semibold">검토필요 ${b.stats.review}</span>` : ''} · 실패 ${b.stats.failed}</span>` : ''}
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
        if (r.mode === 'review') {
          return `<div class="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm space-y-1">
            <div class="text-xs text-rose-500"><i class="fas fa-flag mr-1"></i>@${esc(r.author||'')} · <span class="badge bg-rose-100 text-rose-700">검토 필요</span> <span class="font-semibold">${esc(r.reviewReason||'사장님 직접 답변 권장')}</span></div>
            <div class="text-stone-700 bg-white/70 rounded p-2">${esc((r.text||'').replace(/\s+/g,' ').slice(0,200))}</div>
          </div>`;
        }
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
      ${ocrInputView()}

      ${manualView()}

      ${inputView()}
      ${channelView()}
      ${youtubeView()}
      ${ignoreListView()}
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

  // 스크린샷 OCR: 파일 선택
  const ocrFile = document.getElementById('ocr-file');
  if (ocrFile) ocrFile.addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) handleOcrFile(f); });
  // 추출된 댓글 편집칸 바인딩 (작성자/본문) — render 무방하게 state만 갱신
  document.querySelectorAll('[data-ocr-author]').forEach(elx => {
    elx.addEventListener('input', e => { const i = +elx.getAttribute('data-ocr-author'); if (state.ocr.items && state.ocr.items[i]) state.ocr.items[i].author = e.target.value; });
  });
  document.querySelectorAll('[data-ocr-text]').forEach(elx => {
    elx.addEventListener('input', e => { const i = +elx.getAttribute('data-ocr-text'); if (state.ocr.items && state.ocr.items[i]) state.ocr.items[i].text = e.target.value; });
  });
  document.querySelectorAll('[data-ocr-vyear]').forEach(elx => {
    elx.addEventListener('input', e => { const i = +elx.getAttribute('data-ocr-vyear'); if (state.ocr.items && state.ocr.items[i]) state.ocr.items[i].videoYear = e.target.value.replace(/[^0-9]/g, ''); });
  });
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
window.__genVideo = generateForVideo;
window.__genAllVideos = generateForAllVideos;
window.__copyVideoBatch = copyVideoBatch;
window.__copyVideoOne = copyVideoOne;
window.__copyChannelBatchAll = copyChannelBatchAll;
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

// 댓글 무시: 목록에 추가하고 현재 화면에서도 즉시 제거 (인덱스로 받아 작성자·텍스트도 저장)
window.__ignoreComment = (i) => {
  const c = (state.youtube.list || [])[i];
  if (!c || !c.comment_id) return;
  const id = c.comment_id;
  addIgnore(c);
  state.youtube.list = (state.youtube.list || []).filter(x => x.comment_id !== id);
  render();
};
// 무시 목록에서 특정 댓글 해제
window.__unignoreComment = (id) => { removeIgnore(id); render(); };
// 무시 목록 전체 비우기
window.__clearIgnore = () => {
  if (!ignoreSet.size) return;
  if (window.confirm(`무시 목록 ${ignoreSet.size}건을 모두 해제할까요?\n해제하면 다음에 댓글을 다시 불러올 때 그 댓글들이 목록에 다시 나타납니다.`)) {
    clearIgnore();
    render();
  }
};
// 무시 목록 패널 펼침/접힘 토글
window.__toggleIgnorePanel = () => { state.ignorePanelOpen = !state.ignorePanelOpen; render(); };

// 수동 입력 박스 펼침/접힘 토글
window.__toggleManual = () => { state.manualOpen = !state.manualOpen; render(); };

// 스크린샷 OCR 핸들러
window.__ocrClear = ocrClear;
window.__ocrRetry = runOcrExtract;
window.__ocrAdd = ocrAddItem;
window.__ocrRemove = ocrRemoveItem;
window.__ocrGenerate = ocrGenerate;
window.__copyOcrAll = copyOcrBatchAll;
window.__copyOcrOne = copyOcrOne;

// 어디서든 캡쳐 이미지를 Ctrl+V 로 붙여넣으면 OCR 입력으로 받는다
//   (단, 텍스트 입력칸에 포커스가 있을 때는 그쪽 붙여넣기를 방해하지 않도록 이미지일 때만 가로챈다)
document.addEventListener('paste', handleGlobalPaste);

loadStatus();
render();
