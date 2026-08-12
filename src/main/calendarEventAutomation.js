// 채팅방에서 "@트리거 내일 오전 10시에 OO 미팅 잡아줘" 처럼 캘린더 일정을 만들어달라고 하면,
// fileAttachAutomation.js와 같은 "추측 → 확인 대기 → 실행" 2단계 구조로 처리합니다.
// 캘린더 등록은 실수하면 되돌리기 번거로운 행동이라(참석자에게 이미 초대가 갔을 수도 있음),
// 절대 곧바로 만들지 않고 "이렇게 진행할까요?"로 먼저 확인받은 뒤 승인해야만 실제로 만듭니다.
//
// 참고(회의실 예약): 이 회사는 두레이의 "자원예약" 서비스가 아니라 완전히 별도인 사내 시스템
// (왓츠업)으로 회의실을 예약하고 있어서, 두레이 API로는 실제 회의실 예약 자체가 안 됩니다
// (doorayService.js 상단 "회의실(자원) 예약 기능은 시도했다가 되돌렸습니다" 참고). 그래서
// "3층 회의실"처럼 회의실이 언급되면 실제 예약을 시도하지 않고, 일정의 "장소" 칸에 그 이름을
// 텍스트로만 적습니다.
//
// 동작 2단계:
//  1) proposeCalendarEvent: 제목/일시/장소/참석자를 추측해서 "이렇게 진행할까요?"라고 답장하고,
//     그 추측 내용을 채널별로 잠깐 기억해둡니다(pendingByChannel).
//  2) 같은 채널에서 같은 사람이 "네"라고 답하면 confirmAndExecuteCalendarEvent가 그제서야
//     실제로 doorayService.createEvent()를 호출해 CalDAV로 등록합니다.
// 참석자 이름 -> 두레이 조직원 ID 변환은 doorayService.searchMembersByName()으로 하고,
// 실제 CalDAV ATTENDEE 등록/이메일 조회는 doorayService.createEvent()가 그대로 처리합니다
// (대시보드의 "참석자 추가" 기능과 완전히 같은 경로 — 다만 두레이가 이 필드를 실제로 반영하는지는
// 대시보드 쪽에서도 아직 확정 검증되지 않았으니, 등록 후 실제로 참석자가 붙었는지 한 번 확인이 필요합니다).

const { classifyReply } = require('./fileAttachAutomation')

const PENDING_TTL_MS = 10 * 60 * 1000 // 10분 지나면 추측 내용을 잊어버리고 처음부터 다시 물어야 함
const SUBJECT_WORDS = ['일정', '미팅', '회의']
const ACTION_WORDS = ['잡아', '만들어', '등록', '올려', '예약']

// channelId -> { senderId, createdAt, guess }
const pendingByChannel = new Map()

