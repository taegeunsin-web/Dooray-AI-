// 채팅방 공유 투두리스트의 "태그"(사람별/업무 성격별 구분 섹션)를 저장하는 곳.
// 예: "태근", "재우"처럼 사람으로 나눌 수도 있고, "리포트 관련", "커뮤니케이션 관련"처럼
// 업무 성격으로 나눌 수도 있습니다. 대시보드에서 태그별로 카드를 묶어서 보여주고,
// 드래그로 카드를 다른 태그로 옮기거나 채팅으로 "이거 재우 태그로 바꿔줘"처럼 바꿀 수 있습니다.

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const TODO_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'shared-todo')
const TAGS_PATH = path.join(TODO_DIR, 'todo-tags.json')

function loadTags() {
  try {
    return JSON.parse(fs.readFileSync(TAGS_PATH, 'utf-8'))
  } catch {
    return []
  }
}

function saveTags(tags) {
  fs.mkdirSync(TODO_DIR, { recursive: true })
  fs.writeFileSync(TAGS_PATH, JSON.stringify(tags, null, 2), 'utf-8')
}

// 만든 순서(order) 그대로 돌려줍니다 (대시보드에 위에서부터 섹션으로 쌓임).
function listTags(channelId) {
  return loadTags()
    .filter((t) => t.channelId === channelId)
    .sort((a, b) => a.order - b.order)
}

function addTag({ channelId, name }) {
  const tags = loadTags()
  const existingCount = tags.filter((t) => t.channelId === channelId).length
  const tag = {
    id: crypto.randomUUID(),
    channelId,
    name: (name || '').trim(),
    order: existingCount,
    createdAt: Date.now()
  }
  tags.push(tag)
  saveTags(tags)
  return tag
}

function removeTag(id) {
  const tags = loadTags()
  const next = tags.filter((t) => t.id !== id)
  if (next.length === tags.length) return false
  saveTags(next)
  return true
}

// 이름으로 태그를 찾습니다 (채팅에서 "재우 태그로 바꿔줘"처럼 이름으로만 말했을 때 매칭용).
// 정확히 일치하는 게 없으면, 이름이 포함된 것 중 하나를 돌려줍니다.
function findTagByName(channelId, name) {
  const tags = listTags(channelId)
  const trimmed = (name || '').trim()
  if (!trimmed) return null
  return (
    tags.find((t) => t.name === trimmed) ||
    tags.find((t) => t.name.includes(trimmed) || trimmed.includes(t.name)) ||
    null
  )
}

module.exports = { listTags, addTag, removeTag, findTagByName, TAGS_PATH }
