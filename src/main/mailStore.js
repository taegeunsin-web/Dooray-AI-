// 메일을 파일로 저장/검색하는 모듈 (chatHistoryStore.js와 같은 방식: JSON Lines에 새 것만 追加).
// 두레이에는 메일 전용 조회 API가 없어서, index.js가 주기적으로 최근 활동 스트림
// (GET /common/v1/streams)에서 type이 "mail"인 항목만 걸러 가져온 뒤 여기에 저장합니다.
// 스트림은 최근 2주치만 조회되지만, 이 파일에 한 번 저장해두면 그 이후로는 계속 쌓여서
// 2주가 지나도 여기서는 계속 볼 수 있습니다.

const fs = require('fs')
const path = require('path')
const os = require('os')

const MAIL_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'mail-history')
const MAIL_FILE = path.join(MAIL_DIR, 'mails.jsonl')
const SEEN_FILE = path.join(MAIL_DIR, 'seen-ids.jsonl')
const FOLDERS_FILE = path.join(MAIL_DIR, 'folders.json')

function readAll() {
  if (!fs.existsSync(MAIL_FILE)) return []
  const raw = fs.readFileSync(MAIL_FILE, 'utf-8')
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

let knownIdsCache = null
function getKnownIds() {
  if (!knownIdsCache) knownIdsCache = new Set(readAll().map((m) => m.id))
  return knownIdsCache
}

// 실제로 내용까지 저장할 메일들만 넘겨주세요 (폴더 허용목록 필터링은 호출하는 쪽에서 먼저 적용).
// id 기준으로 중복은 자동으로 걸러집니다. 반환값: 새로 저장된 개수.
function appendMails(mails) {
  const known = getKnownIds()
  const toAdd = (mails || []).filter((m) => m.id && !known.has(m.id))
  if (!toAdd.length) return 0
  fs.mkdirSync(MAIL_DIR, { recursive: true })
  const lines = toAdd.map((m) => JSON.stringify(m) + '\n').join('')
  fs.appendFileSync(MAIL_FILE, lines, 'utf-8')
  toAdd.forEach((m) => known.add(m.id))
  return toAdd.length
}

// ---- "이미 확인한 메일" 기록 (저장 여부와 무관) ------------------------------
// 폴더 허용목록 때문에 저장은 안 해도, "스트림에서 이미 본 적 있는 항목"인지는 계속
// 기억해둬야 매번 폴링할 때마다 2주치 전체를 다시 훑지 않습니다.
let seenIdsCache = null
function getSeenIds() {
  if (!seenIdsCache) {
    if (!fs.existsSync(SEEN_FILE)) {
      seenIdsCache = new Set()
    } else {
      const raw = fs.readFileSync(SEEN_FILE, 'utf-8')
      seenIdsCache = new Set(raw.split('\n').filter(Boolean))
    }
  }
  return seenIdsCache
}

function hasSeen(id) {
  return getSeenIds().has(id)
}

function markSeen(ids) {
  const seen = getSeenIds()
  const newIds = (ids || []).filter((id) => id && !seen.has(id))
  if (!newIds.length) return
  fs.mkdirSync(MAIL_DIR, { recursive: true })
  fs.appendFileSync(SEEN_FILE, newIds.map((id) => id + '\n').join(''), 'utf-8')
  newIds.forEach((id) => seen.add(id))
}

// ---- 관측된 폴더 목록 (설정 화면의 "이 폴더만 저장하기" 체크리스트용) ------------
// 허용목록으로 걸러져서 저장은 안 되는 메일이라도, 폴더 존재 자체는 여기에 계속 기록해서
// 나중에 체크할 수 있게 남겨둡니다.
function loadFoldersMap() {
  try {
    return JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function recordFolders(mails) {
  const map = loadFoldersMap()
  let changed = false
  ;(mails || []).forEach((m) => {
    if (!m.folderId) return
    if (map[m.folderId] !== m.folderName && m.folderName) {
      map[m.folderId] = m.folderName
      changed = true
    }
  })
  if (changed) {
    fs.mkdirSync(MAIL_DIR, { recursive: true })
    fs.writeFileSync(FOLDERS_FILE, JSON.stringify(map, null, 2), 'utf-8')
  }
}

function listKnownFolders() {
  const map = loadFoldersMap()
  return Object.entries(map)
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
}

// ---- 폴더별 정리: 사람별 / 제목별 자동 묶기 ----------------------------------
// 그룹을 사람이 직접 만들지 않고, 지정한 폴더에 저장된 메일을 "보낸사람"이나
// "제목"으로 자동으로 묶어서 보여주는 용도입니다 (예전의 광고주/캠페인 그룹 기능을 대체).

// 사람별 묶기의 기준 키: 이메일이 있으면 이메일, 없으면 이름 (소문자로 통일).
function personGroupKey(mail) {
  const email = (mail.fromEmail || '').trim()
  const name = (mail.fromName || '').trim()
  return (email || name || '(발신자 미상)').toLowerCase()
}

function personGroupLabel(mail) {
  return mail.fromName || mail.fromEmail || '(발신자 미상)'
}

// 제목별 묶기의 기준 키: "RE:", "FW:", "회신:", "전달:" 같은 답장/전달 접두사를
// 반복해서 떼어낸 뒤 비교합니다 (같은 대화 스레드를 같은 그룹으로 묶기 위함).
function normalizeSubject(subject) {
  let s = (subject || '').trim()
  let changed = true
  while (changed) {
    changed = false
    const next = s.replace(/^(re|fw|fwd|회신|전달)\s*[:\-]\s*/i, '')
    if (next !== s) {
      s = next.trim()
      changed = true
    }
  }
  return s || '(제목 없음)'
}

function groupKeyAndLabel(mail, groupType) {
  if (groupType === 'subject') {
    const label = normalizeSubject(mail.subject)
    return { key: label.toLowerCase(), label }
  }
  return { key: personGroupKey(mail), label: personGroupLabel(mail) }
}

// 보낸사람/제목/받은기간 조건에 맞는 메일인지 확인합니다. "폴더별 정리" 카드의 검색
// 필터로 씁니다 (조건을 안 넘기면 전부 통과). 참고: 두레이 메일 이벤트에는 "받는사람" 필드가
// 없어서(항상 나에게 온 메일이라 당연히 나 자신이라 그런 것으로 보임) 필터에서 뺐습니다.
function mailMatchesFilters(mail, filters) {
  if (!filters) return true
  const fromQ = (filters.from || '').trim().toLowerCase()
  const subjectQ = (filters.subject || '').trim().toLowerCase()
  if (fromQ && !`${mail.fromName || ''} ${mail.fromEmail || ''}`.toLowerCase().includes(fromQ)) return false
  if (subjectQ && !(mail.subject || '').toLowerCase().includes(subjectQ)) return false
  // 기간은 "YYYY-MM-DD" 문자열로 받고, 종료일은 그 날의 끝(23:59:59)까지 포함합니다.
  const dateFromQ = (filters.dateFrom || '').trim()
  const dateToQ = (filters.dateTo || '').trim()
  if (dateFromQ || dateToQ) {
    const sent = new Date(mail.sentAt || 0)
    if (dateFromQ && sent < new Date(`${dateFromQ}T00:00:00`)) return false
    if (dateToQ && sent > new Date(`${dateToQ}T23:59:59`)) return false
  }
  return true
}

// 지정한 폴더의 메일을 사람별/제목별로 묶어서, 그룹 목록(건수 + 최근 수신시각 포함)을
// 최근 활동순으로 돌려줍니다. 화면 왼쪽 목록에 바로 씁니다. filters(보낸사람/제목/기간)를
// 넘기면 그 조건에 맞는 메일만 가지고 묶습니다.
function groupMailsByFolder(folderName, groupType, filters) {
  const byKey = new Map()
  for (const m of readAll()) {
    if (m.folderName !== folderName) continue
    if (!mailMatchesFilters(m, filters)) continue
    const { key, label } = groupKeyAndLabel(m, groupType)
    const cur = byKey.get(key) || { key, label, count: 0, latestSentAt: null }
    cur.count += 1
    if (m.sentAt && (!cur.latestSentAt || new Date(m.sentAt) > new Date(cur.latestSentAt))) {
      cur.latestSentAt = m.sentAt
    }
    byKey.set(key, cur)
  }
  return Array.from(byKey.values()).sort(
    (a, b) => new Date(b.latestSentAt || 0) - new Date(a.latestSentAt || 0)
  )
}

// 특정 폴더 + 그룹(사람/제목) 하나에 속한 메일들을 최신순으로 돌려줍니다.
// 화면 오른쪽의 "최근 메일 목록"과 AI 요약 재료로 씁니다. filters는 groupMailsByFolder와
// 같은 조건이며, 그룹 목록을 만들 때와 항상 같은 filters를 넘겨야 개수가 서로 맞습니다.
function getMailsForFolderGroup(folderName, groupType, key, filters) {
  const matched = readAll().filter((m) => {
    if (m.folderName !== folderName) return false
    if (!mailMatchesFilters(m, filters)) return false
    return groupKeyAndLabel(m, groupType).key === key
  })
  matched.sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))
  return matched
}

function countMails() {
  return readAll().length
}

// ---- 메일함 탭: 저장된 메일 전체를 목록으로 보고, 하나 골라 전문을 읽기 ----------
// 폴더/보낸사람/제목/기간 필터(mailMatchesFilters와 동일)로 걸러 최신순으로 돌려줍니다.
// 목록에는 가벼운 필드만 필요하지만, 어차피 로컬 파일이라 그냥 전체를 돌려주고
// 화면(dashboard.html)에서 필요한 필드만 골라 씁니다.
function listMails(filters, limit) {
  const matched = readAll().filter((m) => {
    if (filters?.folderName && m.folderName !== filters.folderName) return false
    return mailMatchesFilters(m, filters)
  })
  matched.sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))
  return matched.slice(0, limit || 200)
}

// 메일함 탭에서 목록에 있는 메일 하나를 클릭했을 때, 본문 전체(bodyContent/bodyMimeType
// 포함)를 가져옵니다.
function getMailById(id) {
  return readAll().find((m) => m.id === id) || null
}

// IMAP에서 받아온 전문으로 저장된 메일의 본문을 교체합니다 (bodyFull: true 표시 포함).
// 한 번 전문으로 채워진 메일은 다시 IMAP에 접속하지 않습니다.
function updateMailBody(id, fields) {
  const all = readAll()
  let changed = false
  const updated = all.map((m) => {
    if (m.id !== id) return m
    changed = true
    return { ...m, ...fields }
  })
  if (!changed) return false
  fs.mkdirSync(MAIL_DIR, { recursive: true })
  fs.writeFileSync(MAIL_FILE, updated.map((m) => JSON.stringify(m) + '\n').join(''), 'utf-8')
  return true
}

module.exports = {
  appendMails,
  hasSeen,
  markSeen,
  recordFolders,
  listKnownFolders,
  countMails,
  groupMailsByFolder,
  getMailsForFolderGroup,
  listMails,
  getMailById,
  updateMailBody
}
