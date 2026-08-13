// 프로그램 진입점.
// 트레이 아이콘으로 상주하며, 백그라운드에서 두레이 채팅을 감시합니다.
// 토큰이 없으면(첫 실행) 자동으로 "대시보드" 창을 띄웁니다.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { app, Tray, Menu, nativeImage, ipcMain, dialog, shell, BrowserWindow, powerMonitor } = require('electron')
const { autoUpdater } = require('electron-updater')
const { loadConfig, saveConfig, DEFAULTS } = require('./config')
const { createDoorayClient } = require('./doorayClient')
const { SocketModeClient } = require('./socketMode')
const { createMentionHandler, getRecentChannels, askClaude, backfillChatHistory, catchUpMissedTodoMessages } = require('./mentionBot')
const { ensureMcpRegistered } = require('./ensureMcp')
const { openTrustPromptWindow, resolveClaudePath, commandFor, checkLoggedIn } = require('./claudeResolver')
const tokenStore = require('./tokenStore')
const { openDashboard, closeDashboard } = require('./dashboardWindow')
const { createDoorayService } = require('./doorayService')
const { searchAllChannels, countAllMessages } = require('./chatHistoryStore')
const mailStore = require('./mailStore')
const mailSummaryCache = require('./mailSummaryCache')
const usageStore = require('./usageStore')
const mailImap = require('./mailImap')
const todoStore = require('./todoStore')
const todoTemplateStore = require('./todoTemplateStore')
const todoTagStore = require('./todoTagStore')
const todoSubTagStore = require('./todoSubTagStore')
const todoHistoryStore = require('./todoHistoryStore')
const promptStore = require('./promptStore')

// 프로그램이 이미 켜져 있는데 또 실행되면(예: 아이콘을 실수로 두 번 클릭), 새로 하나 더 켜서
// 연결이 두 개가 되는 대신, 이미 켜져 있는 프로그램의 대시보드만 다시 앞으로 띄웁니다.
// 이 잠금을 못 얻으면 "이미 다른 인스턴스가 켜져 있다"는 뜻이라, 이 인스턴스는 바로 종료합니다.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
  return
}
app.on('second-instance', () => {
  openDashboard()
})

let tray = null
let socketClient = null
let myMemberId = null
let currentToken = null
let config = loadConfig()
let status = '시작 전'
const logLines = []

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`
  console.log(line)
  logLines.unshift(line)
  if (logLines.length > 200) logLines.pop()
  updateTrayMenu()
}

const doorayClient = createDoorayClient(() => currentToken)
// 캘린더(CalDAV) 연동에 쓸 계정 정보. 설정 탭에서 저장한 값을 그때그때 새로 읽어옵니다
// (비밀번호를 바꾸거나 새로 저장해도 앱을 재시작할 필요 없게).
async function getCaldavCreds() {
  const c = loadConfig()
  const password = await tokenStore.getCaldavPassword().catch(() => null)
  return { user: c.caldavUser || '', password: password || '' }
}
const doorayService = createDoorayService(doorayClient, log, getCaldavCreds)

// 이 프로그램이 클로드(AI)를 돌릴 때 쓰는 전용 작업 폴더의 최상위 경로. "클로드 확인 창"에서
// 신뢰 확인을 받을 때도 홈 폴더 전체(바탕화면·문서함 등 포함)가 아니라 이 폴더만 대상으로 해서,
// 신뢰 범위를 실제로 필요한 만큼만으로 좁혀둡니다.
const CLAUDE_WORKSPACE_ROOT = path.join(os.homedir(), 'Dooray-Assistant-Workspaces')

// AI 메일 요약을 실행할 때 클로드 코드가 쓰는 작업 폴더 (채널별 폴더와 같은 이유로 필요:
// 처음 이 폴더에서 실행할 때 한 번은 터미널에서 직접 신뢰 확인을 해줘야 합니다).
const MAIL_SUMMARY_WORKDIR = path.join(CLAUDE_WORKSPACE_ROOT, 'mail-summary')

// 대시보드 "채팅" 탭에서 직접 묻고 답할 때 쓰는 전용 작업 폴더 (위와 같은 이유로 최초 1회
// 신뢰 확인이 필요할 수 있습니다).
const DASHBOARD_CHAT_WORKDIR = path.join(CLAUDE_WORKSPACE_ROOT, 'dashboard-chat')

// "매체 소재 사이즈 가이드" 갱신(웹 리서치)을 실행할 때 쓰는 전용 작업 폴더 (위와 같은 이유).
const MEDIA_GUIDE_WORKDIR = path.join(CLAUDE_WORKSPACE_ROOT, 'media-guide')
// 대시보드 채팅은 두레이 채팅방과 달리 프로그램 내부에서만 오가는 대화라, 두레이 API에 저장할
// 필요 없이 메모리에만 쌓아둡니다 (프로그램을 껐다 켜면 초기화됨). 채널별 대화 맥락 전달과
// 같은 방식으로, 오간 대화를 계속 넘겨서 이어지는 질문에도 답할 수 있게 합니다.
// { role: 'user' | 'assistant', text }[]
let dashboardChatHistory = []

const MAIL_POLL_INTERVAL_MS = 1 * 60 * 1000 // 1분마다 (새 메일이 없으면 호출 1번으로 끝나서 부담 적음)
let mailPollTimer = null
let mailPolling = false

// "저장 안 하기로 한 폴더"도 지금 두레이에서 즉시 조회해서 볼 수 있게 해주는 임시 캐시입니다
// (id -> mail 객체). 자동 저장(mailStore)은 "이 폴더만 저장하기" 허용목록에 없는 메일은 아예
// 걸러내고, 한 번 확인한 메일은 나중에 다른 폴더로 옮겨져도 다시는 안 살펴봐서(2026-07-30
// 실사용 중 발견 — 웹메일에서 메일을 옮겨도 안 잡히는 문제) 놓치는 경우가 있습니다. 그래서
// "지금 두레이에서 최신 메일 조회" 버튼은 허용목록과 상관없이 그 자리에서 최근 2주치를 즉시
// 조회하고, 그 결과를 여기 담아둡니다 — get-mail-detail/get-mail-summary가 mailStore에서
// 못 찾으면 여기서 찾아서 저장된 메일과 똑같이 IMAP 전문 조회·AI 요약을 해줍니다. 프로그램을
// 껐다 켜면 비워집니다(영구 저장이 아니라 그때그때 조회용이라 문제 없음).
const liveMailCache = new Map()

// 메일 1건의 전문을 IMAP에서 받아와 mail 객체와 저장소에 반영합니다 (이미 받아온 적 있으면
// 바로 통과). 두 가지 실패를 구분해서 돌려줍니다:
//  - imapOff: true  → IMAP 자체가 꺼져있거나 비밀번호가 없어 아예 시도할 수 없음.
//                     (이 경우 호출부는 미리보기 본문으로 대체해서 진행합니다.)
//  - imapOff 없음    → IMAP은 켜져있지만 이 메일 1건만 못 찾았거나 실패함.
//                     (이 경우 호출부는 이 메일을 요약 대상에서 빼는 걸 권장합니다 —
//                      미리보기로 몰래 대체하지 않기 위함.)
async function ensureMailFullBody(mail, cfg) {
  if (mail.bodyFull) return { ok: true }
  if (!cfg.imapEnabled || !cfg.imapUser) return { ok: false, imapOff: true, error: 'IMAP이 꺼져있습니다.' }
  const password = await tokenStore.getImapPassword().catch(() => null)
  if (!password) return { ok: false, imapOff: true, error: 'IMAP 비밀번호가 저장되어 있지 않습니다.' }
  const r = await mailImap.fetchFullBody({ user: cfg.imapUser, password, host: cfg.imapHost }, mail)
  if (r.ok) {
    mailStore.updateMailBody(mail.id, { bodyMimeType: r.bodyMimeType, bodyContent: r.bodyContent, bodyPlainText: r.bodyPlainText, bodyFull: true })
    mail.bodyMimeType = r.bodyMimeType
    mail.bodyContent = r.bodyContent
    mail.bodyPlainText = r.bodyPlainText
    mail.bodyFull = true
    log(`IMAP으로 메일 전문을 가져왔습니다: ${mail.subject}`)
    return { ok: true }
  }
  log(`IMAP 전문 가져오기 실패 (${mail.subject}): ${r.error}`)
  return { ok: false, error: r.error }
}

// ---------------------------------------------------------------------------
// 메일 1건 AI 요약 (공용) — 메일함/도착 알림(1건·묶음)/폴더별 정리 4곳이 전부 이 함수들을
// 통해서만 메일을 요약합니다. 이렇게 통일해두면: ① 어디서 봐도 형식이 같고([요청] 표시 포함),
// ② 어느 화면에서 먼저 요약한 메일이든 다른 화면에서 그대로 재사용되어 AI를 두 번 안 부릅니다.
// ---------------------------------------------------------------------------

// 프롬프트의 "어떻게 요약할지" 규칙 부분 (모든 요약 프롬프트가 공통으로 씀).
function singleMailSummaryInstructions(cfg) {
  const myName = (cfg.myStaffName || '').trim()
  return [
    '- 첫 문장만 보고 뭉뚱그리지 말고, 본문을 끝까지 읽고 실제 내용·배경·수치를 구체적으로 담으세요.',
    '- 각 항목은 반드시 "* "로 시작하는 별도 줄로 작성하세요 (한 줄에 여러 항목을 몰아넣지 마세요).',
    '- 항목 수는 정해두지 말고, 실제 내용이 있는 만큼 나누세요 (보통 2~5개 항목 정도).',
    '- 각 항목에는 무엇을·언제까지·얼마나(마감일·일정·수량·금액·담당자 등)를 최대한 구체적으로 포함하세요.',
    '- 본문에 실제로 적힌 고유명사(회사명·프로젝트명·캠페인명·파일명·시스템명)와 숫자는 그대로 옮겨 적으세요.',
    '  "관련 내용 공유", "일정 안내" 같은 두루뭉술한 표현만 쓰지 말고, 무엇에 대한 것인지 명시하세요.',
    '- 첨부파일이 언급되어 있으면 어떤 파일인지도 항목에 적으세요.',
    `- 이 메일함의 주인${myName ? `(이름: "${myName}")` : ''}이 직접 회신하거나 처리해야 하는 항목만 "* " 바로 뒤에 "[요청] "을 붙이세요.`,
    '  본문이 명백히 다른 사람을 지목한 요청이거나(예: "OO님께서 확인 부탁드립니다"에서 OO이 주인이 아닌 경우),',
    '  단순 공지·뉴스레터·전체 안내면 [요청]을 붙이지 마세요. 애매하면 붙이지 않습니다.',
    '- [요청] 항목은 나중에 그 줄만 따로 떼어내 "할 일 체크리스트"로 쓰입니다. 따라서 그 한 줄만 읽어도',
    '  무슨 일인지 알 수 있게 쓰세요 — 누가 무엇을 요청했고 언제까지 해야 하는지를 그 줄 안에 담고,',
    '  "확인 부탁", "회신 필요"처럼 대상이 빠진 표현만 쓰지 마세요.'
  ]
}

// 메일 1건을 요약합니다. 이미 어딘가(메일함/도착 알림/폴더별 정리)에서 요약해둔 적 있으면
// 그대로 재사용하고 AI를 다시 부르지 않습니다. forceRefresh면 캐시를 무시하고 새로 만듭니다.
// origin: 이 요약이 "누구 때문에 처음 만들어졌는지" 표시 ('individual' = 메일 도착 알림/메일함
// 직접 열람, 'group' = 발신자별 정리 그룹 스캔). buildMailRequestsForFolder가 이 값을 보고
// "오늘 할 일"에 자동으로 넣을지, 체크박스로 옵트인해야 넣을지를 정합니다.
async function summarizeMail(mail, cfg, { forceRefresh = false, bodyLimit = 8000, origin = 'individual' } = {}) {
  if (!forceRefresh) {
    const cached = mailSummaryCache.getMailSummary(mail.id)
    if (cached) return { summary: cached, usedCache: true }
  }
  fs.mkdirSync(MAIL_SUMMARY_WORKDIR, { recursive: true })
  // 화면 표시용 본문(bodyContent)은 HTML일 수 있어 서식 코드가 글자 수를 다 차지해버릴 수
  // 있으므로, AI에게는 글자만 뽑은 텍스트를 우선 사용합니다(2026-07-27 확인). bodyPlainText가
  // 이미 저장돼 있으면 그걸 쓰고, 이 수정 전에 전문을 가져와 bodyPlainText가 없는 옛 메일은
  // 지금 갖고 있는 bodyContent(HTML)를 즉석에서 변환해서 씁니다(IMAP 재조회 없이 바로 적용됨).
  const rawBody = mail.bodyPlainText
    || (mail.bodyMimeType === 'text/html' ? mailImap.htmlToPlainText(mail.bodyContent) : mail.bodyContent)
    || '(내용 없음)'
  const body = trimQuotedThread(rawBody).slice(0, bodyLimit)
  const promptText = [
    '아래는 두레이 메일 1건입니다. 한국어로 정리해주세요:',
    ...singleMailSummaryInstructions(cfg),
    '- 다른 인사말이나 설명, 소제목 없이 "* "로 시작하는 항목들만 출력',
    '',
    `제목: ${mail.subject}`,
    `보낸사람: ${mail.fromName || mail.fromEmail || '(발신자 미상)'}`,
    '내용:',
    body
  ].join('\n')
  const summary = await askClaude(promptText, { cwd: MAIL_SUMMARY_WORKDIR, model: 'haiku', feature: 'mail_single' })
  mailSummaryCache.setMailSummaries({ [mail.id]: summary })
  mailSummaryCache.setSummaryOrigin(mail.id, origin)
  return { summary, usedCache: false }
}

// 캐시에 없는 메일 여러 건을 한 번의 AI 호출로 각각 요약합니다 (묶음 알림/그룹 요약용 —
// AI 호출 횟수를 아끼려고 한 번에 보내되, 결과는 메일별로 나눠서 summarizeMail과 똑같은
// 형식(* 항목만)으로 캐시에 저장합니다 — 그래야 다른 화면에서도 그대로 재사용됩니다).
async function summarizeMailsBatch(mails, cfg, origin = 'individual') {
  if (!mails.length) return {}
  // (2026-08-11 수정) 한 번에 최대 5건까지만. 메일마다 본문을 3,000자씩 담으므로 6건을
  // 넘기면 askClaude의 전체 길이 제한(2만 자)에 걸려 **뒤쪽 메일들이 통째로 잘리고**,
  // 그 메일들은 "===메일 N===" 블록 자체가 응답에 없어 조용히 "(요약 실패)"가 됐습니다.
  // 오래 꺼두었다 켠 직후처럼 밀린 메일이 많을 때 실제로 일어날 수 있는 조건입니다.
  const CHUNK = 5
  if (mails.length > CHUNK) {
    const merged = {}
    for (let i = 0; i < mails.length; i += CHUNK) {
      Object.assign(merged, await summarizeMailsBatch(mails.slice(i, i + CHUNK), cfg, origin))
    }
    return merged
  }
  fs.mkdirSync(MAIL_SUMMARY_WORKDIR, { recursive: true })
  const items = mails.map((m, i) => [
    `[메일 ${i + 1}] 제목: ${m.subject}`,
    `보낸사람: ${m.fromName || m.fromEmail || '(발신자 미상)'}`,
    '내용:',
    trimQuotedThread(
      m.bodyPlainText
        || (m.bodyMimeType === 'text/html' ? mailImap.htmlToPlainText(m.bodyContent) : m.bodyContent)
        || '(내용 없음)'
    ).slice(0, 3000),
    ''
  ].join('\n'))
  const promptText = [
    `아래는 두레이 메일 ${mails.length}건입니다. 메일마다 따로 정리해주세요:`,
    '- 메일 순서대로 정확히 "===메일 N===" 이라는 줄로 시작하세요 (N은 위 [메일 N] 번호와 동일, 1부터).',
    '- 그 아래에 그 메일에 대한 요약만 쓰세요:',
    ...singleMailSummaryInstructions(cfg),
    '- "===메일 N===" 줄과 "* "로 시작하는 항목 줄 외에는 아무것도 출력하지 마세요.',
    '',
    ...items
  ].join('\n')
  const raw = await askClaude(promptText, { cwd: MAIL_SUMMARY_WORKDIR, model: 'haiku', feature: 'mail_batch' })
  const blocks = []
  let current = null
  for (const line of raw.split('\n')) {
    const headerMatch = line.match(/^\s*===\s*메일\s*(\d+)\s*===\s*$/)
    if (headerMatch) {
      if (current) blocks.push(current)
      current = { idx: Number(headerMatch[1]) - 1, lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) blocks.push(current)
  const result = {}
  for (const b of blocks) {
    if (b.idx >= 0 && b.idx < mails.length) {
      const text = b.lines.join('\n').trim()
      if (text) result[mails[b.idx].id] = text
    }
  }
  mailSummaryCache.setMailSummaries(result)
  for (const mailId of Object.keys(result)) mailSummaryCache.setSummaryOrigin(mailId, origin)
  return result
}

// 알림 규칙에 걸렸지만 아직 IMAP 전문을 못 가져온 메일을 잠시 보류해두는 큐입니다.
// key: mail.id, value: { mail, attempts }
// 두레이가 새 메일을 알려주는 시점과 그 메일이 IMAP 서버에 실제로 동기화되는 시점 사이에
// 시차가 있을 수 있어서(막 도착한 메일일수록 흔함) — 못 찾았다고 바로 미리보기로 넘기지 않고,
// 다음 폴링(1분 뒤, MAIL_POLL_INTERVAL_MS)에 다시 시도합니다. 최대 10번(약 10분)까지 기다려보고,
// 그래도 안 되면 미리보기로 대체해서 보내고 그 사실을 알림 문구에 표시합니다.
// (원래 3번/3분이었는데, 실제로는 3분보다 더 오래 걸리는 메일도 있어서 여유를 늘렸습니다.)
const mailAlertPending = new Map()
const MAIL_ALERT_MAX_ATTEMPTS = 10

// 메일 1건의 전문을 알림용으로 준비합니다. 반환 status:
//  - 'ready'         : 전문 확보됨 (또는 IMAP이 원래 꺼져있어 미리보기로 진행 — 기존 동작 유지)
//  - 'giveUpPreview' : 10번 재시도했지만 실패해서 미리보기로 대체 (알림에 표시해야 함)
//  - 'retryLater'    : 아직 재시도 여지가 있어 이번 폴링엔 건너뛰고 다음에 다시 시도
async function resolveMailBodyForAlert(mail, cfg) {
  const r = await ensureMailFullBody(mail, cfg)
  if (r.ok || r.imapOff) {
    mailAlertPending.delete(mail.id)
    return { status: 'ready' }
  }
  const attempts = (mailAlertPending.get(mail.id)?.attempts || 0) + 1
  if (attempts >= MAIL_ALERT_MAX_ATTEMPTS) {
    mailAlertPending.delete(mail.id)
    return { status: 'giveUpPreview' }
  }
  mailAlertPending.set(mail.id, { mail, attempts })
  return { status: 'retryLater' }
}

// 메일 도착 알림 규칙: 지정한 폴더로 새 메일이 저장되면, 지정한 채팅방으로 AI 요약과
// 원문 바로가기 링크를 자동으로 보내줍니다. (알림 기준은 지금은 "폴더"만 지원합니다.)
// 한 번의 확인에서 같은 폴더 메일이 여러 건 발견되면 — 예: 프로그램을 며칠 껐다 켜서
// 밀린 메일을 따라잡을 때 — 건마다 따로 보내지 않고 묶음 메시지 하나로 보냅니다 (알림 폭탄 방지).
// trimQuotedThread는 이 파일 아래쪽에 정의되어 있지만, 함수 선언이라 여기서도 바로 쓸 수 있습니다.
async function notifyMailAlertRules(newMails, cfg) {
  const rules = cfg.mailAlertRules || []
  if (!rules.length) return

  // 이번에 새로 발견된 메일 + 지난 폴링에서 IMAP 실패로 재시도 대기 중이던 메일을 합칩니다.
  const seen = new Set()
  const candidates = [...newMails, ...Array.from(mailAlertPending.values()).map((p) => p.mail)]
    .filter((m) => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
  if (!candidates.length) return

  // 두레이 웹메일에서 실제로 확인한 메일 상세 페이지 주소 형식입니다:
  // https://{도메인}/mail/folders/{폴더ID}/{메일ID}
  const mailUrlOf = (mail) => cfg.doorayDomain
    ? `https://${cfg.doorayDomain}/mail/folders/${mail.folderId}/${mail.id}`
    : ''

  for (const rule of rules) {
    const matched = candidates
      .filter((m) => m.folderName === rule.folderName)
      .sort((a, b) => new Date(a.sentAt || 0) - new Date(b.sentAt || 0))
    if (!matched.length) continue

    let text
    if (matched.length === 1) {
      // 평소처럼 1건 알림 — 공용 summarizeMail 사용 (이미 요약된 적 있으면 재사용)
      const mail = matched[0]
      const bodyResult = await resolveMailBodyForAlert(mail, cfg)
      if (bodyResult.status === 'retryLater') continue // 이번엔 보내지 않고 다음 폴링에서 다시 시도

      let summary = ''
      try {
        const r = await summarizeMail(mail, cfg)
        summary = r.summary
      } catch (err) {
        summary = `(자동 요약 실패: ${err.message})`
      }
      const mailUrl = mailUrlOf(mail)
      text = [
        `[메일 도착] "${mail.folderName}" 폴더`,
        `제목: ${mail.subject}`,
        `보낸사람: ${mail.fromName || mail.fromEmail || '(발신자 미상)'}`,
        '요약:',
        summary,
        bodyResult.status === 'giveUpPreview'
          ? '(IMAP 전문을 여러 번 시도했지만 가져오지 못해 미리보기로 요약됨 — 정확한 내용은 아래 링크에서 확인해주세요)'
          : '',
        mailUrl ? `전문 보기: ${mailUrl}` : ''
      ].filter(Boolean).join('\n')
    } else {
      // 여러 건 묶음 알림: 최대 15건까지만 실제로 요약 시도(비용 제한), 나머지는 제목만 목록에 표시.
      // 이미 다른 화면(메일함/그룹 요약 등)에서 요약해둔 메일은 그대로 재사용하고, 아직 안 된
      // 것들만 모아서 summarizeMailsBatch로 AI 호출 1번에 처리합니다.
      const candidatesForBody = matched.slice(0, 15)
      const usedPreviewSubjects = []
      const readyMails = []
      for (const m of candidatesForBody) {
        const r = await resolveMailBodyForAlert(m, cfg)
        if (r.status === 'retryLater') continue // 이 메일만 다음 폴링으로 미룸
        if (r.status === 'giveUpPreview') usedPreviewSubjects.push(m.subject)
        readyMails.push(m)
      }
      if (!readyMails.length) continue // 전부 재시도 대기 중이면 이번 폴링엔 아무것도 안 보냄

      let summary = ''
      try {
        const needSummarize = readyMails.filter((m) => !mailSummaryCache.getMailSummary(m.id))
        await summarizeMailsBatch(needSummarize, cfg)
        const summaryLines = readyMails.map((m, i) => {
          const s = mailSummaryCache.getMailSummary(m.id) || '(요약 실패)'
          return `${i + 1}. ${m.subject}\n${s}`
        })
        summary = summaryLines.join('\n\n')
        if (usedPreviewSubjects.length) {
          summary += `\n\n(IMAP 전문을 여러 번 시도했지만 가져오지 못해 미리보기로 요약됨: ${usedPreviewSubjects.join(', ')})`
        }
      } catch (err) {
        summary = `(자동 요약 실패: ${err.message})`
      }

      // 목록에는 요약 대상(최대 15건) + 15건을 넘어 요약을 시도하지 않은 나머지도 제목만 표시.
      const listSource = [...readyMails, ...matched.slice(15)]
      const listLines = listSource.slice(0, 20).map((m, i) => {
        const url = mailUrlOf(m)
        return `${i + 1}. ${m.subject} — ${m.fromName || m.fromEmail || '(발신자 미상)'}${url ? `\n   ${url}` : ''}`
      })
      if (listSource.length > 20) listLines.push(`...외 ${listSource.length - 20}건 (메일 탭에서 확인해주세요)`)
      text = [
        `[메일 도착] "${rule.folderName}" 폴더에 새 메일 ${listSource.length}건 (한꺼번에 확인되어 묶어서 알려드려요)`,
        '요약:',
        summary,
        '',
        '목록:',
        ...listLines
      ].join('\n')
    }

    try {
      await doorayClient.request(`/messenger/v1/channels/${rule.channelId}/logs`, {
        method: 'POST',
        body: { text }
      })
    } catch (err) {
      log(`메일 알림 전송 실패 (channelId=${rule.channelId}): ${err.message}`)
    }
  }
}

