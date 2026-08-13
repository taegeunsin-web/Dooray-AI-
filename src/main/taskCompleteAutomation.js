// (2026-08-11 신규) 채팅으로 두레이 업무를 완료 처리하는 흐름.
// "@두레이봇 OO 업무 완료 처리해줘" → 내 담당 업무 중에서 어느 것인지 AI로 추측 →
// "이 업무를 완료 처리할까요?" 확인 → 승인해야만 실제로 상태를 바꿉니다.
// 캘린더 수정/삭제(calendarEventAutomation.js)와 같은 "추측 → 확인 → 실행" 구조입니다.

const PENDING_TTL_MS = 10 * 60 * 1000
const SUBJECT_WORDS = ['업무', '태스크']
const ACTION_WORDS = ['완료', '끝냈', '끝내', '마감 처리', '닫아']

// (2026-08-13 추가) "OO 업무에 진행상황 반영해줘" — 채팅으로 업무 본문을 갱신하는 명령 감지.
// mentionBot에서 완료 명령보다 먼저 검사해야 합니다 — "3번 완료했다고 본문에 반영해줘"처럼
// '완료'가 섞여 있어도 반영/본문 계열 단어가 있으면 본문 갱신이 의도이기 때문입니다.
function isUpdateTaskBodyCommand(text) {
  const t = (text || '').replace(/\s+/g, '')
  if (!SUBJECT_WORDS.some((w) => t.includes(w))) return false
  // "…라고 반영해줘/업데이트해줘"는 그 자체로 본문 갱신 의도입니다.
  if (/(반영|업데이트|갱신|기록)/.test(t)) return true
  // "본문/내용/현황 수정(고쳐)줘"도 본문 갱신으로 봅니다.
  return /(진행상황|진행현황|현황|본문|내용)/.test(t) && /(수정|고쳐)/.test(t)
}

// (2026-08-13 추가) "OO 업무 기한 금요일로 미뤄줘" / "담당자 김준수로 바꿔줘" — 기한·담당자
// 변경 명령 감지. mentionBot에서 단계 변경보다 먼저 검사해야 합니다 — "담당자 OO로 바꿔줘"가
// 단계 변경 규칙((으)로 바꿔)에도 걸리기 때문입니다.
function isEditTaskMetaCommand(text) {
  const t = (text || '').replace(/\s+/g, '')
  if (!SUBJECT_WORDS.some((w) => t.includes(w))) return false
  const dueWords = /(기한|마감일|만기|듀데이트|마감)/.test(t) && /(바꿔|바꾸|변경|미뤄|미루|당겨|연기|연장|늘려|옮겨|수정|지정)/.test(t)
  const assigneeWords = /(담당자|담당)/.test(t) && /(바꿔|바꾸|변경|지정|넘겨|수정|교체|추가|넣어)/.test(t)
  // (2026-08-13 확장) 제목/우선순위/태그/마일스톤/참조자도 같은 확인 흐름으로 처리
  const titleWords = /제목/.test(t) && /(바꿔|바꾸|변경|수정)/.test(t)
  const prioWords = /(우선순위|중요도)/.test(t) && /(바꿔|바꾸|변경|올려|내려|지정|높|낮|으로|로)/.test(t)
  const tagWords = /태그/.test(t) && /(붙여|달아|추가|바꿔|변경|지정|넣어)/.test(t)
  const msWords = /마일스톤/.test(t) && /(바꿔|바꾸|변경|지정|넣어|잡아|으로|로)/.test(t)
  const ccWords = /(참조자|참조)/.test(t) && /(추가|넣어|지정|올려)/.test(t)
  return dueWords || assigneeWords || titleWords || prioWords || tagWords || msWords || ccWords
}