function isCreateCalendarEventCommand(text) {
  const t = (text || '').replace(/\s+/g, '')
  const hasSubject = SUBJECT_WORDS.some((w) => t.includes(w))
  const hasAction = ACTION_WORDS.some((w) => t.includes(w))
  return hasSubject && hasAction
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

function clearPending(channelId) {
  pendingByChannel.delete(channelId)
}

const MARKERS = {
  subject: ['[SUBJECT]', '[/SUBJECT]'],
  wholeDay: ['[WHOLE_DAY]', '[/WHOLE_DAY]'],
  startedAt: ['[STARTED_AT]', '[/STARTED_AT]'],
  endedAt: ['[ENDED_AT]', '[/ENDED_AT]'],
  location: ['[LOCATION]', '[/LOCATION]'],
  attendees: ['[ATTENDEES]', '[/ATTENDEES]']
}

function extractBetween(text, [start, end]) {
  const startIdx = text.indexOf(start)
  if (startIdx === -1) return null
  const contentStart = startIdx + start.length
  const endIdx = text.indexOf(end, contentStart)
  if (endIdx === -1) return null
  return text.slice(contentStart, endIdx).trim()
}

function buildExtractPrompt({ question, todayIso, contextText }) {
  // (2026-08-11 수정) 요청 문장을 앞으로 옮기고 대화 맥락에 상한(최신 쪽 유지)을 둡니다.
  // 예전에는 요청 문장이 프롬프트 맨 끝이라, 대화가 긴 방에서는 askClaude의 길이 제한에
  // 잘려나가 "제목을 못 알아냈어요"가 나올 수 있었습니다 (멘션 봇 질문 잘림 사고와 같은 구조).
  const MAX_CONTEXT = 6000
  const safeContext = (contextText || '').length > MAX_CONTEXT
    ? '(오래된 대화 일부 생략)\n' + contextText.slice(-MAX_CONTEXT)
    : (contextText || '')
  return [
    `오늘 날짜는 ${todayIso}입니다.`,
    '아래는 채팅방에서 캘린더 일정을 만들어달라고 요청한 내용입니다. 지금 단계에서는 실제로',
    '등록하지 말고, 아래 형식대로 정보만 정리해서 출력하세요 (등록은 사람이 확인한 뒤 별도',
    '단계에서 진행합니다).',
    '',
    '- 제목: 요청 문장에서 자연스럽게 뽑되, 명확하지 않으면 아래 대화 맥락을 참고하세요.',
    '- 종일 일정인지, 시간이 정해진 일정인지 판단하세요.',
    `- 날짜/시간 표현("내일", "다음주 화요일" 등)은 오늘(${todayIso}) 기준으로 계산한 실제`,
    '  날짜로 바꾸세요.',
    '- 장소: "3층 회의실", "OO 회의실"처럼 회의실/장소가 언급되면 그 이름을 그대로 적으세요.',
    '  (실제 회의실 예약 시스템과 연동되는 게 아니라, 일정에 텍스트로만 적히는 것입니다 —',
    '  회의실을 실제로 예약하는 기능은 없으니 예약 여부를 판단하려 하지 말고 이름만 받아 적으세요.)',
    '- 참석자: 언급된 사람 이름을 쉼표로 구분해서 적으세요(직책/존칭/"님"은 빼고 이름만).',
    '',
    '다른 설명 없이 아래 형식 그대로만 출력하세요:',
    '',
    MARKERS.subject[0],
    '(일정 제목)',
    MARKERS.subject[1],
    MARKERS.wholeDay[0],
    '(YES 또는 NO)',
    MARKERS.wholeDay[1],
    MARKERS.startedAt[0],
    '(종일이면 YYYY-MM-DD, 시간이 있으면 YYYY-MM-DDTHH:MM:SS)',
    MARKERS.startedAt[1],
    MARKERS.endedAt[0],
    '(종일이면 YYYY-MM-DD[마지막 날의 다음날], 시간이 있으면 YYYY-MM-DDTHH:MM:SS.',
    ' 언급이 없으면 비워두세요)',
    MARKERS.endedAt[1],
    MARKERS.location[0],
    '(장소, 없으면 없음)',
    MARKERS.location[1],
    MARKERS.attendees[0],
    '(이름1,이름2 형태, 없으면 없음)',
    MARKERS.attendees[1],
    '',
    '[요청 문장 — 이것을 처리하세요]',
    question,
    '',
    '[최근 대화 맥락 — 참고용]',
    safeContext || '(없음)'
  ].join('\n')
}

function parseExtracted(raw) {
  const text = raw || ''
  const clean = (v) => (v && v !== '없음' ? v.trim() : '')
  const wholeDayRaw = (extractBetween(text, MARKERS.wholeDay) || '').toUpperCase()
  const attendeesRaw = clean(extractBetween(text, MARKERS.attendees))
  return {
    subject: clean(extractBetween(text, MARKERS.subject)),
    wholeDay: wholeDayRaw.includes('YES'),
    startedAt: clean(extractBetween(text, MARKERS.startedAt)),
    endedAt: clean(extractBetween(text, MARKERS.endedAt)),
    location: clean(extractBetween(text, MARKERS.location)),
    attendeeNames: attendeesRaw ? attendeesRaw.split(',').map((s) => s.trim()).filter(Boolean) : []
  }
}

function pad(n) {
  return String(n).padStart(2, '0')
}

// 종료 시각을 못 뽑았을 때 기본값을 채웁니다: 종일 일정이면 다음 날, 시간 일정이면 1시간 뒤.
function fillDefaultEndedAt(startedAt, wholeDay) {
  if (wholeDay) {
    const d = new Date(`${startedAt}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 1)
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  }
  const d = new Date(`${startedAt}Z`)
  d.setUTCHours(d.getUTCHours() + 1)
  return d.toISOString().slice(0, 19)
}

// 1단계: 추측만 하고, 실제로 일정을 등록하지 않습니다.
// 반환: { ok: true, replyText } (추측 성공, 확인 필요) 또는 { ok: false, error } (추측 자체가 실패)
async function proposeCalendarEvent({ doorayService, question, contextText, todayIso, cwd, askClaude, channelId, senderId }) {
  const raw = await askClaude(
    buildExtractPrompt({ question, todayIso, contextText }),
    { cwd, feature: 'calendar_event_extract' }
  )
  const extracted = parseExtracted(raw)

  if (!extracted.subject) {
    return { ok: false, error: '일정 제목을 못 알아냈어요. 어떤 일정인지 조금 더 구체적으로 말씀해주세요.' }
  }
  const dateRe = extracted.wholeDay ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
  if (!extracted.startedAt || !dateRe.test(extracted.startedAt)) {
    return { ok: false, error: '날짜/시간을 못 알아냈어요. "내일 오전 10시"처럼 조금 더 구체적으로 말씀해주세요.' }
  }
  if (!extracted.endedAt || !dateRe.test(extracted.endedAt)) {
    extracted.endedAt = fillDefaultEndedAt(extracted.startedAt, extracted.wholeDay)
  }

  // 참석자 이름 -> 두레이 조직원 ID. 한 명 못 찾아도 그 사람만 빼고 계속 진행합니다.
  // 같은 이름으로 후보가 여러 명 나오면(동명이인) 아무나 골라 넣지 않고, 승인 답장에서
  // 번호/이름으로 골라달라고 물어봅니다(ambiguous에 후보 목록을 담아둠).
  const attendeeIds = []
  const attendeeLabels = []
  const notFoundNames = []
  const ambiguous = []
  for (const name of extracted.attendeeNames) {
    try {
      const candidates = await doorayService.searchMembersByName(name)
      if (!candidates || !candidates.length) {
        notFoundNames.push(name)
      } else if (candidates.length === 1) {
        attendeeIds.push(candidates[0].id)
        attendeeLabels.push(candidates[0].name || name)
      } else {
        ambiguous.push({
          name,
          candidates: candidates.map((c) => ({ id: c.id, name: c.name || name, userCode: c.userCode || '' }))
        })
      }
    } catch {
      notFoundNames.push(name)
    }
  }

  let calendars = []
  try {
    calendars = await doorayService.listCalendars()
  } catch (err) {
    return { ok: false, error: `캘린더 목록을 못 가져왔어요: ${err.message}` }
  }
  if (!calendars.length) {
    return { ok: false, error: '연결된 캘린더를 찾지 못했어요. 설정 탭에서 캘린더(CalDAV) 연동을 먼저 확인해주세요.' }
  }
  const calendarId = calendars[0].id // 개인 캘린더(첫 번째)에 등록

  const dateLabel = extracted.wholeDay
    ? extracted.startedAt
    : `${extracted.startedAt.slice(0, 10)} ${extracted.startedAt.slice(11, 16)}~${extracted.endedAt.slice(11, 16)}`

  const lines = ['이렇게 진행할까요?', `· 일정: ${extracted.subject}`, `· 일시: ${dateLabel}`]
  if (extracted.location) lines.push(`· 장소: ${extracted.location}`)
  if (attendeeLabels.length) lines.push(`· 참석자: ${attendeeLabels.join(', ')}`)
  if (ambiguous.length) {
    ambiguous.forEach((a) => {
      const opts = a.candidates.map((c, i) => `${i + 1}.${c.name}${c.userCode ? `(${c.userCode})` : ''}`).join(' ')
      lines.push(`· '${a.name}' 후보가 여러 명이에요: ${opts} — 번호나 이름을 같이 말씀해주시면 그 분으로 넣을게요(안 정해주시면 참석자에서 빠져요).`)
    })
  }
  if (notFoundNames.length) lines.push(`· (이 계정을 못 찾아서 참석자로는 못 넣었어요: ${notFoundNames.join(', ')})`)
  lines.push('맞으면 답해주세요 (다시 멘션해서, "네"처럼 짧게 또는 "네 1번"처럼 후보 번호도 같이). 아니면 다시 말씀해주세요. (10분 안에 답 없으면 잊어버려요)')

  const replyText = lines.join('\n')

  pendingByChannel.set(channelId, {
    senderId,
    createdAt: Date.now(),
    question: replyText,
    kind: 'create',
    guess: {
      calendarId,
      subject: extracted.subject,
      startedAt: `${extracted.startedAt}+09:00`,
      endedAt: `${extracted.endedAt}+09:00`,
      wholeDayFlag: extracted.wholeDay,
      location: extracted.location,
      attendeeIds,
      ambiguous
    }
  })

  return { ok: true, replyText }
}

const RESOLVE_MARKERS = {
  verdict: ['[VERDICT]', '[/VERDICT]'],
  selections: ['[SELECTIONS]', '[/SELECTIONS]']
}

function buildResolvePrompt({ question, ambiguous, replyText }) {
  const ambiguousText = ambiguous.length
    ? ambiguous
        .map(
          (a) =>
            `- '${a.name}': ${a.candidates
              .map((c, i) => `${i + 1}번=${c.name}${c.userCode ? `(${c.userCode})` : ''}`)
              .join(', ')}`
        )
        .join('\n')
    : '(없음)'
  return [
    '방금 채팅방에 캘린더 일정을 이렇게 만들지 확인하는 질문을 보냈고, 이어서 답장이 왔습니다.',
    '',
    '[확인 질문]',
    question,
    '',
    '[참석자 후보가 여러 명이라 번호를 골라야 하는 이름들]',
    ambiguousText,
    '',
    '[답장]',
    replyText,
    '',
    '이 답장이 일정을 "만들어라(YES)"인지 "만들지 마라(NO)"인지 "질문과 상관없는 다른 말(UNCLEAR)"인지',
    '판단하세요. 정확히 "네"/"아니오"가 아니어도 자연스러운 긍정/부정 표현이면 그 뜻대로 판단하세요.',
    '그리고 답장에 위 이름들 중 몇 번(또는 어떤 사람)을 골랐다는 언급이 있으면 그 이름=번호를 적으세요',
    '(언급이 없는 이름은 적지 마세요).',
    '',
    '다른 설명 없이 아래 형식 그대로만 출력하세요:',
    RESOLVE_MARKERS.verdict[0],
    'YES 또는 NO 또는 UNCLEAR',
    RESOLVE_MARKERS.verdict[1],
    RESOLVE_MARKERS.selections[0],
    '이름=번호 (여러 줄 가능, 없으면 비워두세요)',
    RESOLVE_MARKERS.selections[1]
  ].join('\n')
}

// 캘린더 확인 답장을 해석합니다. 참석자 후보 선택이 필요 없는 보통 경우에는 기존 방식(짧은
// 키워드 매칭)으로 충분해서 AI를 부르지 않고 바로 판단합니다. 동명이인 후보가 있을 때만 AI를 불러
// "네/아니오" 여부와 "몇 번으로 골랐는지"를 한 번에 알아냅니다.
async function resolveCalendarConfirmReply({ askClaude, channelId, replyText, cwd }) {
  const pending = pendingByChannel.get(channelId)
  if (!pending) return { verdict: 'UNCLEAR', selections: {} }
  const ambiguous = pending.guess.ambiguous || []
  if (!ambiguous.length) {
    const simple = classifyReply(replyText)
    const verdict = simple === 'confirm' ? 'YES' : simple === 'cancel' ? 'NO' : 'UNCLEAR'
    return { verdict, selections: {} }
  }
  const raw = await askClaude(
    buildResolvePrompt({ question: pending.question || '', ambiguous, replyText }),
    { cwd, feature: 'calendar_event_resolve_confirm' }
  )
  const verdictRaw = (extractBetween(raw, RESOLVE_MARKERS.verdict) || '').toUpperCase()
  const verdict = verdictRaw.includes('YES') ? 'YES' : verdictRaw.includes('NO') ? 'NO' : 'UNCLEAR'
  const selectionsRaw = extractBetween(raw, RESOLVE_MARKERS.selections) || ''
  const selections = {}
  selectionsRaw.split('\n').forEach((line) => {
    const m = line.match(/^\s*(.+?)\s*=\s*(\d+)\s*번?\s*$/)
    if (!m) return
    const name = m[1].trim()
    const idx = parseInt(m[2], 10) - 1
    const entry = ambiguous.find((a) => a.name === name)
    if (entry && entry.candidates[idx]) selections[name] = entry.candidates[idx].id
  })
  return { verdict, selections }
}

// 2단계: pending으로 저장해둔 추측대로 실제 일정을 등록합니다. selections는 동명이인 후보 중
// 어떤 사람을 골랐는지({이름: 두레이ID})이고, 골라주지 않은 이름은 참석자에서 빠집니다.
// ---------------------------------------------------------------------------
// (2026-08-10 신규) 채팅으로 이미 있는 일정을 "수정"(시간 변경)하거나 "삭제"하는 흐름.
// 등록과 같은 "추측 → 확인 대기 → 실행" 2단계를 그대로 씁니다 — 특히 삭제는 되돌릴 수
// 없는 행동이라 반드시 확인을 거칩니다.
// ---------------------------------------------------------------------------

const CHANGE_ACTION_WORDS = ['바꿔', '변경', '옮겨', '미뤄', '미루', '취소', '삭제', '지워', '당겨']

function isChangeCalendarEventCommand(text) {
  const t = (text || '').replace(/\s+/g, '')
  const hasSubject = SUBJECT_WORDS.some((w) => t.includes(w))
  const hasAction = CHANGE_ACTION_WORDS.some((w) => t.includes(w))
  return hasSubject && hasAction
}

const CHANGE_MARKERS = {
  action: ['[ACTION]', '[/ACTION]'],
  eventIndex: ['[EVENT_INDEX]', '[/EVENT_INDEX]'],
  startedAt: ['[NEW_STARTED_AT]', '[/NEW_STARTED_AT]'],
  endedAt: ['[NEW_ENDED_AT]', '[/NEW_ENDED_AT]']
}

function buildChangeExtractPrompt({ question, todayIso, eventLines }) {
  return [
    '당신은 캘린더 비서입니다. 사용자가 이미 등록된 일정을 바꾸거나 취소하려고 합니다.',
    `오늘 날짜: ${todayIso} (한국 시간)`,
    '',
    '[등록된 일정 목록 — 번호로 골라야 합니다]',
    eventLines,
    '',
    '[사용자 요청]',
    question,
    '',
    '요청을 읽고 다음 마커 형식으로만 답하세요 (설명 금지):',
    '[ACTION]update 또는 delete[/ACTION]',
    '[EVENT_INDEX]대상 일정의 번호 (확실하지 않으면 none)[/EVENT_INDEX]',
    '[NEW_STARTED_AT]새 시작 (update일 때만. 시간 일정이면 YYYY-MM-DDTHH:MM:SS, 종일이면 YYYY-MM-DD. 모르면 none)[/NEW_STARTED_AT]',
    '[NEW_ENDED_AT]새 종료 (update일 때만. 형식 동일. 모르면 none — 그러면 기존 길이를 유지합니다)[/NEW_ENDED_AT]',
    '',
    '규칙: "취소/삭제/지워"는 delete, "바꿔/옮겨/미뤄/당겨"는 update입니다.',
    '어느 일정인지 제목이나 시간 단서로 특정할 수 없으면 EVENT_INDEX에 none을 넣으세요. 절대 아무거나 고르지 마세요.'
  ].join('\n')
}

// 앞으로 30일(+어제)의 일정을 모아, 채팅 요청이 가리키는 일정을 추측해 확인을 요청합니다.
async function proposeCalendarEventChange({ doorayService, question, todayIso, cwd, askClaude, channelId, senderId }) {
  let calendars = []
  try {
    calendars = await doorayService.listCalendars()
  } catch (err) {
    return { ok: false, error: `캘린더 목록을 못 가져왔어요: ${err.message}` }
  }
  if (!calendars.length) {
    return { ok: false, error: '연결된 캘린더를 찾지 못했어요. 설정 탭에서 캘린더(CalDAV) 연동을 먼저 확인해주세요.' }
  }
  const calendarIds = calendars.map((c) => c.id)
  const start = new Date(Date.now() - 24 * 3600 * 1000)
  const end = new Date(Date.now() + 30 * 24 * 3600 * 1000)
  let events = []
  try {
    events = await doorayService.listEvents({
      calendarIds, timeMin: start.toISOString(), timeMax: end.toISOString()
    })
  } catch (err) {
    return { ok: false, error: `일정 목록을 못 가져왔어요: ${err.message}` }
  }
  events = (events || []).filter((e) => e.id != null).slice(0, 40)
  if (!events.length) {
    return { ok: false, error: '앞으로 한 달 안에 등록된 일정이 없어요. 바꿀 일정을 못 찾았어요.' }
  }

  const isWholeDayStr = (v) => /^\d{4}-\d{2}-\d{2}\+\d{2}:\d{2}$/.test(v || '')
  const fmtWhen = (e) => isWholeDayStr(e.startedAt)
    ? `${(e.startedAt || '').slice(0, 10)} 종일`
    : `${(e.startedAt || '').slice(0, 10)} ${(e.startedAt || '').slice(11, 16)}~${(e.endedAt || '').slice(11, 16)}`
  const eventLines = events
    .map((e, i) => `${i + 1}. ${e.subject || '(제목 없음)'} — ${fmtWhen(e)}`)
    .join('\n')

  const raw = await askClaude(
    buildChangeExtractPrompt({ question, todayIso, eventLines }),
    { cwd, feature: 'calendar_event_change_extract' }
  )
  const action = (extractBetween(raw, CHANGE_MARKERS.action) || '').trim().toLowerCase()
  const idxRaw = (extractBetween(raw, CHANGE_MARKERS.eventIndex) || '').trim()
  const idx = /^\d+$/.test(idxRaw) ? Number(idxRaw) - 1 : -1
  if (action !== 'update' && action !== 'delete') {
    return { ok: false, error: '바꾸려는 건지 취소하려는 건지 못 알아들었어요. "OO 미팅 3시로 옮겨줘"나 "OO 회의 취소해줘"처럼 말씀해주세요.' }
  }
  if (idx < 0 || idx >= events.length) {
    return { ok: false, error: `어느 일정인지 특정하지 못했어요. 지금 등록된 일정은 이래요:\n${eventLines}\n제목을 함께 말씀해주세요.` }
  }
  const target = events[idx]
  const targetWhole = isWholeDayStr(target.startedAt)

  let newStartedAt = null
  let newEndedAt = null
  if (action === 'update') {
    const ns = (extractBetween(raw, CHANGE_MARKERS.startedAt) || '').trim()
    const ne = (extractBetween(raw, CHANGE_MARKERS.endedAt) || '').trim()
    const dateRe = targetWhole ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
    if (!ns || !dateRe.test(ns)) {
      return { ok: false, error: '언제로 바꿀지 못 알아냈어요. "내일 오후 3시로"처럼 조금 더 구체적으로 말씀해주세요.' }
    }
    newStartedAt = ns
    if (ne && dateRe.test(ne)) {
      newEndedAt = ne
    } else if (targetWhole) {
      newEndedAt = ns
    } else {
      // 종료를 안 정해줬으면 기존 일정의 길이를 그대로 유지합니다.
      const oldS = new Date(target.startedAt)
      const oldE = new Date(target.endedAt || target.startedAt)
      const durMs = Math.max(0, oldE - oldS) || 60 * 60 * 1000
      const newS = new Date(`${ns}+09:00`)
      const newE = new Date(newS.getTime() + durMs)
      newEndedAt = `${newE.getFullYear()}-${pad(newE.getMonth() + 1)}-${pad(newE.getDate())}T${pad(newE.getHours())}:${pad(newE.getMinutes())}:${pad(newE.getSeconds())}`
    }
  }

  const lines = action === 'delete'
    ? ['이 일정을 삭제할까요? 되돌릴 수 없어요.', `· ${target.subject || '(제목 없음)'} — ${fmtWhen(target)}`]
    : [
        '이렇게 바꿀까요?',
        `· 일정: ${target.subject || '(제목 없음)'}`,
        `· 기존: ${fmtWhen(target)}`,
        `· 변경: ${targetWhole ? `${newStartedAt} 종일` : `${newStartedAt.slice(0, 10)} ${newStartedAt.slice(11, 16)}~${newEndedAt.slice(11, 16)}`}`
      ]
  lines.push('맞으면 다시 멘션해서 "네"라고 답해주세요. 아니면 다시 말씀해주세요. (10분 안에 답 없으면 잊어버려요)')
  const replyText = lines.join('\n')

  pendingByChannel.set(channelId, {
    senderId,
    createdAt: Date.now(),
    question: replyText,
    kind: action, // 'update' | 'delete'
    guess: {
      calendarId: target.calendarId,
      eventId: target.id,
      subject: target.subject || '(제목 없음)',
      wholeDayFlag: targetWhole,
      location: target.location || '',
      startedAt: newStartedAt ? `${newStartedAt}${targetWhole ? '' : '+09:00'}` : null,
      endedAt: newEndedAt ? `${newEndedAt}${targetWhole ? '' : '+09:00'}` : null,
      ambiguous: []
    }
  })
  return { ok: true, replyText }
}

async function confirmAndExecuteCalendarEvent({ doorayService, channelId, selections = {} }) {
  const pending = pendingByChannel.get(channelId)
  clearPending(channelId)
  if (!pending) {
    return { ok: false, error: '확인할 내용이 없어요 (시간이 지나 잊어버렸을 수 있어요). 다시 말씀해주세요.' }
  }
  const g = pending.guess
  const kind = pending.kind || 'create'

  // (2026-08-10 추가) 수정/삭제 승인 — 등록과 같은 확인 흐름을 거쳐 여기 도착합니다.
  if (kind === 'delete') {
    try {
      await doorayService.deleteEvent({ calendarId: g.calendarId, eventId: g.eventId })
      return { ok: true, kind, event: { subject: g.subject } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
  if (kind === 'update') {
    try {
      const event = await doorayService.updateEvent({
        calendarId: g.calendarId,
        eventId: g.eventId,
        subject: g.subject,
        startedAt: g.startedAt,
        endedAt: g.endedAt,
        location: g.location,
        wholeDayFlag: g.wholeDayFlag
      })
      return { ok: true, kind, event: { subject: g.subject, startedAt: g.startedAt, endedAt: g.endedAt } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  const ambiguous = g.ambiguous || []
  const skippedNames = []
  const extraIds = []
  ambiguous.forEach((a) => {
    const chosenId = selections[a.name]
    if (chosenId) extraIds.push(chosenId)
    else skippedNames.push(a.name)
  })
  const attendeeIds = [...g.attendeeIds, ...extraIds]
  try {
    const event = await doorayService.createEvent({
      calendarId: g.calendarId,
      subject: g.subject,
      startedAt: g.startedAt,
      endedAt: g.endedAt,
      wholeDayFlag: g.wholeDayFlag,
      location: g.location,
      attendeeIds
    })
    return { ok: true, kind: 'create', event, attendeeCount: attendeeIds.length, skippedNames }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

module.exports = {
  isCreateCalendarEventCommand,
  isChangeCalendarEventCommand,
  hasPendingConfirm,
  clearPending,
  proposeCalendarEvent,
  proposeCalendarEventChange,
  resolveCalendarConfirmReply,
  confirmAndExecuteCalendarEvent
}
