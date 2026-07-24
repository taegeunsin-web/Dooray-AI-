// 채팅방에서 "@트리거 태스크 만들어줘" 같은 문구가 감지되면, 그 채팅방에 연결된
// 두레이 템플릿을 실제 대화 내용으로 채워서 업무를 자동 생성하는 로직.
// - 확실하지 않은 항목은 추측하지 않고 템플릿 원본 그대로 비워둡니다.
// - 소재유형 같은 체크박스는 대화에서 명확히 언급된 항목만 체크합니다.

// askClaude는 mentionBot.js에서 넘겨받아 씁니다 (순환 참조 방지를 위해 여기서 직접 require하지 않음).

// "태스크/업무" + "만들어/생성/올려" 조합이면 생성 명령으로 인식 (띄어쓰기 무시하고 비교)
const SUBJECT_WORDS = ['태스크', '업무']
const ACTION_WORDS = ['만들어', '생성', '올려', '등록']

function isCreateTaskCommand(text) {
  const t = (text || '').replace(/\s+/g, '')
  const hasSubject = SUBJECT_WORDS.some((w) => t.includes(w))
  const hasAction = ACTION_WORDS.some((w) => t.includes(w))
  return hasSubject && hasAction
}

function findAutomationForChannel(automations, channelId) {
  return (automations || []).find((a) => a.channelId === channelId)
}

// 예전에는 AI가 JSON 하나로 답하게 했는데, 템플릿 본문에 줄바꿈/따옴표가 섞여 있으면
// AI가 JSON 문법을 깨뜨려서("Expected ',' or '}' ..." 오류) 파싱이 실패하는 경우가 있었습니다.
// 그래서 JSON 대신, 아래 표시(태그) 사이에 내용을 그대로(이스케이프 없이) 적게 하는 방식으로
// 바꿨습니다. 줄바꿈이나 따옴표가 들어있어도 깨질 일이 없어 훨씬 안정적입니다.
const MARKERS = {
  subjectSuffix: ['[SUBJECT_SUFFIX]', '[/SUBJECT_SUFFIX]'],
  body: ['[BODY]', '[/BODY]'],
  confirmerSenderId: ['[CONFIRMER_SENDER_ID]', '[/CONFIRMER_SENDER_ID]'],
  dueDate: ['[DUE_DATE]', '[/DUE_DATE]']
}

// 만기일 계산을 위해 "오늘 날짜"가 필요합니다 (서버 로컬 타임존에 의존하지 않도록
// KST(+09:00) 기준으로 직접 계산합니다).
function pad2(n) {
  return String(n).padStart(2, '0')
}
function nowKstInfo() {
  const kstShifted = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const weekdayNames = ['일', '월', '화', '수', '목', '금', '토']
  return {
    todayIso: `${kstShifted.getUTCFullYear()}-${pad2(kstShifted.getUTCMonth() + 1)}-${pad2(kstShifted.getUTCDate())}`,
    weekdayKo: weekdayNames[kstShifted.getUTCDay()]
  }
}

// 제목 접두사(예: "[LG유플러스]")에서 대괄호/공백만 벗겨내 광고주명(예: "LG유플러스")으로 씁니다.
function stripBrackets(text) {
  return (text || '').replace(/^[\[\(\{【「]+|[\]\)\}】」]+$/g, '').trim()
}

