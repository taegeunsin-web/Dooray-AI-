// 채팅방 공유 투두리스트의 "서브태그"(매체 구분: 메타/구글/카카오/SA 등)를 저장하는 곳.
// 위에 있는 "태그"(사람별/업무 성격별)와는 별개의 축입니다 — 카드 하나가 태그(예: 태근)와
// 서브태그(예: 메타)를 동시에 가질 수 있습니다.
//
// 사람 태그와 다른 점: 태그는 대시보드에서 사람이 직접 만들지만, 서브태그는 새 할 일이
// 등록될 때 AI가 텍스트("메타 소재 세팅"처럼)를 보고 자동으로 인식해서 붙여줍니다.
// 그래서 "같은 매체인데 표기가 갈리는 문제"(메타 vs Meta vs 페이스북)를 줄이려고,
// findSubTagByName()으로 이 채팅방에서 이미 쓰인 이름을 먼저 찾아 재사용하고,
// 정말 처음 보는 이름일 때만 새로 만듭니다. 물론 사람이 대시보드에서 직접 바꿀 수도 있습니다.

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const TODO_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'shared-todo')
const SUBTAGS_PATH = path.join(TODO_DIR, 'todo-subtags.json')

function loadSubTags() {
  try {
    return JSON.parse(fs.readFileSync(SUBTAGS_PATH, 'utf-8'))
  } catch {
    return []
  }
}

function saveSubTags(subTags) {
  fs.mkdirSync(TODO_DIR, { recursive: true })
  fs.writeFileSync(SUBTAGS_PATH, JSON.stringify(subTags, null, 2), 'utf-8')
}

// 만든 순서(order) 그대로 돌려줍니다.
function listSubTags(channelId) {
  return loadSubTags()
    .filter((t) => t.channelId === channelId)
    .sort((a, b) => a.order - b.order)
}

function addSubTag({ channelId, name }) {
  const subTags = loadSubTags()
  const existingCount = subTags.filter((t) => t.channelId === channelId).length
  const subTag = {
    id: crypto.randomUUID(),
    channelId,
    name: (name || '').trim(),
    aliases: [], // 예: "네이버" 매체에 "브검"/"브랜드검색"처럼 텍스트에 매체명이 그대로 안
    // 적히는 경우를 위한 별칭 목록. 사람이 대시보드에서 직접 등록합니다.
    order: existingCount,
    createdAt: Date.now()
  }
  subTags.push(subTag)
  saveSubTags(subTags)
  return subTag
}

// 서브태그에 별칭을 하나 추가합니다(대시보드에서 사람이 직접 등록). 이미 같은 별칭이
// 있거나(이 채팅방 어느 매체에든) 빈 문자열이면 아무 것도 하지 않습니다.
function addAlias(id, alias) {
  const trimmed = (alias || '').trim()
  if (!trimmed) return null
  const subTags = loadSubTags()
  const subTag = subTags.find((t) => t.id === id)
  if (!subTag) return null
  if (!Array.isArray(subTag.aliases)) subTag.aliases = []
  const already = subTags.some(
    (t) => t.channelId === subTag.channelId && (t.aliases || []).some((a) => a === trimmed)
  )
  if (already || subTag.name === trimmed) return subTag
  subTag.aliases.push(trimmed)
  saveSubTags(subTags)
  return subTag
}

function removeAlias(id, alias) {
  const subTags = loadSubTags()
  const subTag = subTags.find((t) => t.id === id)
  if (!subTag || !Array.isArray(subTag.aliases)) return null
  subTag.aliases = subTag.aliases.filter((a) => a !== alias)
  saveSubTags(subTags)
  return subTag
}

function removeSubTag(id) {
  const subTags = loadSubTags()
  const next = subTags.filter((t) => t.id !== id)
  if (next.length === subTags.length) return false
  saveSubTags(next)
  return true
}

// 이름으로 서브태그를 찾습니다 (AI가 텍스트에서 뽑아낸 매체명이 이미 등록된 것과 같은지
// 확인할 때 씁니다). 우선순위: ①이름 정확히 일치 ②별칭 정확히 일치("브검"→"네이버"처럼
// 텍스트에 매체명이 그대로 안 적히는 경우) ③이름이 서로 포함되는 경우("메타" ↔ "메타 광고"
// 처럼 표기가 조금 다른 경우까지 최대한 같은 것으로 묶기 위함).
function findSubTagByName(channelId, name) {
  const subTags = listSubTags(channelId)
  const trimmed = (name || '').trim()
  if (!trimmed) return null
  return (
    subTags.find((t) => t.name === trimmed) ||
    subTags.find((t) => (t.aliases || []).some((a) => a === trimmed)) ||
    subTags.find((t) => t.name.includes(trimmed) || trimmed.includes(t.name)) ||
    null
  )
}

// AI가 텍스트에서 매체명을 뽑아 왔을 때 호출하는 헬퍼: 이미 있으면 그 서브태그를,
// 없으면 새로 만들어서 돌려줍니다. mediaName이 비어있으면 아무 것도 안 하고 null.
function resolveOrCreateSubTag(channelId, mediaName) {
  const trimmed = (mediaName || '').trim()
  if (!trimmed) return null
  const existing = findSubTagByName(channelId, trimmed)
  if (existing) return existing
  return addSubTag({ channelId, name: trimmed })
}

module.exports = {
  listSubTags,
  addSubTag,
  removeSubTag,
  findSubTagByName,
  resolveOrCreateSubTag,
  addAlias,
  removeAlias,
  SUBTAGS_PATH
}
