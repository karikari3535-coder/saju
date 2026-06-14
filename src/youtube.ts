/**
 * youtube.ts — YouTube Data API v3 읽기 전용 연동
 *
 * - 댓글 수집: commentThreads.list (읽기 전용, 게시 안 함)
 * - 채널 스캔: 업로드 재생목록 → 최근 영상 → 미답변 사주 댓글이 있는 영상만
 * - 링크 자동 판단: 채널 링크 / 영상 링크 / ID 자동 분기
 * - 영상 제목에서 출생연도(○○년생) 추출 → 댓글에 연도 없을 때 폴백
 *
 * 프론트엔드(app.js) 소비 형태에 맞춘 응답 필드:
 *   comment: { comment_id, author, text, published_at, like_count, reply_count, owner_replied }
 *   channel video: { video_id, title, published_at, video_birth_year, unanswered_count }
 */

export interface YoutubeComment {
  comment_id: string
  author: string
  text: string
  published_at: string
  like_count: number
  /** 대댓글 수 */
  reply_count: number
  /** 채널 주인이 답글을 단 적 있는지 */
  owner_replied: boolean
}

export interface ChannelVideoNeed {
  video_id: string
  title: string
  published_at: string
  /** 영상 제목에서 추출한 출생연도 (없으면 null) */
  video_birth_year: number | null
  /** 미답변 사주 댓글 수 */
  unanswered_count: number
}

export type YoutubeTarget =
  | { kind: 'video'; id: string }
  | { kind: 'channel'; id?: string; handle?: string; username?: string }
  | { kind: 'unknown'; raw: string }

const SAJU_HINT =
  /(\d{4}\s*년|\d{4}[.\-\/]\d{1,2}[.\-\/]\d{1,2}|음력|양력|생년월일|사주|\d{6,8}|시에?\s*태어|태어난|자시|축시|인시|묘시|진시|사시|오시|미시|신시|유시|술시|해시|봐\s*주|궁금)/

/** 댓글이 사주 요청으로 보이는지 */
export function looksLikeSaju(text: string): boolean {
  return SAJU_HINT.test(text ?? '')
}

/**
 * 영상 제목에서 출생연도를 추출한다.
 *  지원: "1990년생", "90년생", "1990년 생", "1990년生"
 */
export function extractBirthYearFromTitle(title: string): number | null {
  const t = title ?? ''
  // 4자리 연도 + 생
  let m = t.match(/(19\d{2}|20\d{2})\s*년?\s*생/)
  if (m) return parseInt(m[1], 10)
  // 2자리 연도 + 년생 (예: 90년생)
  m = t.match(/(?<!\d)(\d{2})\s*년\s*생/)
  if (m) {
    const yy = parseInt(m[1], 10)
    return yy <= 25 ? 2000 + yy : 1900 + yy
  }
  return null
}

/** 입력 한 줄에서 유튜브 대상(채널/영상)을 추출 */
export function extractYoutubeTarget(input: string): YoutubeTarget {
  const raw = (input ?? '').trim()
  if (!raw) return { kind: 'unknown', raw }

  // 영상 단서 우선
  let m = raw.match(/[?&]v=([\w-]{11})/)
  if (m) return { kind: 'video', id: m[1] }
  m = raw.match(/youtu\.be\/([\w-]{11})/)
  if (m) return { kind: 'video', id: m[1] }
  m = raw.match(/\/(?:shorts|live|embed|video)\/([\w-]{11})/)
  if (m) return { kind: 'video', id: m[1] }

  // 채널 단서
  m = raw.match(/youtube\.com\/channel\/(UC[\w-]{20,})/) || raw.match(/^(UC[\w-]{20,})$/)
  if (m) return { kind: 'channel', id: m[1] }
  m = raw.match(/youtube\.com\/@([\w.\-가-힣]+)/) || raw.match(/^@([\w.\-가-힣]+)$/)
  if (m) return { kind: 'channel', handle: m[1] }
  m = raw.match(/youtube\.com\/(?:user|c)\/([\w.\-가-힣]+)/)
  if (m) return { kind: 'channel', username: m[1] }

  // 순수 11자리 → 영상
  if (/^[\w-]{11}$/.test(raw)) return { kind: 'video', id: raw }

  return { kind: 'unknown', raw }
}

