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

// "정기 업무"는 매일/매주 등 주기마다 새 카드가 계속 쌓이는데, 화면/게시 메시지에는 같은
// 정기 업무(templateId)당 항상 "가장 최근 날짜(forDate)" 카드 1개만 보여줍니다. 이게 없으면
// 어제 완료했거나 못 끝낸 카드가 오늘 새로 만들어진 카드와 나란히 겹쳐 보이게 됩니다
// (실사용 중 발견된 문제 — 정기 업무가 아닌 일반 카드는 그대로 계속 남아있어야 하므로 건드리지 않음).
function keepLatestRoutineInstance(cards) {
  const latestIdByTemplate = new Map()
  for (const c of cards) {
    if (!c.templateId) continue
    const prev = latestIdByTemplate.get(c.templateId)
    if (!prev || (c.forDate || '') > (prev.forDate || '')) latestIdByTemplate.set(c.templateId, c)
  }
  const keepIds = new Set(Array.from(latestIdByTemplate.values()).map((c) => c.id))
  return cards.filter((c) => !c.templateId || keepIds.has(c.id))
}

// 채팅방 하나의 카드 전체를 돌려줍니다. 화면/게시 메시지에서 보기 좋게
// "할 일 먼저(만든 순서), 완료는 뒤(완료한 순서)"로 정렬합니다. 삭제된(status: 'deleted')
// 카드는 여기서 항상 제외합니다 — removeCard()가 실제로는 상태만 바꾸고 남겨두기 때문에
// (정기 업무 재생성 방지용), 화면/게시물에 다시 보이지 않게 여기서 걸러내야 합니다.
function listCards(channelId, { dateIso } = {}) {
  // (2026-08-13 수정) "최신 인스턴스 1장만" 고르기를 삭제 필터보다 먼저 합니다.
  // 예전엔 삭제된 카드를 먼저 걸러낸 뒤 최신을 골라서, 오늘 정기 업무 카드를 삭제하면
  // 어제 카드가 "최신"으로 승격돼 다시 나타났습니다 — 정기 업무만 삭제가 안 먹는 것처럼
  // 보였던 실사용 신고의 원인. 최신을 먼저 고르면, 그 최신이 삭제된 카드일 때 그 정기
  // 업무는 아무것도 안 보이는 게 맞는 동작이 됩니다.
  const mine = keepLatestRoutineInstance(loadCards().filter((c) => c.channelId === channelId))
  const cards = filterVisible(mine.filter((c) => c.status !== 'deleted'), dateIso)
  const todo = cards.filter((c) => c.status !== 'done').sort((a, b) => a.createdAt - b.createdAt)
  const done = cards.filter((c) => c.status === 'done').sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0))
  return [...todo, ...done]
}

function listOpenCards(channelId, { dateIso } = {}) {
  // (2026-08-13 수정) listCards와 같은 이유로 최신 인스턴스 고르기를 먼저 합니다.
  // (완료 필터를 먼저 하면, 오늘 완료한 정기 업무 자리에 어제의 미완료 카드가 다시 떠서
  //  홈 "오늘 할 일"에 이미 끝낸 일이 남아있는 것처럼 보일 수 있었습니다)
  const mine = keepLatestRoutineInstance(loadCards().filter((c) => c.channelId === channelId))
  const cards = mine.filter((c) => c.status !== 'done' && c.status !== 'deleted')
  return filterVisible(cards, dateIso)
}

// 같은 정기 업무 템플릿이 오늘 이미 카드로 만들어졌는지 확인합니다 (중복 생성 방지).
function findRoutineCardForToday(channelId, templateId, forDate) {
  return loadCards().find(
    (c) => c.channelId === channelId && c.templateId === templateId && c.forDate === forDate
  ) || null
}

