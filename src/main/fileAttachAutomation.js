// 채팅방에서 "@트리거 [뭉뚱그린 설명] 파일 첨부해줘" 처럼 업무에 파일을 붙여달라고 하면,
// 어느 업무/어느 파일을 말하는지 추측한 뒤 "맞나요?" 하고 먼저 확인받고, 사용자가 승인한
// 다음에야 실제로 업로드합니다 (제목/메일 내용을 정확히 기억하는 사람이 없다는 전제).
//
// 동작 2단계:
//  1) proposeAttachFile: 프로젝트/업무 제목/메일을 최대한 추측해서 "이렇게 이해했어요, 맞나요?"
//     라고 답장하고, 그 추측 내용을 채널별로 잠깐 기억해둡니다(pendingByChannel).
//  2) 같은 채널에서 같은 사람이 다시 부르면 handleConfirmReply로 "네/아니오"인지 먼저 확인하고,
//     "네"면 confirmAndExecute가 그제서야 실제로 파일을 찾아 업로드합니다.
// 이렇게 나누는 이유: 업무에 파일을 올리는 건 실수하면 되돌리기 번거로운 행동이라, 추측이
// 틀렸을 때 그냥 진행해버리지 않도록 사람 확인을 한 번 거칩니다.

const fs = require('fs')
const path = require('path')

const ATTACH_WORDS = ['첨부', '붙여', '올려줘']
const TASK_URL_RE = /\/task\/(\d+)\/(\d+)/
const PENDING_TTL_MS = 10 * 60 * 1000 // 10분 지나면 추측 내용을 잊어버리고 처음부터 다시 물어야 함

const CONFIRM_WORDS = ['네', '맞아', '맞습니다', '맞음', '예', '응', 'ok', 'OK', '오케이', '확인', '승인', '진행', '그래']
const CANCEL_WORDS = ['아니', '아냐', '취소', '틀렸', '다시']

// channelId -> { senderId, guess, createdAt }
const pendingByChannel = new Map()

function isAttachFileCommand(text) {
  const t = text || ''
  return ATTACH_WORDS.some((w) => t.includes(w))
}

// (2026-08-06 신설) '첨부/붙여/올려줘' 같은 말이 있어도 실제로 "업무에 파일 붙이기"가
// 아닐 수 있습니다 — 예: "이 파일 드라이브에 올려줘". 예전에는 위 isAttachFileCommand의
// 단어 검사만으로 단정해서, 드라이브 업로드 요청까지 전부 업무 첨부 흐름으로 새버렸습니다.
// 이제 단어 검사는 "클로드에게 물어볼 가치가 있나"를 거르는 1차 필터로만 쓰고,
// 실제 판단은 여기서 클로드가 합니다.
//
// 마커 태그로 답을 받는 이유는 taskAutomation.js와 같습니다 (줄바꿈·쉼표가 섞여도 안 깨짐).
// 판단만 하는 가벼운 일이라 가장 싼 모델(haiku)로 부릅니다.
// ⚠️ 호출이 실패하면 'task'를 돌려줘서 예전과 똑같이 동작하게 합니다 — 판단 기능이
//    고장 났다고 파일 첨부 기능 자체가 멈추면 안 되기 때문입니다.
async function judgeAttachIntent(question, { askClaude, cwd } = {}) {
  if (typeof askClaude !== 'function') return 'task'
  const prompt =
    '아래는 사내 메신저에서 봇에게 한 말입니다. 의도를 하나만 고르세요.\n' +
    '- 두레이 "업무(태스크)"에 파일을 첨부해달라는 뜻이면: [ATTACH_TASK]\n' +
    '- 그 외(드라이브에 올리기, 채팅방에 보내기, 단순 질문 등)이면: [OTHER]\n' +
    '애매하면 [OTHER]를 고르세요.\n' +
    '다른 말은 절대 쓰지 말고 태그 하나만 출력하세요.\n\n' +
    `말: ${question}`
  try {
    const out = await askClaude(prompt, { cwd, model: 'haiku', feature: 'attach_intent' })
    return /\[ATTACH_TASK\]/.test(out) ? 'task' : 'other'
  } catch {
    return 'task'
  }
}

function parseTaskUrl(text) {
  const m = (text || '').match(TASK_URL_RE)
  if (!m) return null
  return { projectId: m[1], postId: m[2] }
}

