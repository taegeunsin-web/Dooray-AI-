// 채팅방에서 "@트리거단어 질문"을 감지하면 클로드 코드를 불러서 답을 만들고 보내는 로직.
// dooray-bot-listener.js에서 실제로 테스트 완료된 로직 + openChannels(방별 허용 정책) +
// 클로데이(Clauday) 방식을 참고한 두 가지를 추가로 반영:
//   1. 채널별 작업 폴더 분리 — 클로데이의 "~/Clauday-Workspaces/agent/{channelId}/" 패턴과 동일하게,
//      채널마다 별도 폴더에서 claude를 실행해 컨텍스트가 섞이지 않게 합니다.
//      ⚠️ 새로 생기는 채널 폴더는 클로드 코드 입장에서 "처음 보는 폴더"라, 최초 1회는
//      터미널에서 그 폴더로 이동해 claude를 대화형으로 한 번 실행하고 신뢰(trust) 확인을
//      눌러줘야 자동 호출이 멈추지 않습니다. (README의 "미리 준비해야 할 것" 참고)
//   2. 멘션 직전 최근 대화 내용을 함께 넘겨서, 맥락 있는 질문에도 답할 수 있게 합니다.
//      (2026-07-27 갱신) 두레이 메신저 API(`GET /messenger/v1/channels/{id}/logs?size=N&order=-createdAt`)로
//      멘션 받는 그 순간 채널의 최근 메시지를 즉석 조회합니다(클로데이와 동일한 방식) — 이
//      프로그램이 꺼져있던 동안 온 메시지도 포함됩니다. 다만 "최근 N개"까지만 가능하고, 커서/기간
//      기반으로 그보다 더 과거까지 페이지를 넘기는 건 두레이 API가 지원하지 않습니다. 즉석 조회가
//      실패하면(네트워크 오류 등) 이 프로그램이 켜져 있는 동안 실시간으로 관측한 기록으로 폴백합니다.
//   3. (2026-07-27 추가) 같은 방식으로 "채팅 기록 검색" 저장소도 채웁니다(backfillChatHistory) —
//      소켓 연결 시 한 번, "기록 저장"이 켜진 채팅방마다 최근 100개를 가져와 이미 저장된 것보다
//      나중 메시지만 채워 넣어 프로그램이 꺼져있던 동안의 공백을 메꿉니다.

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { isCreateTaskCommand, findAutomationForChannel, runTaskAutomation } = require('./taskAutomation')
const {
  isAttachFileCommand,
  hasPendingConfirm,
  classifyReply,
  clearPending,
  proposeAttachFile,
  confirmAndExecute
} = require('./fileAttachAutomation')
const {
  isCreateCalendarEventCommand,
  hasPendingConfirm: hasPendingCalendarConfirm,
  clearPending: clearCalendarPending,
  proposeCalendarEvent,
  resolveCalendarConfirmReply,
  confirmAndExecuteCalendarEvent
} = require('./calendarEventAutomation')
const { appendMessage, listStoredChannelIds, getLastMessageTs } = require('./chatHistoryStore')
const { appendFile } = require('./channelFileStore')
const { resolveClaudePath, commandFor } = require('./claudeResolver')
const usageStore = require('./usageStore')
const mailStore = require('./mailStore')
const mailImap = require('./mailImap')
const tokenStore = require('./tokenStore')
const todoStore = require('./todoStore')
const todoTagStore = require('./todoTagStore')
const todoSubTagStore = require('./todoSubTagStore')
const todoTemplateStore = require('./todoTemplateStore')
const todoHistoryStore = require('./todoHistoryStore')

const WORKSPACE_ROOT = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'agent')
const HISTORY_LIMIT = 50 // 채널당 기억할 최근 메시지 개수 (클로데이의 "최근 50개"와 동일)

// channelId -> [{ senderId, text, ts }]
const channelHistory = new Map()
// channelId -> { lastText, lastSenderId, lastAt } — 대시보드의 "채팅방" 목록에서 사용
const channelMeta = new Map()

function recordHistory(channelId, senderId, text) {
  if (!channelHistory.has(channelId)) channelHistory.set(channelId, [])
  const list = channelHistory.get(channelId)
  list.push({ senderId, text, ts: Date.now() })
  if (list.length > HISTORY_LIMIT) list.shift()

  channelMeta.set(channelId, { lastText: text, lastSenderId: senderId, lastAt: Date.now() })
}

// 대시보드에서 "이 방에서 최근에 대화가 있었어요" 목록을 보여주기 위한 함수.
// 프로그램이 켜진 후 실제로 메시지가 관측된 채널만 나열합니다 (그 전 채널 목록 전체 조회 API는 없음).
function getRecentChannels() {
  return Array.from(channelMeta.entries())
    .map(([channelId, meta]) => ({ channelId, ...meta }))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 30)
}

// 두레이 메신저 로그 1건에서 본문 텍스트를 뽑아냅니다. 필드명이 여러 형태로 올 수 있어
// (text / message / messageText / content.content / body.content) 순서대로 시도합니다.
// (클로데이 소스코드의 extractText 로직을 참고해 이 프로젝트 스타일로 재작성함.)
function extractLogText(log) {
  const tryFields = [log.text, log.message, log.messageText]
  for (const t of tryFields) {
    if (typeof t === 'string' && t.trim()) return t.trim()
  }
  for (const wrapper of [log.content, log.body]) {
    if (typeof wrapper === 'string' && wrapper.trim()) return wrapper.trim()
    if (wrapper && typeof wrapper === 'object' && typeof wrapper.content === 'string' && wrapper.content.trim()) {
      return wrapper.content.trim()
    }
  }
  return ''
}

// (2026-07-27 추가) 두레이 API로 이 채널의 최근 메시지를 즉석 조회합니다. 이 프로그램이
// 그동안 꺼져있었어도, 조회하는 그 순간의 "최근 N개"는 서버에서 바로 받아올 수 있습니다
// (커서/기간 기반으로 더 과거까지 페이지 넘기는 건 두레이 API가 지원 안 함 — 클로데이도
// 같은 제약이라 매번 "최근 N개"만 가져옴). 실패하면 null을 돌려주고, 호출부가 기존
// 방식(이 프로그램이 실행 중일 때 실시간으로 관측한 기록)으로 폴백합니다.
async function fetchRecentChannelLogs(doorayClient, channelId, size = HISTORY_LIMIT) {
  try {
    const res = await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
      query: { size, order: '-createdAt' }
    })
    const logs = res?.result || []
    // 최신순으로 오므로, 대화 흐름대로 읽히게 시간순(오래된 것부터)으로 뒤집습니다.
    return logs.slice().reverse().map((log) => {
      const text = extractLogText(log)
      const ts = log.sentAt || log.createdAt
      const senderId = log.sender?.organizationMemberId || log.sender?.member?.organizationMemberId
        || log.creator?.member?.organizationMemberId || '알 수 없음'
      const senderName = log.sender?.name || log.sender?.member?.name || log.creator?.member?.name
      return { text, ts: ts ? new Date(ts).getTime() : Date.now(), senderId, senderName }
    }).filter((m) => m.text)
  } catch (err) {
    return null
  }
}

async function buildContextBlock(doorayClient, channelId, excludeText) {
  const fetched = await fetchRecentChannelLogs(doorayClient, channelId)
  let recent
  let sourceNote
  if (fetched) {
    recent = fetched.filter((m) => m.text !== excludeText)
    sourceNote = '두레이에서 즉석 조회 — 프로그램이 꺼져있던 동안 온 메시지도 포함됨'
  } else {
    // 즉석 조회가 실패하면(네트워크 오류 등) 기존 방식(실행 중 실시간 관측 기록)으로 폴백.
    const list = channelHistory.get(channelId) || []
    recent = list.filter((m) => m.text !== excludeText)
    sourceNote = '프로그램 실행 후 실시간으로 관측된 것만 (즉석 조회 실패로 폴백)'
  }
  if (recent.length === 0) return ''
  const lines = recent.map((m) => {
    const time = new Date(m.ts).toLocaleTimeString('ko-KR')
    const who = m.senderName || m.senderId
    return `(${time}) 발신자 ${who}: ${m.text}`
  })
  return `[이 채팅방의 최근 대화 (${sourceNote})]\n${lines.join('\n')}\n\n[질문]\n`
}

// (2026-07-27 추가) "채팅 기록 검색" 기능용 채우기(백필).
// 프로그램이 꺼져있던 동안 "기록 저장"이 켜진 채팅방에 온 메시지를, 두레이 API로 최근
// 100개를 가져와서 놓친 만큼만 채워 넣습니다. 이미 저장된 마지막 메시지 시각(ts)보다
// 나중 것만 새로 저장하므로 중복 저장되지 않습니다. 소켓이 연결될 때 한 번만 실행됩니다.
const CHAT_HISTORY_BACKFILL_SIZE = 100

async function backfillChatHistory(doorayClient, { log } = {}) {
  const channelIds = listStoredChannelIds()
  for (const channelId of channelIds) {
    try {
      const fetched = await fetchRecentChannelLogs(doorayClient, channelId, CHAT_HISTORY_BACKFILL_SIZE)
      if (!fetched) continue
      const lastTs = getLastMessageTs(channelId)
      const missing = fetched.filter((m) => m.ts > lastTs)
      for (const m of missing) {
        appendMessage(channelId, { senderId: m.senderId, text: m.text, ts: m.ts })
      }
      if (missing.length > 0 && log) log(`채팅 기록 채움: ${channelId} ${missing.length}건`)
    } catch (err) {
      if (log) log(`채팅 기록 채우기 실패 (${channelId}): ${err.message}`)
    }
  }
}

// (2026-07-30 추가) 프로그램이 꺼져있던 동안 공유 투두방에 올라온 메시지를 놓치는 문제
// 해결: 이 방은 항상 실시간으로 지켜보면서 완료/삭제/추가/태그변경을 감지하는데, 컴퓨터가
// 꺼져있는 동안은 그 감지 자체가 아예 안 돌아서 팀원이 "완료했어요"라고 말해도 반영이 안 됨
// (실사용 신고 — 담당자가 퇴근한 뒤 다른 팀원이 완료 처리해도 인식 못 함). 소켓이 다시
// ACTIVE 상태가 될 때, 마지막으로 실시간 처리했던 시각(todoStore.getLastProcessedTs) 이후
// 그 채널에 올라온 메시지를 두레이 API로 가져와, 오래된 것부터 순서대로 다시 "방금 온
// 메시지"인 것처럼 checkTodoCompletion에 통과시켜 밀린 처리를 대신해줍니다. 봇 자기 메시지/
// 시스템 알림은 실시간 처리와 동일하게 건너뜁니다. 이 채널을 처음 추적하는 경우(기록이
// 아예 없음)는 과거 전체를 한꺼번에 재처리하면 예상 못 한 대량 처리가 될 수 있어, 지금부터
// 추적만 시작하고 건너뜁니다.
const TODO_CATCHUP_SIZE = 100

