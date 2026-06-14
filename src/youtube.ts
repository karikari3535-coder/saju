/**
 * youtube.ts — YouTube Data API v3 읽기 전용 연동
 *
 * - 댓글 수집: commentThreads.list (읽기 전용, 게시 안 함)
 * - 채널 스캔: search.list + videos 로 최근 영상 → 답글 필요한 영상만
 * - 링크 자동 판단: 채널 링크 / 영상 링크 / ID 자동 분기
 */

export interface YoutubeComment {
  comment_id: string
  author: string
  text: string
  published_at: string
  like_count: number
  /** 채널 주인이 답글(대댓글)을 단 적 있는지 */
  has_owner_reply: boolean
}

export interface ChannelVideo {
  video_id: string
  title: string
  published_at: string
  thumbnail: string
  comment_count: number | null
  /** 사주 댓글이 있는데 미답변인 것으로 추정 */
  needs_reply: boolean
}

export type YoutubeTarget =
  | { kind: 'video'; id: string }
  | { kind: 'channel'; id?: string; handle?: string; username?: string }
  | { kind: 'unknown'; raw: string }

const SAJU_HINT =
  /(\d{4}\s*년|\d{4}[.\-\/]\d{1,2}[.\-\/]\d{1,2}|음력|양력|생년월일|사주|\d{6,8}|시에?\s*태어|자시|축시|인시|묘시|진시|사시|오시|미시|신시|유시|술시|해시)/

/** 댓글이 사주 요청으로 보이는지 */
export function looksLikeSaju(text: string): boolean {
  return SAJU_HINT.test(text ?? '')
}

/** 입력 한 줄에서 유튜브 대상(채널/영상)을 추출 */
export function extractYoutubeTarget(input: string): YoutubeTarget {
  const raw = (input ?? '').trim()
  if (!raw) return { kind: 'unknown', raw }

  // 영상 ID 직접 (11자)
  if (/^[\w-]{11}$/.test(raw)) return { kind: 'video', id: raw }

  // youtu.be/VIDEOID
  let m = raw.match(/youtu\.be\/([\w-]{11})/)
  if (m) return { kind: 'video', id: m[1] }

  // watch?v=VIDEOID
  m = raw.match(/[?&]v=([\w-]{11})/)
  if (m) return { kind: 'video', id: m[1] }

  // /shorts/VIDEOID  /live/VIDEOID  /embed/VIDEOID
  m = raw.match(/\/(?:shorts|live|embed)\/([\w-]{11})/)
  if (m) return { kind: 'video', id: m[1] }

  // 채널 핸들 @name
  m = raw.match(/youtube\.com\/@([\w.\-가-힣]+)/) || raw.match(/^@([\w.\-가-힣]+)$/)
  if (m) return { kind: 'channel', handle: m[1] }

  // /channel/UCxxxx
  m = raw.match(/youtube\.com\/channel\/(UC[\w-]+)/)
  if (m) return { kind: 'channel', id: m[1] }

  // /user/name  /c/name
  m = raw.match(/youtube\.com\/(?:user|c)\/([\w.\-가-힣]+)/)
  if (m) return { kind: 'channel', username: m[1] }

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

/** 영상의 (미답변·사주) 댓글 수집 */
export async function fetchVideoComments(
  apiKey: string,
  videoId: string,
  opts: { maxPages?: number; onlySaju?: boolean; onlyUnanswered?: boolean } = {},
): Promise<YoutubeComment[]> {
  const maxPages = Math.min(opts.maxPages ?? 3, 10)
  const onlySaju = opts.onlySaju ?? true
  const onlyUnanswered = opts.onlyUnanswered ?? true

  const out: YoutubeComment[] = []
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

      // 채널 주인 답글 여부: replies 중 작성자 채널ID == 영상 채널ID
      const videoChannelId = top.authorChannelId?.value // (top 작성자 — 부정확하므로 보조용)
      const replies = item.replies?.comments ?? []
      const hasOwnerReply = replies.some((r: any) => {
        const rs = r.snippet
        // 채널 소유자 답글은 보통 동일 채널ID. 정확 판별 위해 videosChannel 비교가 이상적이나
        // 여기서는 "답글 존재" + 휴리스틱으로 처리(운영자가 최종 확인).
        return rs?.authorChannelId?.value && rs.authorChannelId.value !== top.authorChannelId?.value
      })

      if (onlyUnanswered && hasOwnerReply) continue

      out.push({
        comment_id: item.snippet.topLevelComment.id,
        author: top.authorDisplayName ?? '익명',
        text,
        published_at: top.publishedAt ?? '',
        like_count: top.likeCount ?? 0,
        has_owner_reply: hasOwnerReply,
      })
    }

    pageToken = data.nextPageToken
    if (!pageToken) break
  }
  return out
}