function cleanupExpired(channelId) {
  const pending = pendingByChannel.get(channelId)
  if (pending && Date.now() - pending.createdAt > PENDING_TTL_MS) {
    pendingByChannel.delete(channelId)
  }
}

// 이 채널에 "그 사람"이 확인해줘야 할 추측이 남아있는지 (만료됐으면 없는 걸로 취급).
function hasPendingConfirm(channelId, senderId) {
  cleanupExpired(channelId)
  const pending = pendingByChannel.get(channelId)
  return !!(pending && pending.senderId === senderId)
}

// 방금 온 메시지가 "네"인지 "아니오"인지 "그냥 다른 말"인지 구분합니다 (AI 호출 없이 키워드로만
// — 짧고 흔한 대답이라 굳이 AI를 부르지 않아도 됩니다).
// 짧은 대답일 때만 키워드로 판단합니다 — "네"/"확인" 같은 한두 글자는 "네이버", "확인서" 같은
// 완전히 다른(새로운) 요청 문장에도 우연히 섞여 있을 수 있어서, 긴 문장까지 확인 답으로
// 잘못 해석하지 않도록 길이를 제한합니다.
const SHORT_REPLY_MAX_LEN = 12

function classifyReply(text) {
  const t = (text || '').trim()
  if (t.length > SHORT_REPLY_MAX_LEN) return 'unclear'
  if (CANCEL_WORDS.some((w) => t.includes(w))) return 'cancel'
  if (CONFIRM_WORDS.some((w) => t.includes(w))) return 'confirm'
  return 'unclear'
}

function clearPending(channelId) {
  pendingByChannel.delete(channelId)
}

const MARKERS = {
  projectNumber: ['[PROJECT_NUMBER]', '[/PROJECT_NUMBER]'],
  taskTitleKeyword: ['[TASK_TITLE_KEYWORD]', '[/TASK_TITLE_KEYWORD]'],
  sourceType: ['[SOURCE_TYPE]', '[/SOURCE_TYPE]'],
  localPath: ['[LOCAL_PATH]', '[/LOCAL_PATH]'],
  mailNumber: ['[MAIL_NUMBER]', '[/MAIL_NUMBER]'],
  attachmentName: ['[ATTACHMENT_NAME]', '[/ATTACHMENT_NAME]']
}

function extractBetween(text, [start, end]) {
  const startIdx = text.indexOf(start)
  if (startIdx === -1) return null
  const contentStart = startIdx + start.length
  const endIdx = text.indexOf(end, contentStart)
  if (endIdx === -1) return null
  return text.slice(contentStart, endIdx).trim()
}

function buildExtractPrompt({ question, hasUrl, projectList, mailList }) {
  const lines = [
    '아래는 사용자가 두레이 업무에 파일을 첨부해달라고 요청한 내용입니다.',
    '사용자는 정확한 링크나 메일 전체 제목을 기억하지 못할 수 있습니다 — 아래 목록을 보고',
    '가장 가능성 높은 것 하나만 골라주세요 (틀려도 나중에 사람이 다시 확인하니 괜찮습니다).',
    ''
  ]
  if (hasUrl) {
    lines.push('문장에 이미 두레이 업무 링크가 있어서 프로젝트/업무 제목은 추측할 필요 없습니다 (없음으로 남겨두세요).')
    lines.push('')
  } else {
    lines.push('[사용 가능한 프로젝트 목록]')
    projectList.forEach((p, i) => lines.push(`${i + 1}. ${p.code || p.description || p.id}${p.description && p.code ? ` - ${p.description}` : ''}`))
    lines.push('')
  }
  lines.push('[최근 저장된 메일 목록] (파일을 메일에서 가져와야 할 때만 참고, 아니면 무시)')
  if (mailList.length) {
    mailList.forEach((m, i) => lines.push(`${i + 1}. [${m.folderName}] ${m.subject} / ${m.fromName || m.fromEmail || ''} / ${(m.sentAt || '').slice(0, 10)}`))
  } else {
    lines.push('(저장된 메일 없음)')
  }
  lines.push('')
  lines.push('다른 설명 없이 아래 형식 그대로만 출력하세요:')
  lines.push('')
  lines.push(MARKERS.projectNumber[0], hasUrl ? '없음' : '(위 프로젝트 목록의 번호, 확실한 게 없으면 없음)', MARKERS.projectNumber[1])
  lines.push(MARKERS.taskTitleKeyword[0], hasUrl ? '없음' : '(그 프로젝트에서 검색할 업무 제목 핵심 단어, 없으면 없음)', MARKERS.taskTitleKeyword[1])
  lines.push(MARKERS.sourceType[0], '(local 또는 mail)', MARKERS.sourceType[1])
  lines.push(MARKERS.localPath[0], '(local일 때 컴퓨터 파일 경로 그대로, 아니면 없음)', MARKERS.localPath[1])
  lines.push(MARKERS.mailNumber[0], '(mail일 때 위 메일 목록의 번호, 아니면 없음)', MARKERS.mailNumber[1])
  lines.push(MARKERS.attachmentName[0], '(첨부파일 이름을 구체적으로 언급했으면 그 일부, 아니면 없음)', MARKERS.attachmentName[1])
  lines.push('')
  lines.push('[요청 문장]')
  lines.push(question)
  return lines.join('\n')
}