const API = 'https://www.googleapis.com/youtube/v3'

async function gfetch(url: string): Promise<any> {
  const res = await fetch(url)
  const data = await res.json()
  if (!res.ok) {
    const reason = data?.error?.message || res.statusText
    throw new Error(`YouTube API 오류: ${reason}`)
  }
  return data
}

export interface CommentsResult {
  comments: YoutubeComment[]
  videoTitle: string | null
  videoBirthYear: number | null
  stats: { scanned: number; answered: number; returned: number }
}

/** 영상 메타(제목) 조회 */
async function fetchVideoMeta(
  apiKey: string,
  videoId: string,
): Promise<{ title: string | null; channelId: string | null }> {
  const params = new URLSearchParams({ part: 'snippet', id: videoId, key: apiKey })
  const data = await gfetch(`${API}/videos?${params}`)
  const item = data.items?.[0]
  return {
    title: item?.snippet?.title ?? null,
    channelId: item?.snippet?.channelId ?? null,
  }
}

/** 영상의 댓글 수집 (미답변·사주 필터) */
export async function fetchVideoComments(
  apiKey: string,
  videoId: string,
  opts: { maxPages?: number; onlySaju?: boolean; onlyUnanswered?: boolean } = {},
): Promise<CommentsResult> {
  const maxPages = Math.min(opts.maxPages ?? 3, 10)
  const onlySaju = opts.onlySaju ?? true
  const onlyUnanswered = opts.onlyUnanswered ?? true

  // 영상 메타(제목·채널ID) — 채널주 답글 판별 및 제목 연도 추출에 사용
  const meta = await fetchVideoMeta(apiKey, videoId)
  const ownerChannelId = meta.channelId

  let scanned = 0
  let answered = 0
  const all: YoutubeComment[] = []

  let pageToken: string | undefined
  for (let i = 0; i < maxPages; i++) {
    const params = new URLSearchParams({
      part: 'snippet,replies',
      videoId,
      maxResults: '100',
      order: 'time',
      textFormat: 'plainText',
      key: apiKey,
    })
    if (pageToken) params.set('pageToken', pageToken)
    const data = await gfetch(`${API}/commentThreads?${params}`)

    for (const item of data.items ?? []) {
      const top = item.snippet?.topLevelComment?.snippet
      if (!top) continue
      const text: string = top.textDisplay ?? top.textOriginal ?? ''
      if (onlySaju && !looksLikeSaju(text)) continue

      scanned++

      // 채널 주인 답글 여부: 대댓글 중 작성자 채널ID == 영상 채널ID
      const replies = item.replies?.comments ?? []
      const ownerReplied = replies.some((r: any) => {
        const rid = r.snippet?.authorChannelId?.value
        return ownerChannelId && rid === ownerChannelId
      })
      if (ownerReplied) answered++

      if (onlyUnanswered && ownerReplied) continue

      all.push({
        comment_id: item.snippet.topLevelComment.id,
        author: top.authorDisplayName ?? '익명',
        text,
        published_at: top.publishedAt ?? '',
        like_count: top.likeCount ?? 0,
        reply_count: item.snippet?.totalReplyCount ?? replies.length ?? 0,
        owner_replied: ownerReplied,
      })
    }

    pageToken = data.nextPageToken
    if (!pageToken) break
  }

  // 최신순 정렬 (스튜디오와 동일)
  all.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())

  return {
    comments: all,
    videoTitle: meta.title,
    videoBirthYear: meta.title ? extractBirthYearFromTitle(meta.title) : null,
    stats: { scanned, answered, returned: all.length },
  }
}