async function catchUpMissedTodoMessages(doorayClient, { log, postTodoListNow, getConfig } = {}) {
  const cfg = getConfig ? getConfig() : {}
  const channels = cfg.todoChannels || []
  for (const channelId of channels) {
    try {
      const lastTs = todoStore.getLastProcessedTs(channelId)
      if (!lastTs) {
        todoStore.setLastProcessedTs(channelId, Date.now())
        continue
      }
      const fetched = await fetchRecentChannelLogs(doorayClient, channelId, TODO_CATCHUP_SIZE)
      if (!fetched) continue
      const missing = fetched.filter((m) => m.ts > lastTs && m.text)
      let latestTs = lastTs
      let handled = 0
      for (const m of missing) {
        latestTs = Math.max(latestTs, m.ts)
        if (isOwnTodoPost(m.text) || isSystemDateNotice(m.text)) continue
        try {
          const acted = await checkTodoCompletion({
            channelId,
            msgText: m.text,
            log,
            postTodoListNow,
            doorayClient,
            trigger: cfg.trigger
          })
          if (acted) handled += 1
        } catch (err) {
          if (log) log(`밀린 투두 메시지 처리 실패 (channelId=${channelId}): ${err.message}`)
        }
      }
      todoStore.setLastProcessedTs(channelId, latestTs)
      if (handled > 0 && log) log(`꺼져있던 동안 밀린 투두 메시지 ${handled}건 반영함 (channelId=${channelId})`)
    } catch (err) {
      if (log) log(`밀린 투두 메시지 확인 실패 (channelId=${channelId}): ${err.message}`)
    }
  }
}

// 자동화(템플릿 자동 업무 생성)에서 쓰는, 서식 없는 순수 대화 기록 텍스트.
function getHistoryText(channelId) {
  const list = channelHistory.get(channelId) || []
  if (list.length === 0) return ''
  return list
    .map((m) => {
      const time = new Date(m.ts).toLocaleTimeString('ko-KR')
      return `(${time}) 발신자 ${m.senderId}: ${m.text}`
    })
    .join('\n')
}

function ensureChannelWorkspace(channelId) {
  const dir = path.join(WORKSPACE_ROOT, channelId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function matchesTrigger(text, trigger) {
  const trimmed = text.replace(/^\s+/, '')
  const lower = trimmed.toLowerCase()
  const needle = '@' + trigger.toLowerCase()
  if (!lower.startsWith(needle)) return false
  const after = trimmed.charAt(needle.length)
  return after === '' || /\s/.test(after)
}

function stripTrigger(text, trigger) {
  const trimmed = text.replace(/^\s+/, '')
  return trimmed.slice(('@' + trigger).length).trim()
}

// claude -p 로 실행해서 답을 받아옴 (shell:false + 배열 인자 = 한글 인자 깨짐 방지, 테스트 완료된 방식)
// 클로드 호출 1건이 끝났을 때, --output-format json 응답에서 비용/토큰 정보를 뽑아
// usageStore에 기록합니다. 이 함수 자체가 실패해도(형식이 예상과 다르는 등) 절대
// 실제 답변 흐름을 막으면 안 되므로, 호출하는 쪽에서 항상 try/catch로 감쌉니다.
function recordUsageFromParsedResult(parsed, { feature, model }) {
  const usage = parsed.usage || {}
  usageStore.appendUsage({
    feature: feature || 'other',
    model: model || parsed.model || '(기본모델)',
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    costUsd: parsed.total_cost_usd ?? parsed.cost_usd ?? 0
  })
}

// cwd를 주면 그 폴더에서 실행됩니다 (채널별 작업 폴더 분리용).
// model을 주면 그 모델로 강제 지정합니다 (예: 메일 요약처럼 가볍게 처리해도 되는 작업은 'haiku'로).
// feature를 주면 사용량 대시보드에서 "어떤 기능이 얼마나 썼는지" 구분하는 라벨로 씁니다.
async function askClaude(promptText, { timeoutMs = 300_000, cwd, model, feature } = {}) {
  // 'claude'라는 이름이 이 컴퓨터에서 바로 실행되는지, 아니면 설치는 됐지만 다른 위치에
  // 있는지 먼저 자동으로 확인합니다 (터미널을 직접 열어 확인할 필요 없음).
  const claudePath = await resolveClaudePath()
  if (!claudePath) {
    throw new Error(
      'claude 실행 실패: 이 컴퓨터에서 클로드(Claude Code)를 찾지 못했습니다. ' +
      '설치가 안 되어 있거나, 이 프로그램이 아는 위치와 다른 곳에 설치되어 있을 수 있어요.'
    )
  }

  return new Promise((resolve, reject) => {
    // 프롬프트를 클로드 실행 명령어의 인자로 그대로 넘기다 보니, 메일 전문(IMAP)처럼
    // 아주 긴 내용이 들어오면 윈도우 명령줄 길이 제한을 넘어 "spawn ENAMETOOLONG" 오류가
    // 났습니다. 앞부분(지침)은 보존한 채 뒷부분만 잘라서 항상 안전한 길이로 보냅니다.
    const MAX_PROMPT_LEN = 20000
    const safePrompt = promptText.length > MAX_PROMPT_LEN
      ? promptText.slice(0, MAX_PROMPT_LEN) + '\n\n...(내용이 너무 길어 일부는 생략했습니다)'
      : promptText
    // --output-format json을 쓰면 답변 텍스트와 함께 공식 비용(USD)·토큰 사용량이 같이
    // 나와서, 사용량 대시보드에 쓸 정확한 값을 직접 요금표 없이 그대로 기록할 수 있습니다.
    const args = ['-p', safePrompt, '--dangerously-skip-permissions', '--output-format', 'json']
    if (model) args.push('--model', model)
    // npm으로 설치된 클로드(cli.js)는 node로 실행해야 해서, 저장된 경로 형태에 맞는
    // 실제 실행 명령으로 변환해서 씁니다 (claudeResolver.commandFor 참고).
    const { cmd, args: preArgs } = commandFor(claudePath)
    const child = spawn(cmd, [...preArgs, ...args], {
      shell: false,
      windowsHide: true,
      cwd: cwd || undefined
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString('utf-8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf-8') })

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`클로드 응답 시간 초과(${timeoutMs / 1000}초). 지금까지 받은 내용: ${stdout.slice(0, 300) || '(없음)'} / 오류 출력: ${stderr.slice(0, 300) || '(없음)'}`))
    }, timeoutMs)

    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`claude 실행 실패: ${err.message}`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude 종료 코드 ${code}: ${stderr.slice(0, 300)}`))
        return
      }
      const raw = stdout.trim()
      let resultText = raw
      // --output-format json 응답 파싱을 시도합니다. 실패해도(예전 버전이라 형식이 다르거나
      // 예상 밖 출력이 섞인 경우) 원본 텍스트를 그대로 답변으로 씁니다 — 사용량 기록만
      // 못 할 뿐, 실제 답변 흐름은 항상 그대로 유지됩니다.
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed.result === 'string') resultText = parsed.result
        try {
          recordUsageFromParsedResult(parsed, { feature, model })
        } catch (usageErr) {
          // 사용량 기록 실패는 조용히 무시 (답변 자체는 정상 처리)
        }
      } catch {
        // json이 아니면 그냥 텍스트로 취급
      }
      resolve(resultText.trim() || '(빈 응답)')
    })
  })
}

// ---- 채팅방 공유 투두리스트: 멘션 없이 지나가는 메시지에서 "완료 보고"/"새 항목 추가" 감지 ----
// "공유 투두방"으로 지정된 채팅방에서는 @두레이봇을 부르지 않아도 오가는 메시지를 읽어서
// 두 가지를 함께 판단합니다: ① 지금 남아있는 할 일 중 뭔가를 끝냈다는 보고인가 ② "~추가/
// ~등록해줘"처럼 새 할 일을 등록해달라는 의도가 명확한가. 둘 다 확실하지 않으면 절대
// 추측하지 않습니다(엉뚱하게 체크되거나, 잡담이 할 일로 잘못 추가되는 것을 막기 위함).
// taskAutomation.js와 같은 이유로 JSON 대신 마커 태그로 답을 받습니다(줄바꿈/쉼표가 섞여도
// 파싱이 깨지지 않음). 한 번의 AI 호출로 두 가지를 같이 물어봐서 호출 횟수를 늘리지 않습니다.
// taskAutomation.js의 nowKstInfo()와 같은 이유로, 서버/사용자 컴퓨터 시스템 시간대에 기대지
// 않도록 KST로 직접 시프트해서 오늘 날짜 문자열을 구합니다.
function todayKstIso() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`
}

// ---- 3분 정적 시 자동 재게시 (항상 최신화 원칙) --------------------------
// "공유 투두방"에서 오간 메시지가(완료/추가로 인식됐든 잡담이라 그냥 지나갔든) 3분간 더
// 없으면, 목록을 다시 게시해서 항상 최신 상태가 채팅방 위쪽에 보이게 합니다.
// ⚠️ 봇이 방금 올린 "오늘의 할일" 게시물 자체도 소켓으로는 똑같이 "새 메시지"로 들어오기
// 때문에, 그걸 걸러내지 않으면 재게시 → 그 메시지가 다시 타이머를 리셋 → 3분 뒤 또 재게시...
// 식으로 무한 반복될 위험이 있습니다. isOwnTodoPost()로 반드시 걸러내야 합니다.
const TODO_IDLE_REPOST_MS = 3 * 60 * 1000
const todoIdleTimers = new Map() // channelId -> timeout handle

// 봇이 이 채팅방에 스스로 올리는 메시지는 전부 여기서 걸러야 합니다. "오늘의 할일" 전체
// 재게시뿐 아니라, "카카오 소재 세팅 등록했어요"처럼 변경 사항을 알려주는 확인 메시지도
// 포함됩니다 — 이 확인 메시지를 걸러내지 않으면, 봇이 보낸 "등록했어요: OO" 문장을 AI가
// 다시 "OO를 새로 등록해달라는 말"로 잘못 읽어서 같은 항목을 계속 반복 추가하는 무한
// 루프가 생깁니다 (실사용 중 발견된 문제 — "카카오 소재 세팅"이 4번 연속 등록된 사례).
const OWN_TODO_MESSAGE_PREFIXES = [
  '📋 오늘의 할일',
  '📌 새 할 일로 등록했어요',
  '✅ 완료로 표시했어요',
  '🏷 태그를 바꿨어요',
  '🗑 삭제했어요',
  '✏️ 내용을 바꿨어요'
]

// 이제 봇이 투두방에 올리는 메시지는 전부 "[두레이봇] " 같은 트리거 이름을 앞에 붙여서
// 누가 봐도 봇 글임을 알 수 있게 합니다. 트리거 이름은 설정에서 바꿀 수 있어 고정
// 문자열로 못 걸러서, 대괄호 부분은 통째로 건너뛰고 그 뒤 내용만으로 판단합니다.
function stripLeadingTag(text) {
  return (text || '').replace(/^\[[^\]]*\]\s*/, '')
}

function isOwnTodoPost(text) {
  if (typeof text !== 'string') return false
  const stripped = stripLeadingTag(text)
  if (OWN_TODO_MESSAGE_PREFIXES.some((prefix) => stripped.startsWith(prefix))) return true
  if (isTodoQueryAnswerPost(text)) return true
  return isTodoTagCreateOwnMessage(text)
}

