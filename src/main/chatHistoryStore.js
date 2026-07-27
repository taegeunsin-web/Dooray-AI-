// 채팅 기록을 파일로 저장/검색하는 모듈.
// 사용자가 "채팅방" 탭에서 "기록 저장"을 켠 채팅방만 대상으로 합니다.
// 채널마다 별도 파일(JSON Lines, 한 줄에 메시지 하나)에 새 메시지만 追加(append)하므로
// 저장 자체는 아주 가볍고, 파일 전체를 읽는 건 "검색"할 때만 합니다 (평소 채팅 응답 속도에 영향 없음).
// ⚠️ 이 기록도 프로그램이 켜진 후 관측된 메시지만 쌓입니다 (두레이 API에 과거 메시지 조회가
// 없다는 제약은 여기서도 동일합니다).

const fs = require('fs')
const path = require('path')
const os = require('os')

const HISTORY_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'chat-history')

function filePathFor(channelId) {
  return path.join(HISTORY_DIR, `${channelId}.jsonl`)
}

// 새 메시지 한 줄만 파일 끝에 추가 (파일 전체를 다시 쓰지 않음 → 채팅방이 오래돼도 느려지지 않음)
function appendMessage(channelId, { senderId, text, ts }) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true })
  const line = JSON.stringify({ senderId, text, ts }) + '\n'
  fs.appendFileSync(filePathFor(channelId), line, 'utf-8')
}

function readAll(channelId) {
  const file = filePathFor(channelId)
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf-8')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// 저장된 기록에서 키워드로 검색 (최신순으로, 최대 limit개만 반환)
function searchMessages(channelId, query, { limit = 200 } = {}) {
  const all = readAll(channelId)
  const q = (query || '').trim().toLowerCase()
  const matched = q ? all.filter((m) => (m.text || '').toLowerCase().includes(q)) : all
  return matched.slice(-limit).reverse()
}

// 채팅방에 저장된 기록이 몇 개나 있는지 (화면에 참고용으로 보여줄 때 사용)
function countMessages(channelId) {
  return readAll(channelId).length
}

// (2026-07-27 추가) 이 채널에 저장된 메시지 중 가장 최근 것의 시각(ts, ms 단위). 없으면 0.
// 프로그램이 꺼져있던 동안 두레이 API로 놓친 메시지를 채워 넣을 때, 이 시각보다 나중 것만
// 새로 저장하면 이미 있는 메시지와 겹치지 않습니다.
function getLastMessageTs(channelId) {
  const all = readAll(channelId)
  if (all.length === 0) return 0
  return all[all.length - 1].ts || 0
}

// "기록 저장"이 한 번이라도 켜졌던 채팅방(=파일이 있는 채팅방) 전체 목록.
function listStoredChannelIds() {
  if (!fs.existsSync(HISTORY_DIR)) return []
  return fs
    .readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
}

// "어떤 채팅방에서 그 말을 했는지 기억이 안 날 때"를 위한 전체 채팅방 통합 검색.
// 채팅방을 먼저 고를 필요 없이, 기록 저장이 켜진 모든 채팅방을 한 번에 뒤져서
// 최신순으로 합쳐 돌려줍니다. 각 결과에 channelId를 붙여서 어느 방인지 알 수 있게 합니다.
function searchAllChannels(query, { limit = 200 } = {}) {
  const q = (query || '').trim().toLowerCase()
  const channelIds = listStoredChannelIds()
  const all = []
  for (const channelId of channelIds) {
    const messages = readAll(channelId)
    for (const m of messages) {
      if (!q || (m.text || '').toLowerCase().includes(q)) {
        all.push({ ...m, channelId })
      }
    }
  }
  all.sort((a, b) => b.ts - a.ts)
  return all.slice(0, limit)
}

// 전체 채팅방에 저장된 기록 총 개수 (화면에 참고용으로 보여줄 때 사용)
function countAllMessages() {
  return listStoredChannelIds().reduce((sum, id) => sum + countMessages(id), 0)
}

module.exports = {
  appendMessage,
  searchMessages,
  countMessages,
  searchAllChannels,
  countAllMessages,
  listStoredChannelIds,
  getLastMessageTs
}