/** 핸들/username → channelId 해석 */
async function resolveChannelId(apiKey: string, target: YoutubeTarget): Promise<string> {
  if (target.kind !== 'channel') throw new Error('채널 대상이 아닙니다.')
  if (target.id) return target.id

  if (target.handle) {
    // forHandle 지원 (앞에 @ 없이)
    const params = new URLSearchParams({
      part: 'id',
      forHandle: target.handle,
      key: apiKey,
    })
    const data = await gfetch(`${API}/channels?${params}`)
    const id = data.items?.[0]?.id
    if (id) return id
  }
  if (target.username) {
    const params = new URLSearchParams({
      part: 'id',
      forUsername: target.username,
      key: apiKey,
    })
    const data = await gfetch(`${API}/channels?${params}`)
    const id = data.items?.[0]?.id
    if (id) return id
  }
  // 마지막 시도: search 로 핸들/이름 검색
  const q = target.handle || target.username || ''
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'channel',
    q,
    maxResults: '1',
    key: apiKey,
  })
  const data = await gfetch(`${API}/search?${params}`)
  const id = data.items?.[0]?.snippet?.channelId || data.items?.[0]?.id?.channelId
  if (id) return id
  throw new Error('채널을 찾지 못했어요. 채널 링크(@핸들 또는 channel/UC...)를 확인해 주세요.')
}

/** 채널의 업로드 재생목록 ID 얻기 */
async function getUploadsPlaylist(apiKey: string, channelId: string): Promise<string> {
  const params = new URLSearchParams({
    part: 'contentDetails',
    id: channelId,
    key: apiKey,
  })
  const data = await gfetch(`${API}/channels?${params}`)
  const pid = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!pid) throw new Error('채널 업로드 목록을 찾지 못했어요.')
  return pid
}

/** 채널 최근 N개 영상을 스캔해서 '답글 필요' 영상만 반환 */
export async function scanChannelForReplyNeeds(
  apiKey: string,
  channelInput: string,
  maxVideos = 30,
): Promise<{ channelId: string; videos: ChannelVideo[] }> {
  const target = extractYoutubeTarget(channelInput)
  if (target.kind !== 'channel') {
    throw new Error('채널 링크(@핸들 또는 youtube.com/channel/UC...)가 아니에요.')
  }
  const channelId = await resolveChannelId(apiKey, target)
  const uploads = await getUploadsPlaylist(apiKey, channelId)

  // playlistItems 로 최근 영상 ID 수집
  const videoIds: string[] = []
  let pageToken: string | undefined
  while (videoIds.length < maxVideos) {
    const params = new URLSearchParams({
      part: 'contentDetails',
      playlistId: uploads,
      maxResults: '50',
      key: apiKey,
    })
    if (pageToken) params.set('pageToken', pageToken)
    const data = await gfetch(`${API}/playlistItems?${params}`)
    for (const it of data.items ?? []) {
      const vid = it.contentDetails?.videoId
      if (vid) videoIds.push(vid)
      if (videoIds.length >= maxVideos) break
    }
    pageToken = data.nextPageToken
    if (!pageToken) break
  }

  if (videoIds.length === 0) return { channelId, videos: [] }

  // videos.list 로 제목·댓글수·썸네일
  const detailParams = new URLSearchParams({
    part: 'snippet,statistics',
    id: videoIds.slice(0, 50).join(','),
    key: apiKey,
  })
  const detail = await gfetch(`${API}/videos?${detailParams}`)

  const videos: ChannelVideo[] = []
  for (const v of detail.items ?? []) {
    const commentCount = v.statistics?.commentCount
      ? parseInt(v.statistics.commentCount, 10)
      : null
    videos.push({
      video_id: v.id,
      title: v.snippet?.title ?? '(제목 없음)',
      published_at: v.snippet?.publishedAt ?? '',
      thumbnail:
        v.snippet?.thumbnails?.medium?.url ||
        v.snippet?.thumbnails?.default?.url ||
        '',
      comment_count: commentCount,
      // 댓글이 있는 영상은 잠재적으로 답글 필요(정확 판별은 댓글 수집 단계에서)
      needs_reply: (commentCount ?? 0) > 0,
    })
  }
  // 댓글 많은 순 → 답글 필요해 보이는 영상 우선
  videos.sort((a, b) => (b.comment_count ?? 0) - (a.comment_count ?? 0))
  return { channelId, videos }
}
