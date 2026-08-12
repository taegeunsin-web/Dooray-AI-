// (2026-08-11 신규) 자주 쓰는 프롬프트("스킬") 저장소.
// 대시보드 채팅 탭에서 자주 쓰는 지시문을 저장해두고 클릭 한 번으로 다시 쓰는 기능.
// todoStore.js와 같은 방식의 로컬 JSON 파일 저장입니다 — 두레이에는 아무것도 안 올라갑니다.

const fs = require('fs')
const os = require('os')
const path = require('path')

const PROMPT_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'prompts')
const PROMPT_PATH = path.join(PROMPT_DIR, 'prompts.json')

function loadAll() {
  try {
    if (!fs.existsSync(PROMPT_PATH)) return []
    const raw = JSON.parse(fs.readFileSync(PROMPT_PATH, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return [] // 파일이 깨졌어도 앱이 죽지 않게 — 새로 저장하면 다시 만들어집니다
  }
}

function saveAll(list) {
  fs.mkdirSync(PROMPT_DIR, { recursive: true })
  fs.writeFileSync(PROMPT_PATH, JSON.stringify(list, null, 2), 'utf-8')
}

function listPrompts() {
  return loadAll()
}

function addPrompt({ title, text }) {
  const t = (title || '').trim()
  const body = (text || '').trim()
  if (!t) throw new Error('프롬프트 이름을 적어주세요.')
  if (!body) throw new Error('프롬프트 내용을 적어주세요.')
  const list = loadAll()
  const item = {
    id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: t,
    text: body,
    createdAt: new Date().toISOString()
  }
  list.unshift(item)
  saveAll(list)
  return item
}

function removePrompt(id) {
  const list = loadAll()
  const next = list.filter((p) => p.id !== id)
  if (next.length === list.length) return false
  saveAll(next)
  return true
}

module.exports = { listPrompts, addPrompt, removePrompt }
