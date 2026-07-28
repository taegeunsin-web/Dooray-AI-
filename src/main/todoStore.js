// 채팅방 공유 투두리스트의 "카드"(할 일 항목)를 저장하는 곳.
// mailSummaryCache.js와 같은 이유로, 일렉트론 전용 폴더가 아니라 "홈 폴더 밑 공용 작업 폴더"에
// 저장합니다 — 두레이봇이 쓰는 MCP 서버/메인 프로세스 양쪽에서 같은 파일을 보게 하기 위함입니다.

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const TODO_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'shared-todo')
const CARDS_PATH = path.join(TODO_DIR, 'todo-cards.json')
const POST_STATE_PATH = path.join(TODO_DIR, 'todo-post-state.json')

function loadCards() {
  try {
    return JSON.parse(fs.readFileSync(CARDS_PATH, 'utf-8'))
  } catch {
    return []
  }
}

function saveCards(cards) {
  fs.mkdirSync(TODO_DIR, { recursive: true })
  fs.writeFileSync(CARDS_PATH, JSON.stringify(cards, null, 2), 'utf-8')
}

// dueDate(예정일)가 있는 카드는 그 날짜가 되기 전까지는 "아직 안 보여줄 카드"입니다.
// dateIso를 넘기면 그 날짜 기준으로 아직 예정일이 안 된 카드를 걸러냅니다(게시 메시지/채팅
// 완료 감지용). dateIso를 안 넘기면 전부 돌려줍니다(대시보드에서 예정된 것까지 관리용으로 봄).
function filterVisible(cards, dateIso) {
  if (!dateIso) return cards
  return cards.filter((c) => !c.dueDate || c.dueDate <= dateIso)
}

// 채팅방 하나의 카드 전체를 돌려줍니다. 화면/게시 메시지에서 보기 좋게
// "할 일 먼저(만든 순서), 완료는 뒤(완료한 순서)"로 정렬합니다.
function listCards(channelId, { dateIso } = {}) {
  const cards = filterVisible(loadCards().filter((c) => c.channelId === channelId), dateIso)
  const todo = cards.filter((c) => c.status !== 'done').sort((a, b) => a.createdAt - b.createdAt)
  const done = cards.filter((c) => c.status === 'done').sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0))
  return [...todo, ...done]
}

function listOpenCards(channelId, { dateIso } = {}) {
  const cards = loadCards().filter((c) => c.channelId === channelId && c.status !== 'done')
  return filterVisible(cards, dateIso)
}

// 같은 정기 업무 템플릿이 오늘 이미 카드로 만들어졌는지 확인합니다 (중복 생성 방지).
function findRoutineCardForToday(channelId, templateId, forDate) {
  return loadCards().find(
    (c) => c.channelId === channelId && c.templateId === templateId && c.forDate === forDate
  ) || null
}

// { channelId, text, templateId?, forDate?, dueDate?, tagId?, sourceMailRequestId? }
// - templateId/forDate: "정기 업무"에서 자동 생성할 때만 채웁니다(중복 생성 방지용).
// - dueDate('YYYY-MM-DD'): 이 카드를 언제부터 보여줄지. 없으면 즉시(오늘부터) 보여줍니다.
//   채팅에서 "7/29 메타 소재 종료 예약"처럼 특정 날짜가 언급된 새 할 일을 감지했을 때 씁니다.
// - tagId: 태그 보드에서 어느 태그 아래 있는지. 없으면 "미분류"로 보여줍니다.
// - sourceMailRequestId: 메일함 [요청] 자동 동기화로 만들어진 카드일 때만 채웁니다(중복 생성 방지용).
function addCard({
  channelId,
  text,
  templateId = null,
  forDate = null,
  dueDate = null,
  tagId = null,
  sourceMailRequestId = null
}) {
  const cards = loadCards()
  const card = {
    id: crypto.randomUUID(),
    channelId,
    text: (text || '').trim(),
    status: 'todo',
    templateId,
    forDate,
    dueDate,
    tagId,
    sourceMailRequestId,
    createdAt: Date.now(),
    doneAt: null
  }
  cards.push(card)
  saveCards(cards)
  return card
}

// 메일 동기화로 이미 만들어둔 카드인지 확인합니다 (중복 생성 방지).
function findCardBySource(channelId, sourceMailRequestId) {
  if (!sourceMailRequestId) return null
  return (
    loadCards().find(
      (c) => c.channelId === channelId && c.sourceMailRequestId === sourceMailRequestId
    ) || null
  )
}

// 카드의 태그를 바꿉니다. tagId를 null로 주면 "미분류"로 돌아갑니다.
function setTag(id, tagId) {
  const cards = loadCards()
  const card = cards.find((c) => c.id === id)
  if (!card) return null
  card.tagId = tagId || null
  saveCards(cards)
  return card
}

function setStatus(id, status) {
  const cards = loadCards()
  const card = cards.find((c) => c.id === id)
  if (!card) return null
  card.status = status
  card.doneAt = status === 'done' ? Date.now() : null
  saveCards(cards)
  return card
}

function removeCard(id) {
  const cards = loadCards()
  const next = cards.filter((c) => c.id !== id)
  if (next.length === cards.length) return false
  saveCards(next)
  return true
}

// ---- 오늘 이미 게시했는지 기록 (같은 날 중복 게시 방지) ------------------------
function loadPostState() {
  try {
    return JSON.parse(fs.readFileSync(POST_STATE_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function getLastPostedDate(channelId) {
  return loadPostState()[channelId] || ''
}

function setLastPostedDate(channelId, dateStr) {
  const state = loadPostState()
  state[channelId] = dateStr
  fs.mkdirSync(TODO_DIR, { recursive: true })
  fs.writeFileSync(POST_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
}

module.exports = {
  listCards,
  listOpenCards,
  findRoutineCardForToday,
  findCardBySource,
  addCard,
  setStatus,
  setTag,
  removeCard,
  getLastPostedDate,
  setLastPostedDate,
  CARDS_PATH
}