// "OO 태그가 없는데 새로 만들까요?" 확인 질문/그 답변에 대한 봇의 응답들도 전부 봇 자신의
// 게시물입니다. 태그 이름·건수가 매번 달라서 고정 문자열로 못 걸러 정규식으로 형태만
// 확인합니다. 이걸 놓치면 봇이 스스로 물어본 질문을 다시 새 요청으로 읽어서 똑같은 확인
// 질문을 무한히 반복해서 올리는 문제가 생깁니다(앞서 다른 자기 메시지 필터 누락으로 생겼던
// 문제와 같은 종류라, 이번엔 미리 막아둡니다).
function isTodoTagCreateOwnMessage(text) {
  if (typeof text !== 'string') return false
  const stripped = stripLeadingTag(text)
  if (stripped === '알겠어요, 태그는 만들지 않을게요.') return true
  if (/^🏷 '.+' 태그를 새로 만들고 옮겼어요:/.test(stripped)) return true
  if (/^'.+' 태그가 아직 없는데, 새로 만들어서 \d+건\(.*\)을 옮길까요\? \(네\/아니오로 답해주세요\)$/.test(stripped)) return true
  return false
}

// "내일 할일 뭐야?" 류의 조회 질문에 봇이 답한 메시지("[두레이봇] 오늘 할 일:\n- ..." 또는
// "[두레이봇] 내일 할 일로 등록된 게 없어요.")도 봇 자신의 게시물입니다. 대괄호 안 트리거
// 이름은 사용자가 설정에서 바꿀 수 있어 고정 문자열로 못 걸러서, 대괄호 부분은 통째로
// 건너뛰고 그 뒤 내용만 확인합니다. 이걸 놓치면 봇의 답변 자체를 다시 조회 질문으로 읽어서
// 똑같은 답을 무한히 반복해서 올리는 문제가 생깁니다(실사용 중 발견된 문제).
function isTodoQueryAnswerPost(text) {
  if (typeof text !== 'string') return false
  const stripped = text.replace(/^\[[^\]]*\]\s*/, '')
  return /^(오늘|내일|모레|\d{4}-\d{2}-\d{2})\s*할\s?일(:|로 등록된 게 없어요)/.test(stripped)
}

// 두레이가 날짜 바뀔 때 채팅방에 자동으로 올리는 시스템 알림("2026.07.29 수요일" 같은,
// 날짜+요일만 있는 짧은 메시지)을 걸러냅니다. 이걸 실제 채팅으로 잘못 인식하면 3분 정적
// 재게시 타이머가 리셋되거나, 완료/새 할 일 감지 AI가 불필요하게 호출됩니다.
function isSystemDateNotice(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  return /^\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\.?\s*(월|화|수|목|금|토|일)요일$/.test(trimmed)
}

function scheduleTodoIdleRepost(channelId, { postTodoListNow, log }) {
  const existing = todoIdleTimers.get(channelId)
  if (existing) clearTimeout(existing)
  todoIdleTimers.set(channelId, setTimeout(() => {
    todoIdleTimers.delete(channelId)
    postTodoListNow(channelId).catch((err) => log(`3분 정적 재게시 실패 (channelId=${channelId}): ${err.message}`))
  }, TODO_IDLE_REPOST_MS))
}

// ---- 날짜가 애매한 새 할 일 → 채팅으로 되물어보기 --------------------------
// fileAttachAutomation.js의 "추측 → 확인 대기 → 실행" 패턴과 같은 구조입니다.
// channelId -> { text, question, createdAt }
const pendingTodoDateClarify = new Map()
const TODO_CLARIFY_TTL_MS = 10 * 60 * 1000

// 이 채팅방에 답을 기다리던 질문이 있으면, 방금 온 메시지가 그 답인지 먼저 확인합니다.
// 답이면 카드까지 만들고 true를 돌려줍니다(호출부는 이후 일반 감지 로직을 생략).
// 답이 아니거나(다른 화제) 기다리던 질문 자체가 없으면 false를 돌려줘서, 호출부가 이
// 메시지를 평소대로(완료 보고/새 할 일 등) 계속 처리하게 합니다.
async function tryResolvePendingTodoClarify({ channelId, msgText, log, postTodoListNow }) {
  const pending = pendingTodoDateClarify.get(channelId)
  if (!pending) return false
  if (Date.now() - pending.createdAt > TODO_CLARIFY_TTL_MS) {
    pendingTodoDateClarify.delete(channelId)
    return false
  }
  const todayIso = todayKstIso()
  const prompt = [
    `오늘 날짜는 ${todayIso}입니다.`,
    '방금 아래 질문을 채팅방에 물어봤고, 이어서 답장이 왔습니다. 이 답장이 그 질문에 대한',
    '답인지 보고, 답이라면 "오늘 할 일"인지 "특정 날짜에 예약"인지 판단해주세요.',
    '답장이 질문과 무관한 다른 이야기면(=답이 아니면) UNCLEAR로 판단하세요.',
    '',
    `[물어본 질문] ${pending.question}`,
    `[할 일 내용] ${pending.text}`,
    `[답장] ${msgText}`,
    '',
    '오늘 할 일이면 TODAY, 특정 날짜면 그 날짜를 오늘 기준으로 계산해 YYYY-MM-DD 형식으로,',
    '답이 아니면 UNCLEAR로 — [RESOLVED]와 [/RESOLVED] 사이에 셋 중 하나만 적으세요.'
  ].join('\n')
  const answer = await askClaude(prompt, { model: 'haiku', feature: 'todo_date_resolve' })
  const m = answer.match(/\[RESOLVED\]([\s\S]*?)\[\/RESOLVED\]/)
  const resolved = m ? m[1].trim() : 'UNCLEAR'
  if (resolved !== 'TODAY' && !/^\d{4}-\d{2}-\d{2}$/.test(resolved)) return false

  const dueDate = resolved === 'TODAY' ? todayIso : resolved
  todoStore.addCard({ channelId, text: pending.text, dueDate })
  pendingTodoDateClarify.delete(channelId)
  log(`모호했던 할 일 날짜 확인됨: "${pending.text}" → ${dueDate} (channelId=${channelId})`)
  try {
    await postTodoListNow(channelId)
  } catch (err) {
    log(`할 일 변경 반영 재게시 실패: ${err.message}`)
  }
  return true
}

// ---- 없는 태그로 옮겨달라는 요청 → "새로 만들까요?" 채팅으로 확인 후 생성 --------------
// 사람 태그(재우/태근 같은)는 매체와 달리 오타나 잘못 말한 단어가 그대로 태그로 굳어버리면
// 안 되기 때문에, AI가 절대 스스로 만들지 않고 여기서 사람에게 먼저 확인을 받습니다.
// channelId -> { tagName, cardIds, createdAt }
const pendingTodoTagCreateClarify = new Map()
const TODO_TAG_CREATE_TTL_MS = 10 * 60 * 1000

// 답을 기다리던 "OO 태그 새로 만들까요?" 질문이 있었다면, 방금 온 메시지가 그 답(예/아니오)인지
// 확인합니다. 애매한 잡담과 헷갈리지 않게, 단순 키워드 매칭 대신 다른 확인 질문들과 같은
// 방식으로 AI에게 판단을 맡깁니다.
async function tryResolvePendingTodoTagCreate({ channelId, msgText, log, postTodoListNow, doorayClient, trigger }) {
  const pending = pendingTodoTagCreateClarify.get(channelId)
  if (!pending) return false
  if (Date.now() - pending.createdAt > TODO_TAG_CREATE_TTL_MS) {
    pendingTodoTagCreateClarify.delete(channelId)
    return false
  }
  const prompt = [
    '방금 채팅방에 아래 질문을 물어봤고, 이어서 답장이 왔습니다. 이 답장이 그 질문에 대한',
    '"응(만들어줘)"인지 "아니(만들지 마)"인지 판단해주세요. 질문과 상관없는 다른 이야기면',
    'UNCLEAR로 판단하세요.',
    '',
    `[물어본 질문] ${pending.question}`,
    `[답장] ${msgText}`,
    '',
    'YES, NO, UNCLEAR 중 하나만 [RESOLVED]와 [/RESOLVED] 사이에 적으세요.'
  ].join('\n')
  const answer = await askClaude(prompt, { model: 'haiku', feature: 'todo_tag_create_resolve' })
  const m = answer.match(/\[RESOLVED\]([\s\S]*?)\[\/RESOLVED\]/)
  const resolved = m ? m[1].trim() : 'UNCLEAR'
  if (resolved !== 'YES' && resolved !== 'NO') return false

  pendingTodoTagCreateClarify.delete(channelId)

  if (resolved === 'NO') {
    log(`새 태그 생성 거절됨: "${pending.tagName}" (channelId=${channelId})`)
    if (doorayClient) {
      try {
        await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
          method: 'POST',
          body: { text: `[${trigger}] 알겠어요, 태그는 만들지 않을게요.` }
        })
      } catch (err) {
        log(`태그 생성 취소 메시지 전송 실패: ${err.message}`)
      }
    }
    return true
  }

  const newTag = todoTagStore.addTag({ channelId, name: pending.tagName })
  const openCards = todoStore.listOpenCards(channelId, { dateIso: todayKstIso() })
  const movedTexts = []
  for (const cardId of pending.cardIds) {
    if (!openCards.some((c) => c.id === cardId)) continue
    todoStore.setTag(cardId, newTag.id)
    const card = openCards.find((c) => c.id === cardId)
    if (card) movedTexts.push(card.text)
  }
  log(`새 태그 생성 및 이동: "${pending.tagName}" ← ${movedTexts.join(', ')} (channelId=${channelId})`)
  if (doorayClient) {
    try {
      await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
        method: 'POST',
        body: { text: `[${trigger}] 🏷 '${pending.tagName}' 태그를 새로 만들고 옮겼어요: ${movedTexts.join(', ') || '(대상 없음)'}` }
      })
    } catch (err) {
      log(`태그 생성 확인 메시지 전송 실패: ${err.message}`)
    }
  }
  try {
    await postTodoListNow(channelId)
  } catch (err) {
    log(`할 일 변경 반영 재게시 실패: ${err.message}`)
  }
  return true
}