// { channelId, text, templateId?, forDate?, dueDate?, tagId?, subTagId?, sourceMailRequestId? }
// - templateId/forDate: "정기 업무"에서 자동 생성할 때만 채웁니다(중복 생성 방지용).
// - dueDate('YYYY-MM-DD'): 이 카드를 언제부터 보여줄지. 없으면 즉시(오늘부터) 보여줍니다.
//   채팅에서 "7/29 메타 소재 종료 예약"처럼 특정 날짜가 언급된 새 할 일을 감지했을 때 씁니다.
// - tagId: 태그 보드에서 어느 태그 아래 있는지. 없으면 "미분류"로 보여줍니다.
// - subTagId: 매체(메타/구글/카카오 등) 서브태그. AI가 텍스트를 보고 자동으로 붙이거나,
//   사람이 대시보드에서 직접 바꿀 수 있습니다. 없으면 "미분류"로 취급합니다.
// - sourceMailRequestId: 메일함 [요청] 자동 동기화로 만들어진 카드일 때만 채웁니다(중복 생성 방지용).
function addCard({
  channelId,
  text,
  templateId = null,
  forDate = null,
  dueDate = null,
  tagId = null,
  subTagId = null,
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
    subTagId,
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

// 카드의 서브태그(매체)를 바꿉니다. AI 자동 인식뿐 아니라, 사람이 대시보드에서 직접
// 바꾸는 경우에도 이 함수를 씁니다. subTagId를 null로 주면 "미분류"로 돌아갑니다.
function setSubTag(id, subTagId) {
  const cards = loadCards()
  const card = cards.find((c) => c.id === id)
  if (!card) return null
  card.subTagId = subTagId || null
  saveCards(cards)
  return card
}

// 카드의 예정일(dueDate)을 바꿉니다. 투두 전용 캘린더에서 카드를 다른 날짜 칸으로
// 끌어다 놓았을 때 씁니다. dueDate를 null로 주면 "예정일 없음"(즉시 표시)으로 돌아갑니다.
function setDueDate(id, dueDate) {
  const cards = loadCards()
  const card = cards.find((c) => c.id === id)
  if (!card) return null
  card.dueDate = dueDate || null
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

// 카드의 내용(문구) 자체를 고칩니다. 태그/매체/예정일과 달리 "무엇을 할지" 자체를 바꾸는
// 것이라 대시보드 "수정" 버튼과 채팅 "OO를 XX로 바꿔줘" 둘 다 이 함수를 거칩니다.
function setText(id, text) {
  const cards = loadCards()
  const card = cards.find((c) => c.id === id)
  const trimmed = (text || '').trim()
  if (!card || !trimmed) return null
  card.text = trimmed
  saveCards(cards)
  return card
}

// 카드를 지웁니다. 배열에서 바로 빼버리지 않고 status를 'deleted'로 표시만 해서 남겨둡니다
// — 정기 업무로 만들어진 카드를 지운 경우, 배열에서 완전히 없애버리면 다음 게시 때
// findRoutineCardForToday가 "오늘 것 아직 안 만들었네"라고 착각해서 또 만들어버리는 문제가
//있었습니다(실사용 중 발견된 문제 — 삭제해도 계속 다시 생겨나는 것처럼 보임). 화면/게시물엔
// listCards/listOpenCards에서 걸러내 안 보이게 하고, 하루 지나면 cleanupOldCards가 완전히
// 지웁니다(그때는 오늘 날짜 재생성 검사 대상이 아니라서 안전).
function removeCard(id) {
  const cards = loadCards()
  const card = cards.find((c) => c.id === id)
  if (!card || card.status === 'deleted') return false
  card.status = 'deleted'
  card.deletedAt = Date.now()
  saveCards(cards)
  return true
}

// KST 기준으로 타임스탬프의 날짜(YYYY-MM-DD)만 뽑습니다(완료/삭제 시각이 "오늘"인지 비교용).
function kstDateOf(ts) {
  if (!ts) return ''
  const kst = new Date(ts + 9 * 60 * 60 * 1000)
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`
}

// 오늘이 아닌 날 완료되었거나 삭제된 카드를 파일에서 완전히 지웁니다. 완료 기록은 이미
// todoHistoryStore(엑셀 내보내기용)에 영구 저장되어 있어서, 활성 목록에까지 계속 남아있을
// 필요가 없습니다 — 이게 없으면 어제, 그저께 완료한 것들이 계속 오늘 게시물에 체크된 채로
// 끼어 보이는 문제가 있었습니다(실사용 중 발견된 문제). postTodoListNow가 게시할 때마다
// 부르므로, 하루에 한 번쯤은 자연히 정리됩니다.
function cleanupOldCards(channelId, todayIso) {
  const cards = loadCards()
  const next = cards.filter((c) => {
    if (c.channelId !== channelId) return true
    if (c.status === 'done' && kstDateOf(c.doneAt) && kstDateOf(c.doneAt) < todayIso) return false
    if (c.status === 'deleted' && kstDateOf(c.deletedAt) && kstDateOf(c.deletedAt) < todayIso) return false
    return true
  })
  if (next.length !== cards.length) saveCards(next)
  return cards.length - next.length
}

// ---- 채널별 상태 기록 (오늘 이미 게시했는지 + 채팅 감지를 어디까지 처리했는지) -------
// 원래는 "채널ID -> 게시한 날짜 문자열"만 저장했는데(예전 형식), 프로그램이 꺼져있던
// 동안 놓친 채팅을 나중에 따라잡아 처리하려면(캐치업) 채널별로 "마지막으로 처리한 시각"도
// 같이 저장해야 해서 채널ID -> {lastPostedDate, lastProcessedTs} 객체 형태로 확장함.
// 예전에 저장된 문자열 값도 그대로 읽을 수 있게 호환 처리(getChannelState).
function loadPostState() {
  try {
    return JSON.parse(fs.readFileSync(POST_STATE_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function getChannelState(channelId) {
  const raw = loadPostState()[channelId]
  if (!raw) return {}
  if (typeof raw === 'string') return { lastPostedDate: raw } // 예전 형식(문자열만 저장) 호환
  return raw
}

function saveChannelState(channelId, patch) {
  const state = loadPostState()
  state[channelId] = { ...getChannelState(channelId), ...patch }
  fs.mkdirSync(TODO_DIR, { recursive: true })
  fs.writeFileSync(POST_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
}

function getLastPostedDate(channelId) {
  return getChannelState(channelId).lastPostedDate || ''
}

function setLastPostedDate(channelId, dateStr) {
  saveChannelState(channelId, { lastPostedDate: dateStr })
}

// 이 채널에서 "완료/삭제/추가/태그변경 감지"를 실시간으로 마지막까지 처리한 시각(ms).
// 프로그램이 꺼져있다가 다시 켜지면, 이 시각 이후 놓친 채팅만 골라 다시 처리(캐치업)함.
function getLastProcessedTs(channelId) {
  return getChannelState(channelId).lastProcessedTs || 0
}

function setLastProcessedTs(channelId, ts) {
  saveChannelState(channelId, { lastProcessedTs: ts })
}

module.exports = {
  listCards,
  listOpenCards,
  findRoutineCardForToday,
  findCardBySource,
  addCard,
  setStatus,
  setTag,
  setSubTag,
  setDueDate,
  setText,
  removeCard,
  cleanupOldCards,
  getLastPostedDate,
  setLastPostedDate,
  // (2026-08-11 추가) 아침 브리핑이 "오늘 이미 보냈나"를 채널 상태에 기록하는 데 씀.
  // 함수 자체는 2026-07-30부터 있었는데 내보내기(module.exports)에 빠져 있었음 —
  // 그동안은 이 파일 안에서만 썼기 때문에 문제가 없다가, 브리핑이 밖에서 부르면서 드러남.
  getChannelState,
  saveChannelState,
  getLastProcessedTs,
  setLastProcessedTs,
  CARDS_PATH
}