// 메일(활동 스트림의 type=mail)을 가져와 mailStore에 쌓습니다. cursor로 계속 과거 페이지를
// 걸어가되, "이미 확인한 적 있는 메일"을 만나면 거기서 멈춥니다 — 그래서 프로그램이 꺼져
// 있던 동안 온 메일도(최근 2주 이내라면) 다시 켰을 때 이 함수가 전부 따라잡아줍니다.
// ---- 채팅방 공유 투두리스트 -----------------------------------------------
// 오늘 날짜(KST 기준)를 "YYYY-MM-DD"로 돌려줍니다. 서버/사용자 컴퓨터의 시스템 시간대에
// 의존하지 않도록 taskAutomation.js의 nowKstInfo()와 같은 방식(KST로 직접 시프트)을 씁니다.
function todoNowKst() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return {
    dateIso: `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`,
    hour: kst.getUTCHours(),
    minute: kst.getUTCMinutes()
  }
}

// 'YYYY-MM-DD' → '7/29' (게시 메시지 제목에 붙일 날짜, 앞자리 0은 뺌)
function formatMonthDay(dateIso) {
  const [, m, d] = dateIso.split('-')
  return `${Number(m)}/${Number(d)}`
}

// tags가 있으면 태그별로 묶어서(캘린더 보드와 같은 순서, 미분류는 맨 뒤) 보여주고,
// 태그가 하나도 없는 채팅방은 예전처럼 밋밋한 한 줄 목록으로 보여줍니다(괜히 "미분류"
// 한 줄만 나오는 걸 막기 위함).
function buildTodoMessageText(cards, tags, dateIso) {
  const header = `📋 오늘의 할일 - ${formatMonthDay(dateIso)}`
  if (!cards.length) return `${header}\n(등록된 항목이 없어요)`

  const lineOf = (c) => `${c.status === 'done' ? '☑' : '☐'} ${c.text}`

  if (!tags.length) {
    return `${header}\n${cards.map(lineOf).join('\n')}`
  }

  const sections = [...tags, { id: null, name: '미분류' }]
  const blocks = sections
    .map((tag) => {
      const sectionCards = cards.filter((c) => (c.tagId || null) === (tag.id || null))
      if (!sectionCards.length) return null
      return `[${tag.name}]\n${sectionCards.map(lineOf).join('\n')}`
    })
    .filter(Boolean)
  return `${header}\n${blocks.join('\n\n')}`
}

// 이 채팅방의 "정기 업무" 템플릿마다 오늘 날짜 카드가 아직 없으면 만들고, 전체 목록을
// 새 메시지로 게시합니다. 두레이 메신저 API에는 메시지 수정 기능이 없어서, 상태가 바뀔
// 때마다(자동 게시든, 완료 감지든) 항상 "새 메시지로 다시 올리는" 방식으로 통일합니다.
async function postTodoListNow(channelId) {
  // 지금 바로 올리는 거라, 미뤄뒀던 디바운스 재게시가 뒤이어 또 한 번 올라오지 않게 취소합니다.
  const pendingDebounce = repostDebounceTimers.get(channelId)
  if (pendingDebounce) {
    clearTimeout(pendingDebounce)
    repostDebounceTimers.delete(channelId)
  }
  const { dateIso } = todoNowKst()
  // (2026-08-13 이동) 아침 브리핑은 여기가 아니라 정기 확인(checkTodoSchedule)에서 보냅니다.
  // 처음엔 여기서 브리핑을 기다렸는데, 브리핑의 AI 코멘트가 오래 걸리면 "지금 게시"나
  // 완료 반영까지 그만큼 늦어져서(실사용 "연동 느림" 신고) 수동/반영 게시는 안 기다리게 했습니다.
  // 오늘이 아닌 날 완료/삭제된 카드는 게시 전에 정리합니다 — 완료 기록은 이미 히스토리에
  // 영구 저장돼 있어서, 활성 목록에까지 계속 남아있을 필요가 없습니다(어제 완료한 게 오늘도
  // 계속 체크된 채로 보이던 문제, 삭제했는데도 계속 남아있는 것처럼 보이던 문제 모두 해결).
  try {
    todoStore.cleanupOldCards(channelId, dateIso)
  } catch (err) {
    log(`오래된 할 일 정리 실패 (channelId=${channelId}): ${err.message}`)
  }
  const cfg = loadConfig()
  if ((cfg.todoMailSyncChannels || []).includes(channelId)) {
    try {
      await syncMailRequestsToTodo(channelId)
    } catch (err) {
      log(`메일 요청 → 투두 동기화 실패 (channelId=${channelId}): ${err.message}`)
    }
  }
  const routineTemplates = todoTemplateStore.listTemplates(channelId)
  for (const tpl of routineTemplates) {
    if (!todoTemplateStore.shouldFireOn(tpl, dateIso)) continue
    if (!todoStore.findRoutineCardForToday(channelId, tpl.id, dateIso)) {
      todoStore.addCard({ channelId, text: tpl.text, templateId: tpl.id, forDate: dateIso, tagId: tpl.tagId || null })
    }
  }
  // 예정일(dueDate)이 아직 안 된 카드는 이 목록/게시에서 빠집니다(그날이 되면 자동으로 나타남).
  const cards = todoStore.listCards(channelId, { dateIso })
  const tags = todoTagStore.listTags(channelId)
  // 채팅방에서 봇이 올린 글임을 한눈에 알아볼 수 있게 트리거 이름을 앞에 붙입니다
  // ("[두레이봇] " 등, 설정 탭에서 바꾼 호출 단어를 그대로 씀).
  const text = `[${cfg.trigger}] ${buildTodoMessageText(cards, tags, dateIso)}`
  await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
    method: 'POST',
    body: { text }
  })
  todoStore.setLastPostedDate(channelId, dateIso)
}

