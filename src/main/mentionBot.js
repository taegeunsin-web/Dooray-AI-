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
const { appendMessage, listStoredChannelIds, getLastMessageTs } = require('./chatHistoryStore')
const { appendFile } = require('./channelFileStore')
const { resolveClaudePath, commandFor } = require('./claudeResolver')
const usageStore = require('./usageStore')
const mailStore = require('./mailStore')
const mailImap = require('./mailImap')
const tokenStore = require('./tokenStore')
const todoStore = require('./todoStore')
const todoTagStore = require('./todoTagStore')
const todoTemplateStore = require('./todoTemplateStore')

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
  '🏷 태그를 바꿨어요'
]

function isOwnTodoPost(text) {
  return typeof text === 'string' && OWN_TODO_MESSAGE_PREFIXES.some((prefix) => text.startsWith(prefix))
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

// 반환값(true/false)은 "이 호출 안에서 이미 최신 목록을 채팅방에 올렸는가"입니다. 호출부가
// 이 값을 보고, 방금 이미 올렸으면 3분 뒤 정적 재게시를 또 걸지 않도록(중복 게시 방지) 씁니다.
async function checkTodoCompletion({ channelId, msgText, log, postTodoListNow, doorayClient }) {
  // 답을 기다리던 모호한 날짜 질문이 있었다면, 이번 메시지가 그 답인지 먼저 확인합니다.
  if (await tryResolvePendingTodoClarify({ channelId, msgText, log, postTodoListNow })) return true

  const todayIso = todayKstIso()
  const openCards = todoStore.listOpenCards(channelId, { dateIso: todayIso })
  const listText = openCards.length
    ? openCards.map((c) => `[${c.id}] ${c.text}`).join('\n')
    : '(없음)'
  const tags = todoTagStore.listTags(channelId)
  const tagListText = tags.length
    ? tags.map((t) => `${t.id}: ${t.name}`).join('\n')
    : '(태그 없음)'

  const prompt = [
    `오늘 날짜는 ${todayIso}입니다.`,
    '',
    '아래는 어느 채팅방의 "오늘의 할 일" 목록, 그 방에 등록된 태그 목록, 그리고 방금 새로',
    '올라온 메시지 1건입니다. 이 메시지를 보고 세 가지를 판단해주세요.',
    '',
    '1) 완료 보고인가: 목록 중 하나(또는 여러 개)를 이미 끝냈다는 보고면, 완료된 항목의 [ ] 안',
    'ID만 골라 [DONE_IDS]와 [/DONE_IDS] 사이에 쉼표로 구분해 적어주세요. 완료 보고가 아니거나',
    '어떤 항목인지 확실하지 않으면, 절대 추측하지 말고 [DONE_IDS][/DONE_IDS] 처럼 비워두세요.',
    '',
    '2) 새 할 일을 알리는 메시지인가: "~추가", "~등록해줘"처럼 명시적인 지시어가 있거나,',
    '지시어가 없어도 "7/29 메타 소재 종료 예약"처럼 (날짜) + (할 일 이름) 형태로 봐도 명백히',
    '새 업무를 알리는 문장이면 새 할 일로 봅니다. 질문/잡담/의견처럼 업무를 등록하려는 의도가',
    '없는 문장이면 절대 추측하지 말고 넣지 마세요.',
    '   2-1) 오늘 할 일인지 특정 날짜 예약인지 명확하면(날짜가 적혀 있거나, 날짜 언급이 아예',
    '   없어 오늘 일로 보는 게 자연스러우면), 항목마다 한 줄에 "YYYY-MM-DD|태그ID|할 일 내용"',
    `   형식으로 [NEW_ITEMS]와 [/NEW_ITEMS] 사이에 적으세요. 날짜가 언급되어 있으면 오늘(${todayIso})`,
    `   기준으로 계산한 실제 날짜로, 언급이 없으면 오늘 날짜(${todayIso})를 그대로 쓰세요.`,
    '   "추가"/"등록" 같은 지시어와 날짜 표현은 할 일 내용에서 빼주세요.',
    '   태그ID 자리: "이거 재우 태그로", "OO 걸로" 처럼 사람 이름이나 업무 성격을 태그처럼',
    '   붙여 말했으면 아래 태그 목록에서 정확히 일치하는 태그를 찾아 그 ID를 적으세요. 그런',
    '   언급이 없거나 목록에 없는 이름이면 태그ID 자리는 비워두세요(새 태그를 지어내지 마세요).',
    '   태그 이름 자체는 할 일 내용에도 다시 넣지 마세요(태그ID 자리에만 적으면 충분합니다).',
    '   2-2) 새 할 일인 건 맞는데, "다음 주 중으로", "조만간"처럼 오늘 할 일로 봐야 할지',
    '   특정 날짜에 예약해야 할지 스스로 확신할 수 없으면, 절대 추측하지 말고 대신',
    '   "할 일 내용|되물을 질문" 형식으로 [AMBIGUOUS]와 [/AMBIGUOUS] 사이에 딱 한 건만',
    '   적으세요 (되물을 질문은 채팅방에 그대로 보낼 것이니 짧고 자연스러운 존댓말로).',
    '   여러 개를 한 번에 말했으면 2-1/2-2 각각 해당하는 형식으로 나눠 적으세요.',
    '',
    '3) 태그를 바꿔달라는 요청인가: "이거 재우 태그로 바꿔줘"처럼 목록의 항목을 아래 태그 목록',
    '중 하나로 옮겨달라는 명확한 요청이면, "카드ID|태그ID" 형식으로 [TAG_CHANGES]와',
    '[/TAG_CHANGES] 사이에 적으세요. 아래 태그 목록에 없는 이름을 말했으면(새 태그 요청) 절대',
    '지어내지 말고 넣지 마세요. 요청이 없거나 확실하지 않으면 비워두세요.',
    '',
    '[오늘의 할 일 목록]',
    listText,
    '',
    '[태그 목록]',
    tagListText,
    '',
    '[새 메시지]',
    msgText
  ].join('\n')

  const answer = await askClaude(prompt, { model: 'haiku', feature: 'todo_complete_detect' })

  const doneIds = []
  const doneMatch = answer.match(/\[DONE_IDS\]([\s\S]*?)\[\/DONE_IDS\]/)
  if (doneMatch) {
    doneIds.push(...doneMatch[1].split(',').map((s) => s.trim()).filter((id) => openCards.some((c) => c.id === id)))
  }
  for (const id of doneIds) todoStore.setStatus(id, 'done')

  const newItems = []
  const newMatch = answer.match(/\[NEW_ITEMS\]([\s\S]*?)\[\/NEW_ITEMS\]/)
  if (newMatch) {
    for (const line of newMatch[1].split('\n').map((s) => s.trim()).filter(Boolean)) {
      // "YYYY-MM-DD|태그ID|할 일 내용" 형식이 기본이지만, 예전 "YYYY-MM-DD|할 일 내용"(태그 없음)
      // 응답도 그대로 받아들이도록 구분자 개수를 보고 유연하게 나눕니다.
      const parts = line.split('|')
      const dateStr = (parts[0] || '').trim()
      let tagId = null
      let text = ''
      if (parts.length >= 3) {
        const tagCandidate = parts[1].trim()
        if (tagCandidate && tags.some((t) => t.id === tagCandidate)) tagId = tagCandidate
        text = parts.slice(2).join('|').trim()
      } else {
        text = (parts[1] || '').trim()
      }
      if (!text) continue
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : todayIso
      newItems.push({ text, dueDate, tagId })
      todoStore.addCard({ channelId, text, dueDate, tagId })
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
        body: { text: ambiguous.question }
      })
      log(`할 일 날짜 애매해서 되물음: "${ambiguous.text}" (channelId=${channelId})`)
    } catch (err) {
      log(`날짜 확인 질문 전송 실패: ${err.message}`)
    }
  }

  // 아무 것도 안 걸려도 "확인은 했다"는 걸 로그로 남겨서, "아예 코드가 안 도는 것"과
  // "읽었지만 해당 없어서 지나간 것"이 구분되게 합니다.
  if (!doneIds.length && !newItems.length && !tagChanges.length && !ambiguous) {
    log(`공유 투두 메시지 확인함 (channelId=${channelId}): 완료/추가/태그변경 해당 없음`)
    return false
  }
  if (doneIds.length) log(`공유 투두 완료 처리: ${doneIds.join(', ')} (channelId=${channelId})`)
  if (newItems.length) {
    log(`공유 투두 새 항목 추가: ${newItems.map((i) => `${i.text}(${i.dueDate})`).join(' / ')} (channelId=${channelId})`)
  }
  if (tagChanges.length) log(`공유 투두 태그 변경: ${tagChanges.length}건 (channelId=${channelId})`)
  if (!doneIds.length && !newItems.length && !tagChanges.length) return false // 되물어보기만 한 경우, 재게시는 아직 안 함

  // 목록을 통째로 다시 올리는 것만으로는 "방금 내가 한 말이 실제로 반영됐다"는 게 잘 안
  // 드러나서(할 일이 많으면 특히), 무엇이 바뀌었는지 짧게 먼저 확인 메시지로 알려줍니다.
  const ackLines = []
  if (newItems.length) {
    ackLines.push(...newItems.map((i) => {
      const tagName = i.tagId ? tags.find((t) => t.id === i.tagId)?.name : null
      const dateLabel = i.dueDate === todayIso ? '오늘' : i.dueDate
      return `📌 새 할 일로 등록했어요: ${i.text} (${dateLabel}${tagName ? `, ${tagName} 태그` : ''})`
    }))
  }
  if (doneIds.length) {
    const doneTexts = doneIds.map((id) => openCards.find((c) => c.id === id)?.text || id)
    ackLines.push(`✅ 완료로 표시했어요: ${doneTexts.join(', ')}`)
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
        body: { text: ackLines.join('\n') }
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

// "추가/완료/삭제" 같은 지시가 섞여 있으면 checkTodoCompletion이 이미 처리하는 영역이라
// 여기서는 건드리지 않고, 순수하게 "뭐 있어?" 류의 조회 질문일 때만 개입합니다.
function isTodoQueryQuestion(question) {
  if (!/할\s?일|투두/.test(question)) return false
  if (/추가|등록|완료|끝냈|했어|삭제|지워|바꿔/.test(question)) return false
  return true
}

async function resolveTodoQueryDate(question, todayIso) {
  const prompt = [
    `오늘 날짜는 ${todayIso}입니다.`,
    '아래 질문이 어느 날짜의 할 일을 묻는지 판단해주세요. "오늘"이면 오늘 날짜, "내일"이면',
    '내일, "모레"면 모레, 특정 날짜(예: 7/30, 8월 1일, 다음주 화요일)가 있으면 오늘 기준으로',
    '계산한 그 날짜, 날짜 언급이 전혀 없으면 오늘로 보세요.',
    '',
    `[질문] ${question}`,
    '',
    '그 날짜를 YYYY-MM-DD 형식으로만 [DATE]와 [/DATE] 사이에 적으세요.'
  ].join('\n')
  const answer = await askClaude(prompt, { model: 'haiku', feature: 'todo_query_date' })
  const m = answer.match(/\[DATE\]([\s\S]*?)\[\/DATE\]/)
  const date = m ? m[1].trim() : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayIso
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
    if (
      (config.todoChannels || []).includes(channelId) &&
      !isOwnTodoPost(msgText) &&
      !isSystemDateNotice(msgText)
    ) {
      // 이 방은 멘션 없이도 전부 읽고 있으므로, "내일 할일 뭐야?"류의 조회 질문도 멘션
      // 여부와 상관없이 여기서 먼저 확인합니다(멘션이 있으면 트리거만 떼고 판단).
      const bareText = matchesTrigger(msgText, config.trigger)
        ? stripTrigger(msgText, config.trigger)
        : msgText
      if (isTodoQueryQuestion(bareText)) {
        try {
          const todayIso = todayKstIso()
          const targetDateIso = await resolveTodoQueryDate(bareText, todayIso)
          const answerText = buildTodoQueryAnswer(channelId, targetDateIso, todayIso)
          await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
            method: 'POST',
            body: { text: `[${config.trigger}] ${answerText}` }
          })
          log(`할 일 조회 답변 완료 (channelId=${channelId}, date=${targetDateIso})`)
        } catch (err) {
          log(`할 일 조회 답변 실패: ${err.message}`)
          try {
            await doorayClient.request(`/messenger/v1/channels/${channelId}/logs`, {
              method: 'POST',
              body: { text: `[${config.trigger}] 할 일 조회 중 오류가 발생했어요: ${err.message}` }
            })
          } catch { /* 이중 실패는 무시 */ }
        }
        scheduleTodoIdleRepost(channelId, { postTodoListNow, log })
        return
      }

      let alreadyReposted = false
      try {
        alreadyReposted = await checkTodoCompletion({ channelId, msgText, log, postTodoListNow, doorayClient })
      } catch (err) {
        log(`공유 투두 완료 감지 오류: ${err.message}`)
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
  backfillChatHistory
}
