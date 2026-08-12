// 채팅방에 최근 올라온 "이미지"를 내려받아, 클로드에게 넘길 로컬 파일 경로를 만들어 줍니다.
//
// (2026-08-10 신규) 지금까지 @두레이봇은 채팅 본문 "글자"만 클로드에게 넘겼습니다. 그래서
// 스크린샷이 올라와도 클로드에게는 `![...](/files/123)` 라는 글자로만 전달돼 그림 자체를
// 볼 수 없었습니다. 클로드 코드는 파일 경로를 주면 그 파일을 직접 열어볼 수 있으므로,
// 이미지를 미리 내려받아 경로를 함께 넘깁니다.
// (같은 문제를 먼저 해결한 클로데이 v2.0.5의 방식을 참고 — 한 번에 8장, 실패한 장은 건너뜀.)
//
// ⚠️ 한계: 이미지 목록은 channelFileStore.js가 저장해둔 것에서 가져오는데, 그 저장소는
// "이 프로그램이 켜져 있는 동안 지나간 파일"만 담고 있습니다(두레이 API에 채팅방 첨부파일을
// 나중에 다시 조회하는 기능이 없어서입니다). 프로그램이 꺼져 있는 동안 올라온 이미지는
// 여기서 찾지 못합니다.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { listFiles } = require('./channelFileStore')
const { doorayFileLimiter, withRateLimit } = require('./rateLimiter')

const IMAGE_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'chat-images')
const MAX_IMAGES = 8                              // 멘션 한 번에 넘길 최대 장수
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000      // 최근 24시간 안에 올라온 것만
const MAX_IMAGE_BYTES = 10 * 1024 * 1024          // 10MB 넘는 건 건너뜀

function sanitizeFileName(name) {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned || 'image'
}

// 두레이 파일 다운로드는 2단계입니다 (mcp-server의 downloadDoorayFileToDisk와 같은 패턴):
//  1) media=raw 로 요청 → 307과 함께 실제 파일 서버 주소를 받음
//  2) 그 주소로 Authorization을 그대로 유지한 채 다시 요청 → 응답 본문이 파일 원본
async function downloadOne(doorayClient, channelId, file) {
  const dir = path.join(IMAGE_DIR, String(channelId))
  const safeName = sanitizeFileName(file.fileName || `${file.fileId}.png`)
  const localPath = path.join(dir, `${file.fileId}_${safeName}`)

  // 전에 받아둔 게 있으면 다시 받지 않습니다 (같은 방에서 여러 번 멘션할 때 낭비를 막습니다).
  try {
    if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) return localPath
  } catch { /* 확인 실패 시엔 그냥 새로 받습니다 */ }

  const auth = doorayClient.getAuthHeader()
  const url = `${doorayClient.baseUrl}/messenger/v1/channels/${channelId}/files/${file.fileId}?media=raw`

  const step1 = await fetch(url, { method: 'GET', redirect: 'manual', headers: { Authorization: auth } })
  if (step1.status !== 307 && step1.status !== 302) {
    throw new Error(`이미지 다운로드 1단계 실패 (${step1.status})`)
  }
  const location = step1.headers.get('location')
  if (!location) throw new Error('이미지 다운로드 1단계: location 헤더가 없습니다')

  const step2 = await fetch(location, { method: 'GET', headers: { Authorization: auth } })
  if (!step2.ok) throw new Error(`이미지 다운로드 2단계 실패 (${step2.status})`)

  const buf = Buffer.from(await step2.arrayBuffer())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(localPath, buf)
  return localPath
}

// 이 채팅방에 최근 올라온 이미지들을 내려받아 [{ fileName, localPath }] 로 돌려줍니다.
// 실패한 장은 조용히 건너뜁니다 — 이미지 때문에 답변 자체가 막히면 안 되기 때문입니다.
async function collectRecentChannelImages(doorayClient, channelId, { log } = {}) {
  let files = []
  try {
    files = listFiles(channelId, { limit: 40 }) // 최신순으로 돌아옵니다
  } catch {
    return []
  }

  const cutoff = Date.now() - RECENT_WINDOW_MS
  const targets = files
    .filter((f) => /^image\//i.test(f.mimeType || ''))
    .filter((f) => !f.fileSize || f.fileSize <= MAX_IMAGE_BYTES)
    .filter((f) => {
      const t = typeof f.ts === 'number' ? f.ts : Date.parse(f.ts || 0)
      return Number.isFinite(t) && t >= cutoff
    })
    .slice(0, MAX_IMAGES)

  const out = []
  for (const f of targets) {
    try {
      // 파일 API 대기표를 거쳐서 받습니다 (여러 장을 한꺼번에 받다 일부만 오는 것을 막음).
      const localPath = await withRateLimit(doorayFileLimiter, () => downloadOne(doorayClient, channelId, f))
      out.push({ fileName: f.fileName || path.basename(localPath), localPath })
    } catch (err) {
      if (log) log(`채팅방 이미지 건너뜀 (${f.fileName || f.fileId}): ${err.message}`)
    }
  }
  return out
}

// 위 결과를 클로드에게 줄 프롬프트 조각으로 만듭니다.
function buildImageBlock(images) {
  if (!images || images.length === 0) return ''
  const lines = images.map((i, n) => `${n + 1}. ${i.fileName} → ${i.localPath}`)
  return (
    `[이 채팅방에 최근 올라온 이미지 ${images.length}장 — 질문과 관련 있어 보이면 아래 경로의 파일을 직접 열어서 확인하세요]\n` +
    `${lines.join('\n')}\n\n`
  )
}

module.exports = { collectRecentChannelImages, buildImageBlock }