// 정해둔 시각을 기다리는 기능은 없앴습니다 — 대화가 잠잠하면 3분마다 알아서 재게시되고
// 있어서, 굳이 하루 중 특정 시각을 기다릴 필요가 없다는 판단입니다. 대신 프로그램이 켜져서
// 두레이에 연결될 때(소켓 'ACTIVE') 딱 한 번만 "오늘 아직 안 올렸으면" 올려줍니다 —
// 그래야 하루 중 프로그램을 처음 켰을 때 오늘의 할 일이 채팅방에 바로 보이게 됩니다.
// (재시작/여러 번 겹쳐 불려도 채팅방별로 하루 한 번만 게시 — getLastPostedDate로 판단)
async function checkTodoSchedule() {
  const cfg = loadConfig()
  const channels = cfg.todoChannels || []
  if (!channels.length) return
  const { dateIso } = todoNowKst()
  for (const channelId of channels) {
    // (2026-08-13) 아침 브리핑 — 오늘 아직 안 보낸 방이면 투두리스트보다 먼저 보냅니다.
    // (여기는 배경 스케줄이라 브리핑의 AI 코멘트가 오래 걸려도 사용자를 기다리게 하지 않습니다)
    try {
      if (todoStore.getChannelState(channelId).briefingLastPostedDate !== dateIso) {
        await postBriefingNow(channelId)
        log(`아침 브리핑 게시 완료 (channelId=${channelId})`)
      }
    } catch (err) {
      log(`아침 브리핑 게시 실패 (channelId=${channelId}): ${err.message}`)
    }
    if (todoStore.getLastPostedDate(channelId) === dateIso) continue
    try {
      await postTodoListNow(channelId)
    } catch (err) {
      log(`공유 투두리스트 게시 실패 (channelId=${channelId}): ${err.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// (2026-08-10 신규) 아침 브리핑 — 오늘 일정 + 오늘 할 일 + 메일 [요청]을 정해진 시각에
// "아침 브리핑"을 켜둔 채팅방으로 보냅니다. AI를 부르지 않고 이미 있는 데이터를 조립만
// 하므로 빠르고, 매일 도는 기능이라 토큰도 안 쓰고, 실패할 구석이 적습니다.
// (사내 오픈소스 클로데이의 AI 브리핑을 참고하되, 6분류 대신 3섹션으로 단순화)
// ---------------------------------------------------------------------------

async function buildBriefingText() {
  const { dateIso } = todoNowKst()
  const lines = [`☀️ ${formatMonthDay(dateIso)} 아침 브리핑`]

  // 1. 오늘 일정 — 섹션마다 따로 try/catch: 캘린더 조회가 실패해도 나머지는 내보냅니다.
  try {
    const cals = await doorayService.listCalendars()
    const calendarIds = (cals || []).map((c) => c.id)
    let events = []
    if (calendarIds.length) {
      const start = new Date(); start.setHours(0, 0, 0, 0)
      const end = new Date(start.getTime() + 24 * 3600 * 1000)
      events = await doorayService.listEvents({
        calendarIds, timeMin: start.toISOString(), timeMax: end.toISOString()
      })
    }
    const isWholeDay = (v) => /^\d{4}-\d{2}-\d{2}\+\d{2}:\d{2}$/.test(v || '')
    const sorted = [...events].sort((a, b) => {
      if (isWholeDay(a.startedAt) !== isWholeDay(b.startedAt)) return isWholeDay(a.startedAt) ? -1 : 1
      return new Date(a.startedAt || 0) - new Date(b.startedAt || 0)
    })
    if (!sorted.length) {
      lines.push('', '\uD83D\uDCC5 오늘 일정 없음 — 집중하기 좋은 날')
    } else {
      lines.push('', `\uD83D\uDCC5 오늘 일정 ${sorted.length}건`)
      for (const e of sorted.slice(0, 10)) {
        const when = isWholeDay(e.startedAt)
          ? '종일'
          : new Date(e.startedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        lines.push(`- ${when} ${e.subject || '(제목 없음)'}`)
      }
      if (sorted.length > 10) lines.push(`- … 외 ${sorted.length - 10}건`)
    }
  } catch (err) {
    lines.push('', '\uD83D\uDCC5 오늘 일정: 조회 실패 — 캨린더 탭에서 직접 확인하세요')
    log(`브리핑 일정 조회 실패: ${err.message}`)
  }

  // 2. 내 두레이 업무 — 체크박스가 아니라 기한 안내만. (2026-08-12: 브리핑을 투두리스트
  // 직전에 함께 보내도록 통합하면서, 겹치던 "오늘 할 일" 섹션을 이걸로 교체했습니다)
  try {
    let tasks
    if (myTasksCache.tasks && Date.now() - myTasksCache.at < MY_TASKS_CACHE_MS) {
      tasks = myTasksCache.tasks
    } else {
      const myId = await getMyMemberId()
      tasks = await doorayService.listMyTasks(myId, { log })
      myTasksCache = { at: Date.now(), tasks }
      saveTasksCacheFile(tasks)
    }
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const soon = (tasks || [])
      .filter((t) => t.dueDate && !isNaN(new Date(t.dueDate)))
      .map((t) => ({ ...t, diff: Math.round((new Date(new Date(t.dueDate).setHours(0, 0, 0, 0)) - today) / 86400000) }))
      .filter((t) => t.diff <= 7)
      .sort((a, b) => a.diff - b.diff)
    if ((tasks || []).length) {
      lines.push('', `\uD83D\uDCCC 내 두레이 업무 ${tasks.length}건${soon.length ? ` — 기한 임박 ${soon.length}건` : ''}`)
      for (const t of soon.slice(0, 10)) {
        const d = t.diff < 0 ? `${-t.diff}일 지남 ⚠️` : (t.diff === 0 ? '오늘 마감' : `${t.diff}일 남음`)
        lines.push(`- [${t.projectCode || '?'}] ${t.subject} — ${d}`)
      }
      if (soon.length > 10) lines.push(`- … 외 ${soon.length - 10}건`)
    }
  } catch (err) {
    log(`브리핑 두레이 업무 조회 실패: ${err.message}`)
  }

  // 3. 메일 [요청] (미완료만)
  try {
    const requests = (await getAllMailRequests()).filter((r) => !r.done)
    if (requests.length) {
      lines.push('', `✉️ 메일 요청 ${requests.length}건`)
      for (const r of requests.slice(0, 10)) lines.push(`- ${r.text}`)
      if (requests.length > 10) lines.push(`- … 외 ${requests.length - 10}건`)
    }
  } catch (err) {
    log(`브리핑 메일 요청 조회 실패: ${err.message}`)
  }

  // 4. (2026-08-13 확장) AI 브리핑 코멘트 — 위에서 프로그램이 조립한 실제 데이터를 읽고
  // "오늘 집중할 것"과 "제안"을 판단해 붙입니다 (클로데이의 판단형 브리핑 참고 — 단, 데이터
  // 수집·조립은 여전히 프로그램이 해서 건수·목록이 틀릴 일은 없습니다).
  // AI가 실패하거나 출력 형식이 이상하면 이 부분만 빼고 브리핑은 그대로 나갑니다.
  try {
    const prompt = [
      '당신은 마케터의 업무 비서입니다. 아래는 프로그램이 조립한 오늘 아침 브리핑 데이터입니다.',
      '이 데이터만 근거로, 아래 형식 그대로 짧은 판단을 써주세요 (다른 말·인사말·설명 금지).',
      '',
      '형식:',
      '\uD83C\uDFAF 오늘 집중',
      '- (가장 중요한 것 1~2개. 왜 지금인지 한 마디씩 — 예: 기한 지남, 오늘 마감, 회의 전에 준비 필요)',
      '\uD83D\uDCA1 제안',
      '- (일정·기한·메일 요청을 조합한 실질적인 조언 1~2개. 뻔한 덕담·응원 금지)',
      '',
      '규칙:',
      '- 데이터에 없는 내용을 지어내지 마세요. 마땅한 항목이 없는 줄은 통째로 빼세요.',
      '- 전체 6줄 이내로 짧게.',
      '',
      '[브리핑 데이터]',
      lines.join('\n')
    ].join('\n')
    const raw = await askClaude(prompt, { cwd: CLAUDE_WORKSPACE_ROOT, feature: 'briefing_comment', timeoutMs: 60_000 })
    const comment = (raw || '').trim()
    // 형식이 깨졌거나(마커 없음) 지나치게 길면 AI가 딴소리를 한 것이므로 붙이지 않습니다.
    if (comment && comment.length <= 900 && /(\uD83C\uDFAF|\uD83D\uDCA1)/.test(comment)) {
      lines.push('', comment)
    } else if (comment) {
      log('브리핑 AI 코멘트가 예상 형식과 달라 이번에는 생략했어요')
    }
  } catch (err) {
    log(`브리핑 AI 코멘트 생략: ${err.message}`)
  }

  return lines.join('\n')
}

async function postBriefingNow(channelId) {
  const cfg = loadConfig()
  const text = `[${cfg.trigger}] ${await buildBriefingText()}`
  await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
    method: 'POST',
    body: { text }
  })
  // 게시 날짜는 공유 투두리스트와 같은 채널 상태 저장소를 쓰되, 키를 따로 둬서 안 섞이게 합니다.
  todoStore.saveChannelState(channelId, { briefingLastPostedDate: todoNowKst().dateIso })
}

// (2026-08-12 변경) 별도 브리핑 스케줄(토글 방 + 시각 설정)은 없앴습니다 — 브리핑은 이제
// 공유 투두방에 "그날 첫 투두리스트"가 올라가기 직전, postTodoListNow()가 함께 보냅니다.

// ---------------------------------------------------------------------------
// (2026-08-13 신규) 일일/주간 보고서 생성 — 클로데이 ReportGenerator 참고.
// 재료(내 두레이 업무 + 기간 내 완료한 할 일 + 기간 내 일정)는 프로그램이 정확히 모으고,
// AI는 그걸 보고서 문장으로 정리만 합니다. 채팅 "@두레이봇 주간 보고서 써줘" 전용입니다
// (대시보드 화면도 있었지만 쓸 일이 없어 2026-08-13 제거 — 구조는 여기 남겨둠). 30개까지 보관.
// ---------------------------------------------------------------------------
const REPORTS_PATH = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'reports', 'reports.json')
function loadReports() { try { return JSON.parse(fs.readFileSync(REPORTS_PATH, 'utf-8')) } catch { return [] } }
function saveReports(list) {
  try {
    fs.mkdirSync(path.dirname(REPORTS_PATH), { recursive: true })
    fs.writeFileSync(REPORTS_PATH, JSON.stringify(list.slice(0, 30), null, 2), 'utf-8')
  } catch { /* 보관 실패는 무시 — 생성 자체는 성공 */ }
}

async function generateReport(type) {
  const isWeekly = type === 'weekly'
  const now = new Date()
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  if (isWeekly) {
    const dow = (start.getDay() + 6) % 7 // 이번 주 월요일부터
    start.setDate(start.getDate() - dow)
  }
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`
  const periodLabel = isWeekly ? `${fmt(start)}~${fmt(now)} 주간` : `${fmt(now)} 일일`

  const facts = [`[기간] ${periodLabel}`]

  // 1. 열려 있는 내 두레이 업무 (단계·기한) — 3분 캐시 재사용
  try {
    let tasks
    if (myTasksCache.tasks && Date.now() - myTasksCache.at < MY_TASKS_CACHE_MS) {
      tasks = myTasksCache.tasks
    } else {
      const myId = await getMyMemberId()
      tasks = await doorayService.listMyTasks(myId, { log })
      myTasksCache = { at: Date.now(), tasks }
      saveTasksCacheFile(tasks)
    }
    facts.push('', '[열려 있는 내 두레이 업무]')
    for (const t of (tasks || []).slice(0, 30)) {
      facts.push(`- [${t.projectCode || '?'}] ${t.subject} — ${t.workflowName || (t.workflowClass === 'working' ? '진행 중' : '할 일')}${t.dueDate ? `, 기한 ${String(t.dueDate).slice(0, 10)}` : ''}`)
    }
  } catch (err) { log(`보고서: 업무 조회 실패 — ${err.message}`) }

  // 2. 기간 내 완료한 할 일 (공유 투두 완료 히스토리)
  try {
    const done = todoHistoryStore.readAll().filter((r) => (r.completedAt || 0) >= start.getTime())
    if (done.length) {
      facts.push('', '[이 기간에 완료한 할 일]')
      for (const r of done.slice(-40)) facts.push(`- ${r.text}${r.tagName ? ` (${r.tagName})` : ''}`)
    }
  } catch (err) { log(`보고서: 완료 히스토리 조회 실패 — ${err.message}`) }

  // 3. 기간 내 일정
  try {
    const cals = await doorayService.listCalendars()
    const calendarIds = (cals || []).map((c) => c.id)
    if (calendarIds.length) {
      const end = new Date(start.getTime() + (isWeekly ? 7 : 1) * 86400000)
      const events = await doorayService.listEvents({ calendarIds, timeMin: start.toISOString(), timeMax: end.toISOString() })
      if ((events || []).length) {
        facts.push('', '[이 기간의 일정]')
        for (const e of events.slice(0, 20)) facts.push(`- ${String(e.startedAt || '').slice(0, 10)} ${e.subject || '(제목 없음)'}`)
      }
    }
  } catch (err) { log(`보고서: 일정 조회 실패 — ${err.message}`) }

  const prompt = [
    `당신은 마케터의 업무 비서입니다. 아래 실제 데이터만 근거로 ${isWeekly ? '주간' : '일일'} 업무 보고서 초안을 작성하세요.`,
    '',
    '형식 (마크다운):',
    `# ${isWeekly ? '주간' : '일일'} 업무 보고 (${periodLabel})`,
    '섹션: ## 완료한 일 / ## 진행 중인 일 / ## 다음 예정 / ## 특이사항·공유',
    '',
    '규칙:',
    '- 데이터에 있는 것만 쓰세요. 지어내지 마세요.',
    '- 비슷한 항목은 묶어서 정리하고, 프로젝트 표기([XX])는 유지하세요.',
    '- 기한이 지났거나 임박한 업무는 "진행 중인 일"에서 기한과 함께 짚어주세요.',
    '- 해당 내용이 없는 섹션은 "없음" 한 줄로 두세요.',
    '- 보고서 본문만 출력하세요 (머리말·설명·인사 금지).',
    '',
    facts.join('\n')
  ].join('\n')
  const content = ((await askClaude(prompt, { cwd: CLAUDE_WORKSPACE_ROOT, feature: 'report_generate', timeoutMs: 240_000 })) || '').trim()
  if (!content) throw new Error('AI가 빈 보고서를 돌려줬어요 — 잠시 후 다시 시도해주세요.')
  const report = { type: isWeekly ? 'weekly' : 'daily', periodLabel, content, createdAt: new Date().toISOString() }
  saveReports([report, ...loadReports()])
  return report
}


async function pollMail() {
  if (mailPolling) return // 이미 돌고 있으면 중복 실행 방지
  mailPolling = true
  try {
    const cfg = loadConfig()
    const allowlist = new Set(cfg.mailFolderAllowlist || [])
    let before
    let totalNew = 0
    const allUnseen = [] // 이번 확인에서 발견된 새 메일 전체 — 알림은 마지막에 한 번에 (묶음 전송)
    for (let page = 0; page < 50; page++) { // 안전장치: 최대 50페이지(최대 5000건)까지만
      // size=100은 두레이 서버가 500을 내는 걸 확인해서 50으로 낮춤 (doorayService.js 참고)
      const { mails, cursor } = await doorayService.fetchMailStreamPage({ before, size: 50 })
      if (!mails.length) break
      const unseen = mails.filter((m) => !mailStore.hasSeen(m.id))
      mailStore.recordFolders(unseen) // 폴더 존재 자체는 저장 여부와 상관없이 계속 기록
      if (unseen.length) {
        mailStore.markSeen(unseen.map((m) => m.id))
        const toSave = allowlist.size ? unseen.filter((m) => allowlist.has(m.folderName)) : unseen
        totalNew += mailStore.appendMails(toSave)
        allUnseen.push(...unseen)
      }
      // 이 페이지 안에 "이미 아는 메일"이 하나라도 섞여 있었다면, 거기서부터는 지난번에
      // 이미 훑은 영역이라는 뜻이라 더 과거로 갈 필요가 없습니다.
      if (unseen.length < mails.length || !cursor) break
      before = cursor
    }
    // 알림은 "이 폴더만 저장하기" 설정과 상관없이, 알림 규칙에 걸린 폴더면 항상 보냅니다.
    // 페이지를 다 모은 뒤 한 번에 보내서, 밀린 메일이 많아도 채팅방에 폭탄처럼 쏟아지지 않습니다.
    await notifyMailAlertRules(allUnseen, cfg)
    if (totalNew > 0) log(`메일 ${totalNew}건 새로 저장됨`)
  } catch (err) {
    log(`메일 조회 실패: ${err.message}`)
  } finally {
    mailPolling = false
  }
}

async function getMyMemberId() {
  if (myMemberId) return myMemberId
  const res = await doorayClient.request('/common/v1/members/me')
  myMemberId = res.result?.organizationMemberId || res.result?.id
  return myMemberId
}

function updateTrayMenu() {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    { label: `상태: ${status}`, enabled: false },
    { type: 'separator' },
    { label: '대시보드 열기', click: () => openDashboard() },
    { label: '지금 재연결', click: () => startBot() },
    { type: 'separator' },
    ...logLines.slice(0, 5).map((l) => ({ label: l, enabled: false })),
    { type: 'separator' },
    { label: '종료', click: () => app.quit() }
  ])
  tray.setToolTip(`두레이 AI 어시스턴트 - ${status}`)
  tray.setContextMenu(menu)
}

// startBot()은 트레이 "지금 재연결", 설정 저장, 대시보드 재연결 버튼, 앱 시작 등 여러 곳에서
// 각각 독립적으로 호출될 수 있습니다. 이 호출들이 거의 동시에 겹치면(예: 재연결 버튼을 누른
// 직후 설정을 저장하는 경우) 이전 소켓이 채 정리되기 전에 새 소켓 연결 시도가 겹쳐서 열려,
// 두레이 서버가 같은 계정의 연결이 두 개라고 보고 하나를 AGENT_ALREADY_CONNECTED로 끊어버리는
// 문제가 있었습니다. 그래서 실제 연결 로직(startBotImpl)은 큐에 넣어 한 번에 하나씩만,
// 이전 호출이 끝난 뒤 순서대로 실행되게 합니다.
let startBotChain = Promise.resolve()
function startBot() {
  startBotChain = startBotChain
    .then(() => startBotImpl())
    .catch((err) => log(`재연결 처리 중 오류: ${err.message}`))
  return startBotChain
}

async function startBotImpl() {
  config = loadConfig()
  currentToken = await tokenStore.getToken()
  myMemberId = null // 토큰이 바뀌었을 수 있으니 다시 조회하도록 초기화

  if (!currentToken || !config.doorayDomain) {
    status = '설정 필요 (토큰/도메인 없음)'
    updateTrayMenu()
    log('두레이 토큰 또는 주소가 없습니다. 대시보드의 "설정"에서 입력해주세요.')
    openDashboard()
    return
  }

  // 메일 폴링: 소켓 연결이 실제로 끝나기 전에 여기서 바로 메일 조회까지 같이 실행하면,
  // 두 요청이 동시에 두레이 서버로 몰려서 429(요청이 너무 많음) 오류가 나는 경우가 있었습니다.
  // 그래서 "시작하자마자 한 번 몰아서 확인하기"는 아래 소켓의 state 핸들러에서, 연결이 실제로
  // ACTIVE가 된 뒤에 하도록 미뤘습니다. 그 이후의 주기적 조회(1분마다)는 그대로 둡니다.
  if (mailPollTimer) clearInterval(mailPollTimer)
  mailPollTimer = setInterval(pollMail, MAIL_POLL_INTERVAL_MS)
  let initialMailPollDone = false
  let initialHistoryBackfillDone = false
  let initialTodoScheduleCheckDone = false
  let initialTodoCatchupDone = false

  await ensureMcpRegistered({ token: currentToken, appDir: app.getAppPath(), log })

  if (socketClient) socketClient.stop()
  socketClient = new SocketModeClient({ doorayClient, domain: config.doorayDomain })
  const handleMessage = createMentionHandler({
    doorayClient, doorayService, getConfig: () => config, getMyMemberId, log, postTodoListNow
  })

  socketClient.on('state', (s) => {
    status = s === 'ACTIVE' ? '연결됨' : s === 'CONNECTING' ? '연결 중' : '끊김'
    updateTrayMenu()
    if (s === 'ACTIVE' && !initialMailPollDone) {
      initialMailPollDone = true
      pollMail()
    }
    if (s === 'ACTIVE' && !initialHistoryBackfillDone) {
      initialHistoryBackfillDone = true
      backfillChatHistory(doorayClient, { log }).catch((err) => log(`채팅 기록 채우기 오류: ${err.message}`))
    }
    // 컴퓨터/프로그램이 게시 예정 시각보다 늦게 켜졌을 경우를 대비해, 연결되자마자
    // (1분 주기를 기다리지 않고) 바로 한 번 "오늘 게시했어야 했는데 아직 안 했는지" 확인합니다.
    if (s === 'ACTIVE' && !initialTodoCatchupDone) {
      initialTodoCatchupDone = true
      // 컴퓨터가 꺼져있던 동안 공유 투두방에 올라온 메시지(완료/삭제/추가/태그변경/수정 보고)를
      // 놓치는 문제 해결 — 담당자가 퇴근해서 프로그램이 꺼진 사이 다른 팀원이 완료 처리를
      // 해도 인식 못 하던 실사용 신고에 따른 대응(정제문서 참고).
      catchUpMissedTodoMessages(doorayClient, { log, postTodoListNow, getConfig: loadConfig })
        .catch((err) => log(`밀린 투두 메시지 캐치업 오류: ${err.message}`))
    }
    if (s === 'ACTIVE' && !initialTodoScheduleCheckDone) {
      initialTodoScheduleCheckDone = true
      checkTodoSchedule().catch((err) => log(`공유 투두리스트 스케줄 확인 오류: ${err.message}`))
    }
  })
  socketClient.on('message', (data) => {
    handleMessage(data).catch((err) => log(`처리 오류: ${err.message}`))
  })
  socketClient.on('error', (err) => log(`소켓 오류: ${err.message}`))
  socketClient.on('close', ({ code, reason }) => log(`연결 종료 (code=${code} ${reason})`))

  status = '연결 중'
  updateTrayMenu()
  socketClient.start()
}

function applyAutoStart(autoStart) {
  try {
    if (app.isPackaged) {
      // 설치 프로그램(설치파일_만들기.bat)으로 설치한 경우: 실행 파일 자체가 이 프로그램이라
      // 별다른 인자 없이 등록해도 부팅 시 정상적으로 열립니다.
      app.setLoginItemSettings({ openAtLogin: !!autoStart })
    } else {
      // 실행.bat(= "electron .")으로 켜는 경우: 인자 없이 등록하면 electron 실행 파일만
      // 등록되어, 부팅 때 이 프로그램이 아니라 빈 electron만 뜨고 맙니다 — "자동 실행을
      // 켜놨는데 안 켜진다"는 증상의 실제 원인이 이것입니다. electron 실행 파일 경로에
      // 이 프로그램 폴더를 인자로 같이 등록해서, 부팅 시에도 정확히 이 프로그램이 열리게 합니다.
      // 폴더 경로에 띄어쓰기가 있으면(예: "두레이 연동") 따옴표 없이 등록할 경우 윈도우가
      // 부팅 시 그 경로를 띄어쓰기에서 잘라버려 실행에 실패하므로, 반드시 따옴표로 감싸서 등록합니다.
      app.setLoginItemSettings({
        openAtLogin: !!autoStart,
        path: process.execPath,
        args: [`"${app.getAppPath()}"`]
      })
    }
  } catch (err) {
    log(`자동 실행 설정 실패: ${err.message}`)
  }
}

// ---- 대시보드(renderer)에서 오는 요청 처리 ---------------------------------

ipcMain.handle('dooray:get-config', async () => {
  const c = loadConfig()
  return {
    doorayDomain: c.doorayDomain,
    trigger: c.trigger,
    autoStart: !!c.autoStart,
    myTeamName: c.myTeamName || '',
    myStaffName: c.myStaffName || '',
    briefingHour: Number.isInteger(c.briefingHour) ? c.briefingHour : 8,
    briefingMinute: Number.isInteger(c.briefingMinute) ? c.briefingMinute : 50
  }
})

// (2026-08-11 추가) 오류 리포트 — 로그의 오류/실패 줄 + 버전 정보를 한 덩어리 텍스트로.
// 팀원이 "안 되는데요"만 말하고 끝나지 않게, 붙여넣을 수 있는 진단 묶음을 만들어 줍니다.
ipcMain.handle('dooray:build-error-report', async () => {
  try {
    const errorLines = logLines.filter((l) => /(오류|실패|Error|error)/.test(l)).slice(0, 30)
    let claudeInfo = '확인 안 됨'
    try {
      const p = await resolveClaudePath()
      claudeInfo = p || '찾지 못함'
    } catch { /* 무시 */ }
    const lines = [
      `[두레이 AI 어시스턴트 오류 리포트]`,
      `생성 시각: ${new Date().toLocaleString('ko-KR')}`,
      `앱 버전: v${app.getVersion()} (${app.isPackaged ? '설치본' : '개발 모드'})`,
      `OS: ${process.platform} ${process.getSystemVersion ? process.getSystemVersion() : ''}`,
      `클로드 경로: ${claudeInfo}`,
      `소켓 상태: ${status}`,
      '',
      `[최근 오류/실패 로그 ${errorLines.length}건 (최신순)]`,
      ...(errorLines.length ? errorLines : ['(없음 — 오류 기록이 없어요)'])
    ]
    return { ok: true, text: lines.join('\n') }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:has-token', async () => {
  const t = await tokenStore.getToken()
  return !!t
})

ipcMain.handle('dooray:save-settings', async (_event, { domain, token, trigger, autoStart, myTeamName, myStaffName }) => {
  try {
    const c = loadConfig()
    c.doorayDomain = domain
    c.trigger = trigger || '두레이봇'
    c.autoStart = !!autoStart
    c.myTeamName = (myTeamName || '').trim()
    c.myStaffName = (myStaffName || '').trim()
    // 이 컴퓨터에서 처음 설정을 저장하는 거라면, 클로드 "폴더 신뢰 확인" 창을 자동으로
    // 한 번 띄워줍니다 (사용자가 직접 터미널을 열 필요 없음). 이후로는 다시 안 띄웁니다.
    // 신뢰 대상은 홈 폴더 전체가 아니라, 실제로 AI 작업이 일어나는 전용 폴더로 좁혀서
    // 바탕화면/문서함 같은 다른 개인 폴더에는 영향이 없게 합니다.
    if (!c.claudeTrustPromptShown) {
      fs.mkdirSync(CLAUDE_WORKSPACE_ROOT, { recursive: true })
      // 창 띄우기는 저장 완료를 막지 않도록 기다리지 않고 진행합니다 (실패해도 저장은 계속).
      openTrustPromptWindow({ cwd: CLAUDE_WORKSPACE_ROOT, log }).catch(() => {})
      c.claudeTrustPromptShown = true
    }
    saveConfig(c)
    applyAutoStart(c.autoStart)
    if (token) await tokenStore.saveToken(token)
    startBot()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// "가이드" 탭의 버튼에서 수동으로도 다시 띄울 수 있게 합니다 (예: 신뢰 절차를 다시 해야 할 때).
// 여기서도 신뢰 대상은 홈 폴더 전체가 아니라 실제 작업 폴더로 좁혀서 확인합니다.
ipcMain.handle('dooray:open-claude-trust-window', async () => {
  fs.mkdirSync(CLAUDE_WORKSPACE_ROOT, { recursive: true })
  const opened = await openTrustPromptWindow({ cwd: CLAUDE_WORKSPACE_ROOT, log })
  return { ok: opened }
})

// 테스트/시연용: 이 프로그램이 저장해둔 모든 것(설정, 두레이 토큰, 메일/채팅 기록)을 지우고
// 마치 이 컴퓨터에 처음 설치한 것처럼 되돌립니다. 실행 후 프로그램을 자동으로 다시 시작합니다.
ipcMain.handle('dooray:reset-all-data', async () => {
  try {
    await tokenStore.deleteToken().catch(() => {})
    await tokenStore.deleteImapPassword().catch(() => {})
    saveConfig({ ...DEFAULTS })
    const workspaceRoot = path.join(os.homedir(), 'Dooray-Assistant-Workspaces')
    for (const sub of ['mail-history', 'chat-history', 'agent', 'mail-summary', 'dashboard-chat']) {
      fs.rmSync(path.join(workspaceRoot, sub), { recursive: true, force: true })
    }
    mailSummaryCache.clearAll()
    // 클로드에 등록해둔 두레이 도구(MCP)도 지웁니다 — 예전(env) 방식으로 등록된 경우
    // 클로드 설정 파일에 토큰이 남아있을 수 있어서, 초기화할 때 함께 제거해야 안전합니다.
    // (참고: 클로드 앱 자체의 설치/로그인/폴더 신뢰 상태나 Node.js는 이 프로그램이 만든 게
    //  아니라서 건드리지 않습니다 — "완전 새 컴퓨터" 테스트는 다른 PC/계정에서 해야 정확합니다.)
    try {
      const claudePath = await resolveClaudePath({})
      if (claudePath) {
        const { cmd, args } = commandFor(claudePath)
        await new Promise((resolve) => {
          execFile(cmd, [...args, 'mcp', 'remove', '--scope', 'user', 'dooray'], { shell: false, timeout: 15000 }, () => resolve())
        })
      }
    } catch { /* 등록이 없거나 제거 실패해도 초기화는 계속 진행 */ }
    log('저장된 모든 정보를 초기화했습니다. 프로그램을 다시 시작합니다.')
    app.relaunch()
    app.exit()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// "내 정보"(팀명/이름)만 저장 — 연결 재시작 없이 설정 파일만 갱신합니다.
// (예전에는 이것도 전체 저장으로 처리되어, 이름만 고쳐도 두레이 연결이 다시 시작됐음)
ipcMain.handle('dooray:save-my-info', async (_event, { myTeamName, myStaffName }) => {
  try {
    const c = loadConfig()
    c.myTeamName = (myTeamName || '').trim()
    c.myStaffName = (myStaffName || '').trim()
    saveConfig(c)
    config = c
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:close-setup', async () => {
  closeDashboard()
  return { ok: true }
})

ipcMain.handle('dooray:get-status', async () => {
  return { status, logs: logLines.slice(0, 100) }
})

// 클로드 코드(Claude Code)가 이 컴퓨터에 설치되어 있는지만 빠르게 확인합니다 (실제 AI 호출은
// 하지 않아서 비용이 들지 않습니다). 화면에 "설치 필요" 안내 배너를 띄울지 판단하는 용도입니다.
ipcMain.handle('dooray:get-claude-status', async () => {
  const claudePath = await resolveClaudePath({})
  // loggedIn: true/false는 확인됨, null은 이 컴퓨터에서는 확인할 방법이 없음(예: macOS).
  const loggedIn = claudePath ? checkLoggedIn() : false
  return { ok: true, installed: !!claudePath, loggedIn }
})

// 내가 참여 중인 "모든" 채팅방 + 프로그램 실행 후 관측된 최근 활동 정보를 합쳐서 돌려줍니다.
// (예전에는 메시지가 감지된 방만 나와서, 자동화/알림 설정 전에 그 방에 먼저 말을 걸어야 했음)
// (2026-08-12 추가) 채팅방 목록은 첫 로드가 무거워서(방마다 이름 조회), 60초 캐시와
// 겹침 방지를 둡니다. 토글 상태(허용/기록/투두/브리핑)는 아래에서 그때그때 다시 입히므로
// 캐시가 있어도 토글 표시는 항상 최신입니다.
let channelListCache = { at: 0, merged: null }
let channelListInflight = null
const CHANNEL_LIST_CACHE_MS = 60 * 1000

// (2026-08-12 추가) 채팅방 목록도 지난 실행 결과를 디스크에 보관합니다. 앱을 새로 켠 직후
// 첫 화면은 그 목록을 즉시 보여주고, 실제 갱신은 뒤에서 돌립니다 (내 업무 목록과 같은 방식).
// 허용/기록/투두/브리핑 토글과 이름 오버라이드는 dooray:get-channels가 매번 최신 설정으로
// 입히므로, 목록이 조금 낡아도 설정 스위치가 낡게 보이는 일은 없습니다.
const CHANNELS_CACHE_PATH = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'cache', 'channel-list.json')
function loadChannelsCacheFile() {
  try { return JSON.parse(fs.readFileSync(CHANNELS_CACHE_PATH, 'utf-8')) } catch { return null }
}
function saveChannelsCacheFile(merged) {
  try {
    fs.mkdirSync(path.dirname(CHANNELS_CACHE_PATH), { recursive: true })
    fs.writeFileSync(CHANNELS_CACHE_PATH, JSON.stringify({ at: Date.now(), merged }), 'utf-8')
  } catch { /* 캐시 저장 실패는 무시 */ }
}

async function buildChannelList() {
  if (channelListCache.merged && Date.now() - channelListCache.at < CHANNEL_LIST_CACHE_MS) {
    return channelListCache.merged
  }
  if (channelListInflight) return channelListInflight
  channelListInflight = (async () => {
    try {
      const merged = await buildChannelListOnce()
      channelListCache = { at: Date.now(), merged }
      saveChannelsCacheFile(merged) // 다음 실행의 첫 화면용으로 보존 (2026-08-12)
      return merged
    } finally {
      channelListInflight = null
    }
  })()
  // (2026-08-12 추가) 이번 실행에서 아직 한 번도 목록을 못 만들었으면(첫 로드), 지난 실행 때
  // 저장해둔 목록을 즉시 돌려주고, 위에서 시작한 실제 갱신은 뒤에서 마저 돌게 둡니다.
  if (!channelListCache.merged) {
    const disk = loadChannelsCacheFile()
    if (disk && Array.isArray(disk.merged) && disk.merged.length) {
      channelListInflight.catch((err) => log(`채팅방 목록 배경 갱신 실패: ${err.message}`))
      return disk.merged
    }
  }
  return channelListInflight
}

async function buildChannelListOnce() {
  // 토글 상태(허용/기록/투두)와 이름 오버라이드는 캐시하면 안 되므로 여기서 다루지
  // 않고, dooray:get-channels 핸들러가 매번 최신 설정으로 입힙니다.
  // (2026-08-13 변경) 전체 채팅방 목록 조회를 없앴습니다 — 방마다 이름 조회까지 하면
  // 호출이 수십~백 개라 앱 시작이 통째로 느려졌습니다(실사용 신고). 실제로 필요한 건
  // "최근 대화가 관측된 방 + 스위치를 켜둔 방"뿐이고, 이 방들 이름은 디스크 이름 캐시에
  // 대부분 있어 호출이 거의 없습니다. 새 방은 메시지가 한 번 관측되면 목록에 나타납니다.
  const recent = getRecentChannels()
  const recentMap = new Map(recent.map((ch) => [ch.channelId, ch]))
  const cfg = loadConfig()
  const knownIds = [...new Set([
    ...recent.map((ch) => ch.channelId),
    ...(cfg.openChannels || []),
    ...(cfg.todoChannels || []),
    ...(cfg.historyDisabledChannels || []),
    ...(cfg.todoMailSyncChannels || []),
    ...Object.keys(cfg.channelLabelOverrides || {})
  ])]

  let labels = {}
  try {
    const myId = await getMyMemberId()
    labels = await doorayService.getChannelLabels(knownIds, myId)
  } catch { /* 이름 조회 실패하면 숫자 ID로 표시 (직접 지정한 이름은 핸들러가 입힘) */ }

  const merged = knownIds.map((channelId) => {
    const seen = recentMap.get(channelId)
    return {
      channelId,
      label: labels[channelId] || channelId,
      lastText: seen?.lastText || '',
      lastSenderId: seen?.lastSenderId || '',
      lastAt: seen?.lastAt || 0
    }
  })

  // 최근 활동이 있는 방을 위로, 나머지는 이름순
  merged.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || (a.label || '').localeCompare(b.label || '', 'ko'))
  return merged
}

ipcMain.handle('dooray:get-channels', async () => {
  const cfg = loadConfig()
  const allowed = new Set(cfg.openChannels || [])
  const historyOff = new Set(cfg.historyDisabledChannels || [])
  const todoOn = new Set(cfg.todoChannels || [])
  const briefingOn = new Set(cfg.briefingChannels || [])
  const overrides = cfg.channelLabelOverrides || {}
  const merged = await buildChannelList()
  return merged.map((ch) => ({
    ...ch,
    label: overrides[ch.channelId] || ch.label,
    allowed: allowed.has(ch.channelId),
    historyEnabled: !historyOff.has(ch.channelId),
    todoEnabled: todoOn.has(ch.channelId),
    briefingEnabled: briefingOn.has(ch.channelId)
  }))
})

ipcMain.handle('dooray:toggle-channel', async (_event, { channelId, allowed }) => {
  const c = loadConfig()
  const set = new Set(c.openChannels || [])
  if (allowed) set.add(channelId)
  else set.delete(channelId)
  c.openChannels = Array.from(set)
  saveConfig(c)
  config = c
  return { ok: true }
})

// 기록 저장은 기본이 켜짐이라, "끈" 채팅방만 목록에 저장합니다.
ipcMain.handle('dooray:toggle-history', async (_event, { channelId, enabled }) => {
  const c = loadConfig()
  const set = new Set(c.historyDisabledChannels || [])
  if (enabled) set.delete(channelId)
  else set.add(channelId)
  c.historyDisabledChannels = Array.from(set)
  saveConfig(c)
  config = c
  return { ok: true }
})

// 이 채팅방을 "공유 투두방"으로 켜면, 매일 정해진 시각 자동 게시 + 멘션 없는 완료 감지가 시작됩니다.
ipcMain.handle('dooray:toggle-todo-channel', async (_event, { channelId, enabled }) => {
  const c = loadConfig()
  const set = new Set(c.todoChannels || [])
  if (enabled) set.add(channelId)
  else set.delete(channelId)
  c.todoChannels = Array.from(set)
  saveConfig(c)
  config = c
  return { ok: true }
})

// (2026-08-11 추가) 워크스페이스(로컬 지식 베이스) 프로젝트 폴더 목록 — '문서에서 갱신'용.
// 폴더가 없는 컴퓨터(다른 팀원)에서는 available:false를 돌려주고 화면이 이 기능을 숨깁니다.
ipcMain.handle('dooray:list-workspace-projects', async () => {
  try {
    const cfg = loadConfig()
    const root = cfg.workspaceDocsRoot
    const projectsDir = root ? path.join(root, '02_프로젝트') : ''
    if (!projectsDir || !fs.existsSync(projectsDir)) return { ok: true, available: false, folders: [] }
    const folders = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'ko'))
    return { ok: true, available: true, folders, links: cfg.taskDocLinks || {} }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// (2026-08-11 추가) 워크스페이스 문서를 읽고 업무 본문 갱신 "초안"을 만듭니다.
// 정제문서가 100KB를 넘는 프로젝트도 있어 프롬프트에 담지 않고, 봇의 클로드가 파일을
// 직접 읽게 경로만 알려줍니다 (클로드 코드는 로컬 파일을 도구로 열 수 있음).
ipcMain.handle('dooray:propose-task-body-from-doc', async (_event, { projectId, postId, folderName } = {}) => {
  try {
    if (!folderName) return { ok: false, error: '워크스페이스 프로젝트 폴더를 골라주세요.' }
    const cfg = loadConfig()
    const root = cfg.workspaceDocsRoot
    const docPath = path.join(root, '02_프로젝트', folderName, '정제문서.md')
    const historyPath = path.join(root, '02_프로젝트', folderName, '히스토리.md')
    if (!fs.existsSync(docPath)) return { ok: false, error: `정제문서를 못 찾았어요: ${docPath}` }
    const post = await doorayService.getPost(projectId, postId)
    const current = post?.body?.content || ''
    if (!current.trim()) return { ok: false, error: '업무 본문이 비어 있어요 — 먼저 본문 양식을 직접 만들어주세요.' }
    // 이 업무가 어느 폴더와 연결되는지 기억 — 다음부터는 자동 선택
    const c = loadConfig()
    c.taskDocLinks = { ...(c.taskDocLinks || {}), [postId]: folderName }
    saveConfig(c)
    config = c
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
    const todayLabel = `${String(kst.getUTCMonth() + 1).padStart(2, '0')}/${String(kst.getUTCDate()).padStart(2, '0')}`
    const prompt = [
      '당신은 업무 문서를 갱신하는 비서입니다. 아래 로컬 문서 두 개를 직접 읽고,',
      '[현재 본문]을 문서의 최신 진행 상황에 맞게 고친 전체 본문을 출력하세요.',
      '',
      '읽을 파일 (도구로 직접 여세요):',
      `- ${docPath} (프로젝트의 지금 상태)`,
      `- ${historyPath} (진행 이력 — 표의 최근 행 위주로만 보면 됩니다)`,
      '',
      '규칙:',
      '- [현재 본문]의 양식·구조·항목 순서(■ 항목들)를 그대로 유지합니다.',
      '- 체크리스트(- [ ])는 문서에서 완료가 확인된 항목만 - [x]로 바꿉니다. 애매하면 그대로 둡니다.',
      `- "■ 현재 상태"를 갱신하고, [최종 갱신 : MM/DD] 표기가 있으면 ${todayLabel}로 바꿉니다.`,
      '- 이 본문은 팀 공유방에 올라갑니다. 파일 경로·함수명 같은 내부 구현 상세는 절대 넣지 않습니다.',
      '- 문서에서 확인되지 않는 내용은 지어내지 말고 그대로 둡니다.',
      '',
      '두레이 업무 양식 규칙 (이 팀의 고정 양식 — 반드시 지킬 것):',
      '- 체크리스트 줄은 "- [ ] 번호. 내용" 형태를 유지합니다. 번호와 내용은 체크박스와 같은 줄에 둡니다.',
      '- 체크박스는 반드시 "- [ ]" / "- [x]" 문법만 씁니다. □·☑ 같은 유니코드 문자는 절대 쓰지 않습니다(두레이에서 클릭이 안 됩니다).',
      '- "■ "로 시작하는 항목 제목들과 그 순서는 절대 바꾸지 않습니다. 빈 항목도 지우지 않습니다.',
      '- "■ 제약사항, 참고사항"의 각 원칙에는 "   * (예: ...)" 예시 줄이 붙는 형식을 유지합니다.',
      '',
      '다른 설명 없이 아래 형식으로만 출력하세요:',
      '[BODY]',
      '(고친 본문 전체)',
      '[/BODY]',
      '',
      '[현재 본문]',
      current
    ].join('\n')
    const { askClaude } = require('./mentionBot')
    const raw = await askClaude(prompt, { cwd: CLAUDE_WORKSPACE_ROOT, feature: 'task_body_from_doc', timeoutMs: 480_000 })
    const st = raw.indexOf('[BODY]')
    const en = raw.indexOf('[/BODY]')
    if (st === -1 || en === -1 || en <= st) return { ok: false, error: 'AI 초안 형식이 올바르지 않아요 — 다시 시도해주세요.' }
    const proposed = raw.slice(st + '[BODY]'.length, en).trim()
    if (!proposed) return { ok: false, error: 'AI 초안이 비어 있어요 — 다시 시도해주세요.' }
    return { ok: true, proposed }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// (2026-08-11 추가) 업무 본문 저장 (수기 수정 + AI 초안 승인 공용). 저장 전 미리보기·확인은
// 화면 쪽에서 끝내고 오므로 여기서는 바로 반영합니다.
ipcMain.handle('dooray:update-task-body', async (_event, { projectId, postId, content } = {}) => {
  try {
    if (!projectId || !postId) return { ok: false, error: '업무를 찾지 못했어요.' }
    if (content === undefined || content === null) return { ok: false, error: '본문 내용이 없어요.' }
    await doorayService.updatePostBody(projectId, postId, String(content))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// (2026-08-11 추가) AI 진행상황 반영 — 사용자의 한 줄 메모를 읽고 본문을 갱신한 "초안"만
// 만들어 돌려줍니다. 실제 저장은 사용자가 초안을 검토하고 저장을 눌러야만 일어납니다.
// (2026-08-12 변경) 초안 생성 로직을 함수로 분리 — 대시보드(IPC)와 채팅(@두레이봇의
// "진행상황 반영해줘")이 같은 규칙·같은 양식으로 같은 초안을 만들게 합니다.
async function proposeTaskBodyDraft(projectId, postId, progressNote) {
  try {
    if (!progressNote || !progressNote.trim()) return { ok: false, error: '진행 상황을 한 줄 적어주세요.' }
    const post = await doorayService.getPost(projectId, postId)
    const current = post?.body?.content || ''
    if (!current.trim()) return { ok: false, error: '본문이 비어 있어요 — 먼저 본문을 직접 작성해주세요.' }
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
    const todayLabel = `${String(kst.getUTCMonth() + 1).padStart(2, '0')}/${String(kst.getUTCDate()).padStart(2, '0')}`
    const prompt = [
      '당신은 업무 문서를 갱신하는 비서입니다. 아래 [현재 본문]을 [진행 상황]에 맞게 고친 전체 본문을 출력하세요.',
      '',
      '규칙:',
      '- 본문의 양식·구조·항목 순서를 그대로 유지합니다. 언급되지 않은 부분은 절대 바꾸지 않습니다.',
      `- 체크리스트(- [ ])는 진행 상황에서 끝났다고 분명히 말한 항목만 - [x]로 바꿉니다. 애매하면 그대로 둡니다.`,
      `- "■ 현재 상태" 같은 상태 칸이 있으면 진행 상황을 반영해 갱신하고, [최종 갱신 : MM/DD] 표기가 있으면 ${todayLabel}로 바꿉니다.`,
      '- "■ 다음 할 일"이 있고 진행 상황에 다음 계획이 언급됐으면 갱신합니다.',
      '- 확실하지 않은 내용을 지어내지 마세요.',
      '',
      '두레이 업무 양식 규칙 (이 팀의 고정 양식 — 반드시 지킬 것):',
      '- 체크리스트 줄은 "- [ ] 번호. 내용" 형태를 유지합니다. 번호와 내용은 체크박스와 같은 줄에 둡니다.',
      '- 체크박스는 반드시 "- [ ]" / "- [x]" 문법만 씁니다. □·☑ 같은 유니코드 문자는 절대 쓰지 않습니다(두레이에서 클릭이 안 됩니다).',
      '- "■ "로 시작하는 항목 제목들과 그 순서는 절대 바꾸지 않습니다. 빈 항목도 지우지 않습니다.',
      '- "■ 제약사항, 참고사항"의 각 원칙에는 "   * (예: ...)" 예시 줄이 붙는 형식을 유지합니다.',
      '',
      '다른 설명 없이 아래 형식으로만 출력하세요:',
      '[BODY]',
      '(고친 본문 전체)',
      '[/BODY]',
      '',
      '[진행 상황]',
      progressNote.trim(),
      '',
      '[현재 본문]',
      current
    ].join('\n')
    const { askClaude } = require('./mentionBot')
    const raw = await askClaude(prompt, { cwd: CLAUDE_WORKSPACE_ROOT, feature: 'task_body_update' })
    const s = raw.indexOf('[BODY]')
    const e = raw.indexOf('[/BODY]')
    if (s === -1 || e === -1 || e <= s) return { ok: false, error: 'AI 초안 형식이 올바르지 않아요 — 다시 시도해주세요.' }
    const proposed = raw.slice(s + '[BODY]'.length, e).trim()
    if (!proposed) return { ok: false, error: 'AI 초안이 비어 있어요 — 다시 시도해주세요.' }
    return { ok: true, proposed, current }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
ipcMain.handle('dooray:propose-task-body-update', async (_event, { projectId, postId, progressNote } = {}) => {
  return proposeTaskBodyDraft(projectId, postId, progressNote)
})

// (2026-08-11 추가) 업무 상세(본문+댓글) — "내 두레이 업무"에서 행을 클릭하면 앱 안에서 봅니다.
ipcMain.handle('dooray:get-task-detail', async (_event, { projectId, postId } = {}) => {
  try {
    if (!projectId || !postId) return { ok: false, error: '업무를 찾지 못했어요.' }
    const [post, comments] = await Promise.all([
      doorayService.getPost(projectId, postId),
      doorayService.listPostComments(projectId, postId).catch((err) => {
        log(`댓글 조회 실패(본문만 표시): ${err.message}`)
        return null // 댓글 조회가 실패해도 본문은 보여줌
      })
    ])
    // (2026-08-13) 속성 편집 UI용 필드 확장 + 내 댓글 판별
    let myIdForComments = ''
    try { myIdForComments = await getMyMemberId() } catch { /* 판별 실패 시 수정/삭제 버튼만 안 보임 */ }
    return {
      ok: true,
      subject: post?.subject || '',
      bodyContent: post?.body?.content || '',
      bodyMimeType: post?.body?.mimeType || 'text/x-markdown', // (2026-08-12) 렌더링 방식 결정용
      dueDate: post?.dueDate || null,
      workflowId: post?.workflow?.id || '', // (2026-08-12) 단계 드롭다운의 현재값 표시용
      workflowName: post?.workflow?.name || '',
      priority: post?.priority || 'none',
      milestoneId: post?.milestone?.id || '',
      milestoneName: post?.milestone?.name || '',
      tagIds: (post?.tags || []).map((t) => String(t.id || t.tagId || '')).filter(Boolean),
      toNames: (post?.users?.to || []).map((u) => u?.member?.name).filter(Boolean),
      ccNames: (post?.users?.cc || []).map((u) => u?.member?.name).filter(Boolean),
      files: (post?.files || []).map((f) => ({ id: f.id, name: f.name || f.fileName || '파일', size: f.size || 0 })),
      comments: comments === null ? null : comments.map((c) => ({ ...c, isMine: !!myIdForComments && c.creatorId === myIdForComments }))
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:add-task-comment', async (_event, { projectId, postId, content } = {}) => {
  try {
    if (!content || !content.trim()) return { ok: false, error: '댓글 내용을 적어주세요.' }
    await doorayService.addPostComment(projectId, postId, content.trim())
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// (2026-08-12 추가) 업무 단계(워크플로) 조회/변경 — "내 두레이 업무" 상세의 단계 드롭다운용.
ipcMain.handle('dooray:get-task-workflows', async (_event, { projectId } = {}) => {
  try {
    if (!projectId) return { ok: false, error: '프로젝트를 찾지 못했어요.' }
    return { ok: true, workflows: await doorayService.listProjectWorkflows(projectId) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
ipcMain.handle('dooray:set-task-workflow', async (_event, { projectId, postId, workflowId } = {}) => {
  try {
    if (!projectId || !postId || !workflowId) return { ok: false, error: '바꿀 단계를 찾지 못했어요.' }
    await doorayService.setTaskWorkflow(projectId, postId, workflowId)
    invalidateMyTasksCache() // 목록/홈 카드에 새 단계가 바로 보이게
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// (2026-08-13 추가) 업무 속성 일괄 변경 — 제목/우선순위/태그/마일스톤/참조자·담당자 추가/기한.
ipcMain.handle('dooray:update-task-meta', async (_event, { projectId, postId, changes } = {}) => {
  try {
    if (!projectId || !postId || !changes || typeof changes !== 'object') {
      return { ok: false, error: '바꿀 내용을 찾지 못했어요.' }
    }
    await doorayService.updatePostMeta(projectId, postId, changes)
    invalidateMyTasksCache()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
ipcMain.handle('dooray:get-task-milestones', async (_event, { projectId } = {}) => {
  try {
    if (!projectId) return { ok: false, error: '프로젝트를 찾지 못했어요.' }
    return { ok: true, milestones: await doorayService.listProjectMilestones(projectId) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
ipcMain.handle('dooray:update-task-comment', async (_event, { projectId, postId, logId, content } = {}) => {
  try {
    if (!content || !content.trim()) return { ok: false, error: '댓글 내용을 적어주세요.' }
    await doorayService.updatePostComment(projectId, postId, logId, content.trim())
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
ipcMain.handle('dooray:delete-task-comment', async (_event, { projectId, postId, logId } = {}) => {
  try {
    if (!projectId || !postId || !logId) return { ok: false, error: '댓글을 찾지 못했어요.' }
    await doorayService.deletePostComment(projectId, postId, logId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
ipcMain.handle('dooray:download-task-file', async (_event, { projectId, postId, fileId, fileName } = {}) => {
  try {
    if (!projectId || !postId || !fileId) return { ok: false, error: '파일을 찾지 못했어요.' }
    const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() || undefined, {
      title: '첨부파일 저장',
      defaultPath: path.join(app.getPath('downloads'), fileName || '첨부파일')
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    await doorayService.downloadPostFileToPath(projectId, postId, fileId, result.filePath)
    shell.showItemInFolder(result.filePath)
    return { ok: true, filePath: result.filePath }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// (2026-08-11 추가) 대시보드 "빠른 업무 생성" — 자연어 한 줄을 AI가 템플릿에 채워
// 미리보기를 만들고(preview), 사용자가 확인을 누르면 그때만 실제로 생성(create)합니다.
// 채팅방 자동화(runTaskAutomation)와 같은 채움 로직을 쓰되, 즉시 생성하지 않는 점만 다릅니다.
const quickTaskPreviews = new Map() // previewId -> { rule, subject, body, dueDate, madeAt }

// (2026-08-11 개편) 원래는 "채팅방 자동 연결" 규칙이 있어야만 쓸 수 있었는데, 대시보드에서만
// 쓰고 싶은 사람도 억지로 규칙을 만들어야 하는 이상한 의존이었습니다(실사용 지적). 이제
// 프로젝트·템플릿을 직접 받습니다. 같은 프로젝트·템플릿의 자동화 규칙이 있으면 그 규칙의
// 부가 설정(제목 접두사·기본 담당자·참조·태그)을 덤으로 가져다 씁니다.
ipcMain.handle('dooray:preview-quick-task', async (_event, { projectId, templateId, text } = {}) => {
  try {
    if (!text || !text.trim()) return { ok: false, error: '업무 내용을 적어주세요.' }
    if (!projectId || !templateId) return { ok: false, error: '프로젝트와 템플릿을 골라주세요.' }
    const cfg = loadConfig()
    const rule = (cfg.automations || []).find((a) => a.projectId === projectId && a.templateId === templateId)
      || { projectId, templateId, subjectPrefix: '' }
    const detail = await doorayService.getTemplateDetail(rule.projectId, rule.templateId)
    const preview = await buildQuickTaskPreview({ rule, detail, text: text.trim(), cfg })
    const previewId = `qt-${Date.now()}`
    quickTaskPreviews.set(previewId, { rule, ...preview, madeAt: Date.now() })
    // 오래된 미리보기는 정리 (10분)
    for (const [id, p] of quickTaskPreviews) {
      if (Date.now() - p.madeAt > 10 * 60 * 1000) quickTaskPreviews.delete(id)
    }
    return { ok: true, previewId, subject: preview.subject, body: preview.body, dueDate: preview.dueDate || null, projectLabel: rule.projectLabel || rule.projectId, templateLabel: rule.templateLabel || '' }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// AI 채움 부분만 떼어낸 도우미 — taskAutomation.js의 프롬프트 구성 요소를 재사용하기 위해
// runTaskAutomation과 같은 형식의 지시문을 직접 만들지 않고, 대화 맥락 자리에 사용자의
// 한 줄 입력을 넣어 같은 경로(runTaskAutomation의 채움 프롬프트)를 통과시킵니다.
async function buildQuickTaskPreview({ rule, detail, text, cfg }) {
  const { buildFillPromptForQuickTask } = require('./taskAutomation')
  const prompt = buildFillPromptForQuickTask({
    templateSubject: detail.subject,
    templateBody: detail.bodyContent,
    subjectPrefix: rule.subjectPrefix,
    userText: text,
    teamName: cfg.myTeamName || '',
    staffName: cfg.myStaffName || ''
  })
  const { askClaude } = require('./mentionBot')
  const raw = await askClaude(prompt, { cwd: CLAUDE_WORKSPACE_ROOT, feature: 'quick_task_preview' })
  const { parseFilledForQuickTask } = require('./taskAutomation')
  const filled = parseFilledForQuickTask(raw)
  const prefix = (rule.subjectPrefix || '').trim()
  const suffix = (filled.subjectSuffix || '').trim()
  return {
    subject: [prefix, suffix].filter(Boolean).join(' ') || detail.subject,
    body: filled.body || detail.bodyContent || '',
    dueDate: filled.dueDate ? `${filled.dueDate}T18:00:00+09:00` : undefined
  }
}

ipcMain.handle('dooray:create-quick-task', async (_event, { previewId, subject, body } = {}) => {
  try {
    const p = quickTaskPreviews.get(previewId)
    if (!p) return { ok: false, error: '미리보기가 만료됐어요 (10분). 다시 만들어주세요.' }
    quickTaskPreviews.delete(previewId)
    // 사용자가 미리보기 화면에서 제목/본문을 고쳤으면 고친 값을 우선합니다.
    const post = await doorayService.createFromTemplate(p.rule.projectId, p.rule.templateId, {
      subject: (subject || p.subject || '').trim() || p.subject,
      body: (body !== undefined && body !== null) ? body : p.body,
      assigneeId: p.rule.defaultAssigneeId || undefined,
      dueDate: p.dueDate,
      ccMemberIds: p.rule.ccMemberIds,
      tagIds: p.rule.tagIds
    })
    const cfg = loadConfig()
    const taskUrl = cfg.doorayDomain && post?.id ? `https://${cfg.doorayDomain}/project/tasks/${post.id}` : null
    myTasksCache = { at: 0, tasks: null } // 새 업무가 목록에 바로 보이게 캐시 비움
    return { ok: true, taskUrl, subject: post?.subject || subject }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// (2026-08-11 추가) 내 두레이 업무 목록 — 프로젝트 수만큼 API를 부르므로 3분 캐시를 둡니다.
const TASKS_CACHE_PATH = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'cache', 'my-tasks.json')
function loadTasksCacheFile() {
  try { return JSON.parse(fs.readFileSync(TASKS_CACHE_PATH, 'utf-8')) } catch { return null }
}
function saveTasksCacheFile(tasks) {
  try {
    fs.mkdirSync(path.dirname(TASKS_CACHE_PATH), { recursive: true })
    fs.writeFileSync(TASKS_CACHE_PATH, JSON.stringify({ at: Date.now(), tasks }), 'utf-8')
  } catch { /* 캐시 저장 실패는 무시 */ }
}
let myTasksCache = { at: 0, tasks: null }
// (2026-08-11 추가) 조회가 이미 도는 중이면 새로 시작하지 않고 그 결과를 같이 기다립니다.
// 홈 카드와 서브탭이 거의 동시에 부르면 같은 전체 조회가 두 번 돌았습니다 (429 사고의 절반).
let myTasksInflight = null
// (2026-08-11 추가) 채팅으로 업무를 완료 처리한 직후 mentionBot이 불러서, 홈/할 일 탭에
// 방금 완료한 업무가 3분간 계속 보이는 일이 없게 합니다.
function invalidateMyTasksCache() { myTasksCache = { at: 0, tasks: null } }
const MY_TASKS_CACHE_MS = 3 * 60 * 1000
ipcMain.handle('dooray:get-my-tasks', async (_event, { forceRefresh } = {}) => {
  try {
    if (!forceRefresh && myTasksCache.tasks && Date.now() - myTasksCache.at < MY_TASKS_CACHE_MS) {
      return { ok: true, tasks: myTasksCache.tasks, cached: true }
    }
    if (myTasksInflight) {
      const tasks = await myTasksInflight
      return { ok: true, tasks, cached: true }
    }
    const refresh = () => {
      myTasksInflight = (async () => {
        const myId = await getMyMemberId()
        const tasks = await doorayService.listMyTasks(myId, { log })
        myTasksCache = { at: Date.now(), tasks }
        saveTasksCacheFile(tasks) // 다음 실행의 첫 화면용으로 보존 (2026-08-12)
        return tasks
      })()
      myTasksInflight.finally(() => { myTasksInflight = null })
      return myTasksInflight
    }
    // (2026-08-12 추가) 첫 로드 체감 개선: 지난 실행에서 저장해둔 목록이 있으면 그걸 먼저
    // 돌려주고(즉시 표시), 실제 갱신은 뒤에서 돌립니다. 화면이 stale 표시를 보고 갱신이
    // 끝나면 다시 불러 최신으로 바꿉니다.
    if (!forceRefresh) {
      const disk = loadTasksCacheFile()
      if (disk && Array.isArray(disk.tasks)) {
        refresh().catch((err) => log(`내 업무 배경 갱신 실패: ${err.message}`))
        return { ok: true, tasks: disk.tasks, stale: true, staleAt: disk.at }
      }
    }
    return { ok: true, tasks: await refresh() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// (2026-08-11 추가) 자주 쓰는 프롬프트 — 채팅 탭에서 저장/재사용
ipcMain.handle('dooray:get-prompts', async () => {
  try { return { ok: true, prompts: promptStore.listPrompts() } }
  catch (err) { return { ok: false, error: err.message } }
})
ipcMain.handle('dooray:add-prompt', async (_event, { title, text } = {}) => {
  try { return { ok: true, prompt: promptStore.addPrompt({ title, text }) } }
  catch (err) { return { ok: false, error: err.message } }
})
ipcMain.handle('dooray:remove-prompt', async (_event, { id } = {}) => {
  try { return { ok: promptStore.removePrompt(id) } }
  catch (err) { return { ok: false, error: err.message } }
})

// (2026-08-11 추가) 채팅방 이름 수동 지정 — 빈 문자열을 주면 지정 해제.
ipcMain.handle('dooray:set-channel-label', async (_event, { channelId, label } = {}) => {
  try {
    if (!channelId) return { ok: false, error: '채팅방을 찾지 못했어요.' }
    const c = loadConfig()
    const overrides = { ...(c.channelLabelOverrides || {}) }
    const trimmed = (label || '').trim()
    if (trimmed) overrides[channelId] = trimmed
    else delete overrides[channelId]
    c.channelLabelOverrides = overrides
    saveConfig(c)
    config = c
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// (2026-08-10 추가) 채팅방 탭의 "아침 브리핑" 토글
ipcMain.handle('dooray:toggle-briefing-channel', async (_event, { channelId, enabled }) => {
  const c = loadConfig()
  const set = new Set(c.briefingChannels || [])
  if (enabled) set.add(channelId)
  else set.delete(channelId)
  c.briefingChannels = Array.from(set)
  saveConfig(c)
  config = c
  return { ok: true }
})

// (2026-08-10 추가) 아침 브리핑 시각 저장 + 지금 바로 보내보기(미리보기 겸 테스트)
ipcMain.handle('dooray:save-briefing-time', async (_event, { hour, minute } = {}) => {
  try {
    const c = loadConfig()
    const h = Number(hour); const m = Number(minute)
    if (!Number.isInteger(h) || h < 0 || h > 23) return { ok: false, error: '시(hour)는 0~23 사이여야 해요.' }
    if (!Number.isInteger(m) || m < 0 || m > 59) return { ok: false, error: '분(minute)은 0~59 사이여야 해요.' }
    c.briefingHour = h
    c.briefingMinute = m
    saveConfig(c)
    config = c
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:post-briefing-now', async (_event, { channelId } = {}) => {
  try {
    if (!channelId) return { ok: false, error: '채팅방을 먼저 고르세요.' }
    await postBriefingNow(channelId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:get-todo-cards', async (_event, { channelId }) => {
  return { ok: true, cards: todoStore.listCards(channelId) }
})

// 메일함 [요청] 자동 반영 토글 (채팅방 단위). 메일 알림 설정과는 별개입니다 — 메일
// 요청이 다른 방으로 알림가고 있어도, 이 투두방에 반영할지는 이 방에서 따로 켜고 끕니다.
ipcMain.handle('dooray:get-todo-mail-sync', async (_event, { channelId }) => {
  const c = loadConfig()
  return { ok: true, enabled: (c.todoMailSyncChannels || []).includes(channelId) }
})

ipcMain.handle('dooray:toggle-todo-mail-sync', async (_event, { channelId, enabled }) => {
  const c = loadConfig()
  const set = new Set(c.todoMailSyncChannels || [])
  if (enabled) set.add(channelId)
  else set.delete(channelId)
  c.todoMailSyncChannels = Array.from(set)
  saveConfig(c)
  config = c
  // 토글을 켤 때는 드물게 일어나는 의도적인 조작이라(드래그처럼 연달아 일어나지 않음),
  // 디바운스 없이 바로 게시해서 메일함 요청이 즉시 반영된 걸 보여줍니다.
  if (enabled) {
    try {
      await postTodoListNow(channelId)
    } catch (err) {
      log(`메일 동기화 켠 뒤 게시 실패 (channelId=${channelId}): ${err.message}`)
    }
  }
  return { ok: true }
})

// ---- 공유 투두리스트: 태그(사람별/업무 성격별 구분) ------------------------

ipcMain.handle('dooray:get-todo-tags', async (_event, { channelId }) => {
  return { ok: true, tags: todoTagStore.listTags(channelId) }
})

ipcMain.handle('dooray:add-todo-tag', async (_event, { channelId, name }) => {
  if (!channelId || !(name || '').trim()) return { ok: false, error: '태그 이름을 입력해주세요.' }
  todoTagStore.addTag({ channelId, name })
  return { ok: true, tags: todoTagStore.listTags(channelId) }
})

ipcMain.handle('dooray:remove-todo-tag', async (_event, { id, channelId }) => {
  todoTagStore.removeTag(id)
  await repostTodoQuietly(channelId)
  return { ok: true, tags: todoTagStore.listTags(channelId) }
})

ipcMain.handle('dooray:set-todo-card-tag', async (_event, { id, channelId, tagId }) => {
  todoStore.setTag(id, tagId || null)
  await repostTodoQuietly(channelId)
  return { ok: true, cards: todoStore.listCards(channelId) }
})

// 할 일 내용(문구) 자체를 고칩니다 — 채팅 "OO를 XX로 바꿔줘"와 같은 동작을 대시보드
// 카드의 "수정" 버튼으로도 할 수 있게 함.
ipcMain.handle('dooray:set-todo-card-text', async (_event, { id, channelId, text }) => {
  if (!(text || '').trim()) return { ok: false, error: '내용을 입력해주세요.' }
  todoStore.setText(id, text)
  await repostTodoQuietly(channelId)
  return { ok: true, cards: todoStore.listCards(channelId) }
})

// 서브태그(매체: 메타/구글/카카오 등)는 평소엔 AI가 새 할 일 등록 시 자동으로 붙이지만,
// 대시보드에서 사람이 직접 골라 바꿀 수도 있습니다 — 태그와 같은 구조의 IPC입니다.
ipcMain.handle('dooray:get-todo-subtags', async (_event, { channelId }) => {
  return { ok: true, subTags: todoSubTagStore.listSubTags(channelId) }
})

// 평소엔 AI가 채팅에서 자동으로 매체를 만들지만, 사람이 대시보드에서 직접 새 매체를
// 만들고 싶을 때도 있어서(태그 만들기와 같은 방식) 이 IPC를 추가합니다.
ipcMain.handle('dooray:add-todo-subtag', async (_event, { channelId, name }) => {
  if (!channelId || !(name || '').trim()) return { ok: false, error: '매체 이름을 입력해주세요.' }
  todoSubTagStore.addSubTag({ channelId, name })
  return { ok: true, subTags: todoSubTagStore.listSubTags(channelId) }
})

// 매체 별칭 관리 — "브검"처럼 매체명이 텍스트에 그대로 안 적히는 경우를 위해, 사람이
// 미리 "이 단어가 나오면 이 매체다"라고 등록해두는 규칙입니다. 채팅으로 새 할 일이 등록될 때
// 이 별칭 목록도 같이 확인해서 매체를 자동으로 붙여줍니다(todoSubTagStore.findSubTagByName 참고).
ipcMain.handle('dooray:add-todo-subtag-alias', async (_event, { channelId, subTagId, alias }) => {
  if (!subTagId || !(alias || '').trim()) return { ok: false, error: '별칭을 입력해주세요.' }
  todoSubTagStore.addAlias(subTagId, alias)
  return { ok: true, subTags: todoSubTagStore.listSubTags(channelId) }
})

ipcMain.handle('dooray:remove-todo-subtag-alias', async (_event, { channelId, subTagId, alias }) => {
  todoSubTagStore.removeAlias(subTagId, alias)
  return { ok: true, subTags: todoSubTagStore.listSubTags(channelId) }
})

ipcMain.handle('dooray:set-todo-card-subtag', async (_event, { id, channelId, subTagId }) => {
  todoStore.setSubTag(id, subTagId || null)
  await repostTodoQuietly(channelId)
  return { ok: true, cards: todoStore.listCards(channelId) }
})

// 캘린더에서 카드를 다른 날짜 칸으로 끌어다 놓았을 때 예정일을 바꿉니다.
ipcMain.handle('dooray:set-todo-card-duedate', async (_event, { id, channelId, dueDate }) => {
  todoStore.setDueDate(id, dueDate || null)
  await repostTodoQuietly(channelId)
  return { ok: true, cards: todoStore.listCards(channelId) }
})

// 완료 히스토리를 매체별 시트로 나눈 엑셀 파일로 내보냅니다. 저장 위치는 사람이 직접
// 고르고(다른 이름으로 저장 창), 끝나면 탐색기에서 그 파일이 바로 보이게 열어줍니다.
ipcMain.handle('dooray:export-todo-history', async (_event, { channelId }) => {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() || undefined, {
      title: '완료 히스토리 엑셀로 내보내기',
      defaultPath: path.join(app.getPath('documents'), `투두_히스토리_${today}.xlsx`),
      filters: [{ name: 'Excel 파일', extensions: ['xlsx'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    await todoHistoryStore.exportToExcel({
      channelId,
      outputPath: result.filePath,
      appDir: app.getAppPath(),
      log
    })
    shell.showItemInFolder(result.filePath)
    return { ok: true, filePath: result.filePath }
  } catch (err) {
    log(`히스토리 엑셀 내보내기 실패: ${err.message}`)
    return { ok: false, error: err.message }
  }
})

// 캘린더 화면용: 이 채팅방의 모든 카드(완료 포함, dueDate/forDate 상관없이 전부)를 돌려주고,
// 화면에서 날짜별로 직접 묶어서 표시합니다. listCards(channelId)는 dateIso를 안 주면
// 예정된 것까지 전부 돌려주므로(관리용 전체 보기), 캘린더에 딱 맞습니다.
ipcMain.handle('dooray:get-todo-calendar-cards', async (_event, { channelId }) => {
  return { ok: true, cards: todoStore.listCards(channelId) }
})

// 대시보드에서 카드를 추가/체크/삭제/태그 변경할 때마다 매번 바로 채팅방에 다시 올리면,
// 예를 들어 드래그로 태그를 이것저것 옮겨보는 동안 메시지가 너무 자주(연달아) 올라오는
// 문제가 있었습니다. 그래서 마지막 변경 후 30초 동안 추가 변경이 없을 때 한 번만 실제
// 채팅방에 올리도록 미룹니다(디바운스). 그동안에도 대시보드 화면 자체는 todoStore 값이
// 바로 바뀌어서 즉시 최신으로 보이니, 화면상 불편함은 없습니다.
// (2026-08-13 단축) 30초 → 5초. 연달아 바꾸는 조작(드래그 등)만 묶으면 되지,
// 카드 하나 체크한 게 채팅방에 30초 뒤에야 보이는 건 "연동이 느리다"로 느껴집니다(실사용 피드백).
const REPOST_DEBOUNCE_MS = 5 * 1000
const repostDebounceTimers = new Map() // channelId -> timeout handle

function repostTodoQuietly(channelId) {
  const existing = repostDebounceTimers.get(channelId)
  if (existing) clearTimeout(existing)
  repostDebounceTimers.set(channelId, setTimeout(() => {
    repostDebounceTimers.delete(channelId)
    postTodoListNow(channelId).catch((err) => log(`대시보드 변경 반영 재게시 실패 (channelId=${channelId}): ${err.message}`))
  }, REPOST_DEBOUNCE_MS))
}

ipcMain.handle('dooray:add-todo-card', async (_event, { channelId, text, dueDate }) => {
  if (!channelId || !(text || '').trim()) return { ok: false, error: '채팅방/내용이 필요합니다.' }
  todoStore.addCard({ channelId, text, dueDate: dueDate || null })
  await repostTodoQuietly(channelId)
  return { ok: true, cards: todoStore.listCards(channelId) }
})

ipcMain.handle('dooray:set-todo-card-status', async (_event, { id, channelId, status }) => {
  // 대시보드 체크박스로 완료 처리할 때도, 채팅으로 완료 보고했을 때와 똑같이 히스토리에
  // 기록을 남깁니다 (완료 → 다른 상태로 되돌리는 경우는 기록하지 않습니다).
  if (status === 'done') {
    const card = todoStore.listCards(channelId).find((c) => c.id === id)
    if (card && card.status !== 'done') {
      try {
        const tags = todoTagStore.listTags(channelId)
        const subTags = todoSubTagStore.listSubTags(channelId)
        todoHistoryStore.appendHistory({
          channelId,
          cardId: id,
          text: card.text,
          tagName: card.tagId ? tags.find((t) => t.id === card.tagId)?.name || null : null,
          subTagName: card.subTagId ? subTags.find((t) => t.id === card.subTagId)?.name || null : null,
          createdAt: card.createdAt,
          completedAt: Date.now()
        })
      } catch (err) {
        log(`완료 히스토리 기록 실패: ${err.message}`)
      }
    }
  }
  todoStore.setStatus(id, status)
  await repostTodoQuietly(channelId)
  return { ok: true, cards: todoStore.listCards(channelId) }
})

ipcMain.handle('dooray:remove-todo-card', async (_event, { id, channelId }) => {
  todoStore.removeCard(id)
  await repostTodoQuietly(channelId)
  return { ok: true, cards: todoStore.listCards(channelId) }
})

ipcMain.handle('dooray:get-todo-templates', async (_event, { channelId }) => {
  return { ok: true, templates: todoTemplateStore.listTemplates(channelId) }
})

ipcMain.handle('dooray:add-todo-template', async (_event, { channelId, text, cycle, startDate, endDate, tagId }) => {
  if (!channelId || !(text || '').trim()) return { ok: false, error: '정보가 부족합니다.' }
  if ((cycle === 'weekly' || cycle === 'monthly' || cycle === 'once') && !startDate) {
    return { ok: false, error: '이 주기는 기준일(날짜)이 필요합니다.' }
  }
  todoTemplateStore.addTemplate({ channelId, text, cycle, startDate, endDate, tagId: tagId || null })
  return { ok: true, templates: todoTemplateStore.listTemplates(channelId) }
})

ipcMain.handle('dooray:remove-todo-template', async (_event, { id, channelId }) => {
  todoTemplateStore.removeTemplate(id)
  return { ok: true, templates: todoTemplateStore.listTemplates(channelId) }
})

// 9시를 기다리지 않고 지금 바로 게시해보는 테스트 버튼용.
ipcMain.handle('dooray:post-todo-list-now', async (_event, { channelId }) => {
  try {
    await postTodoListNow(channelId)
    return { ok: true, cards: todoStore.listCards(channelId) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 채팅방을 먼저 고르지 않고, "기록 저장"이 켜진 모든 채팅방을 한 번에 검색합니다.
// (어떤 채팅방에서 그 말을 했는지 기억이 안 날 때를 위한 용도)
ipcMain.handle('dooray:search-history-all', async (_event, { query }) => {
  try {
    const messages = searchAllChannels(query)
    let labels = {}
    try {
      const myId = await getMyMemberId()
      const channelIds = Array.from(new Set(messages.map((m) => m.channelId)))
      labels = await doorayService.getChannelLabels(channelIds, myId)
    } catch (err) {
      log(`검색 결과 채팅방 이름 조회 실패 (숫자 ID로 표시됩니다): ${err.message}`)
    }
    const withLabels = messages.map((m) => ({ ...m, channelLabel: labels[m.channelId] || m.channelId }))
    return { ok: true, messages: withLabels, totalStored: countAllMessages() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:test-connection', async () => {
  try {
    const res = await doorayClient.request('/common/v1/members/me')
    return { ok: true, memberName: res.result?.name || res.result?.userName || '' }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:reconnect', async () => {
  startBot()
  return { ok: true }
})

// ---- 템플릿 탭: 프로젝트/템플릿 조회, 템플릿으로 업무 생성 --------------------

ipcMain.handle('dooray:list-projects', async () => {
  try {
    return { ok: true, projects: await doorayService.listProjects() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:list-templates', async (_event, projectId) => {
  try {
    return { ok: true, templates: await doorayService.listTemplates(projectId) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:get-template-detail', async (_event, { projectId, templateId }) => {
  try {
    return { ok: true, detail: await doorayService.getTemplateDetail(projectId, templateId) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:create-from-template', async (_event, { projectId, templateId, subject, body, assigneeId, ccMemberIds, tagIds }) => {
  try {
    // 제목이 비어 있으면 두레이 서버가 "Subject code can not be empty" 같은 알기 어려운
    // 오류로 튕겨내므로, 여기서 먼저 확인해 이해하기 쉬운 문구로 알려줍니다.
    if (!(subject || '').trim()) {
      return { ok: false, error: '제목을 입력해주세요.' }
    }
    const post = await doorayService.createFromTemplate(projectId, templateId, {
      subject, body, assigneeId, ccMemberIds, tagIds
    })
    log(`템플릿으로 업무 생성됨 (projectId=${projectId}, templateId=${templateId})`)
    return { ok: true, post }
  } catch (err) {
    log(`템플릿 업무 생성 실패: ${err.message}`)
    return { ok: false, error: err.message }
  }
})

// ---- 자동화 탭: 채팅방 + 프로젝트 + 템플릿 연결 규칙 관리 ------------------

ipcMain.handle('dooray:get-automations', async () => {
  const c = loadConfig()
  return { ok: true, automations: c.automations || [] }
})

ipcMain.handle('dooray:add-automation', async (_event, {
  channelId, channelLabel, projectId, projectLabel, templateId, templateLabel,
  subjectPrefix, defaultAssigneeId, defaultAssigneeLabel,
  ccMemberIds, ccMemberLabels, tagIds, tagLabels
}) => {
  try {
    const c = loadConfig()
    const list = c.automations || []
    // 채팅방 하나에는 규칙 하나만 (이미 있으면 덮어씀)
    const filtered = list.filter((a) => a.channelId !== channelId)
    filtered.push({
      id: `${channelId}:${Date.now()}`,
      channelId,
      channelLabel,
      projectId,
      projectLabel,
      templateId,
      templateLabel,
      subjectPrefix: subjectPrefix || '',
      defaultAssigneeId: defaultAssigneeId || '',
      defaultAssigneeLabel: defaultAssigneeLabel || '',
      ccMemberIds: ccMemberIds || [],
      ccMemberLabels: ccMemberLabels || [],
      tagIds: tagIds || [],
      tagLabels: tagLabels || []
    })
    c.automations = filtered
    saveConfig(c)
    config = c
    return { ok: true, automations: filtered }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 자동화 규칙 설정 화면에서 태그 체크박스 목록을 보여줄 때 사용
ipcMain.handle('dooray:list-project-tags', async (_event, projectId) => {
  try {
    return { ok: true, tags: await doorayService.listProjectTags(projectId) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 자동화 규칙 설정 화면에서 담당자/참고를 이름으로 검색할 때 사용
ipcMain.handle('dooray:search-members', async (_event, name) => {
  try {
    // (2026-08-13) 동명이인이면 nhnad(우리 회사) 계정이 먼저 오게 정렬 — 화면들이 공통으로 씁니다.
    const sorted = doorayService.sortMembersNhnadFirst(await doorayService.searchMembersByName(name))
    return { ok: true, members: sorted.map((m) => ({ ...m, isNhnad: doorayService.isNhnadMember(m) })) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:remove-automation', async (_event, { id }) => {
  try {
    const c = loadConfig()
    c.automations = (c.automations || []).filter((a) => a.id !== id)
    saveConfig(c)
    config = c
    return { ok: true, automations: c.automations }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ---- 캘린더 탭: 내 캘린더 목록/일정 조회/일정 등록 ------------------------
// (프로젝트 캘린더는 두레이가 아직 API로 안 열어서, 지금은 개인 캘린더만 나옵니다)

ipcMain.handle('dooray:list-calendars', async () => {
  try {
    return { ok: true, calendars: await doorayService.listCalendars() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:list-events', async (_event, { calendarIds, timeMin, timeMax }) => {
  try {
    return { ok: true, events: await doorayService.listEvents({ calendarIds, timeMin, timeMax }) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:create-calendar-event', async (_event, { calendarId, subject, startedAt, endedAt, wholeDayFlag, location, attendeeIds }) => {
  try {
    const event = await doorayService.createEvent({ calendarId, subject, startedAt, endedAt, wholeDayFlag, location, attendeeIds })
    log(`캘린더 일정 등록됨 (calendarId=${calendarId}, subject=${subject}${attendeeIds && attendeeIds.length ? `, 참석자 ${attendeeIds.length}명` : ''})`)
    return { ok: true, event }
  } catch (err) {
    log(`캘린더 일정 등록 실패: ${err.message}`)
    return { ok: false, error: err.message }
  }
})

// 캘린더 화면에서 일정을 날짜 칸으로 드래그해서 옮길 때 씀 (제목/장소는 그대로 두고
// 시작/종료 시각만 바꿔서 다시 저장).
// (2026-08-10 추가) 캘린더 일정 삭제 — 날짜 상세 목록의 삭제 버튼용
ipcMain.handle('dooray:delete-calendar-event', async (_event, { calendarId, eventId } = {}) => {
  try {
    await doorayService.deleteEvent({ calendarId, eventId })
    log(`캘린더 일정 삭제됨 (eventId=${eventId})`)
    return { ok: true }
  } catch (err) {
    log(`캘린더 일정 삭제 실패: ${err.message}`)
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:update-calendar-event', async (_event, { calendarId, eventId, subject, startedAt, endedAt, location, wholeDayFlag }) => {
  try {
    const event = await doorayService.updateEvent({ calendarId, eventId, subject, startedAt, endedAt, location, wholeDayFlag })
    log(`캘린더 일정 이동됨 (subject=${subject})`)
    return { ok: true, event }
  } catch (err) {
    log(`캘린더 일정 이동 실패: ${err.message}`)
    return { ok: false, error: err.message }
  }
})

// ---- 메일 탭: 저장된 메일 조회/필터, 폴더 허용목록, AI 요약 --------------------

ipcMain.handle('dooray:get-mail-folders', async () => {
  try {
    return { ok: true, folders: mailStore.listKnownFolders() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ---- 메일 탭: 메일함 (실제 메일 원문을 여기서 바로 읽기) ----------------------
// 두레이 웹메일을 새로 열지 않아도, 저장해둔 메일 전문을 이 프로그램 안에서 바로 볼 수
// 있게 해줍니다. 왼쪽 목록(폴더/보낸사람/제목/기간 필터) + 오른쪽 전문 보기 구조입니다.

ipcMain.handle('dooray:list-saved-mail', async (_event, { folderName, from, subject, dateFrom, dateTo, limit } = {}) => {
  try {
    const mails = mailStore.listMails({ folderName, from, subject, dateFrom, dateTo }, limit)
    return {
      ok: true,
      mails: mails.map((m) => ({
        id: m.id,
        subject: m.subject,
        fromName: m.fromName,
        fromEmail: m.fromEmail,
        folderName: m.folderName,
        sentAt: m.sentAt
      }))
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 저장 안 하기로 한 폴더도 지금 두레이에서 즉시 조회합니다(허용목록 무시, 저장하지 않음).
// 최근 활동 스트림(최근 2주치)을 계속 페이지 넘겨가며 요청한 폴더에 해당하는 것만 모읍니다.
ipcMain.handle('dooray:list-live-mail', async (_event, { folderName } = {}) => {
  try {
    let before
    const matched = []
    for (let page = 0; page < 50 && matched.length < 300; page++) {
      const { mails, cursor } = await doorayService.fetchMailStreamPage({ before, size: 50 })
      if (!mails.length) break
      for (const m of mails) {
        if (folderName && m.folderName !== folderName) continue
        matched.push(m)
        liveMailCache.set(m.id, m)
      }
      if (!cursor) break
      before = cursor
    }
    matched.sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))
    return {
      ok: true,
      mails: matched.map((m) => ({
        id: m.id,
        subject: m.subject,
        fromName: m.fromName,
        fromEmail: m.fromEmail,
        folderName: m.folderName,
        sentAt: m.sentAt
      }))
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:get-mail-detail', async (_event, { id } = {}) => {
  try {
    const mail = mailStore.getMailById(id) || liveMailCache.get(id)
    if (!mail) return { ok: false, error: '메일을 찾지 못했습니다 (삭제되었거나 저장 기간이 지났을 수 있어요).' }
    const cfg = loadConfig()
    const mailUrl = cfg.doorayDomain ? `https://${cfg.doorayDomain}/mail/folders/${mail.folderId}/${mail.id}` : ''

    // 두레이 API가 주는 본문은 미리보기 일부뿐이라, IMAP이 켜져 있고 아직 전문을 안
    // 받아온 메일이면 지금 IMAP에서 원문을 찾아와 저장합니다 (메일당 딱 한 번).
    const r = await ensureMailFullBody(mail, cfg)
    const imapNote = r.ok ? '' : r.error

    return {
      ok: true,
      mail: {
        id: mail.id,
        subject: mail.subject,
        fromName: mail.fromName,
        fromEmail: mail.fromEmail,
        folderName: mail.folderName,
        sentAt: mail.sentAt,
        bodyMimeType: mail.bodyMimeType || 'text/plain',
        bodyContent: mail.bodyContent || '',
        bodyFull: !!mail.bodyFull,
        imapEnabled: !!cfg.imapEnabled,
        imapNote,
        mailUrl,
        isManualTodo: !!mailSummaryCache.getManualTodo(mail.id)
      }
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 메일함에서 메일을 열었을 때 보여줄 AI 요약. 도착 알림이나 폴더별 정리 때 이미 요약해둔
// 적이 있으면 그걸 그대로 재사용하고(같은 메일 두 번 요약 안 함), 없으면 지금 새로 만들어
// 캐시에 저장합니다 — 이렇게 저장된 건 나중에 폴더별 정리에서도 재사용됩니다.
// 본문(dooray:get-mail-detail)과 별도 호출로 분리해서, 본문은 바로 보여주고 요약은
// 뒤늦게 채워지도록 합니다 (AI 응답을 기다리느라 본문 읽기가 늦어지지 않게).
const mailSummaryInflight = new Map()
ipcMain.handle('dooray:get-mail-summary', async (_event, { id, forceRefresh } = {}) => {
  // 재요약(forceRefresh) 요청은 캐시를 무시해야 하므로 진행 중인 것과 별도로 처리합니다.
  if (!forceRefresh && mailSummaryInflight.has(id)) return mailSummaryInflight.get(id)
  const promise = (async () => {
    try {
      const mail = mailStore.getMailById(id) || liveMailCache.get(id)
      if (!mail) return { ok: false, error: '메일을 찾지 못했습니다.' }
      const cfg = loadConfig()
      // 전문 확보는 get-mail-detail이 먼저 시도했을 것이므로 여기서 다시 IMAP을 조회하지
      // 않고, 그때까지 확보된 본문(전문 또는 미리보기)을 그대로 재료로 씁니다.
      const { summary, usedCache } = await summarizeMail(mail, cfg, { forceRefresh })
      return { ok: true, summary, usedCache }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })()
  if (!forceRefresh) {
    mailSummaryInflight.set(id, promise)
    promise.finally(() => mailSummaryInflight.delete(id))
  }
  return promise
})

// 사용량 대시보드 — 이 프로그램이 클로드를 부를 때마다 쌓아둔 비용/토큰 기록을 집계해서 돌려줍니다.
// period: '24h' | '7d' | '30d'
ipcMain.handle('dooray:get-usage-stats', async (_event, { period } = {}) => {
  try {
    return { ok: true, stats: usageStore.getStats(period) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 메일함에서 전문 가져오기가 실패했을 때, 사용자가 직접 "다시 시도"를 누르면 여기로 옵니다.
// 이전 성공 여부와 상관없이 IMAP을 다시 조회합니다.
ipcMain.handle('dooray:retry-mail-imap', async (_event, { id } = {}) => {
  try {
    const mail = mailStore.getMailById(id) || liveMailCache.get(id)
    if (!mail) return { ok: false, error: '메일을 찾지 못했습니다 (삭제되었거나 저장 기간이 지났을 수 있어요).' }
    const cfg = loadConfig()
    mail.bodyFull = false // 캐시된 성공 여부를 무시하고 강제로 다시 시도
    const r = await ensureMailFullBody(mail, cfg)
    if (!r.ok) return { ok: false, error: r.error }
    return {
      ok: true,
      mail: {
        id: mail.id,
        bodyMimeType: mail.bodyMimeType || 'text/plain',
        bodyContent: mail.bodyContent || '',
        bodyFull: !!mail.bodyFull
      }
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ---- 설정 탭: 메일 전문 가져오기 (IMAP) ------------------------------------

ipcMain.handle('dooray:get-imap-settings', async () => {
  const c = loadConfig()
  const hasPassword = !!(await tokenStore.getImapPassword().catch(() => null))
  return { ok: true, enabled: !!c.imapEnabled, user: c.imapUser || '', hasPassword }
})

ipcMain.handle('dooray:save-imap-settings', async (_event, { enabled, user, password } = {}) => {
  try {
    const c = loadConfig()
    c.imapEnabled = !!enabled
    c.imapUser = (user || '').trim()
    saveConfig(c)
    config = c
    if (password) await tokenStore.saveImapPassword(password)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:test-imap-connection', async () => {
  try {
    const c = loadConfig()
    if (!c.imapUser) return { ok: false, error: '메일 주소를 먼저 입력하고 저장해주세요.' }
    const password = await tokenStore.getImapPassword().catch(() => null)
    if (!password) return { ok: false, error: '메일 비밀번호를 먼저 입력하고 저장해주세요.' }
    return await mailImap.testConnection({ user: c.imapUser, password, host: c.imapHost })
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ---- 설정 탭: 캘린더 연동 (CalDAV) -----------------------------------------
// 서버 주소는 두레이 고정값이라 코드에만 두고 화면에는 노출하지 않습니다.
const CALDAV_SERVER = 'https://caldav.dooray.com/'

ipcMain.handle('dooray:get-caldav-settings', async () => {
  const c = loadConfig()
  const hasPassword = !!(await tokenStore.getCaldavPassword().catch(() => null))
  return { ok: true, user: c.caldavUser || '', hasPassword }
})

ipcMain.handle('dooray:save-caldav-settings', async (_event, { user, password } = {}) => {
  try {
    const c = loadConfig()
    c.caldavUser = (user || '').trim()
    saveConfig(c)
    config = c
    if (password) await tokenStore.saveCaldavPassword(password)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:test-caldav-connection', async () => {
  try {
    const c = loadConfig()
    if (!c.caldavUser) return { ok: false, error: '메일 주소를 먼저 입력하고 저장해주세요.' }
    const password = await tokenStore.getCaldavPassword().catch(() => null)
    if (!password) return { ok: false, error: '비밀번호를 먼저 입력하고 저장해주세요.' }
    const res = await fetch(CALDAV_SERVER, {
      method: 'PROPFIND',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${c.caldavUser}:${password}`).toString('base64'),
        Depth: '0',
        'Content-Type': 'application/xml'
      },
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>'
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' }
    }
    if (res.status >= 200 && res.status < 400) return { ok: true }
    return { ok: false, error: `연결 실패 (상태 코드 ${res.status})` }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ---- 설정 탭: 사내 LLM 연동 (Playground) -----------------------------------
// 왓츠업 게시물 조회/휴가 기안 신청처럼 Playground에 이미 내장된 기능이 필요할 때,
// 클로드가 dooray-mcp-server.mjs의 dooray_ask_playground 도구로 이 값들을 읽어 호출합니다.

ipcMain.handle('dooray:get-playground-settings', async () => {
  const c = loadConfig()
  const hasApiKey = !!(await tokenStore.getPlaygroundApiKey().catch(() => null))
  return {
    ok: true,
    baseUrl: c.playgroundBaseUrl || '',
    model: c.playgroundModel || '',
    hasApiKey
  }
})

ipcMain.handle('dooray:save-playground-settings', async (_event, { baseUrl, model, apiKey } = {}) => {
  try {
    const c = loadConfig()
    c.playgroundBaseUrl = (baseUrl || '').trim().replace(/\/$/, '')
    c.playgroundModel = (model || '').trim()
    saveConfig(c)
    config = c
    if (apiKey) await tokenStore.savePlaygroundApiKey(apiKey)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:test-playground-connection', async () => {
  try {
    const c = loadConfig()
    if (!c.playgroundBaseUrl) return { ok: false, error: '주소를 먼저 입력하고 저장해주세요.' }
    const apiKey = await tokenStore.getPlaygroundApiKey().catch(() => null)
    if (!apiKey) return { ok: false, error: 'API 키를 먼저 입력하고 저장해주세요.' }
    const res = await fetch(`${c.playgroundBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: c.playgroundModel,
        messages: [{ role: 'user', content: '연결 테스트입니다. "연결됨"이라고만 답해주세요.' }]
      })
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'API 키가 올바르지 않습니다.' }
    }
    if (!res.ok) return { ok: false, error: `연결 실패 (상태 코드 ${res.status})` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 홈 화면의 "안읽은 메일" 카드용: IMAP 폴더 목록 + 고른 폴더의 안읽은 개수를 확인합니다.
// IMAP이 꺼져 있거나 계정 정보가 없으면 needsImap:true를 같이 돌려줘서, 화면에서
// "IMAP 연동이 필요한 기능"이라고 구분해서 안내할 수 있게 합니다.
ipcMain.handle('dooray:get-imap-mailboxes', async () => {
  try {
    const c = loadConfig()
    if (!c.imapEnabled || !c.imapUser) {
      return { ok: false, error: 'IMAP 연동이 필요한 기능이에요. 설정에서 IMAP을 켜주세요.', needsImap: true }
    }
    const password = await tokenStore.getImapPassword().catch(() => null)
    if (!password) return { ok: false, error: 'IMAP 비밀번호를 먼저 입력하고 저장해주세요.', needsImap: true }
    return await mailImap.listMailboxes({ user: c.imapUser, password, host: c.imapHost })
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:get-imap-unseen-count', async (_event, { mailboxPath } = {}) => {
  try {
    const c = loadConfig()
    if (!c.imapEnabled || !c.imapUser) {
      return { ok: false, error: 'IMAP 연동이 필요한 기능이에요. 설정에서 IMAP을 켜주세요.', needsImap: true }
    }
    const password = await tokenStore.getImapPassword().catch(() => null)
    if (!password) return { ok: false, error: 'IMAP 비밀번호를 먼저 입력하고 저장해주세요.', needsImap: true }
    return await mailImap.getUnseenCount({ user: c.imapUser, password, host: c.imapHost }, mailboxPath)
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:get-mail-folder-allowlist', async () => {
  const c = loadConfig()
  return { ok: true, allowlist: c.mailFolderAllowlist || [] }
})

ipcMain.handle('dooray:save-mail-folder-allowlist', async (_event, { folderNames }) => {
  try {
    const c = loadConfig()
    c.mailFolderAllowlist = folderNames || []
    saveConfig(c)
    config = c
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 홈 "오늘 할 일" 카드에 자동으로 모아올 메일함 선택 (비어있으면 전체 폴더).
ipcMain.handle('dooray:get-todo-folder-allowlist', async () => {
  const c = loadConfig()
  return { ok: true, allowlist: c.todoFolderAllowlist || [] }
})

ipcMain.handle('dooray:save-todo-folder-allowlist', async (_event, { folderNames }) => {
  try {
    const c = loadConfig()
    c.todoFolderAllowlist = folderNames || []
    saveConfig(c)
    config = c
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 메일함에서 특정 메일 1건을 수동으로 "오늘 할 일"에 추가/제외합니다.
ipcMain.handle('dooray:add-manual-todo', async (_event, { mailId, folderName, text, mailUrl, groupLabel } = {}) => {
  try {
    if (!mailId) return { ok: false, error: '메일 정보가 없습니다.' }
    mailSummaryCache.addManualTodo({ mailId, folderName, text, mailUrl, groupLabel })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:remove-manual-todo', async (_event, { mailId } = {}) => {
  try {
    if (!mailId) return { ok: false, error: '메일 정보가 없습니다.' }
    mailSummaryCache.removeManualTodo(mailId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// "발신자별 정리"에서 나온 [요청] 줄 하나를 체크/해제 — 체크한 것만 "오늘 할 일"에 반영됩니다.
ipcMain.handle('dooray:set-mail-request-optin', async (_event, { folderName, mailId, text, optedIn } = {}) => {
  try {
    if (!folderName || !mailId || !text) return { ok: false, error: '정보가 부족합니다.' }
    const id = computeRequestId(folderName, `mail::${mailId}`, text)
    mailSummaryCache.setRequestOptIn(id, !!optedIn)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:get-mail-alert-rules', async () => {
  const c = loadConfig()
  return { ok: true, rules: c.mailAlertRules || [] }
})

ipcMain.handle('dooray:add-mail-alert-rule', async (_event, { folderName, channelId, channelLabel }) => {
  try {
    if (!folderName || !channelId) return { ok: false, error: '폴더와 채팅방을 모두 선택해주세요.' }
    const c = loadConfig()
    const list = c.mailAlertRules || []
    list.push({ id: `${folderName}:${channelId}:${Date.now()}`, folderName, channelId, channelLabel })
    c.mailAlertRules = list
    saveConfig(c)
    config = c
    return { ok: true, rules: list }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:remove-mail-alert-rule', async (_event, { id }) => {
  try {
    const c = loadConfig()
    c.mailAlertRules = (c.mailAlertRules || []).filter((r) => r.id !== id)
    saveConfig(c)
    config = c
    return { ok: true, rules: c.mailAlertRules }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ---- 메일 탭: 폴더별 정리 (사람별 / 제목별 자동 묶기) ------------------------
// 사람이 그룹을 직접 만드는 대신, 폴더를 고르면 그 안의 메일을 자동으로 사람별 또는
// 제목별로 묶어서 보여줍니다. AI 요약은 그룹마다 결과를 저장해두고, 그 사이에 새 메일이
// 안 들어왔으면 저장된 요약을 그대로 재사용합니다 (매번 다시 돌리지 않아 시간/비용을 아낌).

ipcMain.handle('dooray:get-mail-folder-groups', async (_event, { folderName, groupType, from, subject, dateFrom, dateTo } = {}) => {
  try {
    if (!folderName) return { ok: false, error: '폴더를 먼저 선택해주세요.' }
    const type = groupType === 'subject' ? 'subject' : 'person'
    const groups = mailStore.groupMailsByFolder(folderName, type, { from, subject, dateFrom, dateTo })
    // 정렬: 즐겨찾기(★)한 그룹이 맨 위, 그다음은 메일 많은 순(자주 이야기하는 사람 우선),
    // 개수가 같으면 최근에 온 순.
    const favSet = new Set(loadConfig().mailGroupFavorites || [])
    const withFav = groups.map((g) => ({
      ...g,
      favorite: favSet.has(`${folderName}::${type}::${g.key}`)
    }))
    withFav.sort((a, b) =>
      (b.favorite - a.favorite) ||
      (b.count - a.count) ||
      (new Date(b.latestSentAt || 0) - new Date(a.latestSentAt || 0))
    )
    return { ok: true, groups: withFav }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// "폴더별 정리" 목록에서 별(★)을 눌러 그룹을 맨 위에 고정/해제합니다.
ipcMain.handle('dooray:toggle-mail-group-favorite', async (_event, { folderName, groupType, key, favorite } = {}) => {
  try {
    const type = groupType === 'subject' ? 'subject' : 'person'
    const favKey = `${folderName}::${type}::${key}`
    const c = loadConfig()
    const set = new Set(c.mailGroupFavorites || [])
    if (favorite) set.add(favKey)
    else set.delete(favKey)
    c.mailGroupFavorites = Array.from(set)
    saveConfig(c)
    config = c
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ---- 메일 탭: 요청 모아보기 --------------------------------------------------
// 저장된 AI 요약들에서 [요청]으로 표시된 줄만 모아서 한 카드에 보여줍니다.
// 완료 체크 상태는 파일로 저장되어 껐다 켜도 유지됩니다.

// [요청] 항목 ID를 만드는 공통 규칙. buildMailRequestsForFolder와 buildFolderGroupDetail이
// 똑같은 문장에 대해 항상 같은 id를 만들어야 체크(완료/옵트인) 상태가 서로 어긋나지 않습니다.
function computeRequestId(folderName, sourceKey, text) {
  return crypto.createHash('sha1').update(`${folderName}::${sourceKey}::${text}`).digest('hex').slice(0, 16)
}

// 폴더 하나의 [요청] 목록을 만듭니다. 아래 두 IPC 핸들러(폴더 하나 조회 / 전체 폴더 통합 조회)가
// 이 함수를 공유해서, 로직이 두 군데로 갈라지지 않게 합니다.
async function buildMailRequestsForFolder(folderName) {
  if (!folderName) return []
  {
    const doneMap = mailSummaryCache.getRequestDoneMap()
    const optInMap = mailSummaryCache.getRequestOptInMap()
    const seen = new Map() // 같은 출처의 같은 요청 문장은 (필터 조합이 달라도) 한 번만

    // [요청] 줄을 뽑아 목록에 넣는 공통 처리.
    // sourceKey: 중복 제거 및 항목 ID를 만드는 기준 (같은 메일/그룹의 같은 문장 = 같은 할 일)
    // requireOptIn이 true면 (발신자별 정리에서 나온 항목) 사람이 체크박스로 직접 골라야만
    // 포함합니다 — 여러 사람 메일을 한 번에 훑다 보니 [요청] 오탐이 늘 수 있어서입니다.
    const collect = (summaryText, { sourceKey, label, generatedAt, mailId, mailUrl, requireOptIn }) => {
      const lines = String(summaryText || '')
        .split('\n')
        .filter((l) => /^\s*\*?\s*\[요청\]/.test(l))
      for (const line of lines) {
        const text = line.trim().replace(/^\*?\s*\[요청\]\s*/, '')
        if (!text) continue
        const dedupeKey = `${sourceKey}::${text}`
        if (seen.has(dedupeKey)) continue
        const id = computeRequestId(folderName, sourceKey, text)
        if (requireOptIn && !optInMap[id]) continue
        seen.set(dedupeKey, {
          id,
          groupKey: sourceKey,
          groupLabel: label || sourceKey,
          text,
          done: !!doneMap[id],
          generatedAt: generatedAt || '',
          mailId: mailId || null,
          mailUrl: mailUrl || null
        })
      }
    }

    // ① 개별 메일 요약 — 이게 핵심입니다.
    // 예전에는 아래 ②(폴더별 정리 화면에서 만들어진 그룹 요약)만 읽어서, "메일 도착 알림"이
    // 채팅방으로 보낸 요약은 할 일 목록에 전혀 반영되지 않았습니다(그 화면을 직접 열어봐야만
    // 할 일이 생겼음). 이제 이 폴더의 메일 중 요약이 있는 건 전부 확인해서, 알림으로만 보낸
    // 메일의 요청 사항도 자동으로 할 일 목록에 올라옵니다.
    // 요약은 어느 화면에서 먼저 만들었든 같은 캐시에 저장돼서, 여기서 "이 폴더의 메일 전부"를
    // 훑으면 발신자별 정리가 방금 만든 요약도 그대로 다시 걸립니다. summaryOriginMap으로 그
    // 요약이 발신자별 정리(그룹 스캔)에서 처음 만들어진 것인지 확인해서, 그런 경우는 여기서도
    // 자동으로 넣지 않고 체크박스 옵트인을 요구합니다(②와 동일 규칙 적용).
    const cfg = loadConfig()
    const summaryOriginMap = mailSummaryCache.getSummaryOriginMap()
    const mails = mailStore.listMails({ folderName }, 500)
    for (const m of mails) {
      const summary = mailSummaryCache.getMailSummary(m.id)
      if (!summary) continue
      collect(summary, {
        sourceKey: `mail::${m.id}`,
        label: m.fromName || m.fromEmail || '(발신자 미상)',
        generatedAt: m.sentAt || '',
        mailId: m.id,
        mailUrl: cfg.doorayDomain ? `https://${cfg.doorayDomain}/mail/folders/${m.folderId}/${m.id}` : null,
        requireOptIn: summaryOriginMap[m.id] === 'group'
      })
    }

    // ② 폴더별 정리(발신자별)에서 만들어진 그룹 요약 — 여기서 나온 [요청]은 이제 기본으로
    // 안 들어가고, 화면에서 체크박스로 직접 고른 것만 들어갑니다(requireOptIn).
    for (const e of mailSummaryCache.listEntriesForFolder(folderName, 'person')) {
      for (const b of e.mailBlocks || []) {
        if (!b || !b.summary) continue
        collect(b.summary, {
          sourceKey: b.mailId ? `mail::${b.mailId}` : e.groupKey,
          label: e.label || e.groupKey,
          generatedAt: b.sentAt || e.generatedAt || '',
          mailId: b.mailId || null,
          mailUrl: b.mailUrl || null,
          requireOptIn: true
        })
      }
    }

    // ②-1. 같은 메일에서 나온 [요청]이 여러 줄이면 하나로 합칩니다. (2026-08-06 신설)
    // 예전에는 [요청] 줄 하나가 곧 항목 하나여서, 메일 한 통에 요청이 3개면 할 일도 3개가
    // 따로 생겼습니다. 실제로는 "그 메일 하나를 처리하면 끝"인 경우가 대부분이라 묶습니다.
    // 첫 줄을 대표로 두고 나머지는 "· "를 붙여 아래 줄에 붙입니다.
    // ⚠️ 합치면 항목 ID가 바뀌므로 기존 완료 체크는 초기화됩니다 (사용자 확인 완료).
    // ⚠️ ③(사람이 직접 추가한 항목)은 합치지 않습니다 — AI 판단이 아니라 본인이 적은
    //    문장이라 원문 그대로 두는 편이 낫습니다. 그래서 이 처리를 ③보다 먼저 합니다.
    {
      const byMail = new Map()
      for (const item of seen.values()) {
        const list = byMail.get(item.groupKey)
        if (list) list.push(item)
        else byMail.set(item.groupKey, [item])
      }
      seen.clear()
      for (const [groupKey, items] of byMail) {
        if (items.length === 1) {
          seen.set(items[0].id, items[0])
          continue
        }
        const text = items.map((it, i) => (i === 0 ? it.text : `· ${it.text}`)).join('\n')
        const id = computeRequestId(folderName, groupKey, text)
        seen.set(id, { ...items[0], id, text, done: !!doneMap[id], mergedCount: items.length })
      }
    }

    // ③ 사람이 메일함에서 직접 "오늘 할 일"에 추가한 항목 — AI 판단과 무관하게 항상 포함합니다.
    for (const t of mailSummaryCache.listManualTodosForFolder(folderName)) {
      const id = `manual::${t.mailId}`
      seen.set(id, {
        id,
        groupKey: t.mailId ? `mail::${t.mailId}` : id,
        groupLabel: t.groupLabel || '(직접 추가)',
        text: t.text,
        done: !!doneMap[id],
        generatedAt: t.createdAt || '',
        mailId: t.mailId || null,
        mailUrl: t.mailUrl || null,
        manual: true
      })
    }

    // 미완료 먼저, 그 안에서는 최근 메일 순
    return Array.from(seen.values()).sort(
      (a, b) => (a.done - b.done) || (new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0))
    )
  }
}

ipcMain.handle('dooray:get-mail-requests', async (_event, { folderName } = {}) => {
  try {
    return { ok: true, requests: await buildMailRequestsForFolder(folderName) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 관측된 모든(또는 "오늘 할 일"용으로 골라둔 폴더만의) [요청]을 한 번에 모아 돌려줍니다.
// 완료 여부(done)도 그대로 포함합니다 — 홈 화면은 미완료만 걸러 쓰고, 공유 투두리스트
// 메일 동기화(syncMailRequestsToTodo)는 완료 전환도 알아야 해서 전체를 받아 씁니다.
async function getAllMailRequests() {
  const cfg = loadConfig()
  const todoAllow = new Set(cfg.todoFolderAllowlist || [])
  // 선택해둔 메일함이 있으면 그 폴더들만 훑습니다 (공용 메일함처럼 나 말고 다른
  // 사람에게 오는 메일까지 내 할 일로 잡히는 걸 막기 위함). 선택 안 했으면 전체 폴더.
  const folders = mailStore.listKnownFolders().filter((f) => !todoAllow.size || todoAllow.has(f.name))
  const all = []
  for (const f of folders) {
    all.push(...(await buildMailRequestsForFolder(f.name)))
  }
  // 폴더별로 만들었던 id가 우연히 같을 가능성은 거의 없지만, 그래도 한 번 더 정리합니다.
  const dedup = new Map(all.map((r) => [r.id, r]))
  return Array.from(dedup.values()).sort(
    (a, b) => (a.done - b.done) || (new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0))
  )
}

// 채팅방 공유 투두리스트 ↔ 메일함 [요청] 동기화. 이 채팅방에서 토글이 켜져 있을 때만
// postTodoListNow가 호출합니다. sourceMailRequestId로 이미 만들어둔 카드는 다시 만들지
// 않고, 메일 쪽에서 이미 완료 체크된 [요청]은 새로 만들지 않으며, 메일 쪽에서 나중에
// 완료 체크되면 투두 카드도 같이 완료 처리합니다.
async function syncMailRequestsToTodo(channelId) {
  const requests = await getAllMailRequests()
  for (const r of requests) {
    const existing = todoStore.findCardBySource(channelId, r.id)
    if (!existing) {
      if (!r.done) todoStore.addCard({ channelId, text: r.text, sourceMailRequestId: r.id })
    } else if (r.done && existing.status !== 'done') {
      todoStore.setStatus(existing.id, 'done')
    }
  }
}

// 홈 화면의 "오늘 할 일" 카드용: 폴더를 하나씩 고르지 않고, 관측된 모든 폴더의 미완료
// [요청]을 한 번에 모아서 돌려줍니다. (날짜와 무관하게 아직 처리 안 한 것 전부)
ipcMain.handle('dooray:get-mail-requests-all', async () => {
  try {
    const requests = (await getAllMailRequests()).filter((r) => !r.done)
    return { ok: true, requests }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 홈 화면의 "오늘 할 일" 카드용: 모든 "공유 투두방"의 오늘 기준 미완료 카드를 한 번에 모아
// 돌려줍니다. 메일함에서 이미 이 투두방으로 자동 동기화된 카드(sourceMailRequestId 있음)는
// 빼고 돌려줍니다 — 그런 카드는 어차피 위 getAllMailRequests()로도 잡혀서 홈 화면에 이미
// 나오므로, 그대로 같이 넣으면 같은 할 일이 두 번 보이게 됩니다.
async function getAllTodoCardsForHome() {
  const cfg = loadConfig()
  const channels = cfg.todoChannels || []
  if (!channels.length) return []
  const { dateIso } = todoNowKst()
  let labels = {}
  try {
    const myId = await getMyMemberId()
    labels = await doorayService.getChannelLabels(channels, myId)
  } catch { /* 이름 조회 실패해도 카드 자체는 채널ID로 대체해서 보여줌 */ }
  // (2026-08-13 수정) 채팅방 탭에서 직접 붙인 이름(channelLabelOverrides)이 여기엔 안 입혀져서
  // "나와의 대화" 같은 방이 숫자 ID로 보였습니다 — 직접 지정한 이름이 항상 우선.
  const overrides = cfg.channelLabelOverrides || {}
  const all = []
  for (const channelId of channels) {
    const cards = todoStore.listOpenCards(channelId, { dateIso }).filter((c) => !c.sourceMailRequestId)
    for (const c of cards) {
      all.push({ ...c, channelLabel: overrides[channelId] || labels[channelId] || channelId })
    }
  }
  return all
}

ipcMain.handle('dooray:get-todo-cards-all', async () => {
  try {
    return { ok: true, cards: await getAllTodoCardsForHome() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:set-mail-request-done', async (_event, { id, done } = {}) => {
  try {
    if (!id) return { ok: false, error: '요청 항목을 찾지 못했습니다.' }
    mailSummaryCache.setRequestDone(id, !!done)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 그룹 상세(최근 메일 목록 + AI 요약)를 만듭니다. forceRefresh가 아니면, 저장된 요약이
// 있고 그 뒤로 이 그룹에 새 메일이 없었을 때는 AI를 다시 부르지 않고 저장된 것을 그대로 씁니다.
// from/subject/dateFrom/dateTo는 "폴더별 정리" 카드의 검색 필터이며, 그룹 목록을 만들 때와
// 항상 같은 값을 넘겨야 개수가 서로 맞습니다.
async function buildFolderGroupDetail({ folderName, groupType, groupKey, forceRefresh, from, subject, dateFrom, dateTo }) {
  const type = groupType === 'subject' ? 'subject' : 'person'
  const filters = { from, subject, dateFrom, dateTo }
  const mails = mailStore.getMailsForFolderGroup(folderName, type, groupKey, filters)
  if (!mails.length) return { ok: false, error: '이 그룹에 해당하는 메일을 찾지 못했습니다.' }

  // 두레이 웹메일에서 실제로 확인한 메일 상세 페이지 주소 형식입니다 (메일 알림 기능과 동일).
  const cfg = loadConfig()
  const mailUrlOf = (mail) => cfg.doorayDomain
    ? `https://${cfg.doorayDomain}/mail/folders/${mail.folderId}/${mail.id}`
    : ''

  // 필터가 다르면 그룹에 포함되는 메일 구성 자체가 달라질 수 있어서, 캐시 키에도 필터
  // 조건을 같이 넣어 필터 조합마다 별도로 저장합니다.
  const filterSig = JSON.stringify(filters)
  const latestSentAt = mails[0]?.sentAt || null
  const cached = mailSummaryCache.getEntry(folderName, type, groupKey, filterSig)
  const upToDate = !!cached && cached.count === mails.length && cached.latestSentAt === latestSentAt

  // 그룹을 사람이 읽을 수 있는 이름 (요약 저장 시 함께 저장해서 "요청 모아보기"에 표시)
  const groupLabel = type === 'subject'
    ? (mails[0].subject || '(제목 없음)')
    : (mails[0].fromName || mails[0].fromEmail || '발신자 미상')

  // 그룹 상세는 메일들을 하나로 뭉뚱그린 문단이 아니라, 메일 하나하나를 "제목(링크) + 그
  // 메일만의 AI 요약" 블록으로 보여줍니다. 각 메일의 요약은 공용 summarizeMail이 만든 것과
  // 완전히 같은 것이라(캐시 공유), 메일함/도착 알림에서 이미 요약된 메일은 여기서 AI를
  // 다시 부르지 않고 그대로 재사용합니다.
  let mailBlocks
  let usedCache = false
  if (upToDate && !forceRefresh && cached.mailBlocks) {
    mailBlocks = cached.mailBlocks
    usedCache = true
  } else {
    const recent = mails.slice(0, 15)
    // 메일마다 먼저 IMAP 전문을 시도합니다. IMAP 자체가 꺼져있으면(imapOff) 미리보기로
    // 대체하고, 켜져있는데 이 메일만 못 찾았으면 미리보기로 몰래 대체하지 않고 이번
    // 대상에서 뺍니다 (skippedSubjects에 기록해서 결과에 표시).
    const skippedSubjects = []
    const readyMails = []
    for (const m of recent) {
      const r = await ensureMailFullBody(m, cfg)
      if (!r.ok && !r.imapOff) {
        skippedSubjects.push(m.subject)
        continue
      }
      readyMails.push(m)
    }
    // 캐시에 없는 메일만 모아서 AI 호출 1번으로 처리 (forceRefresh면 전부 다시 만듦).
    // origin: 'group' — 발신자별 정리에서 만든 요약이라는 표시를 남겨서, 여기서 나온 [요청]은
    // "오늘 할 일"에 기본으로 안 들어가고 체크박스로 옵트인해야만 들어가게 합니다.
    const needSummarize = readyMails.filter((m) => forceRefresh || !mailSummaryCache.getMailSummary(m.id))
    await summarizeMailsBatch(needSummarize, cfg, 'group')
    mailBlocks = readyMails.map((m) => ({
      mailId: m.id,
      subject: m.subject,
      sentAt: m.sentAt,
      fromName: m.fromName,
      fromEmail: m.fromEmail,
      mailUrl: mailUrlOf(m),
      summary: mailSummaryCache.getMailSummary(m.id) || '(요약 실패)'
    }))
    if (skippedSubjects.length) {
      mailBlocks.push({ mailId: null, note: `IMAP 전문을 가져오지 못해 이번 목록에서 제외됨: ${skippedSubjects.join(', ')}` })
    }
    mailSummaryCache.setEntry(folderName, type, groupKey, filterSig, {
      count: mails.length,
      latestSentAt,
      mailBlocks,
      generatedAt: new Date().toISOString(),
      // "요청 모아보기"에서 어느 폴더/그룹의 요청인지 알 수 있도록 함께 저장
      folderName,
      groupType: type,
      groupKey,
      label: groupLabel
    })
  }

  // "발신자별 정리"(person)에서 나온 [요청]은 화면에서 체크박스로 직접 골라야만 "오늘 할 일"에
  // 들어가므로, 각 줄의 현재 체크 상태를 함께 내려줍니다. 캐시된 요약이어도 체크 상태는 항상
  // 최신 값을 보여줘야 해서, 캐시에 굳이 같이 저장하지 않고 매번 이 시점에 계산합니다.
  let mailBlocksOut = mailBlocks
  if (type === 'person') {
    const optInMap = mailSummaryCache.getRequestOptInMap()
    mailBlocksOut = mailBlocks.map((b) => {
      if (!b.mailId || !b.summary) return b
      const texts = String(b.summary || '')
        .split('\n')
        .filter((l) => /^\s*\*?\s*\[요청\]/.test(l))
        .map((l) => l.trim().replace(/^\*?\s*\[요청\]\s*/, ''))
        .filter(Boolean)
      const requests = texts.map((text) => ({
        text,
        optedIn: !!optInMap[computeRequestId(folderName, `mail::${b.mailId}`, text)]
      }))
      return { ...b, requests }
    })
  }

  return {
    ok: true,
    label: groupLabel,
    mailBlocks: mailBlocksOut,
    usedCache,
    mails: mails.slice(0, 30).map((m) => ({
      id: m.id,
      subject: m.subject,
      sentAt: m.sentAt,
      fromName: m.fromName,
      fromEmail: m.fromEmail,
      mailUrl: mailUrlOf(m)
    }))
  }
}

// 같은 그룹 요약 요청이 "이미 진행 중"이면 새 AI 요청을 또 보내지 않고, 진행 중인 것의
// 결과를 그대로 나눠 씁니다. (화면에서 항목을 빠르게 왔다갔다 클릭하면 — 캐시는 요약이
// "끝난 뒤"에야 저장되기 때문에 — 끝나기 전 재클릭마다 AI 요청이 계속 새로 나가던 문제 방지)
const folderGroupDetailInflight = new Map()
function folderGroupDetailInflightKey(p) {
  return JSON.stringify([p.folderName, p.groupType, p.groupKey, p.from, p.subject, p.dateFrom, p.dateTo, !!p.forceRefresh])
}
function buildFolderGroupDetailDeduped(params) {
  const key = folderGroupDetailInflightKey(params)
  if (folderGroupDetailInflight.has(key)) return folderGroupDetailInflight.get(key)
  const promise = buildFolderGroupDetail(params).finally(() => folderGroupDetailInflight.delete(key))
  folderGroupDetailInflight.set(key, promise)
  return promise
}

ipcMain.handle('dooray:get-mail-folder-group-detail', async (_event, { folderName, groupType, groupKey, from, subject, dateFrom, dateTo } = {}) => {
  try {
    return await buildFolderGroupDetailDeduped({ folderName, groupType, groupKey, forceRefresh: false, from, subject, dateFrom, dateTo })
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// "다시 요약하기" 버튼: 저장된 요약이 있어도 무시하고 강제로 새로 돌립니다.
ipcMain.handle('dooray:refresh-mail-folder-group-summary', async (_event, { folderName, groupType, groupKey, from, subject, dateFrom, dateTo } = {}) => {
  try {
    return await buildFolderGroupDetailDeduped({ folderName, groupType, groupKey, forceRefresh: true, from, subject, dateFrom, dateTo })
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dooray:refresh-mail-now', async () => {
  try {
    await pollMail()
    return { ok: true, total: mailStore.countMails() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 답장 스레드가 길게 이어진 메일은 "-----Original Message-----" 같은 인용 구분선 뒤로
// 예전 답장들이 계속 반복돼서 쌓이는 경우가 많습니다. 글자수로 무조건 자르면 새로 쓴 내용까지
// 잘릴 위험이 있어서, 대신 이 구분선을 찾아 그 지점에서 자릅니다: 새 답장 내용은 항상 전문
// 그대로 남기고, 구분선 바로 뒤에 오는 발신정보(보낸사람/받는사람/제목 등) 몇 줄만 맥락용으로
// 남긴 뒤, 그보다 더 오래된 인용 내용은 잘라냅니다.
const QUOTE_SEPARATOR_PATTERNS = [
  /-{3,}\s*Original Message\s*-{3,}/i,
  /-{3,}\s*원본\s*메[일시][^\n]{0,20}-{3,}/i,
  /^On .{0,120} wrote:\s*$/im
]
function trimQuotedThread(body) {
  if (!body) return body
  let cutIndex = -1
  let markerLength = 0
  for (const pattern of QUOTE_SEPARATOR_PATTERNS) {
    const match = pattern.exec(body)
    if (match && (cutIndex === -1 || match.index < cutIndex)) {
      cutIndex = match.index
      markerLength = match[0].length
    }
  }
  // 구분선을 못 찾으면(뉴스레터 등) 길이 제한 없이 전문을 그대로 넘깁니다.
  if (cutIndex === -1) return body
  const marker = body.slice(cutIndex, cutIndex + markerLength)
  const afterMarker = body.slice(cutIndex + markerLength)
  const headerLines = afterMarker.split('\n').slice(0, 6).join('\n') // From/Sent/To/Subject 등 발신정보 몇 줄
  return `${body.slice(0, cutIndex)}${marker}\n${headerLines}\n...(이 아래는 더 오래된 인용이라 생략함)`
}

// ---- 대시보드 "채팅" 탭: 클로데이처럼 대시보드에서 직접 묻고 답하기 (맥락 기억) -----------

ipcMain.handle('dooray:dashboard-chat-history', async () => {
  return { ok: true, messages: dashboardChatHistory }
})

ipcMain.handle('dooray:dashboard-chat-reset', async () => {
  dashboardChatHistory = []
  return { ok: true }
})

ipcMain.handle('dooray:dashboard-chat-send', async (_event, { text }) => {
  const question = (text || '').trim()
  if (!question) return { ok: false, error: '메시지를 입력해주세요.' }
  try {
    fs.mkdirSync(DASHBOARD_CHAT_WORKDIR, { recursive: true })
    // 지침이 하나도 없으면 가끔 영어로 답하는 경우가 있어서, 여기서도 한국어 답변을 고정합니다
    // (mentionBot.js의 일반 질문 응답과 같은 이유).
    const languageNote = '(답변 지침: 항상 한국어로 답변하세요.)\n\n'
    // (2026-08-11 수정) 질문을 맨 앞에 둡니다. askClaude가 2만 자 초과분을 뒤에서부터 자르는데,
    // 이전 대화(답변 포함)는 금방 수만 자가 되므로 질문이 뒤에 있으면 잘려나갑니다 — 멘션 봇에서
    // 실제로 났던 사고와 같은 구조라 같이 고침. 이전 대화 자체에도 상한(최신 쪽 유지)을 둡니다.
    let historyJoined = dashboardChatHistory.map((m) => `${m.role === 'user' ? '나' : '어시스턴트'}: ${m.text}`).join('\n')
    const MAX_HISTORY_LEN = 8000
    if (historyJoined.length > MAX_HISTORY_LEN) {
      historyJoined = '(오래된 대화 일부 생략)\n' + historyJoined.slice(-MAX_HISTORY_LEN)
    }
    const historyText = dashboardChatHistory.length ? `\n\n[참고 — 이전 대화]\n${historyJoined}` : ''
    const promptText = `${languageNote}[새 질문 — 이것에 답하세요]\n${question}${historyText}`
    const answer = await askClaude(promptText, { cwd: DASHBOARD_CHAT_WORKDIR, feature: 'dashboard_chat' })
    dashboardChatHistory.push({ role: 'user', text: question })
    dashboardChatHistory.push({ role: 'assistant', text: answer })
    // 대화가 너무 길어지면 다음 질문마다 넘기는 맥락도 계속 커지니, 최근 40개(20턴)만 유지합니다.
    if (dashboardChatHistory.length > 40) {
      dashboardChatHistory = dashboardChatHistory.slice(-40)
    }
    return { ok: true, answer }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ---- 템플릿 탭: 매체 소재 사이즈 가이드 (위키에 저장/조회) ------------------
// 매체(예: "네이버", "카카오", "메타")별 소재 사이즈 규격을 AI가 웹에서 찾아 정리한 뒤,
// 지정한 프로젝트의 위키 페이지에 저장합니다. 같은 매체를 다시 "갱신"하면 새 페이지를
// 또 만들지 않고, config.json에 기록해둔 그 페이지(pageId)의 내용만 덮어씁니다.
async function researchMediaSizeGuide(mediaName) {
  fs.mkdirSync(MEDIA_GUIDE_WORKDIR, { recursive: true })
  const promptText = [
    `"${mediaName}" 광고 상품의 소재(이미지/영상) 사이즈 가이드를 최신 기준으로 정리해주세요.`,
    '- 웹 검색으로 가장 최근 자료를 찾아서, 게재 위치/유형별로 사이즈(px), 비율, 파일형식·용량, 영상 길이 제한 등을 정리하세요.',
    '- 마크다운으로 작성하세요: 매체명을 "# " 제목으로, 상품/위치별로 "## " 소제목을 쓰고, 표(|---|)로 규격을 정리하세요.',
    '- 확인한 자료의 출처(사이트명)를 각 섹션 끝에 "출처: ..." 한 줄로 남기세요.',
    '- 자료가 서로 다르거나 오래된 것 같으면, 문서 맨 위에 "⚠️ 실제 발주 전 매체 공식 페이지에서 최신 규격 재확인 필요" 안내를 넣으세요.',
    '- 다른 설명이나 인사말 없이 마크다운 문서 내용만 출력하세요.'
  ].join('\n')
  const content = await askClaude(promptText, { cwd: MEDIA_GUIDE_WORKDIR, feature: 'media_guide_research', timeoutMs: 600_000 })
  return content.trim()
}

ipcMain.handle('dooray:list-media-guides', async () => {
  const c = loadConfig()
  const entries = Object.entries(c.mediaGuidePages || {}).map(([mediaName, info]) => ({ mediaName, ...info }))
  return { ok: true, guides: entries }
})

// 매체 가이드를 (다시) 조사해서 위키에 저장합니다. 이미 그 매체로 저장해둔 페이지가 있으면
// 새로 만들지 않고 그 페이지 내용만 덮어씁니다(제목/위키가 바뀐 경우에만 새로 만듭니다).
ipcMain.handle('dooray:refresh-media-guide', async (_event, { mediaName, projectId, projectLabel, wikiId }) => {
  const name = (mediaName || '').trim()
  if (!name) return { ok: false, error: '매체명을 입력해주세요.' }
  if (!wikiId) return { ok: false, error: '위키가 연결된 프로젝트를 선택해주세요.' }
  try {
    const content = await researchMediaSizeGuide(name)
    const subject = `${name} 소재 사이즈 가이드`
    const c = loadConfig()
    const existing = (c.mediaGuidePages || {})[name]
    let pageId
    if (existing && existing.wikiId === wikiId) {
      await doorayService.updateWikiPageContent(wikiId, existing.pageId, { subject, content })
      pageId = existing.pageId
    } else {
      const page = await doorayService.createWikiPage(wikiId, { subject, content })
      pageId = page.id
    }
    c.mediaGuidePages = { ...(c.mediaGuidePages || {}), [name]: { wikiId, pageId, projectId, projectLabel, updatedAt: new Date().toISOString() } }
    saveConfig(c)
    config = c
    log(`매체 가이드 저장/갱신됨: ${name} (위키페이지 ${pageId})`)
    return { ok: true, content, pageId, wikiId }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 저장해둔 매체 가이드의 현재 위키 페이지 내용을 그대로 불러옵니다 (직접 두레이에서
// 수정했을 수도 있으니, 저장해둔 텍스트를 캐싱하지 않고 매번 위키에서 새로 가져옵니다).
ipcMain.handle('dooray:get-media-guide', async (_event, { mediaName }) => {
  const c = loadConfig()
  const entry = (c.mediaGuidePages || {})[mediaName]
  if (!entry) return { ok: false, error: '저장된 가이드가 없습니다.' }
  try {
    const page = await doorayService.getWikiPage(entry.wikiId, entry.pageId)
    return { ok: true, content: page?.body?.content || '', entry }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ---- 자동 업데이트 ----
// 깃허브 저장소(taegeunsin-web/Dooray-AI-)의 Releases에 새 버전(설치형 exe)을 올려두면,
// 이 프로그램이 켜질 때마다 확인해서 백그라운드로 받아둡니다. 받아지면 재시작할지 바로 물어보고,
// "나중에"를 눌러도 다음에 프로그램을 종료할 때 자동으로 반영됩니다(autoInstallOnAppQuit).
// **포터블 버전(설치 없이 쓰는 exe)은 electron-updater가 자동 설치를 지원하지 않아서 대상이 아님
// — 설치형(Setup.exe)으로 설치한 경우에만 동작합니다.**
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

// (2026-08-10 추가) 앱을 며칠씩 켜두는 사용자를 위해 6시간마다 다시 확인합니다.
// 예전에는 프로그램을 켜는 순간 딱 한 번만 확인해서, 켜둔 사이에 새 버전이
// 나오면 그 세션 내내 모르고 껐다 켜야만 알 수 있었습니다.
const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000
let updateCheckTimer = null
// 이미 새 버전을 찾아 받는 중이거나 다 받아둔 상태면 주기 확인을 건너뜁니다
// (진행 중인 안내를 뒤에서 도는 확인이 덮어쓰지 않게 하려는 것입니다).
let updateBusy = false

autoUpdater.on('checking-for-update', () => log('업데이트 확인 중...'))
autoUpdater.on('update-available', (info) => { updateBusy = true; log(`새 버전 발견: v${info.version} (다운로드를 시작해요)`) })
autoUpdater.on('update-not-available', () => { updateBusy = false; log('지금 이미 최신 버전이에요.') })
autoUpdater.on('error', (err) => { updateBusy = false; log(`업데이트 확인 중 오류: ${err.message}`) })
autoUpdater.on('update-downloaded', async (info) => {
  log(`새 버전(v${info.version}) 다운로드 완료. 재시작하면 반영돼요.`)
  try {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '두레이 AI 어시스턴트 업데이트',
      message: `새 버전(v${info.version})이 준비됐어요. 지금 재시작해서 반영할까요?`,
      detail: '"나중에"를 눌러도 다음에 프로그램을 완전히 종료할 때 자동으로 반영돼요.',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) autoUpdater.quitAndInstall()
  } catch (err) {
    log(`업데이트 알림 창 표시 실패: ${err.message}`)
  }
})

function checkForAppUpdate() {
  // 개발 모드(소스로 직접 실행)에는 업데이트 피드가 없어서 건너뜁니다 — 설치된(패키징된) 앱에서만 확인.
  if (!app.isPackaged) return
  if (updateBusy) return // 이미 받는 중이거나 받아둔 게 있으면 다시 확인하지 않습니다
  autoUpdater.checkForUpdates().catch((err) => log(`업데이트 확인 실패: ${err.message}`))
}

// (2026-08-10 추가) 위 checkForAppUpdate를 6시간마다 반복해서 불러줍니다.
function startUpdateCheckTimer() {
  if (!app.isPackaged || updateCheckTimer) return
  updateCheckTimer = setInterval(checkForAppUpdate, UPDATE_RECHECK_MS)
}

// (2026-08-13 추가) 공유 투두 스케줄을 1분마다 확인 — 원래는 두레이에 연결될 때 한 번만
// 확인했는데, 앱을 밤새 켜두면 자정이 지나도 재연결이 없어 새 날의 아침 브리핑과
// 오늘의 할일이 안 나가는 빈틈이 있었습니다. 하루 1회 보장은 함수 안에서 하므로
// 1분마다 불러도 중복 게시는 없습니다.
setInterval(() => {
  checkTodoSchedule().catch((err) => log(`공유 투두리스트 스케줄 확인 오류: ${err.message}`))
}, 60_000)

app.whenReady().then(() => {
  // 트레이 아이콘: assets/icon.png (클로데이처럼 실제 아이콘 표시).
  // 파일을 못 찾는 경우에도 프로그램은 정상 동작하도록 빈 아이콘으로 대체합니다.
  let icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon-32.png'))
  if (icon.isEmpty()) icon = nativeImage.createEmpty()
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }))
  updateTrayMenu()
  applyAutoStart(config.autoStart)
  startBot()
  // 실행할 때마다 대시보드가 트레이 뒤에 숨지 않고 바로 보이게 합니다.
  openDashboard()
  checkForAppUpdate()
  startUpdateCheckTimer()
  // (2026-08-11 추가) 절전에서 깨어나면 소켓을 바로 다시 연결합니다. 원래는 핑 감시가
  // 최대 75초 뒤에야 끊긴 걸 알아채는데, 복귀 시점은 OS가 알려주므로 기다릴 이유가 없습니다.
  // 회선이 아직 안 살아났어도 괜찮습니다 — 연결 실패는 15초 간격 재시도로 이어지고,
  // 조회(GET) 실패는 doorayClient의 네트워크 재시도가 받아줍니다.
  // (2026-08-12 수정) 윈도우 현대 대기 모드는 절전 중에도 몇 번씩 살짝 깼다 자기를
  // 반복해서, 덮개를 여는 순간 복귀 신호가 여러 번 몰려올 수 있습니다. 그대로 두면
  // 재연결이 연달아 실행되며 밀린 메시지 따라잡기까지 겹쳐 돕니다(실사용 신고 —
  // 로그 도배 + 같은 메시지 이중 AI 검사). 30초 안에 온 추가 신호는 무시합니다.
  let lastResumeAt = 0
  powerMonitor.on('resume', () => {
    const now = Date.now()
    if (now - lastResumeAt < 30_000) return
    lastResumeAt = now
    log('절전에서 복귀 — 두레이 연결을 다시 잡습니다')
    setTimeout(() => startBot(), 3000) // 네트워크가 살아날 시간을 3초쯤 줍니다
  })
  // (2026-08-10 추가) 아침 브리핑 — 1분마다 "보낼 시각이 지났는데 오늘 아직 안 보냈나"를 확인.
})

// 트레이 상주 프로그램이므로, 창이 없어도(원래 없음) 앱이 종료되지 않게 합니다.
app.on('window-all-closed', (e) => e.preventDefault())

// mentionBot.js가 채팅 완료 감지 직전에 "메일 요청 → 투두" 동기화를 먼저 돌릴 수 있게 내보냅니다.
// (mentionBot.js 쪽에서는 순환 참조를 피하려고 함수 안에서 필요할 때만 require('./index')로 불러씀)
module.exports = { syncMailRequestsToTodo, invalidateMyTasksCache, proposeTaskBodyDraft, generateReport }
