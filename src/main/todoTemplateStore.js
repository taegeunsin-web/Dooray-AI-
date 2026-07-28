// 채팅방 공유 투두리스트의 "정기 업무" 템플릿을 저장하는 곳. 채팅방 단위 공용(그 방 팀원 전체가
// 같이 봄)이며, 정해둔 주기(cycle)에 맞는 날짜에만 "오늘의 할일"에 자동으로 카드가 만들어집니다.
// 예전에 만든 파이썬 투두 앱(todo_app/db.py의 routines 테이블 · cycle/start_date/end_date 방식)의
// 개념을 그대로 참고했습니다: weekly/monthly는 start_date(기준일)의 요일/날짜를 그대로 주기로 씁니다.
//
// cycle 종류:
//   - 'daily'   : 매일 (startDate/endDate는 선택 — 있으면 그 기간 안에서만 매일 생성)
//   - 'weekly'  : startDate와 같은 요일마다 (startDate 필수, 그날의 요일이 기준)
//   - 'monthly' : startDate와 같은 날짜(며칠)마다 (startDate 필수, 그날의 "일"이 기준)
//   - 'once'    : startDate 그 하루에만 (endDate는 안 씀)

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const TODO_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'shared-todo')
const TEMPLATES_PATH = path.join(TODO_DIR, 'todo-templates.json')

function loadTemplates() {
  try {
    return JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf-8'))
  } catch {
    return []
  }
}

function saveTemplates(templates) {
  fs.mkdirSync(TODO_DIR, { recursive: true })
  fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(templates, null, 2), 'utf-8')
}

function listTemplates(channelId) {
  return loadTemplates().filter((t) => t.channelId === channelId)
}

// { channelId, text, cycle: 'daily'|'weekly'|'monthly'|'once', startDate?, endDate? }
// startDate/endDate는 'YYYY-MM-DD'(KST 기준) 문자열입니다.
function addTemplate({ channelId, text, cycle, startDate = null, endDate = null }) {
  const templates = loadTemplates()
  const template = {
    id: crypto.randomUUID(),
    channelId,
    text: (text || '').trim(),
    cycle: cycle || 'daily',
    startDate: startDate || null,
    endDate: endDate || null,
    createdAt: Date.now()
  }
  templates.push(template)
  saveTemplates(templates)
  return template
}

function removeTemplate(id) {
  const templates = loadTemplates()
  const next = templates.filter((t) => t.id !== id)
  if (next.length === templates.length) return false
  saveTemplates(next)
  return true
}

// 이 템플릿이 dateIso('YYYY-MM-DD', KST 기준) 날짜에 카드를 만들어야 하는지 판단합니다.
// weekly/monthly인데 startDate가 없으면(잘못 저장된 옛 데이터 등) 안전하게 생성하지 않습니다.
function shouldFireOn(template, dateIso) {
  const { cycle, startDate, endDate } = template
  if (startDate && dateIso < startDate) return false
  if (cycle !== 'once' && endDate && dateIso > endDate) return false

  if (cycle === 'once') return startDate === dateIso
  if (cycle === 'weekly') {
    if (!startDate) return false
    return new Date(`${dateIso}T00:00:00Z`).getUTCDay() === new Date(`${startDate}T00:00:00Z`).getUTCDay()
  }
  if (cycle === 'monthly') {
    if (!startDate) return false
    return new Date(`${dateIso}T00:00:00Z`).getUTCDate() === new Date(`${startDate}T00:00:00Z`).getUTCDate()
  }
  return true // 'daily' (또는 예전 데이터처럼 cycle이 비어있는 경우)
}

module.exports = { listTemplates, addTemplate, removeTemplate, shouldFireOn, TEMPLATES_PATH }