// (2026-08-12 추가) "OO 업무 진행중으로 바꿔줘" / "업무 단계 변경해줘" — 단계 변경 명령 감지.
// mentionBot에서 완료 명령(isCompleteTaskCommand)을 먼저 검사하므로, "완료 처리해줘"류는
// 여전히 완료 흐름으로 갑니다.
function isChangeTaskStageCommand(text) {
  const t = (text || '').replace(/\s+/g, '')
  if (!SUBJECT_WORDS.some((w) => t.includes(w))) return false
  if (/(으로|로)(바꿔|바꾸|변경|옮겨)/.test(t)) return true
  return /(단계|상태)/.test(t) && /(바꿔|바꾸|변경|옮겨|조정)/.test(t)
}

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

  pendingByChannel.set(channelId, { senderId, createdAt: Date.now(), kind: 'done', target })
  return {
    ok: true,
    replyText: [
      '이 업무를 완료 처리할까요?',
      `· [${target.projectCode || '?'}] ${target.subject}`,
      '맞으면 다시 멘션해서 "네"라고 답해주세요. 아니면 다시 말씀해주세요. (10분 안에 답 없으면 잊어버려요)'
    ].join('\n')
  }
}

// (2026-08-12 추가) 어느 업무를 어느 단계로 바꾸려는 건지 추측해 확인을 요청합니다.
async function proposeTaskStageChange({ doorayService, myMemberId, question, cwd, askClaude, channelId, senderId, log = () => {} }) {
  let tasks = []
  try {
    tasks = await doorayService.listMyTasks(myMemberId, { log })
  } catch (err) {
    return { ok: false, error: `담당 업무 목록을 못 가져왔어요: ${err.message}` }
  }
  tasks = (tasks || []).slice(0, 40)
  if (!tasks.length) {
    return { ok: false, error: '단계를 바꿀 담당 업무를 못 찾았어요 (열려 있는 담당 업무가 없어요).' }
  }

  const lines = tasks.map((t, i) => `${i + 1}. [${t.projectCode || '?'}] ${t.subject} (지금: ${t.workflowName || t.workflowClass || '?'})`).join('\n')
  const prompt = [
    '당신은 업무 비서입니다. 사용자가 아래 업무 목록 중 하나의 단계(상태)를 바꾸려고 합니다.',
    '',
    '[열려 있는 담당 업무 목록]',
    lines,
    '',
    '[사용자 요청]',
    question,
    '',
    '다음 마커 형식으로만 답하세요 (설명 금지):',
    '[TASK_INDEX]대상 업무의 번호 (제목·프로젝트 단서로 특정할 수 없으면 none)[/TASK_INDEX]',
    '[STAGE]사용자가 원하는 단계 이름 그대로 (예: 진행중, 검수, 완료 / 모르겠으면 none)[/STAGE]',
    '',
    '규칙: 확실하지 않으면 반드시 none. 절대 아무거나 고르지 마세요.'
  ].join('\n')

  const raw = await askClaude(prompt, { cwd, feature: 'task_stage_extract' })
  const idxRaw = (extractBetween(raw, '[TASK_INDEX]', '[/TASK_INDEX]') || '').trim()
  const stageRaw = (extractBetween(raw, '[STAGE]', '[/STAGE]') || '').trim()
  const idx = /^\d+$/.test(idxRaw) ? Number(idxRaw) - 1 : -1
  if (idx < 0 || idx >= tasks.length) {
    return {
      ok: false,
      error: `어느 업무인지 특정하지 못했어요. 지금 열려 있는 담당 업무는 이래요:\n${lines}\n제목을 함께 말씀해주세요.`
    }
  }
  const target = tasks[idx]

  let workflows = []
  try {
    workflows = await doorayService.listProjectWorkflows(target.projectId)
  } catch (err) {
    return { ok: false, error: `이 프로젝트의 단계 목록을 못 가져왔어요: ${err.message}` }
  }
  const stageNames = workflows.map((w) => w.name).join(', ')
  const wf = matchWorkflow(workflows, stageRaw)
  if (!wf) {
    return { ok: false, error: `"${stageRaw || '?'}" 단계를 이 프로젝트에서 못 찾았어요. 고를 수 있는 단계: ${stageNames || '(없음)'}` }
  }

  pendingByChannel.set(channelId, { senderId, createdAt: Date.now(), kind: 'stage', target, workflow: wf })
  return {
    ok: true,
    replyText: [
      `이 업무의 단계를 '${wf.name}'(으)로 바꿀까요?`,
      `· [${target.projectCode || '?'}] ${target.subject} (지금: ${target.workflowName || '?'})`,
      '맞으면 다시 멘션해서 "네"라고 답해주세요. 아니면 다시 말씀해주세요. (10분 안에 답 없으면 잊어버려요)'
    ].join('\n')
  }
}