/** 핸들/username → channelId 해석 */
async function resolveChannelId(apiKey: string, target: YoutubeTarget): Promise<string> {
  if (target.kind !== 'channel') throw new Error('채널 대상이 아닙니다.')
  if (target.id) return target.id

  if (target.handle) {
    const params = new URLSearchParams({ part: 'id', forHandle: target.handle, key: apiKey })
    const data = await gfetch(`${API}/channels?${params}`)
    const id = data.items?.[0]?.id
    if (id) return id
  }
  if (target.username) {
    const params = new URLSearchParams({ part: 'id', forUsername: target.username, key: apiKey })
    const data = await gfetch(`${API}/channels?${params}`)
    const id = data.items?.[0]?.id
    if (id) return id
  }
  // 마지막 시도: search
  const q = target.handle || target.username || ''
  const params = new URLSearchParams({
    part: 'snippet', type: 'channel', q, maxResults: '1', key: apiKey,
  })
  const data = await gfetch(`${API}/search?${params}`)
  const id = data.items?.[0]?.snippet?.channelId || data.items?.[0]?.id?.channelId
  if (id) return id
  throw new Error('채널을 찾지 못했어요. 채널 링크(@핸들 또는 channel/UC...)를 확인해 주세요.')
}

/** 채널 정보(제목 + 업로드 재생목록) */
async function getChannelInfo(
  apiKey: string,
  channelId: string,
): Promise<{ title: string | null; uploads: string }> {
  const params = new URLSearchParams({
    part: 'contentDetails,snippet', id: channelId, key: apiKey,
  })
  const data = await gfetch(`${API}/channels?${params}`)
  const item = data.items?.[0]
  const uploads = item?.contentDetails?.relatedPlaylists?.uploads
  if (!uploads) throw new Error('채널 업로드 목록을 찾지 못했어요.')
  return { title: item?.snippet?.title ?? null, uploads }
}

export interface ChannelScanResult {
  channelId: string
  channelTitle: string | null
  videos: ChannelVideoNeed[]
  stats: { scanned_videos: number; videos_need_reply: number; total_unanswered: number }
}

/** 채널 최근 N개 영상을 스캔해서 '미답변 사주 댓글이 있는' 영상만 반환 */
export async function scanChannelForReplyNeeds(
  apiKey: string,
  channelInput: string,
  maxVideos = 30,
): Promise<ChannelScanResult> {
  const target = extractYoutubeTarget(channelInput)
  if (target.kind !== 'channel') {
    throw new Error('채널 링크(@핸들 또는 youtube.com/channel/UC...)가 아니에요.')
  }
  const channelId = await resolveChannelId(apiKey, target)
  const { title: channelTitle, uploads } = await getChannelInfo(apiKey, channelId)

  // 최근 영상 ID + 제목 수집
  const vids: { id: string; title: string; publishedAt: string }[] = []
  let pageToken: string | undefined
  while (vids.length < maxVideos) {
    const params = new URLSearchParams({
      part: 'contentDetails,snippet', playlistId: uploads, maxResults: '50', key: apiKey,
    })
    if (pageToken) params.set('pageToken', pageToken)
    const data = await gfetch(`${API}/playlistItems?${params}`)
    for (const it of data.items ?? []) {
      const vid = it.contentDetails?.videoId
      if (vid) {
        vids.push({
          id: vid,
          title: it.snippet?.title ?? '(제목 없음)',
          publishedAt: it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt ?? '',
        })
      }
      if (vids.length >= maxVideos) break
    }
    pageToken = data.nextPageToken
    if (!pageToken) break
  }

  const videos: ChannelVideoNeed[] = []
  let totalUnanswered = 0

  // 각 영상별로 미답변 사주 댓글 수 확인 (1페이지만, 비용 절감)
  for (const v of vids) {
    let unanswered = 0
    try {
      const res = await fetchVideoComments(apiKey, v.id, {
        maxPages: 1,
        onlySaju: true,
        onlyUnanswered: true,
      })
      unanswered = res.stats.returned
    } catch {
      // 댓글 비활성/오류 영상은 건너뜀
      continue
    }
    if (unanswered > 0) {
      totalUnanswered += unanswered
      videos.push({
        video_id: v.id,
        title: v.title,
        published_at: v.publishedAt,
        video_birth_year: extractBirthYearFromTitle(v.title),
        unanswered_count: unanswered,
      })
    }
  }

  // 미답변 많은 순
  videos.sort((a, b) => b.unanswered_count - a.unanswered_count)

  return {
    channelId,
    channelTitle,
    videos,
    stats: {
      scanned_videos: vids.length,
      videos_need_reply: videos.length,
      total_unanswered: totalUnanswered,
    },
  }
}
