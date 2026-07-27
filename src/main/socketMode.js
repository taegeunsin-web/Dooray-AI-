// 두레이 실시간 채팅(Socket Mode) 연결 관리.
// dooray-bot-listener.js에서 이미 검증된 연결/재연결/핑 로직을 그대로 클래스 형태로 옮긴 것입니다.
// 참고 원본: Clauday(github.com/limtaewon/dooray-claude-gui-assistance)의 SocketModeClient.ts 구조를 참고.

const WebSocket = require('ws')
const { EventEmitter } = require('events')

const WS_PATH = '/messenger/v5/ws'
const SOCKET_MODE_TOKEN_PATH = '/common/v1/socket-mode/tokens'
const PING_INTERVAL_MS = 30_000
const RECONNECT_DELAY_MS = 15_000

class SocketModeClient extends EventEmitter {
  constructor({ doorayClient, domain }) {
    super()
    this.doorayClient = doorayClient
    this.domain = (domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
    this.ws = null
    this.pingTimer = null
    this.shouldRun = false
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
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
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

  async _connect(gen) {
    if (!this.shouldRun || gen !== this._gen) return
    try {
      const tokenRes = await this.doorayClient.request(SOCKET_MODE_TOKEN_PATH, { method: 'POST', body: {} })
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

      ws.on('open', () => {
        if (gen !== this._gen) { try { ws.close() } catch { /* ignore */ } ; return }
        this.emit('state', 'CONNECTING')
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
        }, PING_INTERVAL_MS)
      })

      ws.on('message', (raw) => {
        if (gen !== this._gen) return
        let data
        try { data = JSON.parse(raw.toString()) } catch { return }
        if (data.type === 'sessionInfo') { this.emit('state', 'ACTIVE'); return }
        if (data.type === 'pong') return
        this.emit('message', data)
      })

      ws.on('close', (code, reasonBuf) => {
        if (gen !== this._gen) return // 이미 취소된 시도의 뒷정리 신호 — 무시
        this.emit('state', 'DISCONNECTED')
        this.emit('close', { code, reason: reasonBuf ? reasonBuf.toString() : '' })
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
        if (this.shouldRun) setTimeout(() => this._connect(gen), RECONNECT_DELAY_MS)
      })

      ws.on('error', (err) => { if (gen === this._gen) this.emit('error', err) })
    } catch (err) {
      if (gen !== this._gen) return
      this.emit('error', err)
      if (this.shouldRun) setTimeout(() => this._connect(gen), RECONNECT_DELAY_MS)
    }
  }
}

module.exports = { SocketModeClient }