// 반환값(true/false)은 "이 호출 안에서 이미 최신 목록을 채팅방에 올렸는가"입니다. 호출부가
// 이 값을 보고, 방금 이미 올렸으면 3분 뒤 정적 재게시를 또 걸지 않도록(중복 게시 방지) 씁니다.
async function checkTodoCompletion({ channelId, msgText, log, postTodoListNow, doorayClient, trigger }) {
  // 답을 기다리던 모호한 날짜 질문이 있었다면, 이번 메시지가 그 답인지 먼저 확인합니다.
  if (await tryResolvePendingTodoClarify({ channelId, msgText, log, postTodoListNow })) return true
  // 답을 기다리던 "새 태그 만들까요?" 질문이 있었다면, 이번 메시지가 그 답인지 확인합니다.
  if (await tryResolvePendingTodoTagCreate({ channelId, msgText, log, postTodoListNow, doorayClient, trigger })) return true

  const todayIso = todayKstIso()
  const openCards = todoStore.listOpenCards(channelId, { dateIso: todayIso })
  const tags = todoTagStore.listTags(channelId)
  // "미분류에 있는거 재우로 옮겨줘"처럼 여러 항목을 한 번에 옮겨달라는 요청을 AI가 판단하려면
  // 각 항목의 "현재 태그"를 반드시 알아야 합니다 — 이게 없으면 어떤 카드가 미분류인지조차
  // 알 수 없어서, 추측하지 않는 원칙 때문에 아무 것도 못 고르고 조용히 아무 일도 안 일어나는
  // 문제가 있었습니다(실사용 중 발견된 문제).
  const listText = openCards.length
    ? openCards
        .map((c) => `[${c.id}] ${c.text} (현재 태그: ${c.tagId ? (tags.find((t) => t.id === c.tagId)?.name || '미분류') : '미분류'})`)
        .join('\n')
    : '(없음)'
  const tagListText = tags.length
    ? tags.map((t) => `${t.id}: ${t.name}`).join('\n')
    : '(태그 없음)'
  const subTags = todoSubTagStore.listSubTags(channelId)
  // 별칭이 있으면 "네이버(별칭: 브검, 브랜드검색)"처럼 같이 보여줘서, 텍스트에 "브검"만
  // 나와도 AI가 이미 "네이버"로 등록된 것과 같은 매체라는 걸 바로 알 수 있게 합니다.
  const subTagListText = subTags.length
    ? subTags.map((t) => (t.aliases && t.aliases.length ? `${t.name}(별칭: ${t.aliases.join(', ')})` : t.name)).join(', ')
    : '(아직 없음 — 처음 보는 매체명이면 새로 만들어도 됨)'

  const prompt = [
    `오늘 날짜는 ${todayIso}입니다.`,
    '',
    '아래는 어느 채팅방의 "오늘의 할 일" 목록, 그 방에 등록된 태그 목록, 그리고 방금 새로',
    '올라온 메시지 1건입니다. 이 메시지를 보고 아래 항목들을 순서대로 판단해주세요.',
    '',
    '0) 먼저 순수 조회 질문인지 확인하세요: 완료/추가/태그변경/삭제/수정 같은 지시가 조금이라도',
    '섞여 있으면 순수 조회가 아닙니다. 그런 지시 없이 그냥 "오늘/내일/모레/특정 날짜에 할 일',
    `뭐야?"처럼 목록 자체를 물어보는 질문이면, 그 날짜를 오늘(${todayIso}) 기준으로 계산해서`,
    'TODAY(오늘) 또는 YYYY-MM-DD(특정 날짜) 형식으로 [QUERY_DATE]와 [/QUERY_DATE] 사이에',
    '적으세요 — 이 경우 아래 1~5번은 전부 마커만(내용 없이) 그대로 출력하면 됩니다. 순수 조회',
    '질문이 아니면 [QUERY_DATE][/QUERY_DATE]처럼 비워두고, 아래 1~5번을 평소대로 판단하세요.',
    '',
    '1) 완료 보고인가: 목록 중 하나(또는 여러 개)를 이미 끝냈다는 보고면, 완료된 항목의 [ ] 안',
    'ID만 골라 [DONE_IDS]와 [/DONE_IDS] 사이에 쉼표로 구분해 적어주세요. 완료 보고가 아니거나',
    '어떤 항목인지 확실하지 않으면, 절대 추측하지 말고 [DONE_IDS][/DONE_IDS] 처럼 비워두세요.',
    '',
    '2) 새 할 일을 알리는 메시지인가: "~추가", "~등록해줘"처럼 명시적인 지시어가 있거나,',
    '지시어가 없어도 "7/29 메타 소재 종료 예약"처럼 (날짜) + (할 일 이름) 형태로 봐도 명백히',
    '새 업무를 알리는 문장이면 새 할 일로 봅니다. 질문/잡담/의견처럼 업무를 등록하려는 의도가',
    '없는 문장이면 절대 추측하지 말고 넣지 마세요.',
    '   2-0) "OO 태그로 할 일 생성", "이거 다 등록해줘"처럼 명시적으로 등록을 지시하면서',
    '   1. 2. 3.처럼 번호를 매겨 여러 항목을 나열한 경우, 나열된 항목은 전부 등록 대상입니다.',
    '   개별 항목의 내용이 사소하거나 업무처럼 안 보이거나 농담 같아 보여도, 사용자가 이미 그',
    '   목록 전체를 등록해달라고 명시적으로 지시했으므로 절대 임의로 빼지 마세요(위 "질문/',
    '   잡담이면 넣지 마세요"는 지시 자체가 불분명한 메시지에만 해당하고, 이렇게 명시적으로',
    '   번호를 매겨 등록을 요청한 목록에는 적용하지 않습니다). 목록 중 일부만 골라 등록하면',
    '   안 됩니다 — 번호가 매겨진 항목 수와 등록되는 항목 수가 항상 같아야 합니다.',
    '   2-1) 오늘 할 일인지 특정 날짜 예약인지 명확하면(날짜가 적혀 있거나, 날짜 언급이 아예',
    '   없어 오늘 일로 보는 게 자연스러우면), 항목마다 한 줄에',
    '   "YYYY-MM-DD|태그ID|매체명|할 일 내용" 형식으로',
    `   [NEW_ITEMS]와 [/NEW_ITEMS] 사이에 적으세요. 날짜가 언급되어 있으면 오늘(${todayIso})`,
    `   기준으로 계산한 실제 날짜로, 언급이 없으면 오늘 날짜(${todayIso})를 그대로 쓰세요.`,
    '   "추가"/"등록" 같은 지시어와 날짜 표현은 할 일 내용에서 빼주세요.',
    '   태그ID 자리: "이거 재우 태그로", "OO 걸로" 처럼 사람 이름이나 업무 성격을 태그처럼',
    '   붙여 말했으면 아래 태그 목록에서 정확히 일치하는 태그를 찾아 그 ID를 적으세요. 그런',
    '   언급이 없거나 목록에 없는 이름이면 태그ID 자리는 비워두세요(새 태그를 지어내지 마세요).',
    '   태그 이름 자체는 할 일 내용에도 다시 넣지 마세요(태그ID 자리에만 적으면 충분합니다).',
    '   매체명 자리: 할 일 내용에 "메타/구글/카카오/네이버/SA" 같은 광고 매체나 채널 이름이',
    '   들어있으면 그 이름을 적으세요. 아래 매체 목록에 이미 있는 이름과 같은 매체면(표기가',
    '   조금 달라도 같은 매체면, 예: "메타"="Meta") 목록에 있는 표기 그대로 적어서 재사용하고,',
    '   목록에 없는 새 매체면 새 이름을 그대로 적으세요(만들어도 됩니다 — 태그와 달리 매체는',
    '   자동으로 새로 생겨도 괜찮습니다). 매체를 알 수 없으면 이 자리는 비워두세요.',
    '   2-2) 새 할 일인 건 맞는데, "다음 주 중으로", "조만간"처럼 오늘 할 일로 봐야 할지',
    '   특정 날짜에 예약해야 할지 스스로 확신할 수 없으면, 절대 추측하지 말고 대신',
    '   "할 일 내용|되물을 질문" 형식으로 [AMBIGUOUS]와 [/AMBIGUOUS] 사이에 딱 한 건만',
    '   적으세요 (되물을 질문은 채팅방에 그대로 보낼 것이니 짧고 자연스러운 존댓말로).',
    '   여러 개를 한 번에 말했으면 2-1/2-2 각각 해당하는 형식으로 나눠 적으세요.',
    '',
    '3) 태그를 바꿔달라는 요청인가: "이거 재우 태그로 바꿔줘"처럼 목록의 항목을 아래 태그 목록',
    '중 하나로 옮겨달라는 명확한 요청이면, "카드ID|태그ID" 형식으로 [TAG_CHANGES]와',
    '[/TAG_CHANGES] 사이에 적으세요. "미분류에 있는거 재우로 옮겨줘"처럼 특정 항목을 콕 집지',
    '않고 "미분류 전부"/"~에 있는거 다"처럼 뭉뚱그려 말했으면, 위 목록에서 (현재 태그)가 그',
    '조건과 일치하는 항목을 전부 찾아 각각 한 줄씩 적으세요(한 건도 빠짐없이). 요청이 없거나',
    '확실하지 않으면 비워두세요.',
    '   3-1) 옮겨달라고 한 태그 이름이 아래 태그 목록에 없으면(=아직 없는 새 태그), 절대',
    '   지어내서 만들지 말고, 대신 그 새 태그 이름과 옮기려던 항목들의 ID를 "새태그이름|',
    '   카드ID1,카드ID2" 형식으로 [NEW_TAG_REQUEST]와 [/NEW_TAG_REQUEST] 사이에 딱 한 건만',
    '   적으세요(실제로 태그를 만들지는 사람에게 먼저 물어봐야 해서, 여기선 요청만 표시합니다).',
    '',
    '4) 삭제(취소) 요청인가: "삭제해줘", "지워줘", "취소해줘"처럼 완료가 아니라 아예 목록에서',
    '없애달라는 요청이면, 해당 항목의 [ ] 안 ID만 골라 [DELETE_IDS]와 [/DELETE_IDS] 사이에',
    '쉼표로 구분해 적으세요. "끝냈어", "했어" 같은 완료 보고와 절대 헷갈리지 마세요(그건 1번',
    'DONE_IDS입니다). 삭제 요청이 아니거나 어떤 항목인지 확실하지 않으면, 절대 추측하지 말고',
    '[DELETE_IDS][/DELETE_IDS] 처럼 비워두세요.',
    '',
    '5) 수정(문구 변경) 요청인가: "아까 그거 OO로 바꿔줘", "문구 좀 고쳐줘"처럼 목록에 있는',
    '항목의 태그/매체가 아니라 할 일 내용 자체를 다른 문구로 바꿔달라는 요청이면, "카드ID|새',
    '문구" 형식으로 [EDIT_ITEMS]와 [/EDIT_ITEMS] 사이에 줄마다 하나씩 적으세요. 어떤 태그나',
    '매체로 옮겨달라는 요청(3번 TAG_CHANGES)과 절대 헷갈리지 마세요 — 이건 카드가 있는 곳은',
    '그대로 두고 그 카드의 글자만 바꾸는 경우에만 씁니다. 수정 요청이 아니거나 어떤 항목을',
    '어떻게 바꿀지 확실하지 않으면, 절대 추측하지 말고 [EDIT_ITEMS][/EDIT_ITEMS] 처럼',
    '비워두세요.',
    '',
    '[오늘의 할 일 목록]',
    listText,
    '',
    '[태그 목록]',
    tagListText,
    '',
    '[매체 목록(기존에 쓰인 것들)]',
    subTagListText,
    '',
    '[새 메시지]',
    msgText
  ].join('\n')

  const answer = await askClaude(prompt, { model: 'haiku', feature: 'todo_complete_detect' })

  // 순수 조회 질문이면(0번), 완료/추가/태그변경 등 나머지 판단은 아예 건드리지 않고 실제
  // 데이터로 곧바로 답합니다. 예전에는 이 조회 판단을 별도 키워드 목록(isTodoQueryQuestion)이
  // 먼저 걸러냈는데, 목록에 없는 표현("생성" 등)이 나오면 조회로 오판단되어 새 할 일이 하나도
  // 등록 안 되는 버그가 있었음(실사용 중 발견) — 이제는 이 AI 판단 하나로 통합해서, 새로운
  // 표현이 나올 때마다 키워드를 계속 추가해야 하는 문제를 근본적으로 없앰.
  const queryMatch = answer.match(/\[QUERY_DATE\]([\s\S]*?)\[\/QUERY_DATE\]/)
  const queryDateRaw = (queryMatch ? queryMatch[1] : '').trim().toUpperCase()
  if (queryDateRaw === 'TODAY' || /^\d{4}-\d{2}-\d{2}$/.test(queryDateRaw)) {
    const targetDateIso = queryDateRaw === 'TODAY' ? todayIso : queryDateRaw
    const answerText = buildTodoQueryAnswer(channelId, targetDateIso, todayIso)
    if (doorayClient) {
      try {
        await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
          method: 'POST',
          body: { text: `[${trigger}] ${answerText}` }
        })
        log(`할 일 조회 답변 완료 (channelId=${channelId}, date=${targetDateIso})`)
      } catch (err) {
        log(`할 일 조회 답변 실패: ${err.message}`)
      }
    }
    return 'query'
  }

  const doneIds = []
  const doneMatch = answer.match(/\[DONE_IDS\]([\s\S]*?)\[\/DONE_IDS\]/)
  if (doneMatch) {
    doneIds.push(...doneMatch[1].split(',').map((s) => s.trim()).filter((id) => openCards.some((c) => c.id === id)))
  }
  for (const id of doneIds) {
    const card = openCards.find((c) => c.id === id)
    todoStore.setStatus(id, 'done')
    // 완료 시점의 태그/매체 이름을 그대로 남깁니다(나중에 태그가 바뀌거나 지워져도 이
    // 기록은 그때 기준 그대로 남아있어야 하므로, ID가 아니라 이름을 저장합니다).
    if (card) {
      try {
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

  // 삭제(취소) 요청 — 완료와 달리 기록을 남길 필요가 없어서 바로 todoStore.removeCard로
  // 소프트 삭제합니다(대시보드의 "삭제" 버튼과 완전히 같은 동작).
  const deleteIds = []
  const deleteMatch = answer.match(/\[DELETE_IDS\]([\s\S]*?)\[\/DELETE_IDS\]/)
  if (deleteMatch) {
    deleteIds.push(...deleteMatch[1].split(',').map((s) => s.trim()).filter((id) => openCards.some((c) => c.id === id)))
  }
  const deleteTexts = deleteIds.map((id) => openCards.find((c) => c.id === id)?.text || id)
  for (const id of deleteIds) {
    todoStore.removeCard(id)
  }

  // 수정(문구 변경) 요청 — 카드 위치(태그/매체)는 그대로 두고 텍스트만 바꿉니다.
  const editItems = []
  const editMatch = answer.match(/\[EDIT_ITEMS\]([\s\S]*?)\[\/EDIT_ITEMS\]/)
  if (editMatch) {
    for (const line of editMatch[1].split('\n').map((s) => s.trim()).filter(Boolean)) {
      const sep = line.indexOf('|')
      if (sep < 0) continue
      const cardId = line.slice(0, sep).trim()
      const newText = line.slice(sep + 1).trim()
      const card = openCards.find((c) => c.id === cardId)
      if (!card || !newText) continue
      editItems.push({ cardId, oldText: card.text, newText })
      todoStore.setText(cardId, newText)
    }
  }

  const newItems = []
  const newMatch = answer.match(/\[NEW_ITEMS\]([\s\S]*?)\[\/NEW_ITEMS\]/)
  if (newMatch) {
    for (const line of newMatch[1].split('\n').map((s) => s.trim()).filter(Boolean)) {
      // 기본 형식은 "YYYY-MM-DD|태그ID|매체명|할 일 내용"(4개)이지만, 예전 응답 형식
      // "YYYY-MM-DD|태그ID|할 일 내용"(3개)이나 "YYYY-MM-DD|할 일 내용"(2개)도 그대로
      // 받아들이도록 구분자 개수를 보고 유연하게 나눕니다.
      const parts = line.split('|')
      const dateStr = (parts[0] || '').trim()
      let tagId = null
      let mediaName = ''
      let text = ''
      if (parts.length >= 4) {
        const tagCandidate = parts[1].trim()
        if (tagCandidate && tags.some((t) => t.id === tagCandidate)) tagId = tagCandidate
        mediaName = parts[2].trim()
        text = parts.slice(3).join('|').trim()
      } else if (parts.length === 3) {
        const tagCandidate = parts[1].trim()
        if (tagCandidate && tags.some((t) => t.id === tagCandidate)) tagId = tagCandidate
        text = parts[2].trim()
      } else {
        text = (parts[1] || '').trim()
      }
      if (!text) continue
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : todayIso
      // 매체명을 이 채팅방에서 이미 쓰던 서브태그와 최대한 같은 것으로 묶고, 정말 처음
      // 보는 이름이면 새로 만듭니다(사람 손 안 거치고 자동으로).
      const subTag = mediaName ? todoSubTagStore.resolveOrCreateSubTag(channelId, mediaName) : null
      const subTagId = subTag ? subTag.id : null
      newItems.push({ text, dueDate, tagId, subTagId, subTagName: subTag ? subTag.name : null })
      todoStore.addCard({ channelId, text, dueDate, tagId, subTagId })
    }
  }

  const tagChanges = []
  const tagMatch = answer.match(/\[TAG_CHANGES\]([\s\S]*?)\[\/TAG_CHANGES\]/)
  if (tagMatch) {
    for (const line of tagMatch[1].split('\n').map((s) => s.trim()).filter(Boolean)) {
      const sep = line.indexOf('|')
      if (sep < 0) continue
      const cardId = line.slice(0, sep).trim()
      const tagId = line.slice(sep + 1).trim()
      if (!openCards.some((c) => c.id === cardId)) continue
      if (!tags.some((t) => t.id === tagId)) continue
      tagChanges.push({ cardId, tagId })
      todoStore.setTag(cardId, tagId)
    }
  }

  // 목록에 없는 태그로 옮겨달라는 요청 — 바로 만들지 않고, 먼저 채팅방에 확인을 받습니다.
  let newTagRequest = null
  const newTagMatch = answer.match(/\[NEW_TAG_REQUEST\]([\s\S]*?)\[\/NEW_TAG_REQUEST\]/)
  if (newTagMatch) {
    const line = newTagMatch[1].trim()
    const sep = line.indexOf('|')
    if (sep > 0) {
      const tagName = line.slice(0, sep).trim()
      const cardIds = line
        .slice(sep + 1)
        .split(',')
        .map((s) => s.trim())
        .filter((id) => openCards.some((c) => c.id === id))
      if (tagName && cardIds.length && !tags.some((t) => t.name === tagName)) {
        newTagRequest = { tagName, cardIds }
      }
    }
  }
  if (newTagRequest && doorayClient) {
    const cardTexts = newTagRequest.cardIds.map((id) => openCards.find((c) => c.id === id)?.text || id)
    const question = `'${newTagRequest.tagName}' 태그가 아직 없는데, 새로 만들어서 ${cardTexts.length}건(${cardTexts.join(', ')})을 옮길까요? (네/아니오로 답해주세요)`
    pendingTodoTagCreateClarify.set(channelId, {
      tagName: newTagRequest.tagName,
      cardIds: newTagRequest.cardIds,
      question,
      createdAt: Date.now()
    })
    try {
      await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
        method: 'POST',
        body: { text: `[${trigger}] ${question}` }
      })
      log(`새 태그 생성 확인 질문: "${newTagRequest.tagName}" (channelId=${channelId})`)
    } catch (err) {
      log(`새 태그 확인 질문 전송 실패: ${err.message}`)
    }
  }

  // 날짜가 애매해서 되물어야 하는 항목 — 채팅방에 질문을 보내고, 답이 올 때까지 기다립니다.
  let ambiguous = null
  const ambigMatch = answer.match(/\[AMBIGUOUS\]([\s\S]*?)\[\/AMBIGUOUS\]/)
  if (ambigMatch) {
    const line = ambigMatch[1].trim()
    const sep = line.indexOf('|')
    if (sep > 0) {
      ambiguous = { text: line.slice(0, sep).trim(), question: line.slice(sep + 1).trim() }
    }
  }
  if (ambiguous && ambiguous.text && ambiguous.question && doorayClient) {
    pendingTodoDateClarify.set(channelId, { ...ambiguous, createdAt: Date.now() })
    try {
      await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
        method: 'POST',
        body: { text: `[${trigger}] ${ambiguous.question}` }
      })
      log(`할 일 날짜 애매해서 되물음: "${ambiguous.text}" (channelId=${channelId})`)
    } catch (err) {
      log(`날짜 확인 질문 전송 실패: ${err.message}`)
    }
  }

  // 아무 것도 안 걸려도 "확인은 했다"는 걸 로그로 남겨서, "아예 코드가 안 도는 것"과
  // "읽었지만 해당 없어서 지나간 것"이 구분되게 합니다.
  if (!doneIds.length && !newItems.length && !tagChanges.length && !deleteIds.length && !editItems.length && !ambiguous && !newTagRequest) {
    log(`공유 투두 메시지 확인함 (channelId=${channelId}): 완료/추가/태그변경/삭제/수정 해당 없음`)
    return false
  }
  if (doneIds.length) log(`공유 투두 완료 처리: ${doneIds.join(', ')} (channelId=${channelId})`)
  if (deleteIds.length) log(`공유 투두 삭제 처리: ${deleteIds.join(', ')} (channelId=${channelId})`)
  if (editItems.length) log(`공유 투두 문구 수정: ${editItems.length}건 (channelId=${channelId})`)
  if (newItems.length) {
    log(`공유 투두 새 항목 추가: ${newItems.map((i) => `${i.text}(${i.dueDate})`).join(' / ')} (channelId=${channelId})`)
  }
  if (tagChanges.length) log(`공유 투두 태그 변경: ${tagChanges.length}건 (channelId=${channelId})`)
  if (!doneIds.length && !newItems.length && !tagChanges.length && !deleteIds.length && !editItems.length) return false // 되물어보기만 한 경우, 재게시는 아직 안 함

  // 목록을 통째로 다시 올리는 것만으로는 "방금 내가 한 말이 실제로 반영됐다"는 게 잘 안
  // 드러나서(할 일이 많으면 특히), 무엇이 바뀌었는지 짧게 먼저 확인 메시지로 알려줍니다.
  const ackLines = []
  if (newItems.length) {
    ackLines.push(...newItems.map((i) => {
      const tagName = i.tagId ? tags.find((t) => t.id === i.tagId)?.name : null
      const dateLabel = i.dueDate === todayIso ? '오늘' : i.dueDate
      const bits = [dateLabel]
      if (tagName) bits.push(`${tagName} 태그`)
      if (i.subTagName) bits.push(`${i.subTagName} 매체`)
      return `📌 새 할 일로 등록했어요: ${i.text} (${bits.join(', ')})`
    }))
  }
  if (doneIds.length) {
    const doneTexts = doneIds.map((id) => openCards.find((c) => c.id === id)?.text || id)
    ackLines.push(`✅ 완료로 표시했어요: ${doneTexts.join(', ')}`)
  }
  if (deleteIds.length) {
    ackLines.push(`🗑 삭제했어요: ${deleteTexts.join(', ')}`)
  }
  if (editItems.length) {
    ackLines.push(...editItems.map((i) => `✏️ 내용을 바꿨어요: ${i.oldText} → ${i.newText}`))
  }
  if (tagChanges.length) {
    const changeTexts = tagChanges.map(({ cardId, tagId }) => {
      const cardText = openCards.find((c) => c.id === cardId)?.text || cardId
      const tagName = tags.find((t) => t.id === tagId)?.name || tagId
      return `${cardText} → ${tagName}`
    })
    ackLines.push(`🏷 태그를 바꿨어요: ${changeTexts.join(', ')}`)
  }
  if (ackLines.length && doorayClient) {
    try {
      await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
        method: 'POST',
        body: { text: `[${trigger}] ${ackLines.join('\n')}` }
      })
    } catch (err) {
      log(`할 일 변경 확인 메시지 전송 실패: ${err.message}`)
    }
  }

  try {
    await postTodoListNow(channelId)
  } catch (err) {
    log(`할 일 변경 반영 재게시 실패: ${err.message}`)
  }
  return true
}

