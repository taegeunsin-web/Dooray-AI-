// 메일 전문 가져오기 (IMAP).
// 두레이 공개 API(활동 스트림)는 메일 본문의 미리보기 일부만 내려줘서, 전문을 보려면
// 두레이가 메일 프로그램(아웃룩 등)용으로 공식 지원하는 IMAP으로 원문을 받아와야 합니다.
// (두레이 웹메일 설정에서 "IMAP 사용"을 켜야 하고, 메일 비밀번호가 필요합니다 —
//  비밀번호는 tokenStore를 통해 OS 자격 증명 관리자에 저장되고 파일로 남지 않습니다.)
//
// 동작 방식: 메일함 탭에서 메일을 열 때 전문이 없으면 그 메일 1건만 IMAP에서 찾아와
// 저장합니다. 두레이 스트림의 메일과 IMAP의 메일은 서로 ID 체계가 달라서,
// 보낸사람 + 받은시각(±1일) + 제목이 같은 메일을 찾는 방식으로 연결합니다.

const fs = require('fs')
const path = require('path')
const os = require('os')

const DEFAULT_HOST = 'imap.dooray.com'
const DEFAULT_PORT = 993

// 첨부파일을 "필요할 때만" 잠깐 내려받아두는 임시 폴더 (모든 메일 첨부를 미리 저장해두지
//않고, 채팅에서 실제로 요청이 들어왔을 때만 그 1건을 내려받습니다. 업로드가 끝나면
// 호출한 쪽에서 지워도 되는 임시 파일입니다).
const ATTACH_TMP_DIR = path.join(os.tmpdir(), 'dooray-assistant-mail-attachments')

