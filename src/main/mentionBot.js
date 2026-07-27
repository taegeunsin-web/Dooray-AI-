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

/**
 * 소켓에서 받은 메시지 이벤트를 처리하는 핸들러를 만들어 돌려줍니다.
 * - openChannels에 채널ID가 들어있으면: 그 방에서는 누구나 호출 가능
 * - 없으면: 토큰 주인 본인이 보낸 메시지만 반응 (두레이 자체 제약과 동일한 기본 동작)
 */
function createMentionHandler({ doorayClient, doorayService, getConfig, getMyMemberId, log }) {
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
