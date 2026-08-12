// (2026-08-11 신규) 채팅으로 두레이 업무를 완료 처리하는 흐름.
// "@두레이봇 OO 업무 완료 처리해줘" → 내 담당 업무 중에서 어느 것인지 AI로 추측 →
// "이 업무를 완료 처리할까요?" 확인 → 승인해야만 실제로 상태를 바꿉니다.
// 캘린더 수정/삭제(calendarEventAutomation.js)와 같은 "추측 → 확인 → 실행" 구조입니다.

const PENDING_TTL_MS = 10 * 60 * 1000
const SUBJECT_WORDS = ['업무', '태스크']
const ACTION_WORDS = ['완료', '끝냈', '끝내', '마감 처리', '닫아']

// channelId -> { senderId, createdAt, target }
const pendingByChannel = new Map()

function isCompleteTaskCommand(text) {
  const t = (text || '').replace(/\s+/g, '')
  return SUBJECT_WORDS.some((w) => t.includes(w)) && ACTION_WORDS.some((w) => t.includes(w.replace(/\s+/g, '')))
}

function cleanupExpired(channelId) {
  const p = pendingByChannel.get(channelId)
  if (p && Date.now() - p.createdAt > PENDING_TTL_MS) pendingByChannel.delete(channelId)
}

function hasPendingTaskComplete(channelId, senderId) {
  cleanupExpired(channelId)
  const p = pendingByChannel.get(channelId)
  return !!(p && p.senderId === senderId)
}

function clearTaskCompletePending(channelId) {
  pendingByChannel.delete(channelId)
}

function extractBetween(text, start, end) {
  const s = text.indexOf(start)
  if (s === -1) return null
  const e = text.indexOf(end, s + start.length)
  if (e === -1) return null
  return text.slice(s + start.length, e).trim()
}

// 어느 업무를 말하는 건지 추측해서 확인을 요청합니다.
async function proposeTaskComplete({ doorayService, myMemberId, question, cwd, askClaude, channelId, senderId, log = () => {} }) {
  let tasks = []
  try {
    tasks = await doorayService.listMyTasks(myMemberId, { log })
  } catch (err) {
    return { ok: false, error: `담당 업무 목록을 못 가져왔어요: ${err.message}` }
  }
  tasks = (tasks || []).slice(0, 40)
  if (!tasks.length) {
    return { ok: false, error: '완료 처리할 담당 업무를 못 찾았어요 (열려 있는 담당 업무가 없어요).' }
  }

  const lines = tasks.map((t, i) => `${i + 1}. [${t.projectCode || '?'}] ${t.subject}`).join('\n')
  const prompt = [
    '당신은 업무 비서입니다. 사용자가 아래 업무 목록 중 하나를 완료 처리하려고 합니다.',
    '',
    '[열려 있는 담당 업무 목록]',
    lines,
    '',
    '[사용자 요청]',
    question,
    '',
    '다음 마커 형식으로만 답하세요 (설명 금지):',
    '[TASK_INDEX]대상 업무의 번호 (제목·프로젝트 단서로 특정할 수 없으면 none)[/TASK_INDEX]',
    '',
    '규칙: 확실하지 않으면 반드시 none. 절대 아무거나 고르지 마세요.'
  ].join('\n')

  const raw = await askClaude(prompt, { cwd, feature: 'task_complete_extract' })
  const idxRaw = (extractBetween(raw, '[TASK_INDEX]', '[/TASK_INDEX]') || '').trim()
  const idx = /^\d+$/.test(idxRaw) ? Number(idxRaw) - 1 : -1
  if (idx < 0 || idx >= tasks.length) {
    return {
      ok: false,
      error: `어느 업무인지 특정하지 못했어요. 지금 열려 있는 담당 업무는 이래요:\n${lines}\n제목을 함께 말씀해주세요.`
    }
  }
  const target = tasks[idx]

  pendingByChannel.set(channelId, { senderId, createdAt: Date.now(), target })
  return {
    ok: true,
    replyText: [
      '이 업무를 완료 처리할까요?',
      `· [${target.projectCode || '?'}] ${target.subject}`,
      '맞으면 다시 멘션해서 "네"라고 답해주세요. 아니면 다시 말씀해주세요. (10분 안에 답 없으면 잊어버려요)'
    ].join('\n')
  }
}

// 승인 후 실제 완료 처리.
async function confirmAndExecuteTaskComplete({ doorayService, channelId }) {
  const pending = pendingByChannel.get(channelId)
  clearTaskCompletePending(channelId)
  if (!pending) {
    return { ok: false, error: '확인할 내용이 없어요 (시간이 지나 잊어버렸을 수 있어요). 다시 말씀해주세요.' }
  }
  const t = pending.target
  try {
    await doorayService.setTaskDone(t.projectId, t.id)
    return { ok: true, subject: t.subject, projectCode: t.projectCode }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

module.exports = {
  isCompleteTaskCommand,
  hasPendingTaskComplete,
  clearTaskCompletePending,
  proposeTaskComplete,
  confirmAndExecuteTaskComplete
}