// ---- 공유 투두방이 아닌 다른 채팅방에서 "@봇 이거 투두에 추가해줘" 감지 -----------
// "이 방에서 업무 얘기하다가 봇을 불러서 다른 방(공유 투두방)의 투두리스트에 추가해줘"
// 요청을 처리합니다. "태스크/업무 만들어줘"(템플릿 자동화, 실제 두레이 업무 생성)와는
// 완전히 다른 기능이라, 겹치지 않도록 "투두"/"할 일" 단어가 있을 때만 반응합니다.
const TODO_ADD_SUBJECT_WORDS = ['투두', '할일', '할 일']
const TODO_ADD_ACTION_WORDS = ['추가', '등록', '올려', '넣어']

function isTodoAddCommand(text) {
  const t = (text || '').replace(/\s+/g, '')
  const hasSubject = TODO_ADD_SUBJECT_WORDS.some((w) => t.includes(w.replace(/\s+/g, '')))
  const hasAction = TODO_ADD_ACTION_WORDS.some((w) => t.includes(w))
  return hasSubject && hasAction
}

// 공유 투두방이 여러 개일 때 "어느 방에 추가할지" 되물어본 뒤 답을 기다리는 상태.
// askingChannelId(질문을 보낸 방) -> { candidateChannelIds, question, sourceQuestion, createdAt }
const pendingTodoChannelClarify = new Map()
const TODO_CHANNEL_CLARIFY_TTL_MS = 10 * 60 * 1000