// (2026-08-13 추가) 어느 업무의 본문을 어떻게 갱신하려는 건지 추측하고, AI 초안을 만들어
// 미리보기와 함께 확인을 요청합니다. buildDraft에는 index.js의 proposeTaskBodyDraft가 들어옵니다
// — 대시보드의 "AI로 반영 초안 만들기"와 같은 로직, 같은 양식 규칙을 씁니다.
async function proposeTaskBodyUpdate({ doorayService, myMemberId, question, cwd, askClaude, buildDraft, channelId, senderId, log = () => {} }) {
  let tasks = []
  try {
    tasks = await doorayService.listMyTasks(myMemberId, { log })
  } catch (err) {
    return { ok: false, error: `담당 업무 목록을 못 가져왔어요: ${err.message}` }
  }
  tasks = (tasks || []).slice(0, 40)
  if (!tasks.length) {
    return { ok: false, error: '본문을 고칠 담당 업무를 못 찾았어요 (열려 있는 담당 업무가 없어요).' }
  }

  const lines = tasks.map((t, i) => `${i + 1}. [${t.projectCode || '?'}] ${t.subject}`).join('\n')
  const prompt = [
    '당신은 업무 비서입니다. 사용자가 아래 업무 목록 중 하나의 본문(진행 현황)을 갱신하려고 합니다.',
    '',
    '[열려 있는 담당 업무 목록]',
    lines,
    '',
    '[사용자 요청]',
    question,
    '',
    '다음 마커 형식으로만 답하세요 (설명 금지):',
    '[TASK_INDEX]대상 업무의 번호 (제목·프로젝트 단서로 특정할 수 없으면 none)[/TASK_INDEX]',
    '[PROGRESS]본문에 반영할 진행 상황만 뽑아서 한두 문장으로 (예: 3번 완료, 4번 진행 중 / 없으면 none)[/PROGRESS]',
    '',
    '규칙: 확실하지 않으면 반드시 none. 절대 아무거나 고르지 마세요.'
  ].join('\n')

  const raw = await askClaude(prompt, { cwd, feature: 'task_body_extract' })
  const idxRaw = (extractBetween(raw, '[TASK_INDEX]', '[/TASK_INDEX]') || '').trim()
  const progress = (extractBetween(raw, '[PROGRESS]', '[/PROGRESS]') || '').trim()
  const idx = /^\d+$/.test(idxRaw) ? Number(idxRaw) - 1 : -1
  if (idx < 0 || idx >= tasks.length) {
    return {
      ok: false,
      error: `어느 업무인지 특정하지 못했어요. 지금 열려 있는 담당 업무는 이래요:\n${lines}\n제목을 함께 말씀해주세요.`
    }
  }
  if (!progress || progress.toLowerCase() === 'none') {
    return { ok: false, error: '반영할 진행 상황을 못 읽었어요. 예: "OO 업무에 3번 끝냈고 4번 진행 중이라고 반영해줘"' }
  }
  const target = tasks[idx]

  let draft
  try {
    draft = await buildDraft(target.projectId, target.id, progress)
  } catch (err) {
    return { ok: false, error: `초안을 만들다 실패했어요: ${err.message}` }
  }
  if (!draft || !draft.ok) return { ok: false, error: (draft && draft.error) || '초안을 만들지 못했어요.' }

  pendingByChannel.set(channelId, { senderId, createdAt: Date.now(), kind: 'body', target, proposed: draft.proposed })
  const preview = draft.proposed.length > 1200
    ? draft.proposed.slice(0, 1200) + '\n…(길어서 뒷부분 생략 — 저장할 때는 전체가 반영돼요)'
    : draft.proposed
  return {
    ok: true,
    replyText: [
      `[${target.projectCode || '?'}] ${target.subject} 본문을 이렇게 고칠게요:`,
      '─────────────',
      preview,
      '─────────────',
      '맞으면 다시 멘션해서 "네"라고 답해주세요. 아니면 다시 말씀해주세요. (10분 안에 답 없으면 잊어버려요)'
    ].join('\n')
  }
}

