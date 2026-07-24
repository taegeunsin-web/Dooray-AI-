// 채팅방에 올라온 파일(첨부파일) 정보를 저장해두는 모듈.
// 두레이 메신저 API 자체에는 "채팅방에 첨부된 파일을 나중에 다시 조회"하는 기능이 없어서,
// chatHistoryStore.js와 같은 방식으로 실시간으로 지나가는 파일 업로드 이벤트를 붙잡아
// 직접 저장해둡니다. 이렇게 저장해두면 "이 채팅방에 최근 올라온 파일"을 봇이 찾아서
// 두레이 드라이브/구글 드라이브 등으로 옮기는 데 쓸 수 있습니다.
// ⚠️ 채팅 기록과 마찬가지로, 프로그램이 켜진 후 관측된 파일만 쌓입니다.

const fs = require('fs')
const path = require('path')
const os = require('os')

// chatHistoryStore.js와 같은 폴더를 씁니다 (채널 기록과 같은 성격의 데이터라 한곳에 모아둠).
// 파일명 접미사(.files.jsonl)만 다르게 해서 텍스트 기록 파일과 안 섞이게 합니다.
const HISTORY_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'chat-history')

function filePathFor(channelId) {
  return path.join(HISTORY_DIR, `${channelId}.files.jsonl`)
}

// 새 파일 업로드 이벤트 한 줄만 파일 끝에 추가.
function appendFile(channelId, { fileId, fileName, fileSize, mimeType, senderId, ts }) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true })
  const line = JSON.stringify({ fileId, fileName, fileSize, mimeType, senderId, ts }) + '\n'
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

// 이 채팅방에 올라온 파일 목록 (최신순, 최대 limit개). 이름으로 필터링도 가능합니다.
function listFiles(channelId, { query, limit = 30 } = {}) {
  const all = readAll(channelId)
  const q = (query || '').trim().toLowerCase()
  const matched = q ? all.filter((f) => (f.fileName || '').toLowerCase().includes(q)) : all
  return matched.slice(-limit).reverse()
}

module.exports = { appendFile, listFiles }
