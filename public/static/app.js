/* 천기누설 만신보감 · 사주 답글 작성실 — 프론트엔드 로직 */
(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const ELEM_COLORS = { 목: '#7fc69a', 화: '#e8836b', 토: '#d6b35a', 금: '#d8d8d8', 수: '#6fa8d4' }

  let lastDataBlock = null // batch 전체 복사용
  let collectedComments = [] // 유튜브에서 수집한 댓글

  // ── 토스트 ────────────────────────────────────────────────────
  let toastTimer
  function toast(msg) {
    const t = $('toast')
    t.textContent = msg
    t.classList.remove('hidden')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2200)
  }

  // ── 상태 표시 ─────────────────────────────────────────────────
  async function loadStatus() {
    try {
      const { data } = await axios.get('/api/status')
      const chip = $('status-chip')
      const parts = []
      parts.push(data.anthropic_key_set ? '🟢 Claude' : '🔴 Claude키없음')
      parts.push(data.youtube_key_set ? '🟢 YouTube' : '⚪ YouTube키없음')
      parts.push(`<span class="text-amber-200/80">${data.model}</span>`)
      chip.innerHTML = parts.join(' · ')
    } catch {
      $('status-chip').innerHTML = '🔴 서버 응답 없음'
    }
  }

  // ── 입력 수집 ─────────────────────────────────────────────────
  function gatherInput() {
    const v = (id) => {
      const el = $(id)
      return el && el.value !== '' ? el.value : undefined
    }
    return {
      comment: $('comment').value || '',
      year: v('in-year'),
      month: v('in-month'),
      day: v('in-day'),
      hour: v('in-hour'),
      minute: v('in-minute'),
      gender: v('in-gender'),
      calendar: $('in-calendar').value,
      isLeapMonth: $('in-leap').value === 'true',
    }
  }

  // ── 만세력 렌더 ───────────────────────────────────────────────
  function renderSaju(saju, parsed) {
    const box = $('saju-view')
    if (!saju) {
      box.innerHTML = '<p class="text-stone-400">계산 결과가 없어요.</p>'
      return
    }
    if (saju.mode === 'guide') {
      box.innerHTML =
        '<div class="note note-warn"><i class="fas fa-circle-question"></i> 날짜가 모호해서 계산을 보류했어요. 아래 입력칸으로 보정해 주세요.</div>' +
        renderNotes(saju.notes)
      return
    }

    const modeLabel = {
      full: '4기둥(시간 정확)',
      three_pillar: '3기둥(시간 모름)',
      estimate: '시간 추정',
    }[saju.mode] || saju.mode

    const p = saju.pillars
    const cards = [
      pillarCard('시주', p.hour),
      pillarCard('일주', p.day, true),
      pillarCard('월주', p.month),
      pillarCard('연주', p.year),
    ].join('')

    // 오행 막대
    const total = Object.values(saju.elementCount).reduce((a, b) => a + b, 0) || 1
    const bars = ['목', '화', '토', '금', '수'].map((el) => {
      const n = saju.elementCount[el] || 0
      const pct = Math.round((n / total) * 100)
      return `<div class="bar-row"><span class="name el-${el}">${el}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${ELEM_COLORS[el]}"></span></span>
        <span class="text-xs text-stone-400 w-6 text-right">${n}</span></div>`
    }).join('')

    let luckHtml = ''
    if (saju.luck) {
      const dir = saju.luck.forward ? '순행' : '역행'
      const items = saju.luck.pillars.slice(0, 8).map((lp) =>
        `<span class="chip">${lp.age}세 ${lp.korean}</span>`).join('')
      luckHtml = `<div class="mt-3"><div class="text-xs text-stone-400 mb-1">대운 (${dir}, ${saju.luck.startAge}세 시작)</div>${items}</div>`
    }

    box.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <span class="chip">${modeLabel}</span>
        <span class="text-sm">일간 <b class="el-${saju.dayMasterElement}">${saju.dayMaster}(${saju.dayMasterElement})</b></span>
      </div>
      <div class="text-center font-serif text-lg text-amber-200 mb-3">${saju.eightChar}</div>
      <div class="pillar-grid mb-3">${cards}</div>
      <div class="text-xs text-stone-400 mb-1">오행 분포</div>
      ${bars}
      ${saju.voidBranches.length ? `<div class="mt-2 text-sm">공망(空亡): <b class="text-amber-200">${saju.voidBranches.join('·')}</b></div>` : ''}
      ${luckHtml}
      ${renderNotes(saju.notes)}
    `
  }

  function pillarCard(label, pillar, isDay) {
    if (!pillar) {
      return `<div class="pillar-card opacity-50"><div class="label">${label}</div><div class="gan">?</div><div class="ji">?</div><div class="tg">—</div></div>`
    }
    const ring = isDay ? 'style="border-color:rgba(212,175,55,0.6)"' : ''
    return `<div class="pillar-card" ${ring}>
      <div class="label">${label}${isDay ? ' ★' : ''}</div>
      <div class="gan el-${pillar.stemElement}">${pillar.stem}</div>
      <div class="ji el-${pillar.branchElement}">${pillar.branch}</div>
      <div class="tg">${pillar.stemTenGod} · ${pillar.branchTenGod}</div>
    </div>`
  }

  function renderNotes(notes) {
    if (!notes || !notes.length) return ''
    return notes.map((n) => {
      const warn = n.includes('위기') || n.includes('이상') || n.includes('보류') || n.includes('추정')
      return `<div class="note ${warn ? 'note-warn' : 'note-info'}">${escapeHtml(n)}</div>`
    }).join('')
  }

  function renderAmbiguity(parsed) {
    const box = $('ambiguity')
    const list = (parsed && parsed.ambiguity) || []
    if (!list.length) { box.innerHTML = ''; return }
    box.innerHTML = list.map((a) => {
      const warn = a.includes('위기') || a.includes('추정') || a.includes('확인') || a.includes('못')
      return `<div class="note ${warn ? 'note-warn' : 'note-info'}"><i class="fas fa-circle-info mr-1"></i>${escapeHtml(a)}</div>`
    }).join('')
  }

  function fillParsedIntoForm(parsed) {
    // 파싱 결과를 빈 칸에만 채워 운영자가 확인하기 쉽게 (수동 입력은 보존)
    const set = (id, val) => { const el = $(id); if (el && el.value === '' && val != null) el.value = val }
    set('in-year', parsed.year); set('in-month', parsed.month); set('in-day', parsed.day)
    if (parsed.hour != null) set('in-hour', parsed.hour)
    if (parsed.minute != null) set('in-minute', parsed.minute)
    if (parsed.gender) { const g = $('in-gender'); if (!g.value) g.value = parsed.gender }
    if (parsed.calendar) $('in-calendar').value = parsed.calendar
    $('in-leap').value = parsed.isLeapMonth ? 'true' : 'false'
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  // ── 만세력 계산 ───────────────────────────────────────────────
  async function analyze() {
    const btn = $('btn-analyze')
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spinner mr-1"></i>계산중'
    try {
      const { data } = await axios.post('/api/analyze', gatherInput())
      if (!data.ok) { toast(data.error || '계산 실패'); return }
      fillParsedIntoForm(data.parsed)
      renderAmbiguity(data.parsed)
      renderSaju(data.saju, data.parsed)
    } catch (e) {
      toast('계산 오류: ' + (e?.response?.data?.error || e.message))
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-calculator mr-1"></i>만세력 계산하기'
    }
  }

  // ── AI 초안 생성 ──────────────────────────────────────────────
  async function draft() {
    const btn = $('btn-draft')
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spinner mr-1"></i>AI 작성중…'
    $('draft-meta').textContent = ''
    try {
      const { data } = await axios.post('/api/draft', gatherInput())
      if (data.saju) renderSaju(data.saju, data.parsed)
      if (data.parsed) { fillParsedIntoForm(data.parsed); renderAmbiguity(data.parsed) }
      if (!data.ok) { toast(data.error || 'AI 생성 실패'); return }
      $('draft').value = data.draft.text
      lastDataBlock = data.dataBlock
      const u = data.draft.usage
      $('draft-meta').textContent =
        `${data.draft.model}${u ? ` · in ${u.input_tokens}/out ${u.output_tokens}` : ''} · ${data.draft.text.length}자`
    } catch (e) {
      toast('AI 오류: ' + (e?.response?.data?.error || e.message))
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-1"></i>AI 답글 초안 생성'
    }
  }

  // ── 복사 ──────────────────────────────────────────────────────
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('복사했어요 ✦') }
    catch { toast('복사 실패 (브라우저 권한 확인)') }
  }

  // ── 탭 전환 ───────────────────────────────────────────────────
  function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((x) => x.classList.remove('active'))
        b.classList.add('active')
        const tab = b.dataset.tab
        $('tab-single').classList.toggle('hidden', tab !== 'single')
        $('tab-youtube').classList.toggle('hidden', tab !== 'youtube')
      })
    })
  }

  // ── 유튜브: 링크 분석 ─────────────────────────────────────────
  async function ytGo() {
    const link = $('yt-link').value.trim()
    if (!link) { toast('링크를 입력해 주세요.'); return }
    const btn = $('btn-yt-go')
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spinner mr-1"></i>분석중'
    $('yt-result').innerHTML = ''
    $('batch-panel').classList.add('hidden')
    try {
      const { data: r } = await axios.get('/api/resolve-link', { params: { link } })
      if (r.target.kind === 'channel') {
        await scanChannel(link)
      } else if (r.target.kind === 'video') {
        await loadComments(r.target.id)
      } else {
        $('yt-result').innerHTML = '<div class="note note-warn">채널/영상 링크를 인식하지 못했어요.</div>'
      }
    } catch (e) {
      $('yt-result').innerHTML = `<div class="note note-warn">${escapeHtml(e?.response?.data?.error || e.message)}</div>`
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-magnifying-glass mr-1"></i>분석'
    }
  }

  async function scanChannel(link) {
    const { data } = await axios.get('/api/youtube/channel', { params: { link, maxVideos: 30 } })
    if (!data.ok) { $('yt-result').innerHTML = `<div class="note note-warn">${escapeHtml(data.error)}</div>`; return }
    const need = data.videos.filter((v) => v.needs_reply)
    if (!need.length) { $('yt-result').innerHTML = '<div class="note note-info">댓글이 있는 최근 영상을 찾지 못했어요.</div>'; return }
    $('yt-result').innerHTML =
      `<div class="text-sm text-stone-300 mb-2">답글 필요할 수 있는 영상 ${need.length}개 (댓글 많은 순)</div>` +
      need.map((v) => `
        <div class="video-row mb-2">
          <img src="${v.thumbnail}" alt="" />
          <div class="flex-1 min-w-0">
            <div class="text-sm text-stone-100 truncate">${escapeHtml(v.title)}</div>
            <div class="text-xs text-stone-400">댓글 ${v.comment_count ?? '?'}개 · ${v.published_at.slice(0,10)}</div>
          </div>
          <button class="btn-ghost text-sm" data-vid="${v.video_id}"><i class="fas fa-comments mr-1"></i>댓글 달기</button>
        </div>`).join('')
    $('yt-result').querySelectorAll('button[data-vid]').forEach((b) =>
      b.addEventListener('click', () => { $('yt-link').value = b.dataset.vid; loadComments(b.dataset.vid) }))
  }

  async function loadComments(videoId) {
    $('yt-result').innerHTML = '<div class="text-sm text-stone-400"><i class="fas fa-spinner spinner mr-1"></i>미답변 사주 댓글 수집중…</div>'
    const { data } = await axios.get('/api/youtube/comments', {
      params: { videoId, maxPages: 3, onlySaju: true, onlyUnanswered: true },
    })
    if (!data.ok) { $('yt-result').innerHTML = `<div class="note note-warn">${escapeHtml(data.error)}</div>`; return }
    collectedComments = data.comments
    if (!collectedComments.length) {
      $('yt-result').innerHTML = '<div class="note note-info">미답변 사주 댓글이 없어요.</div>'
      return
    }
    $('yt-result').innerHTML =
      `<div class="flex items-center justify-between mb-2">
         <span class="text-sm text-stone-300">미답변 사주 댓글 ${collectedComments.length}개</span>
       </div>` +
      collectedComments.map((c, i) => `
        <div class="comment-row mb-2">
          <input type="checkbox" class="cmt-chk mt-1" data-i="${i}" checked />
          <div class="flex-1 min-w-0">
            <div class="text-xs text-amber-200/80">${escapeHtml(c.author)} · 👍${c.like_count} · ${(c.published_at||'').slice(0,10)}</div>
            <div class="text-sm text-stone-200">${escapeHtml(c.text).slice(0, 280)}</div>
          </div>
        </div>`).join('')
    $('batch-panel').classList.remove('hidden')
    $('batch-result').innerHTML = ''
  }

  // ── 유튜브: 일괄 생성 ─────────────────────────────────────────
  async function runBatch() {
    const checked = [...document.querySelectorAll('.cmt-chk:checked')].map((c) => collectedComments[+c.dataset.i])
    if (!checked.length) { toast('선택된 댓글이 없어요.'); return }
    const btn = $('btn-batch')
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spinner mr-1"></i>생성중…'
    $('batch-result').innerHTML = '<div class="text-sm text-stone-400">최대 동시 4개로 생성 중…</div>'
    try {
      const { data } = await axios.post('/api/batch', { items: checked })
      if (!data.ok) { toast(data.error || '일괄 생성 실패'); return }
      $('batch-result').innerHTML =
        `<div class="text-sm text-stone-300 mb-1">완료: ${data.success}/${data.total}</div>` +
        data.results.map((r) => `
          <div class="batch-card">
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-amber-200/80">${escapeHtml(r.author)}${r.eightChar ? ' · ' + r.eightChar : ''}</span>
              ${r.ok ? `<button class="btn-ghost text-xs" data-copy="${encodeURIComponent(r.draft)}"><i class="far fa-copy"></i></button>` : ''}
            </div>
            ${r.ok
              ? `<div class="draft-text">${escapeHtml(r.draft)}</div>`
              : `<div class="note note-warn">${escapeHtml(r.error)}</div>`}
          </div>`).join('')
      $('batch-result').querySelectorAll('button[data-copy]').forEach((b) =>
        b.addEventListener('click', () => copyText(decodeURIComponent(b.dataset.copy))))
    } catch (e) {
      toast('오류: ' + (e?.response?.data?.error || e.message))
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-bolt mr-1"></i>선택 댓글 일괄 생성'
    }
  }

  function copyAllBatch() {
    const cards = [...document.querySelectorAll('.batch-card .draft-text')]
    if (!cards.length) { toast('복사할 초안이 없어요.'); return }
    const all = cards.map((c, i) => `── ${i + 1} ──\n${c.textContent}`).join('\n\n')
    copyText(all)
  }

  // ── 초기화 ────────────────────────────────────────────────────
  function init() {
    setupTabs()
    loadStatus()
    $('btn-analyze').addEventListener('click', analyze)
    $('btn-draft').addEventListener('click', draft)
    $('btn-copy').addEventListener('click', () => copyText($('draft').value))
    $('btn-yt-go').addEventListener('click', ytGo)
    $('btn-batch').addEventListener('click', runBatch)
    $('btn-copy-all').addEventListener('click', copyAllBatch)
    $('yt-link').addEventListener('keydown', (e) => { if (e.key === 'Enter') ytGo() })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