// (2026-08-13 확장) 어느 업무의 무엇(기한/담당자/제목/우선순위/태그/마일스톤/참조자)을
// 어떻게 바꾸려는 건지 추측해 확인을 요청합니다. 실행은 "네" 승인 후에만 (기존 확인 흐름 그대로).
function mapPriority(word) {
  const t = String(word || '').toLowerCase().replace(/\s+/g, '')
  if (!t || t === 'none') return null
  if (/(최상|매우높|긴급|highest)/.test(t)) return 'highest'
  if (/(최하|매우낮|lowest)/.test(t)) return 'lowest'
  if (/(높|상|high)/.test(t)) return 'high'
  if (/(보통|중간|normal)/.test(t)) return 'normal'
  if (/(낮|하|low)/.test(t)) return 'low'
  return null
}
const PRIORITY_KO = { highest: '최상', high: '상', normal: '보통', low: '하', lowest: '최하' }

async function proposeTaskMetaChange({ doorayService, myMemberId, question, cwd, askClaude, channelId, senderId, log = () => {} }) {
  let tasks = []
  try {
    tasks = await doorayService.listMyTasks(myMemberId, { log })
  } catch (err) {
    return { ok: false, error: `담당 업무 목록을 못 가져왔어요: ${err.message}` }
  }
  tasks = (tasks || []).slice(0, 40)
  if (!tasks.length) {
    return { ok: false, error: '바꿀 담당 업무를 못 찾았어요 (열려 있는 담당 업무가 없어요).' }
  }

  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const todayIso = kst.toISOString().slice(0, 10)
  const dayNames = ['일', '월', '화', '수', '목', '금', '토']
  const todayLabel = `${todayIso}(${dayNames[kst.getUTCDay()]})`

  const lines = tasks.map((t, i) => `${i + 1}. [${t.projectCode || '?'}] ${t.subject}${t.dueDate ? ` (기한: ${String(t.dueDate).slice(0, 10)})` : ''}`).join('\n')
  const prompt = [
    '당신은 업무 비서입니다. 사용자가 아래 업무 목록 중 하나의 속성을 바꾸려고 합니다.',
    `오늘은 ${todayLabel}입니다. "내일", "금요일", "다음주 수요일" 같은 상대 날짜는 이 기준으로 계산하세요.`,
    '',
    '[열려 있는 담당 업무 목록]',
    lines,
    '',
    '[사용자 요청]',
    question,
    '',
    '다음 마커 형식으로만 답하세요 (설명 금지, 해당 없는 항목은 none):',
    '[TASK_INDEX]대상 업무의 번호 (특정할 수 없으면 none)[/TASK_INDEX]',
    '[DUE_DATE]바꿀 기한 YYYY-MM-DD[/DUE_DATE]',
    '[ASSIGNEE]담당자를 이 사람으로 교체[/ASSIGNEE]',
    '[ASSIGNEE_ADD]기존 담당자를 유지하며 추가할 사람들 (쉼표 구분)[/ASSIGNEE_ADD]',
    '[CC_ADD]참조자로 추가할 사람들 (쉼표 구분)[/CC_ADD]',
    '[TITLE]바꿀 새 제목[/TITLE]',
    '[PRIORITY]우선순위 (최상/상/보통/하/최하 중 하나)[/PRIORITY]',
    '[TAGS_ADD]붙일 태그 이름들 (쉼표 구분)[/TAGS_ADD]',
    '[MILESTONE]지정할 마일스톤 이름[/MILESTONE]',
    '',
    '규칙: 확실하지 않으면 반드시 none. 절대 아무거나 고르지 마세요.'
  ].join('\n')

  const raw = await askClaude(prompt, { cwd, feature: 'task_meta_extract' })
  const g = (a, b) => {
    const v = (extractBetween(raw, a, b) || '').trim()
    return (!v || v.toLowerCase() === 'none') ? null : v
  }
  const idxRaw = (extractBetween(raw, '[TASK_INDEX]', '[/TASK_INDEX]') || '').trim()
  const idx = /^\d+$/.test(idxRaw) ? Number(idxRaw) - 1 : -1
  if (idx < 0 || idx >= tasks.length) {
    return {
      ok: false,
      error: `어느 업무인지 특정하지 못했어요. 지금 열려 있는 담당 업무는 이래요:\n${lines}\n제목을 함께 말씀해주세요.`
    }
  }
  const target = tasks[idx]

  const dueRaw = g('[DUE_DATE]', '[/DUE_DATE]')
  const dueDate = dueRaw && /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? dueRaw : null
  const title = g('[TITLE]', '[/TITLE]')
  const priority = mapPriority(g('[PRIORITY]', '[/PRIORITY]'))
  const splitNames = (v) => (v || '').split(',').map((x) => x.trim()).filter(Boolean)
  const assigneeName = g('[ASSIGNEE]', '[/ASSIGNEE]')
  const assigneeAddNames = splitNames(g('[ASSIGNEE_ADD]', '[/ASSIGNEE_ADD]'))
  const ccAddNames = splitNames(g('[CC_ADD]', '[/CC_ADD]'))
  const tagAddNames = splitNames(g('[TAGS_ADD]', '[/TAGS_ADD]'))
  const milestoneName = g('[MILESTONE]', '[/MILESTONE]')

  if (!dueDate && !title && !priority && !assigneeName && !assigneeAddNames.length && !ccAddNames.length && !tagAddNames.length && !milestoneName) {
    return { ok: false, error: '바꿀 내용을 못 읽었어요. 예: "OO 업무 기한 금요일로 미뤄줘", "제목 ~로 바꿔줘", "우선순위 높음으로", "태그 OO 붙여줘"' }
  }

  // 사람 이름 → 계정 찾기. 동명이인이면 nhnad(우리 회사) 계정 우선, 그래도 애매하면 물어봅니다.
  const resolveOne = async (name) => {
    let candidates = []
    try {
      candidates = doorayService.sortMembersNhnadFirst(await doorayService.searchMembersByName(name))
    } catch (err) {
      return { error: `'${name}' 계정 검색에 실패했어요: ${err.message}` }
    }
    if (!candidates.length) return { error: `'${name}' 계정을 못 찾았어요. 정확한 이름으로 다시 말씀해주세요.` }
    const nhnadOnly = candidates.filter((c) => doorayService.isNhnadMember(c))
    const picked = candidates.length === 1 ? candidates[0] : (nhnadOnly.length === 1 ? nhnadOnly[0] : null)
    if (!picked) {
      const opts = candidates.slice(0, 8).map((c) => `${c.name}${c.userCode ? `(${c.userCode})` : ''}`).join(', ')
      return { error: `'${name}' 후보가 여러 명이에요: ${opts}\n아이디(괄호 안)까지 붙여서 다시 말씀해주세요.` }
    }
    return { member: { id: picked.id, name: picked.name || name, userCode: picked.userCode || '' } }
  }
  let assignee = null
  if (assigneeName) {
    const r = await resolveOne(assigneeName)
    if (r.error) return { ok: false, error: r.error }
    assignee = r.member
  }
  const assigneeAdd = []
  for (const n of assigneeAddNames) {
    const r = await resolveOne(n)
    if (r.error) return { ok: false, error: r.error }
    assigneeAdd.push(r.member)
  }
  const ccAdd = []
  for (const n of ccAddNames) {
    const r = await resolveOne(n)
    if (r.error) return { ok: false, error: r.error }
    ccAdd.push(r.member)
  }

  // 태그 이름 → id (기존 태그는 유지하고 추가)
  let tagIds = null
  let tagLabel = ''
  if (tagAddNames.length) {
    let projTags = []
    try {
      projTags = await doorayService.listProjectTags(target.projectId)
    } catch (err) {
      return { ok: false, error: `태그 목록을 못 가져왔어요: ${err.message}` }
    }
    const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, '')
    const matched = []
    for (const n of tagAddNames) {
      const hit = projTags.find((t) => norm(t.name) === norm(n)) || projTags.find((t) => norm(t.name).includes(norm(n)))
      if (!hit) return { ok: false, error: `'${n}' 태그를 이 프로젝트에서 못 찾았어요. 있는 태그: ${projTags.map((t) => t.name).join(', ') || '(없음)'}` }
      matched.push(hit)
    }
    let existing = []
    try {
      const post = await doorayService.getPost(target.projectId, target.id)
      existing = (post?.tags || []).map((t) => String(t.id || t.tagId || '')).filter(Boolean)
    } catch { existing = [] }
    tagIds = Array.from(new Set([...existing, ...matched.map((t) => String(t.id))]))
    tagLabel = matched.map((t) => t.name).join(', ')
  }

  // 마일스톤 이름 → id (열려 있는 것에서 찾기)
  let milestone = null
  if (milestoneName) {
    let list = []
    try {
      list = await doorayService.listProjectMilestones(target.projectId)
    } catch (err) {
      return { ok: false, error: `마일스톤 목록을 못 가져왔어요: ${err.message}` }
    }
    const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, '')
    const open = list.filter((m) => m.status !== 'closed')
    const hit = open.find((m) => norm(m.name) === norm(milestoneName)) ||
      open.find((m) => norm(m.name).includes(norm(milestoneName)) || norm(milestoneName).includes(norm(m.name)))
    if (!hit) return { ok: false, error: `'${milestoneName}' 마일스톤을 못 찾았어요. 열려 있는 마일스톤: ${open.map((m) => m.name).join(', ') || '(없음)'}` }
    milestone = hit
  }

  pendingByChannel.set(channelId, {
    senderId, createdAt: Date.now(), kind: 'meta', target,
    dueDate, assignee, assigneeAdd, ccAdd, title, priority, tagIds, tagLabel, milestone
  })
  const changeLines = []
  if (title) changeLines.push(`· 제목: → ${title}`)
  if (dueDate) changeLines.push(`· 기한: ${String(target.dueDate || '').slice(0, 10) || '(없음)'} → ${dueDate}`)
  if (assignee) changeLines.push(`· 담당자(교체): → ${assignee.name}${assignee.userCode ? `(${assignee.userCode})` : ''}`)
  if (assigneeAdd.length) changeLines.push(`· 담당자 추가: ${assigneeAdd.map((m) => m.name).join(', ')}`)
  if (ccAdd.length) changeLines.push(`· 참조자 추가: ${ccAdd.map((m) => m.name).join(', ')}`)
  if (priority) changeLines.push(`· 우선순위: → ${PRIORITY_KO[priority]}`)
  if (tagIds) changeLines.push(`· 태그 추가: ${tagLabel}`)
  if (milestone) changeLines.push(`· 마일스톤: → ${milestone.name}`)
  return {
    ok: true,
    replyText: [
      '이 업무를 이렇게 바꿀까요?',
      `· [${target.projectCode || '?'}] ${target.subject}`,
      ...changeLines,
      '맞으면 다시 멘션해서 "네"라고 답해주세요. 아니면 다시 말씀해주세요. (10분 안에 답 없으면 잊어버려요)'
    ].join('\n')
  }
}