function parseExtracted(raw) {
  const text = raw || ''
  const clean = (v) => (v && v !== '없음' ? v.trim() : '')
  const sourceTypeRaw = (extractBetween(text, MARKERS.sourceType) || '').toLowerCase()
  return {
    projectNumber: clean(extractBetween(text, MARKERS.projectNumber)),
    taskTitleKeyword: clean(extractBetween(text, MARKERS.taskTitleKeyword)),
    sourceType: sourceTypeRaw.includes('mail') ? 'mail' : sourceTypeRaw.includes('local') ? 'local' : null,
    localPath: clean(extractBetween(text, MARKERS.localPath)),
    mailNumber: clean(extractBetween(text, MARKERS.mailNumber)),
    attachmentName: clean(extractBetween(text, MARKERS.attachmentName))
  }
}

// 1단계: 추측만 하고, 실제로 파일을 내려받거나 업로드하지 않습니다.
// 반환: { ok: true, replyText } (추측 성공, 확인 필요) 또는 { ok: false, error } (추측 자체가 실패)
async function proposeAttachFile({ doorayService, mailStore, cfg, question, cwd, askClaude, channelId, senderId }) {
  const urlTask = parseTaskUrl(question)
  const projectList = urlTask ? [] : await doorayService.listProjects().catch(() => [])
  const mailList = mailStore.listMails({}, 30)

  const raw = await askClaude(
    buildExtractPrompt({ question, hasUrl: !!urlTask, projectList, mailList }),
    { cwd, feature: 'file_attach' }
  )
  const extracted = parseExtracted(raw)

  // ---- 업무 후보 ----
  let taskGuess = null
  if (urlTask) {
    let subject = ''
    try {
      const detail = await doorayService.getPost?.(urlTask.projectId, urlTask.postId)
      subject = detail?.subject || ''
    } catch { /* 제목 조회 실패해도 링크로 계속 진행 */ }
    taskGuess = { projectId: urlTask.projectId, postId: urlTask.postId, subject, projectLabel: '' }
  } else {
    const idx = Number(extracted.projectNumber) - 1
    const project = projectList[idx]
    if (!project) {
      return { ok: false, error: '어느 프로젝트인지 못 찾았어요. 프로젝트 이름을 조금 더 구체적으로 말해주거나, 업무 링크를 붙여주세요.' }
    }
    if (!extracted.taskTitleKeyword) {
      return { ok: false, error: '업무 제목에서 어떤 단어로 찾아야 할지 못 알아냈어요. 업무 제목의 일부를 같이 말해주세요.' }
    }
    const candidates = await doorayService.searchPostsByTitle(project.id, extracted.taskTitleKeyword, 5).catch(() => [])
    if (!candidates.length) {
      return { ok: false, error: `"${project.code || project.description}" 프로젝트에서 "${extracted.taskTitleKeyword}"가 들어간 업무를 못 찾았어요.` }
    }
    const best = candidates[0]
    taskGuess = {
      projectId: project.id,
      postId: best.id,
      subject: best.subject || '',
      projectLabel: project.code || project.description || project.id
    }
  }

  // ---- 파일 후보 ----
  let fileGuess = null
  if (extracted.sourceType === 'local' && extracted.localPath) {
    if (!fs.existsSync(extracted.localPath)) {
      return { ok: false, error: `이 컴퓨터에서 그 파일을 못 찾았어요: ${extracted.localPath}` }
    }
    fileGuess = { type: 'local', localPath: extracted.localPath, label: path.basename(extracted.localPath) }
  } else if (extracted.sourceType === 'mail') {
    const idx = Number(extracted.mailNumber) - 1
    const mail = mailList[idx]
    if (!mail) {
      return { ok: false, error: '어떤 메일인지 못 찾았어요. 메일 제목에 들어있는 단어를 조금 더 구체적으로 말해주세요.' }
    }
    fileGuess = { type: 'mail', mailId: mail.id, mailSubject: mail.subject, attachmentName: extracted.attachmentName, label: `메일 "${mail.subject}"의 첨부파일${extracted.attachmentName ? ` "${extracted.attachmentName}"` : ''}` }
  } else {
    return { ok: false, error: '파일을 컴퓨터 경로로 알려주거나, "메일에 있는 첨부파일"이라고 구체적으로 말해주세요.' }
  }

  pendingByChannel.set(channelId, {
    senderId,
    createdAt: Date.now(),
    guess: { task: taskGuess, file: fileGuess }
  })

  const taskLabel = taskGuess.subject
    ? `${taskGuess.projectLabel ? `[${taskGuess.projectLabel}] ` : ''}"${taskGuess.subject}"`
    : `업무(project ${taskGuess.projectId} / post ${taskGuess.postId})`

  const replyText =
    `이렇게 이해했어요:\n` +
    `· 업무: ${taskLabel}\n` +
    `· 파일: ${fileGuess.label}\n` +
    `맞으면 "네"라고 답해주세요 (다시 멘션해서). 아니면 다시 말씀해주세요. (10분 안에 답 없으면 잊어버려요)`

  return { ok: true, replyText }
}