// 파일 이름에 쓸 수 없는 문자(윈도우 기준)를 안전하게 치환합니다.
function sanitizeFileName(name) {
  return (name || 'attachment').replace(/[\\/:*?"<>|]/g, '_')
}

// imapflow/mailparser는 새로 추가된 부속 라이브러리라, 아직 설치 전인 환경에서도
// 프로그램 전체가 죽지 않도록 필요할 때만 불러옵니다.
function loadLibs() {
  try {
    const { ImapFlow } = require('imapflow')
    const { simpleParser } = require('mailparser')
    return { ImapFlow, simpleParser }
  } catch {
    return null
  }
}

const LIB_MISSING_MSG =
  '메일 전문 가져오기에 필요한 부속 라이브러리가 아직 설치되지 않았어요. ' +
  '실행.bat을 한 번 다시 실행하면 자동으로 설치됩니다.'

// imapflow의 오류는 "Command failed"처럼 뭉툭하게만 나와서, 서버가 실제로 뭐라고
// 거부했는지(인증 실패/네트워크 문제 등)를 사람이 읽을 수 있는 문장으로 풀어줍니다.
function describeImapError(err) {
  const code = err?.code || ''
  if (code === 'ENOTFOUND') return 'IMAP 서버 주소를 찾을 수 없습니다 (네트워크/주소 확인 필요)'
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT') return 'IMAP 서버 응답 시간 초과 (사내망에서 993 포트가 막혀있을 수 있어요)'
  if (code === 'ECONNREFUSED') return 'IMAP 서버가 연결을 거부했습니다 (포트 차단 가능성)'

  const parts = []
  if (err?.authenticationFailed) {
    parts.push('로그인이 거부되었습니다 — ① 두레이 웹메일 환경설정에서 "IMAP 사용"이 켜져 있는지, ② 메일 주소 전체(@ 포함)를 아이디로 썼는지, ③ 비밀번호가 맞는지 확인해주세요. 회사 계정이 SSO/2단계 인증을 쓰면 웹메일 IMAP 설정 화면에서 발급하는 전용(앱) 비밀번호가 필요할 수 있어요.'
    )
  }
  const serverResponse = err?.response || err?.responseText
  if (serverResponse) parts.push(`서버 응답: ${serverResponse}`)
  if (err?.serverResponseCode) parts.push(`응답 코드: ${err.serverResponseCode}`)
  if (!parts.length) parts.push(err?.message || '알 수 없는 오류')
  return parts.join(' / ')
}

function newClient(ImapFlow, { user, password, host }) {
  return new ImapFlow({
    host: host || DEFAULT_HOST,
    port: DEFAULT_PORT,
    secure: true,
    auth: { user, pass: password },
    logger: false,
    // 연결/응답이 너무 오래 걸리면 붙잡고 있지 않도록 제한
    socketTimeout: 30_000,
    greetingTimeout: 15_000
  })
}

// 설정 화면의 "연결 테스트" 버튼용: 로그인까지만 해보고 결과를 돌려줍니다.
async function testConnection({ user, password, host }) {
  const libs = loadLibs()
  if (!libs) return { ok: false, error: LIB_MISSING_MSG }
  const client = newClient(libs.ImapFlow, { user, password, host })
  try {
    await client.connect()
    await client.logout()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: describeImapError(err) }
  } finally {
    try { client.close() } catch { /* 이미 닫혔으면 무시 */ }
  }
}

// 두레이 스트림의 메일 1건(mail)과 같은 메일을 IMAP에서 찾아, 찾을 때마다 onFound(uid, client)를
// 호출합니다. onFound가 값을 돌려주면(=처리 완료) 그 값을 그대로 반환하고 탐색을 멈춥니다.
// onFound가 null/undefined를 돌려주면(=이 메일함에선 원하는 걸 못 얻음, 예: 본문이 비어있음)
// 다음 편지함을 계속 찾아봅니다. fetchFullBody와 fetchAttachment가 이 탐색 로직을 공유합니다.
async function withMatchedMessage(client, mail, onFound) {
  // 열어볼 메일함 순서: 두레이 폴더와 같은 이름의 함 → 받은편지함 → 나머지 (최대 12개).
  // 대부분 첫 번째나 두 번째에서 바로 찾습니다.
  const boxes = await client.list()
  const names = boxes.map((b) => b.path)
  const candidates = []
  const folderMatch = names.find(
    (n) => n === mail.folderName || n.split('/').pop() === mail.folderName
  )
  if (folderMatch) candidates.push(folderMatch)
  if (!candidates.includes('INBOX') && names.includes('INBOX')) candidates.push('INBOX')
  for (const n of names) {
    if (candidates.length >= 12) break
    if (!candidates.includes(n)) candidates.push(n)
  }

  const sent = mail.sentAt ? new Date(mail.sentAt) : null
  const DAY = 24 * 3600 * 1000
  // 두레이 API가 주는 제목과 IMAP 원본 제목 사이에 앞뒤 공백·줄바꿈·중간 공백 개수 차이만
  // 있어도 "다른 메일"로 취급해 놓치는 걸 막기 위해, 비교 전에 공백을 전부 한 칸으로
  // 정리하고 앞뒤를 자릅니다 (완전히 다른 제목까지 같다고 오판하진 않습니다).
  const normalizeSubject = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const wantedSubject = normalizeSubject(mail.subject)

  // 실패했을 때 원인(동기화 지연 vs 제목이 안 맞음 등)을 나중에 로그로 구분할 수 있게
  // 진단 정보를 모아둡니다.
  let boxesChecked = 0
  let totalCandidates = 0
  let subjectMismatches = 0

  for (const box of candidates) {
    let lock
    try {
      lock = await client.getMailboxLock(box)
    } catch {
      continue // 열 수 없는 함(권한 등)은 건너뜀
    }
    try {
      // 받은시각 ±1일 + 보낸사람으로 좁혀서 검색 (빠르고 안전)
      const criteria = {}
      if (sent && !isNaN(sent)) {
        criteria.since = new Date(sent.getTime() - DAY)
        criteria.before = new Date(sent.getTime() + DAY)
      }
      if (mail.fromEmail) criteria.from = mail.fromEmail
      let uids = []
      try {
        uids = (await client.search(criteria, { uid: true })) || []
      } catch {
        continue
      }
      boxesChecked++
      if (!uids.length) continue
      totalCandidates += uids.length

      // 후보들 중 제목까지 같은 메일을 고릅니다 (공백 차이는 무시, 최근 50개까지만 확인)
      let bestUid = null
      for await (const msg of client.fetch(uids.slice(-50), { envelope: true, uid: true }, { uid: true })) {
        const subj = normalizeSubject(msg.envelope?.subject)
        if (subj === wantedSubject) bestUid = msg.uid
        else subjectMismatches++
      }
      if (!bestUid && uids.length === 1) bestUid = uids[0] // 후보가 1건뿐이면 그걸로
      if (!bestUid) continue

      const result = await onFound(bestUid)
      if (result) return result
    } finally {
      lock.release()
    }
  }
  return {
    ok: false,
    error: 'IMAP에서 같은 메일을 찾지 못했습니다 (오래된 메일이거나 다른 계정의 함일 수 있어요).' +
      ` [진단: 확인한 편지함 ${boxesChecked}개, 날짜·발신자로 걸러진 후보 ${totalCandidates}건, 그중 제목 불일치 ${subjectMismatches}건]`
  }
}

// HTML 메일에서 AI 요약용으로 쓸 "글자만" 뽑아냅니다 (화면 표시는 원본 HTML을 그대로 쓰고,
// 이건 클로드에게 넘길 때만 사용). 아웃룩 등에서 온 메일은 눈에 보이는 문장보다 스타일/서식
// 태그가 훨씬 길어서, HTML 원문을 글자 수 제한으로 자르면 실제 내용이 잘리기 전에 서식 코드가
// 자리를 다 차지해버리는 문제가 있었습니다(2026-07-27 확인). simpleParser가 주는 text 필드는
// 원본에 text/plain 파트가 따로 있을 때만 채워지고, HTML 전용 메일이면 비어있어서 별도로
// 태그를 제거해 만듭니다 — 완벽한 변환은 아니지만 AI 요약 재료로는 충분합니다.
function htmlToPlainText(html) {
  if (!html) return ''
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 저장된 메일 1건의 원문 전체를 IMAP에서 찾아옵니다.
// 반환: { ok: true, bodyMimeType, bodyContent, bodyPlainText } 또는 { ok: false, error }
// bodyContent: 화면 표시용(원본 그대로, html이면 html). bodyPlainText: AI 요약용(항상 글자만).
async function fetchFullBody({ user, password, host }, mail) {
  const libs = loadLibs()
  if (!libs) return { ok: false, error: LIB_MISSING_MSG }
  const client = newClient(libs.ImapFlow, { user, password, host })
  try {
    await client.connect()
    return await withMatchedMessage(client, mail, async (bestUid) => {
      const dl = await client.download(String(bestUid), undefined, { uid: true })
      const parsed = await libs.simpleParser(dl.content)
      const html = parsed.html && typeof parsed.html === 'string' ? parsed.html : ''
      const text = parsed.text || ''
      if (!html && !text) return null // 이 편지함 것은 내용이 비어있음 — 다음 편지함 계속 탐색
      return {
        ok: true,
        bodyMimeType: html ? 'text/html' : 'text/plain',
        bodyContent: html || text,
        bodyPlainText: text || htmlToPlainText(html)
      }
    })
  } catch (err) {
    return { ok: false, error: describeImapError(err) }
  } finally {
    try { await client.logout() } catch { /* 무시 */ }
    try { client.close() } catch { /* 무시 */ }
  }
}

// 저장된 메일 1건에 붙어있던 첨부파일 중 하나를 찾아 임시 폴더에 내려받습니다.
// (모든 메일의 첨부파일을 미리 받아두지 않고, 이 함수가 호출될 때만 그때 1건을 받습니다)
// filenameQuery를 주면 그 글자가 파일명에 포함된 첨부만 찾고, 안 주면 첨부가 딱 1개일 때만
// 자동으로 그걸 고릅니다(여러 개면 이름을 알려달라고 요청).
// 반환: { ok: true, localPath, fileName, size } 또는 { ok: false, error }
async function fetchAttachment({ user, password, host }, mail, { filenameQuery } = {}) {
  const libs = loadLibs()
  if (!libs) return { ok: false, error: LIB_MISSING_MSG }
  const client = newClient(libs.ImapFlow, { user, password, host })
  try {
    await client.connect()
    return await withMatchedMessage(client, mail, async (bestUid) => {
      const dl = await client.download(String(bestUid), undefined, { uid: true })
      const parsed = await libs.simpleParser(dl.content)
      const attachments = parsed.attachments || []
      if (!attachments.length) return { ok: false, error: '이 메일에는 첨부파일이 없습니다.' }

      let picked = null
      const q = (filenameQuery || '').trim().toLowerCase()
      if (q) {
        const matches = attachments.filter((a) => (a.filename || '').toLowerCase().includes(q))
        if (matches.length === 1) picked = matches[0]
        else if (matches.length > 1) {
          return {
            ok: false,
            error: `첨부파일이 여러 개 일치해요: ${matches.map((a) => a.filename).join(', ')} — 파일 이름을 더 구체적으로 말해주세요.`
          }
        }
      }
      if (!picked) {
        if (attachments.length === 1) picked = attachments[0]
        else {
          return {
            ok: false,
            error: `이 메일에 첨부파일이 여러 개예요: ${attachments.map((a) => a.filename).join(', ')} — 어떤 파일인지 이름을 같이 말해주세요.`
          }
        }
      }

      fs.mkdirSync(ATTACH_TMP_DIR, { recursive: true })
      const fileName = sanitizeFileName(picked.filename)
      const localPath = path.join(ATTACH_TMP_DIR, `${Date.now()}_${fileName}`)
      fs.writeFileSync(localPath, picked.content)
      return { ok: true, localPath, fileName, size: picked.size || picked.content.length }
    })
  } catch (err) {
    return { ok: false, error: describeImapError(err) }
  } finally {
    try { await client.logout() } catch { /* 무시 */ }
    try { client.close() } catch { /* 무시 */ }
  }
}

// 설정 화면/홈 카드에서 "폴더 선택" 드롭다운을 채우기 위해, IMAP 메일함(폴더) 목록을 가져옵니다.
async function listMailboxes({ user, password, host }) {
  const libs = loadLibs()
  if (!libs) return { ok: false, error: LIB_MISSING_MSG }
  const client = newClient(libs.ImapFlow, { user, password, host })
  try {
    await client.connect()
    const boxes = await client.list()
    return { ok: true, mailboxes: boxes.map((b) => ({ path: b.path, name: b.name || b.path })) }
  } catch (err) {
    return { ok: false, error: describeImapError(err) }
  } finally {
    try { await client.logout() } catch { /* 무시 */ }
    try { client.close() } catch { /* 무시 */ }
  }
}

// 홈 화면의 "안읽은 메일" 카드용: 폴더(mailboxPath) 하나의 안읽은 메일 개수만 가볍게 확인합니다.
// mailboxPath를 안 넘기면 INBOX(받은편지함) 기준입니다. 본문을 안 열어서 매우 빠릅니다.
async function getUnseenCount({ user, password, host }, mailboxPath) {
  const libs = loadLibs()
  if (!libs) return { ok: false, error: LIB_MISSING_MSG }
  const client = newClient(libs.ImapFlow, { user, password, host })
  try {
    await client.connect()
    const status = await client.status(mailboxPath || 'INBOX', { unseen: true })
    return { ok: true, unseen: status.unseen || 0 }
  } catch (err) {
    return { ok: false, error: describeImapError(err) }
  } finally {
    try { await client.logout() } catch { /* 무시 */ }
    try { client.close() } catch { /* 무시 */ }
  }
}

module.exports = { testConnection, fetchFullBody, fetchAttachment, listMailboxes, getUnseenCount, htmlToPlainText }