function buildFillPrompt({ templateSubject, templateBody, subjectPrefix, contextText, teamName, staffName, todayIso, weekdayKo }) {
  const prefixNote = subjectPrefix
    ? `- 제목 앞부분("${subjectPrefix}")은 이미 정해져 있습니다. [SUBJECT_SUFFIX] 안에는 그 뒤에 붙을 나머지 부분만 간단히 지어주세요 (예: "브랜드검색 소재 제작 요청", "DA 소재 제작 요청" 등 요청 내용에 맞게). 접두사 글자를 다시 반복하지 마세요.`
    : '- [SUBJECT_SUFFIX] 안에는 요청 내용을 반영한 제목을 간단히 지어주세요. 마땅치 않으면 템플릿 제목을 그대로 써도 됩니다.'

  const advertiserName = stripBrackets(subjectPrefix)
  const fixedInfoNotes = []
  if (teamName || staffName) {
    fixedInfoNotes.push(
      `- 본문에 "OO팀 OOO입니다" 같은 우리 쪽 소속/이름을 적는 자리(이미 "ㅇㅇ" 같은 글자로 채워진 것처럼 보여도 실제로는 빈 자리표시자입니다)가 있으면,` +
      ` 반드시 팀명은 "${teamName || '(팀명 미설정)'}", 이름은 "${staffName || '(이름 미설정)'}" 로 채우세요. 다른 이름을 추측해서 넣지 마세요.`
    )
  }
  if (advertiserName) {
    fixedInfoNotes.push(
      `- 본문에 "OO광고주" 같은 광고주 이름을 적는 자리가 있으면, 반드시 "${advertiserName}"로 채우세요. 다른 광고주명을 추측해서 넣지 마세요.`
    )
  }

  return [
    '아래는 두레이(Dooray) 업무 템플릿의 실제 내용과, 관련 채팅방의 최근 대화입니다.',
    '대화 내용을 참고해서 템플릿에 비어있는 항목(예: 제작 개수, 기획안 URL, 일정, 소재유형 체크박스 등)을 채워주세요.',
    '',
    '규칙:',
    '- 대화에 명확하게 나온 내용만 채웁니다. 확실하지 않으면 절대 추측하지 말고 원본 그대로 비워둡니다.',
    '- 체크박스(- [ ] 항목) 는 대화에서 분명히 언급된 항목만 - [x] 로 바꾸고, 나머지는 그대로 - [ ] 로 둡니다.',
    '- 템플릿의 전체 구조(마크다운/HTML 문법, 줄바꿈, 굵게 표시 등)는 그대로 유지하고, 필요한 값만 채워 넣습니다.',
    prefixNote,
    ...fixedInfoNotes,
    '- 대화 각 줄은 "(시각) 발신자 숫자ID: 내용" 형태입니다 (예: "(오후 5:26) 발신자 12345: 안녕하세요"). 이 중에서, 처음에 업무를 요청한 사람이 아닌',
    '  "다른" 사람이 "확인했습니다", "전달드리겠습니다", "진행하겠습니다" 처럼 확인/수락하는 의미의 답장을',
    '  보냈다면, [CONFIRMER_SENDER_ID] 안에 그 사람의 발신자 숫자ID를 그대로 적어주세요. 그런 사람이 없거나 애매하면',
    '  반드시 "없음" 이라고만 적으세요 (추측 금지).',
    `- 대화에 "OO일까지 부탁드립니다", "이번주 금요일까지 부탁드려요", "내일까지 부탁드립니다" 처럼`,
    `  "~까지 부탁드립니다/부탁드려요/해주세요" 형태로 업무 마감일(만기일)을 요청하는 문장이 있으면,`,
    `  오늘 날짜(${todayIso}, ${weekdayKo}요일)를 기준으로 "~까지"에 해당하는 실제 날짜를 계산해서`,
    '  [DUE_DATE] 안에 YYYY-MM-DD 형식으로 적으세요. 이런 마감일 요청 문장이 전혀 없으면 반드시',
    '  "없음"이라고만 적으세요 (추측 금지).',
    '',
    '다른 설명 없이, 아래 형식 그대로만 출력하세요 (각 표시 안의 내용은 줄바꿈이나 따옴표가 있어도',
    '그대로 적으면 됩니다. JSON이나 코드블록으로 감싸지 마세요):',
    '',
    MARKERS.subjectSuffix[0],
    '(여기에 제목 뒷부분)',
    MARKERS.subjectSuffix[1],
    MARKERS.body[0],
    '(여기에 채워진 템플릿 본문 전체)',
    MARKERS.body[1],
    MARKERS.confirmerSenderId[0],
    '(여기에 숫자ID 또는 없음)',
    MARKERS.confirmerSenderId[1],
    MARKERS.dueDate[0],
    '(여기에 YYYY-MM-DD 또는 없음)',
    MARKERS.dueDate[1],
    '',
    '[템플릿 제목]',
    templateSubject || '(제목 없음)',
    '',
    '[템플릿 본문 원본]',
    templateBody || '(내용 없음)',
    '',
    '[최근 대화 내용]',
    contextText || '(대화 기록 없음)'
  ].join('\n')
}