// 2단계: pending으로 저장해둔 추측대로 실제 파일을 찾아 업로드합니다.
async function confirmAndExecute({ doorayService, mailStore, mailImap, tokenStore, cfg, channelId }) {
  const pending = pendingByChannel.get(channelId)
  clearPending(channelId)
  if (!pending) return { ok: false, error: '확인할 내용이 없어요 (시간이 지나 잊어버렸을 수 있어요). 다시 말씀해주세요.' }

  const { task, file } = pending.guess
  let localPath = ''
  let cleanupPath = ''

  if (file.type === 'local') {
    if (!fs.existsSync(file.localPath)) {
      return { ok: false, error: `이 컴퓨터에서 그 파일을 못 찾았어요: ${file.localPath}` }
    }
    localPath = file.localPath
  } else {
    if (!cfg.imapEnabled) {
      return { ok: false, error: '메일 첨부파일을 가져오려면 설정 탭에서 IMAP을 먼저 켜야 해요.' }
    }
    const mail = mailStore.getMailById(file.mailId)
    if (!mail) {
      return { ok: false, error: '그 메일을 더는 찾을 수 없어요 (삭제됐거나 저장 기간이 지났을 수 있어요).' }
    }
    const password = await tokenStore.getImapPassword().catch(() => null)
    if (!password) {
      return { ok: false, error: 'IMAP 비밀번호가 저장되어 있지 않아요. 설정 탭에서 먼저 등록해주세요.' }
    }
    const r = await mailImap.fetchAttachment(
      { user: cfg.imapUser, password, host: cfg.imapHost },
      mail,
      { filenameQuery: file.attachmentName }
    )
    if (!r.ok) return { ok: false, error: r.error }
    localPath = r.localPath
    cleanupPath = r.localPath
  }

  try {
    await doorayService.uploadPostFile(task.projectId, task.postId, localPath)
    return { ok: true, fileLabel: file.label, taskUrl: `${task.projectId}/${task.postId}` }
  } finally {
    if (cleanupPath) {
      try { fs.unlinkSync(cleanupPath) } catch { /* 무시 */ }
    }
  }
}

module.exports = {
  isAttachFileCommand,
  judgeAttachIntent,
  hasPendingConfirm,
  classifyReply,
  clearPending,
  proposeAttachFile,
  confirmAndExecute
}
