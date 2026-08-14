#!/usr/bin/env node
/**
 * dooray-mcp-server.mjs
 *
 * 두레이 REST API를 클로드 코드(claude)가 도구(tool)로 쓸 수 있게 해주는 MCP 서버.
 * 이 프로그램(dooray-assistant) 안에 번들로 들어있고, ensureMcp.js가 처음 실행 시
 * 자동으로 "claude mcp add"로 등록합니다.
 *
 * 지금까지 대화에서 실제로 두레이 공식 문서를 확인하며 검증한 API들만 담았습니다
 * (캘린더 일정 생성, 회의실 예약 생성, 드라이브 폴더 생성, 공유링크 생성은
 *  Claude in Chrome으로 실제 문서 화면을 읽어서 확정한 스펙입니다).
 *
 * 실행: node dooray-mcp-server.mjs
 * 토큰: 1순위 OS 자격 증명 관리자(keytar), 2순위 DOORAY_API_TOKEN 환경변수
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { createRequire } from 'module'

const BASE_URL = 'https://api.dooray.com'

// 토큰 읽는 순서 (보안 개선):
//  1순위: OS 자격 증명 관리자(keytar) — 앱이 저장해둔 곳에서 직접 읽음. 토큰이 어떤
//         파일에도 평문으로 남지 않는 방식이라 이걸 우선합니다.
//  2순위: DOORAY_API_TOKEN 환경변수 — keytar를 이 node에서 못 읽는 환경을 위한 예비책
//         (ensureMcp.js가 그런 환경에서만 --env로 토큰을 넘겨 등록합니다).
const require = createRequire(import.meta.url)
// (2026-08-10 추가) 두레이 파일 API 속도 제한 대기표 — src/main/rateLimiter.js 설명 참고.
// 이 MCP 서버는 앱과 별개 프로세스라 각자 자기 물통을 씁니다.
const { doorayFileLimiter, doorayApiLimiter, withRateLimit } = require('../main/rateLimiter.js')

let TOKEN = ''
try {
  const keytar = require('keytar')
  TOKEN = (await keytar.getPassword('dooray-assistant', 'default')) || ''
} catch {
  // keytar 로드 실패(일반 node에서 네이티브 모듈 호환 문제 등) — 환경변수로 넘어갑니다.
}
if (!TOKEN) TOKEN = process.env.DOORAY_API_TOKEN || ''

// 캘린더 CalDAV 연동 계정 정보 — 설정 탭(config.json)에 저장된 메일주소 + 자격 증명 관리자에
// 저장된 비밀번호. doorayService.js와 똑같은 방식(caldavClient.js 공용 모듈)을 씁니다.
const caldavClient = require('../main/caldavClient')
async function getCaldavCreds() {
  let user = ''
  try {
    const raw = fs.readFileSync(ELECTRON_CONFIG_PATH, 'utf-8')
    user = JSON.parse(raw).caldavUser || ''
  } catch {
    // 설정 파일을 못 읽으면 user가 빈 값으로 남고, 아래 호출부에서 에러로 처리됩니다.
  }
  let password = ''
  try {
    const keytar = require('keytar')
    password = (await keytar.getPassword('dooray-assistant', 'caldav-password')) || ''
  } catch {
    // keytar 못 쓰면 캘린더 등록/조회 도구가 에러를 그대로 돌려줍니다.
  }
  return { user, password }
}

// 채팅 기록 검색용: dooray-assistant 앱(chatHistoryStore.js)이 저장해두는 것과 정확히 같은
// 위치/형식(채널ID.jsonl, 한 줄에 { senderId, text, ts } 하나)을 그대로 읽습니다. 이 MCP
// 서버는 별도 프로세스라 그 모듈을 직접 불러오는 대신 같은 파일을 이렇게 다시 읽습니다.
const CHAT_HISTORY_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'chat-history')

// ---------------------------------------------------------------------------
// 메일 탭 관련: 대시보드가 쓰는 것과 같은 저장 파일을 읽습니다 (mailStore.js/mailSummaryCache.js
// 와 같은 위치/형식). 그룹핑·필터 로직도 이 두 파일과 똑같이 맞춰서 여기 그대로 옮겨왔습니다
// (다른 프로세스라 그 모듈을 직접 불러오지 못해서, 채팅 기록 때와 같은 방식으로 다시 구현).
// ---------------------------------------------------------------------------
const MAIL_FILE = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'mail-history', 'mails.jsonl')
const MAIL_CACHE_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'mail-cache')
const MAIL_SUMMARY_CACHE_PATH = path.join(MAIL_CACHE_DIR, 'mail-group-summary-cache.json')
const MAIL_REQUEST_DONE_PATH = path.join(MAIL_CACHE_DIR, 'mail-request-done.json')
// 설정 파일(config.json, 즐겨찾기·두레이 주소 등)은 일렉트론 전용 위치에 저장됩니다.
// 이 프로그램은 Windows 전용으로 빌드되어 있어서(package.json의 build.win 설정 참고),
// 일렉트론이 쓰는 실제 경로(%APPDATA%\dooray-assistant)를 그대로 계산해서 읽습니다.
const ELECTRON_CONFIG_PATH = path.join(os.homedir(), 'AppData', 'Roaming', 'dooray-assistant', 'config.json')

function readAllMails() {
  if (!fs.existsSync(MAIL_FILE)) return []
  const raw = fs.readFileSync(MAIL_FILE, 'utf-8')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

function readAppConfig() {
  try {
    return JSON.parse(fs.readFileSync(ELECTRON_CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function readMailSummaryCache() {
  try {
    return JSON.parse(fs.readFileSync(MAIL_SUMMARY_CACHE_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function readMailRequestDoneMap() {
  try {
    return JSON.parse(fs.readFileSync(MAIL_REQUEST_DONE_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function mailUrlOf(mail, doorayDomain) {
  return doorayDomain ? `https://${doorayDomain}/mail/folders/${mail.folderId}/${mail.id}` : ''
}

// (2026-08-11 신규) 드라이브 파일의 "두레이 안 고정 주소". 공유 링크와 달리 API 권한이
// 필요 없고, 두레이에 로그인된 팀원이면 클릭으로 바로 열립니다.
// 형식은 사용자가 실제 브라우저 주소창에서 복사해 확인한 것:
//   https://{도메인}/drive/{driveId}/{folderId}/views/{fileId}
function driveFileWebUrl(driveId, folderId, fileId) {
  const domain = readAppConfig().doorayDomain
  if (!domain || !driveId || !folderId || !fileId) return ''
  return `https://${domain}/drive/${driveId}/${folderId}/views/${fileId}`
}

// mailStore.js의 mailMatchesFilters와 동일한 규칙 (보낸사람/제목/받은기간).
function mailMatchesFilters(mail, filters) {
  if (!filters) return true
  const fromQ = (filters.from || '').trim().toLowerCase()
  const subjectQ = (filters.subject || '').trim().toLowerCase()
  if (fromQ && !`${mail.fromName || ''} ${mail.fromEmail || ''}`.toLowerCase().includes(fromQ)) return false
  if (subjectQ && !(mail.subject || '').toLowerCase().includes(subjectQ)) return false
  const dateFromQ = (filters.dateFrom || '').trim()
  const dateToQ = (filters.dateTo || '').trim()
  if (dateFromQ || dateToQ) {
    const sent = new Date(mail.sentAt || 0)
    if (dateFromQ && sent < new Date(`${dateFromQ}T00:00:00`)) return false
    if (dateToQ && sent > new Date(`${dateToQ}T23:59:59`)) return false
  }
  return true
}

// mailStore.js의 personGroupKey/personGroupLabel/normalizeSubject/groupKeyAndLabel과 동일.
function personGroupKey(mail) {
  const email = (mail.fromEmail || '').trim()
  const name = (mail.fromName || '').trim()
  return (email || name || '(발신자 미상)').toLowerCase()
}
function personGroupLabel(mail) {
  return mail.fromName || mail.fromEmail || '(발신자 미상)'
}
function normalizeSubject(subject) {
  let s = (subject || '').trim()
  let changed = true
  while (changed) {
    changed = false
    const next = s.replace(/^(re|fw|fwd|회신|전달)\s*[:\-]\s*/i, '')
    if (next !== s) { s = next.trim(); changed = true }
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

