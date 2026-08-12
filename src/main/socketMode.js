// 두레이 실시간 채팅(Socket Mode) 연결 관리.
// dooray-bot-listener.js에서 이미 검증된 연결/재연결/핑 로직을 그대로 클래스 형태로 옮긴 것입니다.
// 참고 원본: Clauday(github.com/limtaewon/dooray-claude-gui-assistance)의 SocketModeClient.ts 구조를 참고.

const WebSocket = require('ws')
const { EventEmitter } = require('events')

const WS_PATH = '/messenger/v5/ws'
const SOCKET_MODE_TOKEN_PATH = '/common/v1/socket-mode/tokens'
const PING_INTERVAL_MS = 30_000
const RECONNECT_DELAY_MS = 15_000

// (2026-08-10 추가) 아래 네 개는 "재연결이 영원히 멈추는" 구간을 막는 제한 시간입니다.
//
// 이 클래스의 재연결은 소켓이 **닫히는 것을 신호로** 다음 시도로 넘어갑니다(아래 'close' 핸들러).
// 그래서 소켓이 닫히지도 열리지도 않는 어중간한 상태에 빠지면 그 자리에서 영원히 기다리게
// 됩니다 — 화면에는 "연결 중…"만 계속 떠 있고 자동 재연결도 돌지 않습니다. 그런 구간이
// 네 군데 있었습니다. 각각 제한 시간을 두고, 걸리면 소켓을 강제로 끊습니다. 끊으면 'close'가
// 발생하면서 평소대로 재연결이 걸립니다.
// (같은 문제를 먼저 겪고 고친 Clauday v2.0.6의 수정 내용을 참고했습니다.)
const TOKEN_TIMEOUT_MS = 15_000   // ① 접속 토큰 요청이 응답하지 않을 때
const OPEN_TIMEOUT_MS = 15_000    // ② 연결 협상이 끝나지 않을 때
const SESSION_TIMEOUT_MS = 20_000 // ③ 연결은 됐는데 서버가 세션 승인(sessionInfo)을 안 보낼 때
const PONG_TIMEOUT_MS = 75_000    // ④ 회선이 조용히 끊겨 소켓만 살아있을 때(핑 2.5회분)
                                  //    - 무선 전환 / VPN 재접속 / 절전 복귀에서 실제로 발생

