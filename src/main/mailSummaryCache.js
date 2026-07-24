// "폴더별 정리" 화면에서 만든 AI 요약 결과를 저장해두는 곳.
// AI 요약은 시간도 걸리고 비용도 들어서, 그룹(사람/제목)에 새 메일이 안 들어왔으면
// 저장된 요약을 그대로 다시 보여주고, 다시 AI를 부르지 않습니다.
// 새 메일이 들어와서 건수나 최신 메일이 달라졌을 때만 자동으로 다시 요약합니다.
//
// 저장 위치: 예전에는 일렉트론(Electron) 전용 폴더(app.getPath('userData'))에 저장했는데,
// 그러면 두레이봇이 쓰는 MCP 서버(일렉트론이 아닌 일반 node로 따로 실행됨)가 이 파일을
// 못 읽었습니다. 그래서 메일 기록/채팅 기록과 같은 방식으로 "홈 폴더 밑 공용 작업 폴더"에
// 저장하도록 옮겨서, 두레이봇도 같은 파일을 직접 읽어 즐겨찾기/저장된 요약/요청 목록을
// 볼 수 있게 했습니다. 기존에 예전 위치에 저장해둔 내용은 아래에서 한 번만 자동으로 옮겨옵니다.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { app } = require('electron')

const MAIL_CACHE_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'mail-cache')
const CACHE_PATH = path.join(MAIL_CACHE_DIR, 'mail-group-summary-cache.json')

// 예전 위치(일렉트론 userData 폴더)에 파일이 남아있고 새 위치엔 아직 없으면, 딱 한 번만
// 그대로 복사해옵니다 (기존 사용자의 즐겨찾기/저장된 요약이 없어지지 않도록).
function migrateFromOldLocation(oldPath, newPath) {
  try {
    if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
      fs.mkdirSync(path.dirname(newPath), { recursive: true })
      fs.copyFileSync(oldPath, newPath)
    }
  } catch { /* 이전 실패해도 새 파일로 계속 진행 (심각한 문제 아님) */ }
}
try {
  migrateFromOldLocation(path.join(app.getPath('userData'), 'mail-group-summary-cache.json'), CACHE_PATH)
} catch { /* app이 아직 준비 안 됐거나 접근 실패해도 무시 */ }

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true })
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8')
}

// 폴더 + 그룹 종류(사람/제목) + 그룹 키 + 검색 필터 조건을 하나로 합쳐 캐시를 구분하는
// 값을 만듭니다. 보낸사람/제목/기간 필터가 걸려 있으면 그룹에 포함되는 메일 구성 자체가
// 달라질 수 있어서, 필터 조합마다 서로 다른 캐시로 취급합니다.
function makeCacheKey(folderName, groupType, groupKey, filterSig) {
  return `${folderName}::${groupType}::${groupKey}::${filterSig || ''}`
}

// 저장된 요약이 있으면 { count, latestSentAt, summary, generatedAt }을 돌려주고,
// 없으면 null을 돌려줍니다.
function getEntry(folderName, groupType, groupKey, filterSig) {
  const cache = loadCache()
  return cache[makeCacheKey(folderName, groupType, groupKey, filterSig)] || null
}

function setEntry(folderName, groupType, groupKey, filterSig, entry) {
  const cache = loadCache()
  cache[makeCacheKey(folderName, groupType, groupKey, filterSig)] = entry
  saveCache(cache)
}

// "요청 모아보기" 카드용: 특정 폴더의 저장된 요약들을 전부 돌려줍니다.
// (요약을 저장할 때 함께 넣어둔 folderName/groupType/label 정보가 있는 항목만 —
//  예전 버전이 저장한 항목은 이 정보가 없어서 빠지지만, 다시 요약되면 자동으로 채워집니다.)
function listEntriesForFolder(folderName, groupType) {
  const cache = loadCache()
  return Object.values(cache).filter(
    (e) => e && e.folderName === folderName && e.groupType === (groupType || 'person')
  )
}