// 대화 맥락(같은 방의 최근 대화 + 방금 멘션 메시지)에서 "할 일 내용"을 뽑아냅니다.
// targetChannelId 기준 태그/매체 목록을 참고해 태그/매체까지 함께 판단합니다.
async function resolveCrossChannelTodoItem({ targetChannelId, sourceChannelId, question, log }) {
  const todayIso = todayKstIso()
  const tags = todoTagStore.listTags(targetChannelId)
  const tagListText = tags.length ? tags.map((t) => `${t.id}: ${t.name}`).join('\n') : '(태그 없음)'
  const subTags = todoSubTagStore.listSubTags(targetChannelId)
  const subTagListText = subTags.length
    ? subTags.map((t) => (t.aliases && t.aliases.length ? `${t.name}(별칭: ${t.aliases.join(', ')})` : t.name)).join(', ')
    : '(아직 없음)'
  const contextText = getHistoryText(sourceChannelId)

  const prompt = [
    `오늘 날짜는 ${todayIso}입니다.`,
    '이 채팅방에서 업무 얘기를 나누다가, 방금 봇을 불러서 그 내용을 다른 방의 "공유',
    '투두리스트"에 추가해달라고 요청했습니다. 무엇을 추가해야 하는지 정리해주세요.',
    '요청 메시지 자체에 할 일 내용이 이미 다 적혀 있으면 그 내용을 그대로 쓰고,',
    '"이거"처럼 대화를 가리키기만 하면 아래 최근 대화에서 무엇을 말하는지 찾아 정리하세요.',
    '"투두에 추가해줘" 같은 지시어 자체는 할 일 내용에서 빼주세요.',
    '',
    '한 줄로 "YYYY-MM-DD|태그ID|매체명|할 일 내용" 형식을 [ITEM]과 [/ITEM] 사이에 적으세요.',
    `날짜가 언급되어 있으면 오늘(${todayIso}) 기준으로 계산한 실제 날짜로, 언급이 없으면`,
    `오늘 날짜(${todayIso})를 그대로 쓰세요.`,
    '태그ID 자리: 사람 이름 등이 아래 태그 목록과 정확히 일치하면 그 ID를, 아니면 비워두세요.',
    '매체명 자리: 메타/구글/카카오 같은 매체명이 언급되면 아래 매체 목록에 있는 표기를',
    '그대로 쓰거나(같은 매체면), 목록에 없는 새 매체면 새 이름을 그대로 적으세요. 없으면 비워두세요.',
    '할 일 내용을 대화에서도, 요청 메시지에서도 전혀 알 수 없으면 [ITEM][/ITEM]처럼 비워두세요.',
    '',
    '[이 채팅방의 최근 대화]',
    contextText || '(없음)',
    '',
    '[방금 온 요청 메시지]',
    question,
    '',
    '[대상 투두방 태그 목록]',
    tagListText,
    '',
    '[대상 투두방 매체 목록(기존에 쓰인 것들)]',
    subTagListText
  ].join('\n')

  const answer = await askClaude(prompt, { model: 'haiku', feature: 'todo_cross_channel_add' })
  const m = answer.match(/\[ITEM\]([\s\S]*?)\[\/ITEM\]/)
  const line = m ? m[1].trim() : ''
  if (!line) return null

  const parts = line.split('|')
  const dateStr = (parts[0] || '').trim()
  let tagId = null
  let mediaName = ''
  let text = ''
  if (parts.length >= 4) {
    const tagCandidate = parts[1].trim()
    if (tagCandidate && tags.some((t) => t.id === tagCandidate)) tagId = tagCandidate
    mediaName = parts[2].trim()
    text = parts.slice(3).join('|').trim()
  } else {
    text = parts[parts.length - 1].trim()
  }
  if (!text) return null
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : todayIso
  const subTag = mediaName ? todoSubTagStore.resolveOrCreateSubTag(targetChannelId, mediaName) : null

  return { text, dueDate, tagId, tagName: tagId ? tags.find((t) => t.id === tagId)?.name : null, subTagId: subTag ? subTag.id : null, subTagName: subTag ? subTag.name : null }
}

// 실제로 카드까지 만들고, 대상 투두방을 재게시하고, 요청한 방에 확인 메시지를 보냅니다.
async function addCrossChannelTodoItem({ askingChannelId, targetChannelId, targetLabel, question, log, doorayClient, postTodoListNow }) {
  const item = await resolveCrossChannelTodoItem({ targetChannelId, sourceChannelId: askingChannelId, question, log })
  if (!item) {
    await doorayClient.request(`/messenger/v1/channels/${askingChannelId}/logs`, {
      method: 'POST',
      body: { text: '어떤 내용을 투두리스트에 추가할지 확실하지 않아서, 등록하지 않았어요. 조금 더 구체적으로 말씀해주세요.' }
    })
    return
  }
  todoStore.addCard({
    channelId: targetChannelId,
    text: item.text,
    dueDate: item.dueDate,
    tagId: item.tagId,
    subTagId: item.subTagId
  })
  log(`다른 방에서 투두 추가: "${item.text}" → ${targetLabel}(${targetChannelId})`)
  try {
    await postTodoListNow(targetChannelId)
  } catch (err) {
    log(`투두 재게시 실패: ${err.message}`)
  }
  const bits = [item.dueDate]
  if (item.tagName) bits.push(`${item.tagName} 태그`)
  if (item.subTagName) bits.push(`${item.subTagName} 매체`)
  try {
    await doorayClient.request(`/messenger/v1/channels/${askingChannelId}/logs`, {
      method: 'POST',
      body: { text: `📌 [${targetLabel}] 공유 투두리스트에 추가했어요: ${item.text} (${bits.join(', ')})` }
    })
  } catch (err) {
    log(`투두 추가 확인 메시지 전송 실패: ${err.message}`)
  }
}

// 답을 기다리던 "어느 방에 추가할까요?" 질문이 있었다면, 이번 메시지가 그 답인지 확인합니다.
async function tryResolvePendingTodoChannelClarify({ channelId, msgText, log, doorayClient, postTodoListNow }) {
  const pending = pendingTodoChannelClarify.get(channelId)
  if (!pending) return false
  if (Date.now() - pending.createdAt > TODO_CHANNEL_CLARIFY_TTL_MS) {
    pendingTodoChannelClarify.delete(channelId)
    return false
  }
  const trimmed = (msgText || '').trim()
  // 번호("1", "2번") 또는 방 이름 일부로 답할 수 있게 둘 다 확인합니다.
  const numMatch = trimmed.match(/^(\d+)/)
  let matched = null
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1
    matched = pending.candidates[idx] || null
  }
  if (!matched) {
    matched = pending.candidates.find((c) => trimmed.includes(c.label) || c.label.includes(trimmed))
  }
  if (!matched) return false // 답이 아니거나 못 알아들음 — 평소 흐름으로 계속 처리되게 둠

  pendingTodoChannelClarify.delete(channelId)
  await addCrossChannelTodoItem({
    askingChannelId: channelId,
    targetChannelId: matched.channelId,
    targetLabel: matched.label,
    question: pending.sourceQuestion,
    log,
    doorayClient,
    postTodoListNow
  })
  return true
}

// 공유 투두방이 아닌 채팅방에서 "@봇 이거 투두에 추가해줘"를 감지했을 때 부르는 진입점.
async function handleCrossChannelTodoAddCommand({ channelId, question, config, getMyMemberId, doorayService, log, doorayClient, postTodoListNow }) {
  const todoChannels = config.todoChannels || []
  if (todoChannels.length === 0) {
    await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
      method: 'POST',
      body: { text: '아직 공유 투두방으로 켜둔 채팅방이 없어요. 채팅방 탭에서 먼저 켜주셔야 추가할 수 있어요.' }
    })
    return
  }
  if (todoChannels.length === 1) {
    const myId = await getMyMemberId()
    let label = todoChannels[0]
    try {
      const labels = await doorayService.getChannelLabels(todoChannels, myId)
      label = labels[todoChannels[0]] || label
    } catch { /* 이름 조회 실패해도 ID로라도 진행 */ }
    await addCrossChannelTodoItem({
      askingChannelId: channelId,
      targetChannelId: todoChannels[0],
      targetLabel: label,
      question,
      log,
      doorayClient,
      postTodoListNow
    })
    return
  }

  // 공유 투두방이 여러 개면 추측하지 않고 되물어봅니다.
  const myId = await getMyMemberId()
  let labels = {}
  try {
    labels = await doorayService.getChannelLabels(todoChannels, myId)
  } catch { /* 실패하면 ID를 그대로 이름으로 사용 */ }
  const candidates = todoChannels.map((id) => ({ channelId: id, label: labels[id] || id }))
  const listText = candidates.map((c, i) => `${i + 1}. ${c.label}`).join('\n')
  const questionText = `어느 채팅방 투두리스트에 추가할까요?\n${listText}\n(번호나 이름으로 답해주세요)`
  pendingTodoChannelClarify.set(channelId, { candidates, sourceQuestion: question, createdAt: Date.now() })
  await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
    method: 'POST',
    body: { text: questionText }
  })
}