class SocketModeClient extends EventEmitter {
  constructor({ doorayClient, domain }) {
    super()
    this.doorayClient = doorayClient
    this.domain = (domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
    this.ws = null
    this.pingTimer = null
    this.shouldRun = false
    // (2026-08-10 추가) 위 제한 시간을 재는 타이머들과, 마지막으로 서버에서 뭔가 받은 시각.
    this.openTimer = null
    this.sessionTimer = null
    this.lastSeenAt = 0
    // start()/stop()을 부를 때마다 1씩 늘어나는 "세대" 번호입니다. 토큰 발급처럼 시간이 걸리는
    // 작업을 하는 도중에 stop()이 호출되면 세대가 바뀌는데, 나중에 그 작업이 끝나서 이어지는
    // 코드가 실행될 때 자기 세대가 최신이 아니라는 걸 알면 조용히 멈춥니다. 이게 없으면
    // "재연결" 요청이 겹칠 때 이미 취소된 시도가 뒤늦게 진짜 소켓을 열어버려서, 같은 계정으로
    // 소켓이 두 개 동시에 뜨고 두레이 서버가 하나를 AGENT_ALREADY_CONNECTED로 끊어버리는
    // 문제가 있었습니다.
    this._gen = 0
  }

  start() {
    this.shouldRun = true
    this._gen += 1
    this._connect(this._gen)
  }

  stop() {
    this.shouldRun = false
    this._gen += 1 // 지금 진행 중이거나 예약된 재연결 시도를 전부 무효화
    this._clearTimers()
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.close(1000, 'stop')
        // 일부 네트워크 상황에서는 정상 close 핸드셰이크가 끝나지 않고 지연될 수 있어서,
        // 바로 강제 종료까지 같이 호출해 서버 쪽에 "연결이 살아있다"는 상태가 남지 않게 합니다.
        if (typeof this.ws.terminate === 'function') this.ws.terminate()
      } catch { /* ignore */ }
      this.ws = null
    }
  }

  // (2026-08-10 추가) 열려 있는 타이머를 한 번에 정리합니다. stop()과 연결이 끊길 때 부릅니다.
  _clearTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null }
    if (this.sessionTimer) { clearTimeout(this.sessionTimer); this.sessionTimer = null }
  }

  // (2026-08-10 추가) 멈춰 있는 소켓을 강제로 끊습니다.
  // terminate()를 부르면 'close' 이벤트가 발생하고, 그 핸들러가 재연결을 예약합니다.
  _killStalled(ws, why) {
    this.emit('error', new Error(`소켓이 "${why}" 단계에서 응답이 없어 연결을 끊고 다시 시도합니다`))
    try { ws.terminate() } catch { /* ignore */ }
  }

  // (2026-08-10 추가) 약속된 시간 안에 끝나지 않는 요청을 실패로 처리합니다.
  // fetch 자체에는 제한 시간이 없어서, 두레이가 응답을 안 주면 여기서 영원히 멈췄습니다.
  _withTimeout(promise, ms, label) {
    let timer = null
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}이(가) ${ms / 1000}초 안에 응답하지 않았습니다`)), ms)
    })
    return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer) })
  }

  async _connect(gen) {
    if (!this.shouldRun || gen !== this._gen) return
    try {
      // ① 접속 토큰 요청 — 제한 시간 안에 응답이 없으면 실패로 보고 아래 catch에서 재시도합니다.
      const tokenRes = await this._withTimeout(
        this.doorayClient.request(SOCKET_MODE_TOKEN_PATH, { method: 'POST', body: {} }),
        TOKEN_TIMEOUT_MS,
        '접속 토큰 요청'
      )
      // 토큰을 받아오는 동안 stop()이 호출되어 세대가 바뀌었으면, 이 시도는 이미 취소된 것이므로
      // 소켓을 새로 열지 않고 조용히 멈춥니다.
      if (!this.shouldRun || gen !== this._gen) return
      const t = tokenRes.result
      if (!t?.accessToken || !t?.tenantId || !t?.organizationMemberId) {
        throw new Error('Socket Mode 토큰 응답 형식이 예상과 다릅니다')
      }
      const wsUrl = `wss://${this.domain}${WS_PATH}/${t.tenantId}/${t.organizationMemberId}`
      const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${t.accessToken}` } })
      this.ws = ws

      // ② 연결 협상 제한 — 이 시간 안에 'open'이 안 오면 끊고 다시 붙습니다.
      this.openTimer = setTimeout(() => {
        if (gen === this._gen) this._killStalled(ws, '연결 협상')
      }, OPEN_TIMEOUT_MS)

      ws.on('open', () => {
        if (gen !== this._gen) { try { ws.close() } catch { /* ignore */ } ; return }
        if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null }
        this.emit('state', 'CONNECTING')

        // ③ 세션 승인 제한 — 서버가 sessionInfo(=ACTIVE 신호)를 안 보내면 여기서 걸립니다.
        //    이게 없으면 화면이 "연결 중…"에서 영원히 멈춰 있었습니다. 토큰이 만료돼
        //    서버가 협상을 거절했을 때가 가장 잦은 원인이었습니다.
        this.sessionTimer = setTimeout(() => {
          if (gen === this._gen) this._killStalled(ws, '세션 승인 대기')
        }, SESSION_TIMEOUT_MS)

        // ④ 회선이 조용히 끊긴 경우 감지 — 핑만 계속 보내고 아무 응답도 못 받는 상태를 잡습니다.
        this.lastSeenAt = Date.now()
        this.pingTimer = setInterval(() => {
          if (gen !== this._gen) return
          if (Date.now() - this.lastSeenAt > PONG_TIMEOUT_MS) {
            this._killStalled(ws, '핑 응답 대기')
            return
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
        }, PING_INTERVAL_MS)
      })

      ws.on('message', (raw) => {
        if (gen !== this._gen) return
        // 무엇이든 받았다면 회선이 살아있다는 뜻이므로, ④ 감시 시계를 되돌립니다.
        this.lastSeenAt = Date.now()
        let data
        try { data = JSON.parse(raw.toString()) } catch { return }
        if (data.type === 'sessionInfo') {
          if (this.sessionTimer) { clearTimeout(this.sessionTimer); this.sessionTimer = null }
          this.emit('state', 'ACTIVE')
          return
        }
        if (data.type === 'pong') return
        this.emit('message', data)
      })

      ws.on('close', (code, reasonBuf) => {
        if (gen !== this._gen) return // 이미 취소된 시도의 뒷정리 신호 — 무시
        this.emit('state', 'DISCONNECTED')
        this.emit('close', { code, reason: reasonBuf ? reasonBuf.toString() : '' })
        this._clearTimers()
        if (this.shouldRun) setTimeout(() => this._connect(gen), RECONNECT_DELAY_MS)
      })

      ws.on('error', (err) => { if (gen === this._gen) this.emit('error', err) })
    } catch (err) {
      if (gen !== this._gen) return
      this._clearTimers()
      this.emit('error', err)
      if (this.shouldRun) setTimeout(() => this._connect(gen), RECONNECT_DELAY_MS)
    }
  }
}

module.exports = { SocketModeClient }