// [MARKER] ... [/MARKER] 사이 내용을 그대로 꺼냅니다 (JSON 이스케이프 불필요, 줄바꿈/따옴표 그대로 허용).
function extractBetween(text, [start, end]) {
  const startIdx = text.indexOf(start)
  if (startIdx === -1) return null
  const contentStart = startIdx + start.length
  const endIdx = text.indexOf(end, contentStart)
  if (endIdx === -1) return null
  return text.slice(contentStart, endIdx).trim()
}

function parseFilledResponse(text) {
  const raw = text || ''
  const subjectSuffix = extractBetween(raw, MARKERS.subjectSuffix)
  const body = extractBetween(raw, MARKERS.body)
  const confirmerRaw = extractBetween(raw, MARKERS.confirmerSenderId)
  const dueDateRaw = extractBetween(raw, MARKERS.dueDate)

  if (subjectSuffix === null || body === null) {
    throw new Error('AI 응답에서 필요한 항목을 찾지 못했습니다: ' + raw.slice(0, 200))
  }

  const confirmerSenderId =
    confirmerRaw && confirmerRaw !== '없음' && /^\d+$/.test(confirmerRaw) ? confirmerRaw : null

  const dueDate =
    dueDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw.trim()) ? dueDateRaw.trim() : null

  return { subjectSuffix, body, confirmerSenderId, dueDate }
}

// rule: { projectId, templateId, subjectPrefix, defaultAssigneeId, ccMemberIds, tagIds }
// myTeamName/myStaffName: "설정" 탭에 저장해둔, 인사말에 채울 우리 쪽 팀명/이름 고정값
async function runTaskAutomation({ doorayService, rule, contextText, cwd, askClaude, myTeamName, myStaffName }) {
  const detail = await doorayService.getTemplateDetail(rule.projectId, rule.templateId)
  const { todayIso, weekdayKo } = nowKstInfo()
  const prompt = buildFillPrompt({
    templateSubject: detail.subject,
    templateBody: detail.bodyContent,
    subjectPrefix: rule.subjectPrefix,
    contextText,
    teamName: myTeamName,
    staffName: myStaffName,
    todayIso,
    weekdayKo
  })
  const raw = await askClaude(prompt, { cwd, feature: 'task_automation' })
  const filled = parseFilledResponse(raw)

  const prefix = (rule.subjectPrefix || '').trim()
  const suffix = (filled.subjectSuffix || '').trim()
  const subject = [prefix, suffix].filter(Boolean).join(' ') || detail.subject

  // 채팅에서 "확인/수락" 답장을 보낸 사람이 있으면 그 사람을 담당자로 우선 쓰고,
  // 없으면 자동화 규칙에 미리 정해둔 기본 담당자를 씁니다.
  const assigneeId = filled.confirmerSenderId || rule.defaultAssigneeId || undefined

  // 마감일은 "그 날 업무 마감"의 의미로, 시간은 오후 6시(18:00, 업무 종료 시각)로 기본 설정합니다.
  const dueDate = filled.dueDate ? `${filled.dueDate}T18:00:00+09:00` : undefined

  const post = await doorayService.createFromTemplate(rule.projectId, rule.templateId, {
    subject,
    body: filled.body,
    assigneeId,
    ccMemberIds: rule.ccMemberIds || [],
    tagIds: rule.tagIds || [],
    dueDate
  })
  return { post, subject }
}

module.exports = { isCreateTaskCommand, findAutomationForChannel, runTaskAutomation }
