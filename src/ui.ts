/**
 * ui.ts — 서버가 내보내는 HTML (SPA 셸 + 로그인 페이지)
 *
 * 메인 화면은 최소 셸(<div id="app">)이고, 실제 UI는 /static/app.js 가
 * 클라이언트에서 렌더한다(원본 사이트와 동일한 SPA 구조).
 */

/** 메인 SPA 셸 */
export const SHELL_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>천기누설 만신보감 · 사주 답글 작성실</title>
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml" />
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet" />
  <link href="/static/style.css" rel="stylesheet" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;600;700&family=Noto+Sans+KR:wght@400;500;700&display=swap" rel="stylesheet">
</head>
<body class="bg-stone-100 text-stone-800">
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script src="/static/app.js"></script>
</body>
</html>`

/** 로그인 페이지 (error=true면 비밀번호 오류 메시지 표시) */
export function loginPageHtml(error: boolean): string {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>천기누설 만신보감 · 로그인</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet" />
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@600;700&display=swap" rel="stylesheet"></head>
<body class="bg-stone-100 min-h-screen flex items-center justify-center px-4">
  <form method="POST" action="/login" class="bg-white rounded-2xl shadow-sm border border-stone-200 p-8 w-full max-w-sm space-y-4">
    <div class="text-center">
      <div style="font-family:'Noto Serif KR',serif" class="text-2xl font-bold text-stone-800">천기누설 만신보감</div>
      <div class="text-amber-700 font-semibold text-sm mt-1"><i class="fas fa-feather-pointed mr-1"></i>사주 답글 작성실</div>
    </div>
    <div id="login-error" class="bg-rose-50 text-rose-700 rounded-lg p-3 text-sm text-center ${error ? '' : 'hidden'}"><i class="fas fa-circle-exclamation mr-1"></i>비밀번호가 올바르지 않습니다.</div>
    <input id="pw" type="password" name="password" autocomplete="current-password" autofocus placeholder="비밀번호" class="w-full border border-stone-300 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-amber-400" />
    <button id="login-btn" type="submit" class="w-full bg-stone-800 text-white font-bold py-3 rounded-xl hover:bg-stone-700 transition"><i class="fas fa-lock-open mr-2"></i>입장하기</button>
    <p class="text-xs text-stone-400 text-center"><i class="fas fa-shield-halved mr-1"></i>이 작업실은 운영자 전용입니다.</p>
  </form>
  <script>
    (function () {
      var form = document.querySelector('form');
      var btn = document.getElementById('login-btn');
      var errBox = document.getElementById('login-error');
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var pw = document.getElementById('pw').value;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>확인 중…';
        try {
          var res = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'password=' + encodeURIComponent(pw),
            redirect: 'manual',
            credentials: 'same-origin'
          });
          if (res.status === 302 || res.status === 0 || res.type === 'opaqueredirect' || res.ok) {
            window.location.href = '/';
          } else {
            errBox.classList.remove('hidden');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-lock-open mr-2"></i>입장하기';
          }
        } catch (err) {
          form.submit();
        }
      });
    })();
  </script>
</body></html>`
}
