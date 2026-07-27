// 프로그램 진입점.
// 트레이 아이콘으로 상주하며, 백그라운드에서 두레이 채팅을 감시합니다.
// 토큰이 없으면(첫 실행) 자동으로 "대시보드" 창을 띄웁니다.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { app, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')
const { loadConfig, saveConfig, DEFAULTS } = require('./config')
const { createDoorayClient } = require('./doorayClient')
const { SocketModeClient } = require('./socketMode')
const { createMentionHandler, getRecentChannels, askClaude, backfillChatHistory } = require('./mentionBot')
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

  await ensureMcpRegistered({ token: currentToken, appDir: app.getAppPath(), log })

  if (socketClient) socketClient.stop()
  socketClient = new SocketModeClient({ doorayClient, domain: config.doorayDomain })
  const handleMessage = createMentionHandler({ doorayClient, doorayService, getConfig: () => config, getMyMemberId, log })

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
    myStaffName: c.myStaffName || ''
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
ipcMain.handle('dooray:get-channels', async () => {
  const cfg = loadConfig()
  const allowed = new Set(cfg.openChannels || [])
  const historyOff = new Set(cfg.historyDisabledChannels || [])
  const recent = getRecentChannels()
  const recentMap = new Map(recent.map((ch) => [ch.channelId, ch]))

  let merged = []
  try {
    const myId = await getMyMemberId()
    const all = await doorayService.listAllChannelsLabeled(myId)
    const apiIds = new Set(all.map((c) => c.id))
    merged = all.map((c) => {
      const seen = recentMap.get(c.id)
      return {
        channelId: c.id,
        label: c.label,
        lastText: seen?.lastText || '',
        lastSenderId: seen?.lastSenderId || '',
        lastAt: seen?.lastAt || 0
      }
    })
    // API 목록에 없는데 메시지가 관측된 방이 있으면(희귀한 경우) 함께 표시
    for (const ch of recent) {
      if (!apiIds.has(ch.channelId)) merged.push({ ...ch, label: ch.channelId })
    }
  } catch (err) {
    // 전체 목록 조회가 실패해도(권한/일시 오류) 예전처럼 관측된 방이라도 보여줍니다.
    log(`전체 채팅방 목록 조회 실패 (감지된 방만 표시): ${err.message}`)
    let labels = {}
    try {
      const myId = await getMyMemberId()
      labels = await doorayService.getChannelLabels(recent.map((ch) => ch.channelId), myId)
    } catch { /* 이름 조회까지 실패하면 숫자 ID로 표시 */ }
    merged = recent.map((ch) => ({ ...ch, label: labels[ch.channelId] || ch.channelId }))
  }

  // 최근 활동이 있는 방을 위로, 나머지는 이름순
  merged.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || (a.label || '').localeCompare(b.label || '', 'ko'))
  return merged.map((ch) => ({
    ...ch,
    allowed: allowed.has(ch.channelId),
    historyEnabled: !historyOff.has(ch.channelId)
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
    return { ok: true, members: await doorayService.searchMembersByName(name) }
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

ipcMain.handle('dooray:get-mail-detail', async (_event, { id } = {}) => {
  try {
    const mail = mailStore.getMailById(id)
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
      const mail = mailStore.getMailById(id)
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
    const mail = mailStore.getMailById(id)
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

// 홈 화면의 "오늘 할 일" 카드용: 폴더를 하나씩 고르지 않고, 관측된 모든 폴더의 미완료
// [요청]을 한 번에 모아서 돌려줍니다. (날짜와 무관하게 아직 처리 안 한 것 전부)
ipcMain.handle('dooray:get-mail-requests-all', async () => {
  try {
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
    const requests = Array.from(dedup.values())
      .filter((r) => !r.done)
      .sort((a, b) => new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0))
    return { ok: true, requests }
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
    const historyText = dashboardChatHistory.length
      ? `[이전 대화]\n${dashboardChatHistory.map((m) => `${m.role === 'user' ? '나' : '어시스턴트'}: ${m.text}`).join('\n')}\n\n[새 질문]\n`
      : ''
    const promptText = `${languageNote}${historyText}${question}`
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

autoUpdater.on('checking-for-update', () => log('업데이트 확인 중...'))
autoUpdater.on('update-available', (info) => log(`새 버전 발견: v${info.version} (다운로드를 시작해요)`))
autoUpdater.on('update-not-available', () => log('지금 이미 최신 버전이에요.'))
autoUpdater.on('error', (err) => log(`업데이트 확인 중 오류: ${err.message}`))
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
  autoUpdater.checkForUpdates().catch((err) => log(`업데이트 확인 실패: ${err.message}`))
}

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
})

// 트레이 상주 프로그램이므로, 창이 없어도(원래 없음) 앱이 종료되지 않게 합니다.
app.on('window-all-closed', (e) => e.preventDefault())