// ---- "내일 할일 뭐야?" 같은 조회 질문 → 실제 데이터로 정확하게 답하기 --------
// 예전에는 @멘션 질문이 전부 "최근 대화 맥락 + 자유 답변"으로만 처리돼서, 채팅방에 남아있는
// "오늘의 할일" 게시물을 보고 "내일"이라고 물어도 오늘 것을 그대로 답하는 문제가 있었습니다.
// 할 일을 묻는 질문은 todoStore/todoTemplateStore의 실제 데이터로 직접 계산해서 답합니다.
function addDaysIso(dateIso, days) {
  const d = new Date(`${dateIso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function relativeDayLabel(targetDateIso, todayIso) {
  if (targetDateIso === todayIso) return '오늘'
  if (targetDateIso === addDaysIso(todayIso, 1)) return '내일'
  if (targetDateIso === addDaysIso(todayIso, 2)) return '모레'
  return targetDateIso
}

// targetDateIso 기준으로 "그날 보일 할 일"을 계산합니다: 지금 열려있는 카드 중 그날 이미
// dueDate가 지났거나 없는 것 + 정기 업무 중 그날 주기가 돌아오는데 아직 실제 카드가 없는
// 것(있을 예정이라는 미리보기로 표시).
function buildTodoQueryAnswer(channelId, targetDateIso, todayIso) {
  const cards = todoStore.listOpenCards(channelId, { dateIso: targetDateIso }).slice()
  const templates = todoTemplateStore.listTemplates(channelId)
  for (const tpl of templates) {
    if (!todoTemplateStore.shouldFireOn(tpl, targetDateIso)) continue
    if (todoStore.findRoutineCardForToday(channelId, tpl.id, targetDateIso)) continue
    if (cards.some((c) => c.templateId === tpl.id && c.forDate === targetDateIso)) continue
    cards.push({ text: tpl.text, preview: true })
  }
  const label = relativeDayLabel(targetDateIso, todayIso)
  if (!cards.length) return `${label} 할 일로 등록된 게 없어요.`
  const lines = cards.map((c) => `- ${c.text}${c.preview ? ' (정기 업무 예정)' : ''}`)
  return `${label} 할 일:\n${lines.join('\n')}`
}

/**
 * 소켓에서 받은 메시지 이벤트를 처리하는 핸들러를 만들어 돌려줍니다.
 * - openChannels에 채널ID가 들어있으면: 그 방에서는 누구나 호출 가능
 * - 없으면: 토큰 주인 본인이 보낸 메시지만 반응 (두레이 자체 제약과 동일한 기본 동작)
 */
function createMentionHandler({ doorayClient, doorayService, getConfig, getMyMemberId, log, postTodoListNow }) {
  return async function handleSocketMessage(data) {
    const service = data.service || 'messenger'
    if (service !== 'messenger') return

    const content = data.content || data.payload || {}
    if (content.type === 1) return // 시스템 메시지 제외

    const action = data.action || ''
    if (action && action !== 'create' && action !== 'update') return

    const msgText = content.text
    const channelId = content.channelId || data.channelId
    const senderId = content.senderId

    // 채팅방에 파일이 올라오면(type:4) 별도 이벤트로 오고, content.file에 실제 파일 정보
    // (id/이름/크기/mimeType)가 들어있습니다. 두레이 API 자체엔 이걸 나중에 다시 조회하는
    // 기능이 없어서, 지나가는 이 이벤트를 붙잡아 직접 저장해둡니다 — 나중에 "이 채팅방에
    // 최근 올라온 파일"을 봇이 찾아 두레이 드라이브/구글 드라이브로 옮길 때 씁니다.
    if (content.type === 4 && content.file && channelId) {
      try {
        appendFile(channelId, {
          fileId: content.file.id,
          fileName: content.file.fileName || content.file.title || '',
          fileSize: content.file.fileSize || 0,
          mimeType: content.file.mimeType || '',
          senderId,
          ts: content.sentAt || Date.now()
        })
      } catch (err) {
        log(`채팅방 파일 정보 저장 실패: ${err.message}`)
      }
    }

    // 실제 채팅 메시지가 아니라 "읽음 처리(안 읽은 메시지 수 갱신)" 같은 이벤트는
    // text가 없어서 여기서 조용히 걸러집니다 (정상 동작).
    if (!msgText || !channelId || !senderId) return

    // 멘션 여부와 상관없이, 지나가는 메시지를 최근 대화 기록으로 남겨둡니다
    // (나중에 멘션이 오면 이 기록을 맥락으로 같이 넘김).
    recordHistory(channelId, senderId, msgText)

    const config = getConfig()

    // "어느 채팅방에 추가할까요?"라고 되물어둔 게 있다면, 이번 메시지가 그 답인지 먼저
    // 확인합니다. 이 답은 공유 투두방이 아닌 "질문을 물어본 그 방"에서 오고, @봇 멘션 없이
    // 그냥 번호/이름만 칠 수도 있으므로 멘션 여부와 상관없이 여기서 가장 먼저 체크합니다.
    if (pendingTodoChannelClarify.has(channelId)) {
      try {
        const resolved = await tryResolvePendingTodoChannelClarify({ channelId, msgText, log, doorayClient, postTodoListNow })
        if (resolved) return
      } catch (err) {
        log(`투두 추가 대상 방 확인 처리 오류: ${err.message}`)
      }
    }

    // 기록 저장은 기본이 켜짐이라, 이 방에서 사용자가 명시적으로 "끈" 경우만 건너뜁니다.
    // (새 메시지만 파일 끝에 追加하는 방식이라 방이 오래돼도 느려지지 않습니다.)
    if (!(config.historyDisabledChannels || []).includes(channelId)) {
      try {
        appendMessage(channelId, { senderId, text: msgText, ts: Date.now() })
      } catch (err) {
        log(`대화 기록 저장 실패: ${err.message}`)
      }
    }

    // 이 방이 "공유 투두방"이면, @두레이봇 멘션 여부와 상관없이 완료 보고인지 항상 확인합니다.
    // (아래 매치되면 return하는 일반 멘션 흐름과는 별개 — 같은 방에서 멘션도 그대로 계속 동작함)
    // 단, 봇이 방금 올린 "오늘의 할일" 게시물 자체와, 두레이가 자동으로 올리는 날짜 알림
    // ("2026.07.29 수요일" 같은 시스템 메시지)은 건너뜁니다 — 그렇지 않으면 AI를 불필요하게
    // 또 부르고, 3분 정적 타이머도 리셋되어 무한 반복/오작동 위험이 있습니다.
    if ((config.todoChannels || []).includes(channelId)) {
      // 이 방에서 지금 이 순간까지는 실시간으로 계속 지켜보고 있었다는 뜻이므로, 자기
      // 메시지/시스템 알림이든 아니든 "마지막으로 처리한 시각"을 갱신해둡니다. 나중에
      // 프로그램이 꺼졌다 켜질 때, 이 시각 이후 것만 놓친 메시지로 보고 캐치업합니다.
      try {
        todoStore.setLastProcessedTs(channelId, Date.now())
      } catch (err) {
        log(`투두 처리 시각 기록 실패: ${err.message}`)
      }
    }

    if (
      (config.todoChannels || []).includes(channelId) &&
      !isOwnTodoPost(msgText) &&
      !isSystemDateNotice(msgText)
    ) {
      // "내일 할일 뭐야?"류의 순수 조회 질문 판단도 이제 checkTodoCompletion 안의 AI 호출
      // 하나로 통합되어 있습니다(예전엔 별도 키워드 목록으로 먼저 걸렀는데, 목록에 없는
      // 표현이 나오면 오판단되는 문제가 있어서 통합함 — 정제문서 참고).
      let alreadyReposted = false
      try {
        alreadyReposted = await checkTodoCompletion({ channelId, msgText, log, postTodoListNow, doorayClient, trigger: config.trigger })
      } catch (err) {
        log(`공유 투두 완료 감지 오류: ${err.message}`)
      }
      if (alreadyReposted === 'query') {
        // 조회 질문으로 판단되어 checkTodoCompletion이 이미 답변까지 보냈습니다. 멘션이
        // 섞여 있어도(예: "@두레이봇 오늘 할일 뭐야?") 아래 일반 멘션 흐름으로 새어나가
        // 또 답하는 일이 없도록 여기서 바로 끝냅니다(재게시 타이머는 걸어둠).
        scheduleTodoIdleRepost(channelId, { postTodoListNow, log })
        return
      }
      // 완료/추가/태그변경이 실제로 인식되면 checkTodoCompletion 안에서 이미 최신 목록을
      // 올렸습니다 — 그런데도 여기서 3분 뒤 정적 타이머를 또 걸면, 3분 후 아무 변화도 없이
      // 방금과 똑같은 목록이 한 번 더 올라가는 불필요한 중복 게시가 생깁니다(실사용 중 발견된
      // 문제). 그래서 이미 올렸으면(alreadyReposted) 타이머를 새로 걸지 않고, 잡담이라 그냥
      // 지나갔거나 되물어보기만 한 경우에만 원래대로 3분 정적 재게시를 예약합니다.
      if (!alreadyReposted) scheduleTodoIdleRepost(channelId, { postTodoListNow, log })
    }

    if (!matchesTrigger(msgText, config.trigger)) return

    const myMemberId = await getMyMemberId()
    const isOpenChannel = (config.openChannels || []).includes(channelId)
    if (!isOpenChannel && senderId !== myMemberId) {
      log(`멘션 무시 (이 방은 본인만 호출 가능): senderId=${senderId}, channelId=${channelId}`)
      return
    }
    if (senderId !== myMemberId) {
      log(`다른 사람이 호출함 (허용된 방): senderId=${senderId}, channelId=${channelId}`)
    }

    const question = stripTrigger(msgText, config.trigger)
    log(`질문 수신: "${question}" (channelId=${channelId})`)

    // ("할일 조회" 질문 처리는 위쪽 "공유 투두방" 공통 블록에서 멘션 여부와 상관없이
    // 이미 먼저 처리되므로, 여기서는 따로 다시 확인하지 않습니다.)

    // 공유 투두방이 아닌 "다른" 채팅방에서 "@봇 이거 투두에 추가해줘"라고 부른 경우.
    // (공유 투두방 자체에서는 위쪽 블록이 멘션 없이도 항상 추가/완료를 처리하고 있어서
    // 여기서 또 처리하면 중복되므로, 이미 투두방으로 켜둔 방은 건드리지 않습니다.)
    if (!(config.todoChannels || []).includes(channelId) && isTodoAddCommand(question)) {
      log(`다른 방에서 투두 추가 명령 감지됨 (channelId=${channelId}): "${question}"`)
      try {
        await handleCrossChannelTodoAddCommand({
          channelId,
          question,
          config,
          getMyMemberId,
          doorayService,
          log,
          doorayClient,
          postTodoListNow
        })
      } catch (err) {
        log(`다른 방에서 투두 추가 처리 실패: ${err.message}`)
        try {
          await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
            method: 'POST',
            body: { text: `투두리스트에 추가하는 중 오류가 발생했어요: ${err.message}` }
          })
        } catch { /* 이중 실패는 무시 */ }
      }
      return
    }

    const workDir = ensureChannelWorkspace(channelId)

    // 이 채팅방에 "템플릿 자동화" 규칙이 연결되어 있고, "태스크/업무 만들어줘" 같은
    // 생성 명령이면 일반 질답 대신 템플릿 채워서 업무 생성하는 흐름으로 갑니다.
    const automation = findAutomationForChannel(config.automations, channelId)
    if (automation && isCreateTaskCommand(question)) {
      log(`자동화 규칙 감지됨 (channelId=${channelId}) → 업무 생성 시도`)
      try {
        const contextText = getHistoryText(channelId)
        const { post, subject } = await runTaskAutomation({
          doorayService,
          rule: automation,
          contextText,
          cwd: workDir,
          askClaude,
          myTeamName: config.myTeamName,
          myStaffName: config.myStaffName
        })
        // 업무 상세 페이지 URL 형식은 두레이 웹에서 실제로 확인한 패턴입니다:
        // https://{도메인}/task/{project-id}/{post-id}
        // 두레이 메신저 메시지는 마크다운 링크([글자](주소))를 지원하지 않아서,
        // 클릭 가능한 링크가 되도록 URL을 그대로 문장에 넣습니다 (자동 링크 인식).
        const taskUrl = `https://${config.doorayDomain}/task/${automation.projectId}/${post.id}`
        await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
          method: 'POST',
          body: {
            text: `[${config.trigger}] "${automation.projectLabel || automation.projectId}" 프로젝트에 업무를 생성했어요: ${subject}\n${taskUrl}\n(기획안·상세 파일은 두레이에서 직접 첨부해주세요)`
          }
        })
        log(`자동화로 업무 생성 완료 (postId=${post.id})`)
      } catch (err) {
        log(`자동 업무 생성 실패: ${err.message}`)
        try {
          await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
            method: 'POST',
            body: { text: `[${config.trigger}] 업무 생성 중 오류가 발생했어요: ${err.message}` }
          })
        } catch { /* 이중 실패는 무시 */ }
      }
      return
    }

    // 이 채널에서 이 사람에게 확인받을 "캘린더 일정 추측"이 남아있으면, 이번 멘션은 새 질문이
    // 아니라 그 확인에 대한 답("네"/"아니오")인지 먼저 봅니다. 캘린더 등록은 참석자에게 이미
    // 초대가 갔을 수도 있는 되돌리기 번거로운 행동이라, 파일 첨부와 같은 방식으로 승인 후에만
    // 실제로 실행합니다.
    if (hasPendingCalendarConfirm(channelId, senderId)) {
      // 단순 "네/아니오" 키워드 매칭이 아니라 AI로 답장을 해석합니다 — 동명이인 참석자 후보가
      // 있으면 같은 답장 안에서 "네, 1번"처럼 번호/이름 선택까지 함께 알아내야 하기 때문입니다.
      const resolved = await resolveCalendarConfirmReply({ askClaude, channelId, replyText: question, cwd: workDir })
      if (resolved.verdict === 'YES') {
        log(`캘린더 일정 등록 승인됨 (channelId=${channelId}) → 실행`)
        try {
          const result = await confirmAndExecuteCalendarEvent({ doorayService, channelId, selections: resolved.selections })
          const skippedNote = result.ok && result.skippedNames && result.skippedNames.length
            ? ` (후보를 안 정해주셔서 참석자에서 뺐어요: ${result.skippedNames.join(', ')})`
            : ''
          const replyText = result.ok
            ? `[${config.trigger}] 일정을 만들었어요: ${result.event.subject}${result.attendeeCount ? ` (참석자 ${result.attendeeCount}명 등록 — 실제로 초대됐는지는 두레이에서 한 번 확인해주세요)` : ''}${skippedNote}`
            : `[${config.trigger}] 일정 등록에 실패했어요: ${result.error}`
          await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, { method: 'POST', body: { text: replyText } })
          log(result.ok ? `캘린더 일정 등록 완료 (channelId=${channelId})` : `캘린더 일정 등록 실패: ${result.error}`)
        } catch (err) {
          log(`캘린더 일정 등록 실행 중 오류: ${err.message}`)
          try {
            await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
              method: 'POST',
              body: { text: `[${config.trigger}] 일정 등록 중 오류가 발생했어요: ${err.message}` }
            })
          } catch { /* 이중 실패는 무시 */ }
        }
        return
      }
      if (resolved.verdict === 'NO') {
        clearCalendarPending(channelId)
        await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
          method: 'POST',
          body: { text: `[${config.trigger}] 취소했어요. 다시 말씀해주세요.` }
        }).catch(() => {})
        return
      }
      // 'UNCLEAR'면 확인 답이 아니라 새로운 말로 보고, 남아있던 추측은 잊어버린 뒤 아래로 계속 진행합니다.
      clearCalendarPending(channelId)
    }

    // "일정/미팅/회의 잡아줘"처럼 캘린더 등록 요청이면, 바로 만들지 않고 제목/일시/장소/참석자를
    // 최대한 추측해서 먼저 "이렇게 진행할까요?"라고 확인받습니다. 승인해야만 실제로 등록합니다.
    if (isCreateCalendarEventCommand(question)) {
      log(`캘린더 일정 생성 명령 감지됨 (channelId=${channelId}) → 추측 중`)
      try {
        const contextText = getHistoryText(channelId)
        const result = await proposeCalendarEvent({
          doorayService,
          question,
          contextText,
          todayIso: todayKstIso(),
          cwd: workDir,
          askClaude,
          channelId,
          senderId
        })
        const replyText = result.ok ? `[${config.trigger}] ${result.replyText}` : `[${config.trigger}] ${result.error}`
        await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, { method: 'POST', body: { text: replyText } })
        log(result.ok ? `캘린더 일정 추측 완료, 확인 대기 (channelId=${channelId})` : `캘린더 일정 추측 실패: ${result.error}`)
      } catch (err) {
        log(`캘린더 일정 추측 중 오류: ${err.message}`)
        try {
          await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
            method: 'POST',
            body: { text: `[${config.trigger}] 일정 준비 중 오류가 발생했어요: ${err.message}` }
          })
        } catch { /* 이중 실패는 무시 */ }
      }
      return
    }

    // 이 채널에서 이 사람에게 확인받을 "파일 첨부 추측"이 남아있으면, 이번 멘션은 새 질문이
    // 아니라 그 확인에 대한 답("네"/"아니오")인지 먼저 봅니다.
    if (hasPendingConfirm(channelId, senderId)) {
      const verdict = classifyReply(question)
      if (verdict === 'confirm') {
        log(`파일 첨부 승인됨 (channelId=${channelId}) → 실행`)
        try {
          const result = await confirmAndExecute({ doorayService, mailStore, mailImap, tokenStore, cfg: config, channelId })
          const replyText = result.ok
            ? `[${config.trigger}] "${result.fileLabel}" 파일을 업무에 첨부했어요.`
            : `[${config.trigger}] 파일 첨부에 실패했어요: ${result.error}`
          await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, { method: 'POST', body: { text: replyText } })
          log(result.ok ? `파일 첨부 완료 (channelId=${channelId})` : `파일 첨부 실패: ${result.error}`)
        } catch (err) {
          log(`파일 첨부 실행 중 오류: ${err.message}`)
          try {
            await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
              method: 'POST',
              body: { text: `[${config.trigger}] 파일 첨부 중 오류가 발생했어요: ${err.message}` }
            })
          } catch { /* 이중 실패는 무시 */ }
        }
        return
      }
      if (verdict === 'cancel') {
        clearPending(channelId)
        await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
          method: 'POST',
          body: { text: `[${config.trigger}] 취소했어요. 다시 말씀해주세요.` }
        }).catch(() => {})
        return
      }
      // 'unclear'면 확인 답이 아니라 새로운 말로 보고, 남아있던 추측은 잊어버린 뒤 아래로 계속 진행합니다.
      clearPending(channelId)
    }

    // 채팅에 "첨부/붙여줘" 같은 말이 있으면, 업무/파일을 뭉뚱그려 말했더라도 최대한 추측해서
    // 먼저 "이렇게 이해했어요, 맞나요?"라고 확인받습니다. 승인해야만 실제로 올립니다.
    if (isAttachFileCommand(question)) {
      log(`파일 첨부 명령 감지됨 (channelId=${channelId}) → 추측 중`)
      try {
        const result = await proposeAttachFile({
          doorayService, mailStore, cfg: config, question, cwd: workDir, askClaude, channelId, senderId
        })
        const replyText = result.ok ? `[${config.trigger}] ${result.replyText}` : `[${config.trigger}] ${result.error}`
        await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, { method: 'POST', body: { text: replyText } })
        log(result.ok ? `파일 첨부 추측 완료, 확인 대기 (channelId=${channelId})` : `파일 첨부 추측 실패: ${result.error}`)
      } catch (err) {
        log(`파일 첨부 추측 중 오류: ${err.message}`)
        try {
          await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
            method: 'POST',
            body: { text: `[${config.trigger}] 파일 첨부 준비 중 오류가 발생했어요: ${err.message}` }
          })
        } catch { /* 이중 실패는 무시 */ }
      }
      return
    }

    // 지침이 하나도 없으면 가끔 영어로 답하는 경우가 있어서, 항상 한국어로 답하도록 고정합니다.
    const LANGUAGE_NOTE = '(답변 지침: 질문이 영어로 되어 있어도 항상 한국어로 답변하세요.)\n\n'
    const contextBlock = await buildContextBlock(doorayClient, channelId, msgText)
    const promptText = `${LANGUAGE_NOTE}${contextBlock}${question}`

    try {
      const answer = await askClaude(promptText, { cwd: workDir, feature: 'channel_mention' })
      await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
        method: 'POST',
        body: { text: `[${config.trigger}] ${answer}` }
      })
      log('답변 전송 완료')
    } catch (err) {
      log(`답변 생성/전송 실패: ${err.message}`)
      try {
        await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
          method: 'POST',
          body: { text: `[${config.trigger}] 오류가 발생했어요: ${err.message}` }
        })
      } catch { /* 이중 실패는 무시 */ }
    }
  }
}

module.exports = {
  createMentionHandler,
  matchesTrigger,
  stripTrigger,
  askClaude,
  getRecentChannels,
  getHistoryText,
  backfillChatHistory,
  catchUpMissedTodoMessages
}
