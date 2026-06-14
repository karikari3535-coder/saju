import build from '@hono/vite-build/cloudflare-pages'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ─────────────────────────────────────────────────────────────────
// 빌드 타임 시크릿 인라인 (옵션 A)
//   wrangler `vars` 는 배포 로그에 값이 평문으로 찍힌다. 이를 피하기 위해
//   민감 키를 vars 에서 빼고, 빌드 시점에 코드 번들 안으로 직접 주입한다.
//   값의 출처는 git 에서 제외된 .prod.vars(있으면) → .dev.vars 순서.
//   런타임 코드는 `c.env.X || __INLINE_X__` 로 읽으므로,
//   나중에 vars/secret 을 다시 채우면 그쪽이 우선한다(유연성 유지).
// ─────────────────────────────────────────────────────────────────
function parseDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(path)) return out
  const raw = readFileSync(path, 'utf-8')
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    // 양쪽 따옴표 제거
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

function loadInlineSecrets(): Record<string, string> {
  // .prod.vars 가 있으면 우선, 없으면 .dev.vars 사용
  const prod = parseDotenv(resolve(__dirname, '.prod.vars'))
  const dev = parseDotenv(resolve(__dirname, '.dev.vars'))
  return { ...dev, ...prod }
}

const secrets = loadInlineSecrets()
const INLINE_KEYS = ['ANTHROPIC_API_KEY', 'YOUTUBE_API_KEY', 'SITE_PASSWORD', 'CLAUDE_MODEL'] as const

const define: Record<string, string> = {}
for (const k of INLINE_KEYS) {
  // 정의되지 않은 키는 빈 문자열로 (런타임에서 c.env fallback 후 빈값 처리)
  define[`__INLINE_${k}__`] = JSON.stringify(secrets[k] ?? '')
}

export default defineConfig({
  define,
  plugins: [
    build(),
    devServer({
      adapter,
      entry: 'src/index.tsx'
    })
  ]
})