// mailSummaryCache.js의 makeCacheKey와 반드시 동일한 형식이어야 저장된 요약을 찾을 수 있습니다.
function makeSummaryCacheKey(folderName, groupType, groupKey, filterSig) {
  return `${folderName}::${groupType}::${groupKey}::${filterSig || ''}`
}

if (!TOKEN) {
  console.error('[dooray-mcp] 두레이 API 토큰을 찾지 못했습니다 (자격 증명 관리자/환경변수 모두 없음).')
  process.exit(1)
}

// (2026-08-11 추가) 앱 본체와 같은 이유로, MCP 서버의 모든 호출에도 속도 제한 + 429 재시도를
// 깝니다. (별개 프로세스라 앱과 대기표는 따로지만, 각자 초당 3개면 합쳐도 안전권입니다.)
async function doorayFetch(reqPath, opts = {}) {
  return withRateLimit(doorayApiLimiter, () => doorayFetchOnce(reqPath, opts))
}

async function doorayFetchOnce(reqPath, { method = 'GET', body, query } = {}) {
  let url = `${BASE_URL}${reqPath}`
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      qs.set(k, String(v))
    }
    const qsStr = qs.toString()
    if (qsStr) url += `?${qsStr}`
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `dooray-api ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  if (!res.ok) {
    const msg = json?.header?.resultMessage || json?.message || text || `HTTP ${res.status}`
    throw new Error(`두레이 API 오류 (${res.status}) ${method} ${reqPath}: ${msg}`)
  }
  return json
}

// 두레이 파일 업로드는 다운로드와 같은 2단계 구조입니다 (방향만 반대):
//  1) api.dooray.com 으로 요청 → 307과 함께 file-api.dooray.com 주소를 받음
//  2) 그 주소로 Authorization을 유지한 채 다시 요청 → 실제 업로드
// ⚠️ Content-Type을 직접 지정하면 안 됩니다. FormData를 넘기면 fetch가
//    boundary가 포함된 올바른 Content-Type을 자동으로 붙여줍니다.
//    수동으로 'multipart/form-data'만 적으면 boundary가 없어서 서버가 못 읽습니다.
async function doorayUploadFile(reqPath, localPath, { method = 'POST' } = {}) {
  if (!fs.existsSync(localPath)) {
    throw new Error(`업로드할 파일이 없습니다: ${localPath}`)
  }
  const fileName = path.basename(localPath)

  // FormData는 한 번 보내면 소진되므로 단계마다 새로 만듭니다.
  const buildForm = async () => {
    const form = new FormData()
    form.append('file', await fs.openAsBlob(localPath), fileName)
    return form
  }

  const step1 = await fetch(`${BASE_URL}${reqPath}`, {
    method,
    redirect: 'manual',
    headers: { Authorization: `dooray-api ${TOKEN}` },
    body: await buildForm()
  })
  if (step1.status !== 307 && step1.status !== 302) {
    const t = await step1.text().catch(() => '')
    throw new Error(`파일 업로드 1단계 실패 (${step1.status}) — 예상한 리다이렉트 응답이 아닙니다. ${t}`)
  }
  const location = step1.headers.get('location')
  if (!location) throw new Error('파일 업로드 1단계: location 헤더가 없습니다.')

  const step2 = await fetch(location, {
    method,
    headers: { Authorization: `dooray-api ${TOKEN}` },
    body: await buildForm()
  })
  const text = await step2.text()
  let json
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  if (!step2.ok || json?.header?.isSuccessful === false) {
    const msg = json?.header?.resultMessage || text || `HTTP ${step2.status}`
    throw new Error(`파일 업로드 2단계 실패 (${step2.status}): ${msg}`)
  }
  return { fileName, result: json.result || {} }
}

// 파일 원본을 컴퓨터에 저장해두는 폴더. 다운로드한 파일의 실제 내용은 절대 클로드에게
// 텍스트로 돌려주지 않고(용량이 크면 문맥이 감당 못 함), 저장된 "경로"만 알려줍니다 —
// 구글 드라이브 업로드 도구는 이 경로를 읽어서 올리면 됩니다.
const DRIVE_DOWNLOAD_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'drive-downloads')

// 파일 이름에 쓸 수 없는 문자(윈도우 기준)를 안전하게 치환합니다.
function sanitizeFileName(name) {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned || 'download'
}

// 두레이 파일 다운로드는 공식 가이드 기준으로 2단계입니다:
//  1) media=raw 로 원래 주소에 요청 → 307과 함께 실제 파일 서버(file-api.dooray.com) 주소를 받음
//  2) 그 주소로 Authorization을 그대로 유지한 채 다시 요청 → 응답 본문이 파일 원본
// (자동 리다이렉트를 쓰면 일부 클라이언트에서 Authorization 헤더가 리다이렉트 중 빠져서
//  401이 난다는 게 공식 가이드에도 나와있어서, 직접 두 단계로 나눠 처리합니다.)
// 실제 다운로드는 아래 ...Once 가 하고, 이 함수는 속도 제한 대기표를 거치게 하는 얇은 껍데기입니다.
// (드라이브 파일 / 채팅방 파일 다운로드 3곳이 전부 이 함수 하나를 지나갑니다.)
async function downloadDoorayFileToDisk(reqPath, fileName) {
  return withRateLimit(doorayFileLimiter, () => downloadDoorayFileToDiskOnce(reqPath, fileName))
}

async function downloadDoorayFileToDiskOnce(reqPath, fileName) {
  const step1 = await fetch(`${BASE_URL}${reqPath}`, {
    method: 'GET',
    redirect: 'manual',
    headers: { Authorization: `dooray-api ${TOKEN}` }
  })
  if (step1.status !== 307 && step1.status !== 302) {
    throw new Error(`파일 다운로드 1단계 실패 (${step1.status}) — 예상한 리다이렉트 응답이 아닙니다.`)
  }
  const location = step1.headers.get('location')
  if (!location) throw new Error('파일 다운로드 1단계: location 헤더가 없습니다.')

  const step2 = await fetch(location, {
    method: 'GET',
    headers: { Authorization: `dooray-api ${TOKEN}` }
  })
  if (!step2.ok || !step2.body) {
    throw new Error(`파일 다운로드 2단계 실패 (${step2.status})`)
  }

  fs.mkdirSync(DRIVE_DOWNLOAD_DIR, { recursive: true })
  // 같은 이름의 예전 다운로드와 안 겹치게, 파일ID 대신 시각을 붙여 구분합니다.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeName = sanitizeFileName(fileName)
  const localPath = path.join(DRIVE_DOWNLOAD_DIR, `${stamp}_${safeName}`)

  const { Readable } = await import('stream')
  const { pipeline } = await import('stream/promises')
  await pipeline(Readable.fromWeb(step2.body), fs.createWriteStream(localPath))

  const stat = fs.statSync(localPath)
  return { localPath, sizeBytes: stat.size }
}

// ---------------------------------------------------------------------------
// 채팅 기록 검색 도우미 (chatHistoryStore.js와 같은 저장 파일을 읽음)
// ---------------------------------------------------------------------------
function listStoredChannelIds() {
  if (!fs.existsSync(CHAT_HISTORY_DIR)) return []
  return fs
    .readdirSync(CHAT_HISTORY_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
}

function readChannelHistoryFile(channelId) {
  const file = path.join(CHAT_HISTORY_DIR, `${channelId}.jsonl`)
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

// 채팅방에 올라온 파일(첨부파일) 목록 읽기. channelFileStore.js(dooray-assistant 앱)가
// 실시간으로 저장해두는 것과 정확히 같은 위치/형식({channelId}.files.jsonl)을 읽습니다.
function readChannelFilesFile(channelId) {
  const file = path.join(CHAT_HISTORY_DIR, `${channelId}.files.jsonl`)
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

function listStoredChannelFileIds() {
  if (!fs.existsSync(CHAT_HISTORY_DIR)) return []
  return fs
    .readdirSync(CHAT_HISTORY_DIR)
    .filter((f) => f.endsWith('.files.jsonl'))
    .map((f) => f.slice(0, -'.files.jsonl'.length))
}

// 채팅방ID -> 사람이 읽을 수 있는 이름. 실패해도(권한 문제 등) 검색 자체는 계속되게 채널ID로 대체합니다.
let channelLabelMapCache = null
async function getChannelLabelMap() {
  if (channelLabelMapCache) return channelLabelMapCache
  const map = new Map()
  try {
    const res = await doorayFetch('/messenger/v1/channels')
    for (const ch of res.result || []) {
      let label = ch.title || ''
      if (!label && ch.type === 'me') label = '나와의 대화'
      map.set(ch.id, label || ch.id)
    }
  } catch {
    // 채널 이름 조회가 실패해도 검색 결과 자체는 돌려줘야 하므로 무시하고 빈 맵을 씁니다.
  }
  channelLabelMapCache = map
  return map
}

// ---------------------------------------------------------------------------
// 날짜 표현 도우미: "today", "thisweek", "prev-7d", "YYYY-MM-DD~YYYY-MM-DD" 등을
// 두레이가 요구하는 조회 파라미터 형태로 변환합니다.
// ---------------------------------------------------------------------------
function resolveDateRange(expr) {
  if (!expr) return undefined
  const now = new Date()
  const fmt = (d) => d.toISOString().slice(0, 19) + 'Z'
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59)

  if (expr === 'today') {
    return `${fmt(startOfDay(now))},${fmt(endOfDay(now))}`
  }
  if (expr === 'thisweek') {
    const day = now.getDay() || 7
    const monday = new Date(now); monday.setDate(now.getDate() - day + 1)
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6)
    return `${fmt(startOfDay(monday))},${fmt(endOfDay(sunday))}`
  }
  const prevMatch = expr.match(/^prev-(\d+)d$/)
  if (prevMatch) {
    const days = parseInt(prevMatch[1], 10)
    const start = new Date(now); start.setDate(now.getDate() - days)
    return `${fmt(startOfDay(start))},${fmt(endOfDay(now))}`
  }
  if (expr.includes('~')) {
    const [a, b] = expr.split('~')
    return `${a}T00:00:00Z,${b}T23:59:59Z`
  }
  return expr
}

// ---------------------------------------------------------------------------
// 도구 정의
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'dooray_whoami',
    description: '내 두레이 계정 정보(이름, memberId 등)를 확인합니다.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'dooray_list_projects',
    description: '내가 속한 두레이 프로젝트 목록을 가져옵니다 (각 프로젝트의 위키 ID 포함).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'dooray_wiki_get_pages',
    description: '위키의 페이지 목록을 가져옵니다. parentPageId를 주면 그 하위 페이지만 가져옵니다.',
    inputSchema: {
      type: 'object',
      properties: {
        wikiId: { type: 'string', description: '위키 ID' },
        parentPageId: { type: 'string', description: '하위 페이지만 볼 때 지정 (없으면 최상위 목록)' }
      },
      required: ['wikiId']
    }
  },
  {
    name: 'dooray_wiki_get_page',
    description: '위키 페이지 하나의 제목/본문 내용을 가져옵니다.',
    inputSchema: {
      type: 'object',
      properties: { wikiId: { type: 'string' }, pageId: { type: 'string' } },
      required: ['wikiId', 'pageId']
    }
  },
  {
    name: 'dooray_wiki_create_page',
    description: '위키에 새 페이지를 만듭니다 (마크다운 내용).',
    inputSchema: {
      type: 'object',
      properties: {
        wikiId: { type: 'string' },
        parentPageId: { type: 'string', description: '상위 페이지 (없으면 최상위)' },
        subject: { type: 'string', description: '페이지 제목' },
        content: { type: 'string', description: '마크다운 본문' }
      },
      required: ['wikiId', 'subject', 'content']
    }
  },
  {
    name: 'dooray_wiki_update_page',
    description: '기존 위키 페이지의 제목과/또는 본문을 수정합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        wikiId: { type: 'string' },
        pageId: { type: 'string' },
        subject: { type: 'string', description: '바꿀 제목 (안 바꾸면 생략)' },
        content: { type: 'string', description: '바꿀 마크다운 본문 (안 바꾸면 생략)' }
      },
      required: ['wikiId', 'pageId']
    }
  },
  {
    name: 'dooray_search_posts',
    description: '프로젝트의 업무(태스크) 게시물을 검색합니다. 제목, 수정일/생성일 범위로 필터링 가능.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        subjects: { type: 'string', description: '제목에 포함될 검색어' },
        updatedAt: { type: 'string', description: 'today | thisweek | prev-7d | YYYY-MM-DD~YYYY-MM-DD' },
        createdAt: { type: 'string', description: 'today | thisweek | prev-7d | YYYY-MM-DD~YYYY-MM-DD' },
        size: { type: 'number', description: '가져올 개수 (기본 30)' }
      },
      required: ['projectId']
    }
  },
  {
    name: 'dooray_get_post',
    description: '업무 게시물 하나의 상세 내용을 가져옵니다.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, postId: { type: 'string' } },
      required: ['projectId', 'postId']
    }
  },
  {
    name: 'dooray_list_templates',
    description: '프로젝트에 등록된 업무 템플릿 목록을 가져옵니다 (예: 디자인팀 템플릿).',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId']
    }
  },
  {
    name: 'dooray_create_post_from_template',
    description: '템플릿을 사용해서 새 업무 게시물을 만듭니다. overrides로 제목/내용/담당자 등을 덮어쓸 수 있습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        templateId: { type: 'string' },
        overrideSubject: { type: 'string' },
        overrideBody: { type: 'string' },
        overrideDueDate: { type: 'string', description: 'ISO 8601 날짜' },
        overrideUserIds: { type: 'array', items: { type: 'string' }, description: '담당자 organizationMemberId 목록' }
      },
      required: ['projectId', 'templateId']
    }
  },
  {
    name: 'dooray_list_mail',
    description: '내 받은 메일(알림 스트림 중 메일 항목)을 최신순으로 가져옵니다. 두레이에는 별도 메일 전용 API가 없어 공용 스트림에서 필터링합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        size: { type: 'number', description: '가져올 개수 (기본 30)' },
        onlyUnread: { type: 'boolean' }
      }
    }
  },
  {
    name: 'dooray_search_saved_mail',
    description:
      '이 프로그램(대시보드 앱)이 그동안 저장해둔 메일 전체 기록에서 보낸사람/제목/폴더/받은기간으로 검색합니다. ' +
      'dooray_list_mail은 방금 온 최근 메일 몇십 건만 훑는 것이라 검색어로 못 거르지만, 이 도구는 저장된 전체 기록을 ' +
      '조건에 맞게 걸러서 찾아줍니다. "어제 OOO가 OO 건으로 보낸 메일 찾아줘" 같은 질문엔 이 도구를 쓰세요.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '보낸사람 이름 또는 이메일에 포함된 단어 (선택)' },
        subject: { type: 'string', description: '제목에 포함된 단어 (선택)' },
        folderName: { type: 'string', description: '특정 폴더만 볼 때 지정 (선택, 안 주면 전체 폴더)' },
        dateFrom: { type: 'string', description: '받은 날짜 시작 (YYYY-MM-DD, 선택)' },
        dateTo: { type: 'string', description: '받은 날짜 끝 (YYYY-MM-DD, 선택)' },
        limit: { type: 'number', description: '최대 결과 개수 (기본 30)' }
      }
    }
  },
  {
    name: 'dooray_get_mail_folder_groups',
    description:
      '지정한 폴더에 저장된 메일을 대시보드의 "폴더별 정리"와 똑같이 사람별 또는 제목별로 자동 묶어서, ' +
      '그룹 목록(누구/무슨 제목, 건수, 즐겨찾기 여부, 최근 수신시각)을 보여줍니다. 필터를 주면 그 조건에 맞는 ' +
      '메일만 가지고 묶습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        folderName: { type: 'string', description: '폴더 이름' },
        groupType: { type: 'string', enum: ['person', 'subject'], description: '묶는 기준 (기본 person=사람별)' },
        from: { type: 'string' },
        subject: { type: 'string' },
        dateFrom: { type: 'string', description: 'YYYY-MM-DD' },
        dateTo: { type: 'string', description: 'YYYY-MM-DD' }
      },
      required: ['folderName']
    }
  },
  {
    name: 'dooray_get_mail_group_summary',
    description:
      '대시보드의 "폴더별 정리"에서 이미 만들어둔 AI 요약을 조회합니다. 이 도구는 새로 AI 요약을 만들지 ' +
      '않고, 저장된 것만 읽어옵니다 — 저장된 게 없으면 "아직 없음"이라고 알려줍니다 (비용이 드는 AI 호출을 ' +
      '채팅에서 물어볼 때마다 다시 하지 않기 위함). dooray_get_mail_folder_groups로 먼저 groupKey를 확인한 뒤 쓰세요.',
    inputSchema: {
      type: 'object',
      properties: {
        folderName: { type: 'string' },
        groupType: { type: 'string', enum: ['person', 'subject'], description: '기본 person' },
        groupKey: { type: 'string', description: 'dooray_get_mail_folder_groups 결과의 key 값' },
        from: { type: 'string', description: '그룹 목록을 조회할 때와 같은 필터를 넣어야 정확히 일치합니다 (선택)' },
        subject: { type: 'string' },
        dateFrom: { type: 'string' },
        dateTo: { type: 'string' }
      },
      required: ['folderName', 'groupKey']
    }
  },
  {
    name: 'dooray_get_mail_requests',
    description:
      '대시보드 "요청 모아보기" 카드와 같은 내용입니다. 저장된 AI 요약들 중 [요청]으로 표시된 항목만 모아서, ' +
      '완료 여부와 함께 보여줍니다.',
    inputSchema: {
      type: 'object',
      properties: { folderName: { type: 'string' } },
      required: ['folderName']
    }
  },
  {
    name: 'dooray_search_chat_history',
    description:
      '이 프로그램(dooray-assistant)이 저장해둔 두레이 채팅 기록(모든 채팅방 통합)에서 키워드로 검색합니다. ' +
      '"내가 어디서/언제 이런 말을 했더라" 같은 질문에 답할 때 사용하세요. dooray_search_posts는 업무(태스크) ' +
      '제목만 검색하고 채팅 내용은 검색하지 못하니, 채팅에서 오간 말을 찾을 때는 이 도구를 쓰세요. 두레이 ' +
      '메신저 API 자체에는 과거 메시지 조회 기능이 없어서, 이 프로그램이 켜져 있는 동안 실제로 오간 메시지 중 ' +
      '"기록 저장"이 켜진 채팅방의 것만 검색 대상입니다 (프로그램 실행 전 대화나 기록을 꺼둔 방은 안 나옵니다).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색할 키워드 (메시지 내용에 포함된 단어). 비우면 최근 기록 전체.' },
        limit: { type: 'number', description: '최대 결과 개수 (기본 30)' }
      },
      required: ['query']
    }
  },
  {
    name: 'dooray_list_calendars',
    description: '내가 접근 가능한 캘린더 목록을 가져옵니다.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'dooray_list_events',
    description: '캘린더 일정을 기간으로 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: '특정 캘린더만 볼 때 지정 (없으면 전체 "*")' },
        timeMin: { type: 'string', description: 'ISO 8601 시작 시각' },
        timeMax: { type: 'string', description: 'ISO 8601 종료 시각' }
      },
      required: ['timeMin', 'timeMax']
    }
  },
  {
    name: 'dooray_create_event',
    description: '캘린더에 새 일정을 만듭니다. (CalDAV 사용 — dooray_list_calendars로 얻은 calendarId 필요)',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string' },
        subject: { type: 'string', description: '일정 제목' },
        startedAt: {
          type: 'string',
          description: '시간 일정은 ISO 8601(예: 2026-07-11T14:00:00+09:00), 종일 일정은 "YYYY-MM-DD+09:00" 형식(시간 없음)'
        },
        endedAt: {
          type: 'string',
          description: '시간 일정은 ISO 8601. 종일 일정은 "YYYY-MM-DD+09:00"이고 마지막 날의 "다음 날"을 넣어야 함(예: 7/11 하루짜리면 endedAt은 7/12)'
        },
        location: { type: 'string' }
      },
      required: ['calendarId', 'subject', 'startedAt', 'endedAt']
    }
  },
  {
    name: 'dooray_list_drives',
    description:
      '접근 가능한 드라이브 목록을 가져옵니다. 생략하면 개인 + 프로젝트 드라이브를 모두 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['private', 'project'],
          description: '생략하면 둘 다 조회합니다. shared는 서버 오류(500)가 나서 지원하지 않습니다.'
        }
      }
    }
  },
  {
    name: 'dooray_list_drive_files',
    description: '드라이브의 파일/폴더 목록을 가져옵니다.',
    inputSchema: {
      type: 'object',
      properties: {
        driveId: { type: 'string' },
        parentId: { type: 'string', description: '하위 폴더만 볼 때 지정' }
      },
      required: ['driveId']
    }
  },
  {
    name: 'dooray_download_drive_file',
    description:
      '두레이 드라이브 파일 1건을 실제로 내려받아 이 컴퓨터에 저장합니다 (dooray_list_drive_files로 먼저 driveId/fileId/name을 확인한 뒤 쓰세요). ' +
      '중요: 이 도구는 파일 내용을 텍스트로 돌려주지 않고, 저장된 로컬 경로(localPath)만 돌려줍니다 — 파일이 커도 응답이 커지지 않습니다. ' +
      '다른 곳(예: 구글 드라이브 업로드)으로 옮길 때는 이 localPath를 그대로 넘겨서 경로 기반으로 업로드하세요 (내용을 직접 읽어서 전달하지 마세요).',
    inputSchema: {
      type: 'object',
      properties: {
        driveId: { type: 'string' },
        fileId: { type: 'string' },
        fileName: { type: 'string', description: 'dooray_list_drive_files 결과의 name (저장할 파일명에 사용, 확장자 포함)' }
      },
      required: ['driveId', 'fileId', 'fileName']
    }
  },
  {
    name: 'dooray_list_channel_files',
    description:
      '이 프로그램(dooray-assistant)이 저장해둔, 채팅방에 올라온 파일(첨부파일) 목록을 가져옵니다. ' +
      '두레이 메신저 API 자체에는 "채팅방에 첨부된 파일을 나중에 다시 조회"하는 기능이 없어서, 프로그램이 켜져 ' +
      '있는 동안 실시간으로 지나가는 파일 업로드 이벤트를 붙잡아 저장해둔 것만 조회됩니다 (프로그램 실행 전 올라온 ' +
      '파일은 안 나옵니다). "이 채팅방에 최근 올라온 파일 찾아줘" 같은 요청에 channelId를 모를 때는 먼저 ' +
      'dooray_search_chat_history로 채팅방을 특정한 뒤 이 도구를 쓰세요. 결과의 fileId로 dooray_download_channel_file을 호출하면 됩니다.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: '특정 채팅방만 볼 때 지정 (없으면 기록이 저장된 모든 채팅방 통합)' },
        query: { type: 'string', description: '파일 이름에 포함된 단어로 필터링 (선택)' },
        limit: { type: 'number', description: '최대 결과 개수 (기본 30)' }
      },
      required: []
    }
  },
  {
    name: 'dooray_download_channel_file',
    description:
      '채팅방에 올라온 첨부파일 1건을 실제로 내려받아 이 컴퓨터에 저장합니다 (dooray_list_channel_files로 먼저 ' +
      'channelId/fileId/fileName을 확인한 뒤 쓰세요). ⚠️ 두레이 메신저 첨부파일 다운로드는 공식 문서에 명시되어 ' +
      '있지 않아, 두레이 드라이브/프로젝트 파일과 같은 패턴(media=raw)의 주소를 추측해서 시도합니다 — 실패할 ' +
      '수도 있습니다. 성공 시 이 도구는 파일 내용을 텍스트로 돌려주지 않고, 저장된 로컬 경로(localPath)만 ' +
      '돌려줍니다 — 다른 곳(예: 구글 드라이브 업로드)으로 옮길 때는 이 localPath를 그대로 넘겨서 경로 기반으로 ' +
      '업로드하세요 (내용을 직접 읽어서 전달하지 마세요).',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        fileId: { type: 'string' },
        fileName: { type: 'string', description: 'dooray_list_channel_files 결과의 fileName (저장할 파일명에 사용, 확장자 포함)' }
      },
      required: ['channelId', 'fileId', 'fileName']
    }
  },
  {
    name: 'dooray_create_drive_folder',
    description: '드라이브 안에 새 폴더를 만듭니다. (두레이 공식 문서 기준으로 검증된 스펙)',
    inputSchema: {
      type: 'object',
      properties: {
        driveId: { type: 'string' },
        parentFolderId: { type: 'string', description: '상위 폴더 ID (드라이브 최상위면 루트 폴더 ID)' },
        name: { type: 'string', description: '새 폴더 이름' }
      },
      required: ['driveId', 'parentFolderId', 'name']
    }
  },
  {
    name: 'dooray_create_shared_link',
    description: '드라이브 파일의 공유 링크를 만듭니다. ⚠️ 프로젝트 드라이브에서는 403으로 거절되는 것이 실측 확인됨 — 그 경우 이 도구가 두레이 안 고정 주소(webUrl)를 대신 돌려주니, 그 주소를 사용자에게 전달하면 됩니다(로그인된 팀원만 열 수 있음). parentId(폴더 ID)를 알고 있으면 같이 넘겨주세요 — 대체 주소를 만드는 데 쓰입니다.',
    inputSchema: {
      type: 'object',
      properties: {
        driveId: { type: 'string' },
        fileId: { type: 'string' },
        parentId: { type: 'string', description: '파일이 들어있는 폴더 ID (알면 전달 — 403 대체 주소 생성에 사용)' },
        scope: { type: 'string', enum: ['member', 'memberAndGuest', 'memberAndGuestAndExternal'], description: '공유 범위 (기본 member)' },
        expiredAt: { type: 'string', description: 'ISO 8601 만료일, 없으면 무기한' }
      },
      required: ['driveId', 'fileId']
    }
  },
  {
    name: 'dooray_upload_drive_file',
    description:
      '컴퓨터에 있는 파일을 두레이 드라이브의 특정 폴더에 새로 올립니다. ' +
      '(두레이 공식 문서 기준으로 검증된 스펙)',
    inputSchema: {
      type: 'object',
      properties: {
        driveId: { type: 'string' },
        parentId: { type: 'string', description: '올릴 폴더 ID (파일 목록에서 type이 folder인 항목)' },
        localPath: { type: 'string', description: '올릴 파일의 컴퓨터 경로' }
      },
      required: ['driveId', 'parentId', 'localPath']
    }
  },
  {
    name: 'dooray_update_drive_file',
    description: '드라이브에 이미 있는 파일의 내용을 새 파일로 덮어씁니다(새 버전으로 올림).',
    inputSchema: {
      type: 'object',
      properties: {
        driveId: { type: 'string' },
        fileId: { type: 'string', description: '덮어쓸 기존 파일 ID' },
        localPath: { type: 'string', description: '새로 올릴 파일의 컴퓨터 경로' }
      },
      required: ['driveId', 'fileId', 'localPath']
    }
  },
  {
    name: 'dooray_list_reservable_resources',
    description: '예약 가능한 리소스(회의실 등) 목록을 가져옵니다.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'dooray_list_reservations',
    description: '리소스 예약 내역을 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: { resourceId: { type: 'string', description: '특정 리소스만 볼 때 지정' } }
    }
  },
  {
    name: 'dooray_create_reservation',
    description: '회의실 등 리소스를 예약합니다. (두레이 공식 문서 기준으로 검증된 스펙)',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'string' },
        subject: { type: 'string', description: '예약 제목 (예: 주간 회의)' },
        startedAt: { type: 'string', description: 'ISO 8601' },
        endedAt: { type: 'string', description: 'ISO 8601' },
        wholeDayFlag: { type: 'boolean', description: '기본 false' }
      },
      required: ['resourceId', 'subject', 'startedAt', 'endedAt']
    }
  },
  {
    name: 'dooray_request',
    description: '위 도구로 안 되는 두레이 API를 직접 호출하는 비상용 도구입니다 (method/path/query/body 직접 지정).',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
        path: { type: 'string', description: '예: /project/v1/projects' },
        query: { type: 'object' },
        body: { type: 'object' }
      },
      required: ['method', 'path']
    }
  },
  {
    name: 'dooray_ask_playground',
    description:
      '왓츠업(WhatsUp) 게시물 조회/검색, Harmony 휴가·연차 조회·신청처럼 사내 LLM "Playground"에 ' +
      '이미 내장된 기능이 필요할 때 사용하세요. 사용자의 요청 문장을 최대한 그대로 query에 담아 ' +
      '전달하면, Playground가 실제로 조회/신청을 수행하고 답을 알려줍니다. 이 도구는 텍스트 답변을 ' +
      '대신 지어내지 않고 Playground의 실제 응답을 그대로 돌려줍니다.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '사용자가 요청한 내용 (예: "왓츠업에서 최근 공지 찾아줘", "이번 주 금요일 휴가 신청해줘")' }
      },
      required: ['query']
    }
  }
]

// ---------------------------------------------------------------------------
// 도구 처리
// ---------------------------------------------------------------------------
async function handleTool(name, args = {}) {
  switch (name) {
    case 'dooray_whoami': {
      const res = await doorayFetch('/common/v1/members/me')
      return res.result
    }

    case 'dooray_list_projects': {
      const res = await doorayFetch('/project/v1/projects', { query: { member: 'me' } })
      return (res.result || []).map((p) => ({
        id: p.id, code: p.code, description: p.description, wikiId: p.wiki?.id
      }))
    }

    case 'dooray_wiki_get_pages': {
      // 주의: 최상위 목록은 쿼리 파라미터가 하나라도 있으면 400 에러가 남 (실제로 확인된 버그성 동작)
      if (args.parentPageId) {
        const res = await doorayFetch(`/wiki/v1/wikis/${args.wikiId}/pages`, {
          query: { parentPageId: args.parentPageId, size: 100, page: 0 }
        })
        return res.result
      }
      const res = await doorayFetch(`/wiki/v1/wikis/${args.wikiId}/pages`)
      return res.result
    }

    case 'dooray_wiki_get_page': {
      const res = await doorayFetch(`/wiki/v1/wikis/${args.wikiId}/pages/${args.pageId}`)
      return res.result
    }

    case 'dooray_wiki_create_page': {
      const res = await doorayFetch(`/wiki/v1/wikis/${args.wikiId}/pages`, {
        method: 'POST',
        body: {
          parentPageId: args.parentPageId || undefined,
          subject: args.subject,
          body: { mimeType: 'text/x-markdown', content: args.content }
        }
      })
      return res.result
    }

    case 'dooray_wiki_update_page': {
      const results = {}
      if (args.subject) {
        results.title = await doorayFetch(`/wiki/v1/wikis/${args.wikiId}/pages/${args.pageId}/title`, {
          method: 'PUT', body: { subject: args.subject }
        })
      }
      if (args.content) {
        results.content = await doorayFetch(`/wiki/v1/wikis/${args.wikiId}/pages/${args.pageId}/content`, {
          method: 'PUT', body: { body: { mimeType: 'text/x-markdown', content: args.content } }
        })
      }
      return results
    }

    case 'dooray_search_posts': {
      const res = await doorayFetch(`/project/v1/projects/${args.projectId}/posts`, {
        query: {
          subjects: args.subjects,
          updatedAt: resolveDateRange(args.updatedAt),
          createdAt: resolveDateRange(args.createdAt),
          size: args.size || 30,
          order: '-createdAt'
        }
      })
      return res.result
    }

    case 'dooray_get_post': {
      const res = await doorayFetch(`/project/v1/projects/${args.projectId}/posts/${args.postId}`)
      return res.result
    }

    case 'dooray_list_templates': {
      const res = await doorayFetch(`/project/v1/projects/${args.projectId}/templates`)
      return res.result
    }

    case 'dooray_create_post_from_template': {
      const tmpl = await doorayFetch(
        `/project/v1/projects/${args.projectId}/templates/${args.templateId}`,
        { query: { interpolation: true } }
      )
      const t = tmpl.result
      const body = {
        subject: args.overrideSubject || t.subject,
        body: t.body,
        dueDate: args.overrideDueDate || t.dueDate,
        milestoneId: t.milestoneId,
        tagIds: t.tagIds,
        priority: t.priority,
        users: args.overrideUserIds
          ? { to: args.overrideUserIds.map((id) => ({ type: 'member', member: { organizationMemberId: id } })) }
          : t.users
      }
      if (args.overrideBody) {
        body.body = { mimeType: t.body?.mimeType || 'text/x-markdown', content: args.overrideBody }
      }
      const res = await doorayFetch(`/project/v1/projects/${args.projectId}/posts`, { method: 'POST', body })
      return res.result
    }

    case 'dooray_list_mail': {
      // 두레이 공식 문서(Common > Streams) 확인 결과 각 항목은 { type: 'mail', mail: {...} }
      // 형태로 한 단계 감싸져 있습니다. 예전 코드는 item.subject/item.from처럼 바로 꺼내려
      // 해서 항상 undefined만 나오던 버그가 있었는데, 실제 스펙대로 item.mail.* 을 읽도록 고쳤습니다.
      const res = await doorayFetch('/common/v1/streams', {
        query: { size: args.size || 30, read: args.onlyUnread ? false : undefined }
      })
      return (res.result || [])
        .filter((item) => item.type === 'mail')
        .map((item) => {
          const m = item.mail || {}
          const from = m.users?.from?.emailUser || m.users?.from?.member || {}
          return {
            id: m.id,
            subject: m.subject || '(제목 없음)',
            from: from.name || from.emailAddress || '',
            folder: m.folder?.name || '',
            sentAt: m.sentAt,
            bodyPreview: (m.body?.content || '').slice(0, 200)
          }
        })
    }

    case 'dooray_search_saved_mail': {
      const filters = { from: args.from, subject: args.subject, dateFrom: args.dateFrom, dateTo: args.dateTo }
      const cfg = readAppConfig()
      const limit = args.limit || 30
      const matched = readAllMails().filter((m) => {
        if (args.folderName && m.folderName !== args.folderName) return false
        return mailMatchesFilters(m, filters)
      })
      matched.sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))
      return matched.slice(0, limit).map((m) => ({
        id: m.id,
        subject: m.subject,
        fromName: m.fromName,
        fromEmail: m.fromEmail,
        folderName: m.folderName,
        sentAt: m.sentAt,
        bodyPreview: (m.bodyContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        mailUrl: mailUrlOf(m, cfg.doorayDomain)
      }))
    }

    case 'dooray_get_mail_folder_groups': {
      if (!args.folderName) throw new Error('folderName이 필요합니다.')
      const type = args.groupType === 'subject' ? 'subject' : 'person'
      const filters = { from: args.from, subject: args.subject, dateFrom: args.dateFrom, dateTo: args.dateTo }
      const cfg = readAppConfig()
      const favSet = new Set(cfg.mailGroupFavorites || [])
      const byKey = new Map()
      for (const m of readAllMails()) {
        if (m.folderName !== args.folderName) continue
        if (!mailMatchesFilters(m, filters)) continue
        const { key, label } = groupKeyAndLabel(m, type)
        const cur = byKey.get(key) || { key, label, count: 0, latestSentAt: null }
        cur.count += 1
        if (m.sentAt && (!cur.latestSentAt || new Date(m.sentAt) > new Date(cur.latestSentAt))) cur.latestSentAt = m.sentAt
        byKey.set(key, cur)
      }
      const groups = Array.from(byKey.values()).map((g) => ({
        ...g,
        favorite: favSet.has(`${args.folderName}::${type}::${g.key}`)
      }))
      groups.sort((a, b) =>
        (b.favorite - a.favorite) || (b.count - a.count) || (new Date(b.latestSentAt || 0) - new Date(a.latestSentAt || 0))
      )
      return groups
    }

    case 'dooray_get_mail_group_summary': {
      if (!args.folderName || !args.groupKey) throw new Error('folderName과 groupKey가 필요합니다.')
      const type = args.groupType === 'subject' ? 'subject' : 'person'
      // (2026-08-14 점검 수정) 대시보드는 빈 필터를 빈 문자열로 저장하는데, 여기서 undefined로
      // 만들면 키가 영영 안 맞아 "요약 없음"만 나왔습니다 — 빈 값을 빈 문자열로 통일합니다.
      const filterSig = JSON.stringify({ from: args.from || '', subject: args.subject || '', dateFrom: args.dateFrom || '', dateTo: args.dateTo || '' })
      const cache = readMailSummaryCache()
      const entry = cache[makeSummaryCacheKey(args.folderName, type, args.groupKey, filterSig)]
      if (!entry) {
        return { found: false, message: '이 조건으로 아직 만들어진 AI 요약이 없습니다. 대시보드의 "폴더별 정리"에서 먼저 만들어야 합니다.' }
      }
      // 최근 버전은 메일 하나하나를 "제목 + 그 메일만의 요약" 블록(mailBlocks)으로 저장합니다.
      return {
        found: true,
        mailBlocks: (entry.mailBlocks || []).map((b) => ({
          subject: b.subject,
          fromName: b.fromName,
          fromEmail: b.fromEmail,
          sentAt: b.sentAt,
          summary: b.summary,
          note: b.note
        })),
        generatedAt: entry.generatedAt,
        mailCount: entry.count
      }
    }

    case 'dooray_get_mail_requests': {
      if (!args.folderName) throw new Error('folderName이 필요합니다.')
      const cache = readMailSummaryCache()
      const doneMap = readMailRequestDoneMap()
      const seen = new Map()
      for (const entry of Object.values(cache)) {
        if (!entry || entry.folderName !== args.folderName || entry.groupType !== 'person') continue
        // "* [요청] ..." 형태(불릿 표시)로 올 수도 있어서, 맨 앞 "* " 표시는 있어도/없어도 인식합니다.
        // (2026-08-14 점검 수정) 대시보드(index.js buildMailRequestsForFolder)와 같은 방식으로
        // ID를 만듭니다: 메일 단위 sourceKey(mail::<id>)로 [요청] 줄을 모으고, 같은 메일의
        // 여러 줄은 "첫 줄 + · 다음 줄"로 합친 텍스트로 해시. 예전엔 그룹 키+줄 단위로 해시해서
        // 대시보드에서 체크한 완료 상태가 여기선 항상 미완료로 보였습니다.
        const byMail = new Map() // sourceKey -> { texts, label, generatedAt }
        for (const b of entry.mailBlocks || []) {
          const sourceKey = b && b.mailId ? `mail::${b.mailId}` : entry.groupKey
          const blockLines = String((b && b.summary) || '').split('\n').filter((l) => /^\s*\*?\s*\[요청\]/.test(l))
          for (const line of blockLines) {
            const text = line.trim().replace(/^\*?\s*\[요청\]\s*/, '')
            if (!text) continue
            const bucket = byMail.get(sourceKey) || { texts: [], label: entry.label || entry.groupKey, generatedAt: (b && b.sentAt) || entry.generatedAt || '' }
            if (!bucket.texts.includes(text)) bucket.texts.push(text)
            byMail.set(sourceKey, bucket)
          }
        }
        for (const [sourceKey, bucket] of byMail) {
          const text = bucket.texts.map((t, i) => (i === 0 ? t : `· ${t}`)).join('\n')
          const id = crypto.createHash('sha1').update(`${args.folderName}::${sourceKey}::${text}`).digest('hex').slice(0, 16)
          if (seen.has(id)) continue
          seen.set(id, {
            groupLabel: bucket.label,
            text,
            done: !!doneMap[id],
            generatedAt: bucket.generatedAt
          })
        }
      }
      const requests = Array.from(seen.values()).sort(
        (a, b) => (a.done - b.done) || (new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0))
      )
      return requests
    }

    case 'dooray_search_chat_history': {
      const query = (args.query || '').trim().toLowerCase()
      const limit = args.limit || 30
      const labelMap = await getChannelLabelMap()
      const matched = []
      for (const channelId of listStoredChannelIds()) {
        const messages = readChannelHistoryFile(channelId)
        for (const m of messages) {
          if (!query || (m.text || '').toLowerCase().includes(query)) {
            matched.push({
              channelId,
              channelLabel: labelMap.get(channelId) || channelId,
              senderId: m.senderId,
              text: m.text,
              sentAt: m.ts ? new Date(m.ts).toISOString() : null
            })
          }
        }
      }
      matched.sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))
      return matched.slice(0, limit)
    }

    // 캘린더 조회는 두레이 REST API로 합니다. 등록만 CalDAV(caldav.dooray.com)를 씁니다 —
    // 등록 REST API가 이 계정에서 계속 500 에러가 나서 caldavClient.js가 등록만 CalDAV로
    // 처리합니다(설정 탭에서 CalDAV 메일주소/비밀번호를 먼저 저장해둬야 등록이 동작합니다).
    case 'dooray_list_calendars': {
      return caldavClient.listCalendars({ request: doorayFetch })
    }

    case 'dooray_list_events': {
      return caldavClient.listEvents({
        request: doorayFetch,
        calendarIds: args.calendarId ? [args.calendarId] : undefined,
        timeMin: args.timeMin,
        timeMax: args.timeMax
      })
    }

    case 'dooray_create_event': {
      const { user, password } = await getCaldavCreds()
      return caldavClient.createEvent({
        user,
        password,
        calendarId: args.calendarId,
        subject: args.subject,
        startedAt: args.startedAt,
        endedAt: args.endedAt,
        location: args.location || undefined
      })
    }

    case 'dooray_list_drives': {
      // ⚠️ 실측(2026-08-06): 파라미터 없이 호출하면 개인 드라이브만 돌아옵니다.
      //    프로젝트 드라이브는 ?type=project 로 따로 조회해야 나옵니다(이 계정에서 13개 확인).
      //    ?type=shared 는 이 계정에서 500 서버 오류가 나므로 아예 호출하지 않습니다.
      //    'private'는 ?type=private 가 되는지 확인되지 않아, 검증된 "파라미터 없음" 방식을 씁니다.
      const queries = []
      if (!args.type || args.type === 'private') queries.push({ kind: 'private', query: {} })
      if (!args.type || args.type === 'project') queries.push({ kind: 'project', query: { type: 'project' } })

      const byId = new Map()
      for (const q of queries) {
        try {
          const res = await doorayFetch('/drive/v1/drives', { query: q.query })
          for (const d of res.result || []) {
            if (!byId.has(d.id)) byId.set(d.id, { ...d, queriedType: q.kind })
          }
        } catch (err) {
          // 한쪽이 실패해도 나머지는 그대로 돌려줍니다.
          byId.set(`error::${q.kind}`, { error: `${q.kind} 조회 실패: ${err.message}` })
        }
      }
      return Array.from(byId.values())
    }

    case 'dooray_list_drive_files': {
      const res = await doorayFetch(`/drive/v1/drives/${args.driveId}/files`, {
        query: { parentId: args.parentId }
      })
      // (2026-08-11 추가) 파일마다 두레이 안 고정 주소(webUrl)를 같이 돌려줍니다.
      // 폴더 ID는 조회에 쓴 parentId를 우선 쓰고, 응답에 부모 정보가 있으면 그걸 씁니다.
      return (res.result || []).map((f) => {
        const folderId = f.parentId || f.parentFolderId || args.parentId || ''
        const webUrl = f.type === 'folder' ? '' : driveFileWebUrl(args.driveId, folderId, f.id)
        return webUrl ? { ...f, webUrl } : f
      })
    }

    case 'dooray_download_drive_file': {
      if (!args.driveId || !args.fileId || !args.fileName) {
        throw new Error('driveId, fileId, fileName이 모두 필요합니다.')
      }
      const { localPath, sizeBytes } = await downloadDoorayFileToDisk(
        `/drive/v1/drives/${args.driveId}/files/${args.fileId}?media=raw`,
        args.fileName
      )
      return {
        localPath,
        sizeBytes,
        note: '파일 내용은 이 경로에 저장만 했습니다. 다른 곳에 옮길 때는 이 경로를 그대로 넘겨서 경로 기반으로 처리하세요.'
      }
    }

    case 'dooray_upload_drive_file': {
      if (!args.driveId || !args.parentId || !args.localPath) {
        throw new Error('driveId, parentId, localPath가 모두 필요합니다.')
      }
      const up = await doorayUploadFile(
        `/drive/v1/drives/${args.driveId}/files?parentId=${encodeURIComponent(args.parentId)}`,
        args.localPath,
        { method: 'POST' }
      )

      // ⚠️ 두레이는 성공 응답을 주고도 실제로는 아무것도 안 하는 경우가 있습니다
      //    (시행착오 4번 — CalDAV가 200을 주면서 no-op). 그래서 올린 직후
      //    폴더를 다시 조회해서 실제로 있는지 확인합니다.
      let verified = false
      try {
        const list = await doorayFetch(`/drive/v1/drives/${args.driveId}/files`, {
          query: { parentId: args.parentId }
        })
        verified = (list.result || []).some(
          (f) => (up.result.id && f.id === up.result.id) || f.name === up.fileName
        )
      } catch {
        // 확인 실패 자체를 업로드 실패로 보지는 않고, 아래 note로 그대로 알립니다.
      }

      return {
        fileName: up.fileName,
        fileId: up.result.id || null,
        verified,
        note: verified
          ? '업로드 후 폴더를 다시 조회해 실제로 올라간 것을 확인했습니다.'
          : '업로드 요청은 성공했지만 폴더에서 확인하지 못했습니다. 두레이 화면에서 직접 확인해 주세요.'
      }
    }

    case 'dooray_update_drive_file': {
      if (!args.driveId || !args.fileId || !args.localPath) {
        throw new Error('driveId, fileId, localPath가 모두 필요합니다.')
      }
      const up = await doorayUploadFile(
        `/drive/v1/drives/${args.driveId}/files/${args.fileId}?media=raw`,
        args.localPath,
        { method: 'PUT' }
      )
      return {
        fileName: up.fileName,
        fileId: args.fileId,
        version: up.result.version ?? null,
        note: '기존 파일을 새 버전으로 덮어썼습니다.'
      }
    }

    case 'dooray_list_channel_files': {
      const query = (args.query || '').trim().toLowerCase()
      const limit = args.limit || 30
      const labelMap = await getChannelLabelMap()
      const channelIds = args.channelId ? [args.channelId] : listStoredChannelFileIds()
      const matched = []
      for (const channelId of channelIds) {
        const files = readChannelFilesFile(channelId)
        for (const f of files) {
          if (!query || (f.fileName || '').toLowerCase().includes(query)) {
            matched.push({
              channelId,
              channelLabel: labelMap.get(channelId) || channelId,
              fileId: f.fileId,
              fileName: f.fileName,
              fileSize: f.fileSize,
              mimeType: f.mimeType,
              senderId: f.senderId,
              uploadedAt: f.ts ? new Date(f.ts).toISOString() : null
            })
          }
        }
      }
      matched.sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0))
      return matched.slice(0, limit)
    }

    case 'dooray_download_channel_file': {
      if (!args.channelId || !args.fileId || !args.fileName) {
        throw new Error('channelId, fileId, fileName이 모두 필요합니다.')
      }
      const { localPath, sizeBytes } = await downloadDoorayFileToDisk(
        `/messenger/v1/channels/${args.channelId}/files/${args.fileId}?media=raw`,
        args.fileName
      )
      return {
        localPath,
        sizeBytes,
        note: '파일 내용은 이 경로에 저장만 했습니다. 다른 곳에 옮길 때는 이 경로를 그대로 넘겨서 경로 기반으로 처리하세요.'
      }
    }

    case 'dooray_create_drive_folder': {
      const res = await doorayFetch(
        `/drive/v1/drives/${args.driveId}/files/${args.parentFolderId}/create-folder`,
        { method: 'POST', body: { name: args.name } }
      )
      return res.result
    }

    case 'dooray_create_shared_link': {
      let res
      try {
        res = await doorayFetch(
          `/drive/v1/drives/${args.driveId}/files/${args.fileId}/shared-links`,
          { method: 'POST', body: { scope: args.scope || 'member', expiredAt: args.expiredAt || null } }
        )
      } catch (err) {
        // (2026-08-11 추가, 실측) 프로젝트 드라이브에서는 공유 링크 생성이 403(No access
        // authority)으로 거절됩니다. 이때는 두레이 안 고정 주소로 대체합니다 — 사내 팀원에게
        // 전달하는 용도라면 이 주소로 충분합니다 (로그인된 사람만 열 수 있음).
        if (/403/.test(String(err.message || ''))) {
          // 주소에 필요한 폴더 ID를 파일 정보에서 찾아봅니다 (⚠️ 이 메타 조회의 필드명은
          // 실측 검증 전 — 못 찾으면 webUrl 없이 안내만 돌려줍니다).
          let folderId = args.parentId || ''
          if (!folderId) {
            try {
              const meta = await doorayFetch(`/drive/v1/drives/${args.driveId}/files/${args.fileId}`)
              folderId = meta?.result?.parentId || meta?.result?.parentFolderId || ''
            } catch { /* 메타 조회 실패 시 안내만 */ }
          }
          const webUrl = driveFileWebUrl(args.driveId, folderId, args.fileId)
          return {
            sharedLinkCreated: false,
            reason: '공유 링크 생성이 권한 문제(403)로 거절됨 — 프로젝트 드라이브에서는 API로 못 만듭니다.',
            webUrl: webUrl || null,
            note: webUrl
              ? '대신 두레이 안 고정 주소(webUrl)를 사용자에게 전달하세요. 두레이에 로그인된 팀원이면 클릭으로 바로 열립니다 (외부인은 못 엽니다).'
              : '폴더 ID를 알아내지 못해 고정 주소도 못 만들었습니다. 파일이 있는 드라이브·폴더 경로를 안내하세요.'
          }
        }
        throw err
      }
      return res.result
    }

    case 'dooray_list_reservable_resources': {
      const res = await doorayFetch('/reservation/v1/reservable-resources')
      return res.result
    }

    case 'dooray_list_reservations': {
      const res = await doorayFetch('/reservation/v1/resource-reservations', {
        query: { resourceId: args.resourceId }
      })
      return res.result
    }

    case 'dooray_create_reservation': {
      const res = await doorayFetch('/reservation/v1/resource-reservations', {
        method: 'POST',
        body: {
          resourceId: args.resourceId,
          subject: args.subject,
          startedAt: args.startedAt,
          endedAt: args.endedAt,
          wholeDayFlag: !!args.wholeDayFlag,
          class: 'public'
        }
      })
      return res.result
    }

    case 'dooray_request': {
      const res = await doorayFetch(args.path, { method: args.method, query: args.query, body: args.body })
      return res
    }

    case 'dooray_ask_playground': {
      const appConfig = readAppConfig()
      const baseUrl = appConfig.playgroundBaseUrl || ''
      const model = appConfig.playgroundModel || ''
      if (!baseUrl || !model) {
        throw new Error('Playground 설정이 안 되어 있습니다. 대시보드 설정 탭에서 주소/모델명/API 키를 먼저 저장해주세요.')
      }
      let apiKey = ''
      try {
        const keytar = require('keytar')
        apiKey = (await keytar.getPassword('dooray-assistant', 'playground-api-key')) || ''
      } catch {
        // keytar를 못 읽으면 아래에서 apiKey 빈 값으로 처리되어 에러가 납니다.
      }
      if (!apiKey) {
        throw new Error('Playground API 키가 저장되어 있지 않습니다. 대시보드 설정 탭에서 먼저 저장해주세요.')
      }
      // (2026-07-28 순정 테스트로 되돌림) system_tools 실험 옵션을 뺀, 처음 전달받은 예시
      // 코드(openai 파이썬 라이브러리의 client.chat.completions.create)와 완전히 똑같은
      // 최소 형태로 호출합니다 — "우리가 뭔가 추가해서 이상해진 건 아닌지" 깨끗하게
      // 확인하기 위한 순정 비교용입니다.
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: args.query }]
        })
      })
      const text = await res.text()
      let json
      try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
      if (!res.ok) {
        const msg = json?.error?.message || json?.message || text || `HTTP ${res.status}`
        throw new Error(`Playground 호출 오류 (${res.status}): ${msg}`)
      }
      const answer = json?.choices?.[0]?.message?.content
      if (!answer) throw new Error('Playground 응답 형식이 예상과 다릅니다: ' + text)
      return { answer }
    }

    default:
      throw new Error(`알 수 없는 도구: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// MCP 서버 부트스트랩
// ---------------------------------------------------------------------------
const server = new Server(
  { name: 'dooray-mcp', version: '0.2.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  try {
    const result = await handleTool(name, args || {})
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `오류: ${err.message}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