// 단계 이름 맞추기 — 정확히 일치 > 부분 일치 > 흔한 표현(등록/진행/완료)의 종류(class) 순서로 찾습니다.
function matchWorkflow(workflows, wanted) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')
  const w = norm(wanted)
  if (!w || w === 'none') return null
  let hit = workflows.find((x) => norm(x.name) === w)
  if (hit) return hit
  hit = workflows.find((x) => norm(x.name).includes(w) || w.includes(norm(x.name)))
  if (hit) return hit
  const classMap = [
    [/등록|대기|백로그|할일/, ['registered', 'backlog']],
    [/진행|작업|working/, ['working']],
    [/완료|끝|닫|done|closed/, ['closed']]
  ]
  for (const [re, classes] of classMap) {
    if (re.test(w)) {
      hit = workflows.find((x) => classes.includes(x.class))
      if (hit) return hit
    }
  }
  return null
}

// 승인 후 실제 실행 — 완료 처리(kind 'done')와 단계 변경(kind 'stage')을 함께 다룹니다.
async function confirmAndExecuteTaskComplete({ doorayService, channelId }) {
  const pending = pendingByChannel.get(channelId)
  clearTaskCompletePending(channelId)
  if (!pending) {
    return { ok: false, error: '확인할 내용이 없어요 (시간이 지나 잊어버렸을 수 있어요). 다시 말씀해주세요.' }
  }
  const t = pending.target
  try {
    if (pending.kind === 'stage') {
      await doorayService.setTaskWorkflow(t.projectId, t.id, pending.workflow.id)
      return { ok: true, kind: 'stage', subject: t.subject, projectCode: t.projectCode, stageName: pending.workflow.name }
    }
    if (pending.kind === 'body') {
      await doorayService.updatePostBody(t.projectId, t.id, String(pending.proposed))
      return { ok: true, kind: 'body', subject: t.subject, projectCode: t.projectCode }
    }
    if (pending.kind === 'meta') {
      const changes = {}
      if (pending.title) changes.subject = pending.title
      if (pending.dueDate) changes.dueDate = pending.dueDate
      if (pending.assignee) changes.assigneeMemberId = pending.assignee.id
      if ((pending.assigneeAdd || []).length) changes.addAssigneeMemberIds = pending.assigneeAdd.map((m) => m.id)
      if ((pending.ccAdd || []).length) changes.addCcMemberIds = pending.ccAdd.map((m) => m.id)
      if (pending.priority) changes.priority = pending.priority
      if (pending.tagIds) changes.tagIds = pending.tagIds
      if (pending.milestone) changes.milestoneId = pending.milestone.id
      await doorayService.updatePostMeta(t.projectId, t.id, changes)
      const parts = []
      if (pending.title) parts.push(`제목을 "${pending.title}"(으)로`)
      if (pending.dueDate) parts.push(`기한을 ${pending.dueDate}(으)로`)
      if (pending.assignee) parts.push(`담당자를 ${pending.assignee.name}(으)로`)
      if ((pending.assigneeAdd || []).length) parts.push(`담당자에 ${pending.assigneeAdd.map((m) => m.name).join('·')} 추가`)
      if ((pending.ccAdd || []).length) parts.push(`참조자에 ${pending.ccAdd.map((m) => m.name).join('·')} 추가`)
      if (pending.priority) parts.push(`우선순위를 ${PRIORITY_KO[pending.priority]}(으)로`)
      if (pending.tagIds) parts.push(`태그 ${pending.tagLabel} 추가`)
      if (pending.milestone) parts.push(`마일스톤을 ${pending.milestone.name}(으)로`)
      return { ok: true, kind: 'meta', subject: pending.title || t.subject, projectCode: t.projectCode, metaLabel: `${parts.join(', ')} — 변경했어요` }
    }
    await doorayService.setTaskDone(t.projectId, t.id)
    return { ok: true, kind: 'done', subject: t.subject, projectCode: t.projectCode }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

module.exports = {
  isCompleteTaskCommand,
  isChangeTaskStageCommand,
  isUpdateTaskBodyCommand,
  isEditTaskMetaCommand,
  hasPendingTaskComplete,
  clearTaskCompletePending,
  proposeTaskComplete,
  proposeTaskStageChange,
  proposeTaskBodyUpdate,
  proposeTaskMetaChange,
  confirmAndExecuteTaskComplete
}