// ---- 개별 메일 요약 저장 (알림 요약 ↔ 폴더별 정리 요약 통합용) -----------------
// "메일 도착 알림"이 메일 1건을 요약해서 채팅방에 보낼 때 그 결과를 여기 저장해두고,
// 나중에 "폴더별 정리"에서 같은 메일이 포함된 그룹을 요약할 때는 원문 전체 대신
// 이 미리 만든 요약을 재료로 씁니다 — 같은 메일을 AI가 두 번 읽지 않게 됩니다.
const SINGLE_PATH = path.join(MAIL_CACHE_DIR, 'mail-single-summaries.json')
try {
  migrateFromOldLocation(path.join(app.getPath('userData'), 'mail-single-summaries.json'), SINGLE_PATH)
} catch { /* 무시 */ }

function loadSingleMap() {
  try {
    return JSON.parse(fs.readFileSync(SINGLE_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function getMailSummary(mailId) {
  return loadSingleMap()[mailId] || null
}

// { 메일ID: 요약문 } 형태로 여러 건을 한 번에 합쳐 저장합니다.
function setMailSummaries(obj) {
  const entries = Object.entries(obj || {}).filter(([id, s]) => id && s)
  if (!entries.length) return
  const map = loadSingleMap()
  for (const [id, s] of entries) map[id] = s
  fs.mkdirSync(path.dirname(SINGLE_PATH), { recursive: true })
  fs.writeFileSync(SINGLE_PATH, JSON.stringify(map, null, 2), 'utf-8')
}

// ---- 메일 1건 요약이 "어디서 처음 만들어졌는지" ------------------------------
// 메일 요약은 어느 화면에서 먼저 만들든 같은 캐시(SINGLE_PATH)에 저장되어 다른 화면에서도
// 그대로 재사용됩니다. 그래서 "발신자별 정리(그룹 스캔)에서 처음 만들어진 요약"과
// "메일 도착 알림/메일함에서 직접 본 요약"을 구분할 방법이 따로 필요합니다 — 전자는
// 오탐 방지를 위해 오늘 할 일에 기본으로 안 들어가고 체크해야만 들어가야 하기 때문입니다.
// (요약 문장 자체로는 구분이 안 되므로, 만들어질 때 이 값을 같이 남겨둡니다.)
const ORIGIN_PATH = path.join(MAIL_CACHE_DIR, 'mail-summary-origin.json')

function getSummaryOriginMap() {
  try {
    return JSON.parse(fs.readFileSync(ORIGIN_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function setSummaryOrigin(mailId, origin) {
  if (!mailId) return
  const map = getSummaryOriginMap()
  map[mailId] = origin
  fs.mkdirSync(path.dirname(ORIGIN_PATH), { recursive: true })
  fs.writeFileSync(ORIGIN_PATH, JSON.stringify(map, null, 2), 'utf-8')
}

// ---- 요청 완료 체크 저장 -----------------------------------------------------
// "요청 모아보기"에서 체크한 완료 상태를 파일로 저장합니다 (껐다 켜도 유지).
const DONE_PATH = path.join(MAIL_CACHE_DIR, 'mail-request-done.json')
try {
  migrateFromOldLocation(path.join(app.getPath('userData'), 'mail-request-done.json'), DONE_PATH)
} catch { /* 무시 */ }

function getRequestDoneMap() {
  try {
    return JSON.parse(fs.readFileSync(DONE_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function setRequestDone(id, done) {
  const map = getRequestDoneMap()
  if (done) map[id] = { doneAt: new Date().toISOString() }
  else delete map[id]
  fs.mkdirSync(path.dirname(DONE_PATH), { recursive: true })
  fs.writeFileSync(DONE_PATH, JSON.stringify(map, null, 2), 'utf-8')
}

// ---- 발신자별 정리에서 나온 [요청]의 "오늘 할 일" 포함 여부(옵트인) -------------
// 발신자별 정리는 여러 사람의 메일을 한 번에 훑다 보니 [요청] 오탐이 늘어날 수 있어서,
// 여기서 나온 요청은 기본으로 오늘 할 일에 넣지 않고 체크박스로 직접 골라야만 들어갑니다.
// (메일 도착 알림/메일함에서 요약한 [요청]은 이 대상이 아니라 지금처럼 자동으로 들어갑니다)
const REQ_OPTIN_PATH = path.join(MAIL_CACHE_DIR, 'mail-request-optin.json')

function getRequestOptInMap() {
  try {
    return JSON.parse(fs.readFileSync(REQ_OPTIN_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function setRequestOptIn(id, optedIn) {
  const map = getRequestOptInMap()
  if (optedIn) map[id] = true
  else delete map[id]
  fs.mkdirSync(path.dirname(REQ_OPTIN_PATH), { recursive: true })
  fs.writeFileSync(REQ_OPTIN_PATH, JSON.stringify(map, null, 2), 'utf-8')
}

// ---- 수동으로 지정한 "오늘 할 일" -------------------------------------------
// AI가 [요청]을 자동으로 못 잡거나(또는 반대로 나와 상관없는 메일을 잘못 잡을 때),
// 메일함에서 특정 메일 1건을 사람이 직접 "오늘 할 일"에 추가/제외할 수 있게 합니다.
// 메일 1건당 하나만 둡니다(다시 추가하면 내용을 덮어씀).
const MANUAL_TODO_PATH = path.join(MAIL_CACHE_DIR, 'mail-manual-todos.json')

function loadManualTodoMap() {
  try {
    return JSON.parse(fs.readFileSync(MANUAL_TODO_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function saveManualTodoMap(map) {
  fs.mkdirSync(path.dirname(MANUAL_TODO_PATH), { recursive: true })
  fs.writeFileSync(MANUAL_TODO_PATH, JSON.stringify(map, null, 2), 'utf-8')
}

// 메일 1건에 수동으로 추가된 할 일이 있으면 돌려주고, 없으면 null.
function getManualTodo(mailId) {
  if (!mailId) return null
  return loadManualTodoMap()[mailId] || null
}

// { mailId, folderName, text, mailUrl, groupLabel } — text가 비어있으면 기본 문구를 씁니다.
function addManualTodo({ mailId, folderName, text, mailUrl, groupLabel }) {
  if (!mailId) return
  const map = loadManualTodoMap()
  map[mailId] = {
    mailId,
    folderName: folderName || '',
    text: (text || '').trim() || '메일함에서 직접 추가한 할 일',
    mailUrl: mailUrl || '',
    groupLabel: groupLabel || '',
    createdAt: new Date().toISOString()
  }
  saveManualTodoMap(map)
}

function removeManualTodo(mailId) {
  if (!mailId) return
  const map = loadManualTodoMap()
  if (map[mailId]) {
    delete map[mailId]
    saveManualTodoMap(map)
  }
}

// "오늘 할 일" 집계 함수(index.js의 buildMailRequestsForFolder)가 폴더 하나를 훑을 때
// 그 폴더에 속한 수동 항목만 가져오기 위해 씁니다.
function listManualTodosForFolder(folderName) {
  const map = loadManualTodoMap()
  return Object.values(map).filter((t) => t.folderName === folderName)
}

// "저장된 모든 정보 초기화" 기능에서 함께 지울 때 사용합니다.
function clearAll() {
  try {
    fs.rmSync(CACHE_PATH, { force: true })
    fs.rmSync(DONE_PATH, { force: true })
    fs.rmSync(SINGLE_PATH, { force: true })
    fs.rmSync(MANUAL_TODO_PATH, { force: true })
    fs.rmSync(REQ_OPTIN_PATH, { force: true })
    fs.rmSync(ORIGIN_PATH, { force: true })
  } catch { /* 파일이 없으면 그냥 넘어감 */ }
}

module.exports = {
  getEntry,
  setEntry,
  listEntriesForFolder,
  getMailSummary,
  setMailSummaries,
  getRequestDoneMap,
  setRequestDone,
  getRequestOptInMap,
  setRequestOptIn,
  getSummaryOriginMap,
  setSummaryOrigin,
  getManualTodo,
  addManualTodo,
  removeManualTodo,
  listManualTodosForFolder,
  clearAll,
  CACHE_PATH
}
