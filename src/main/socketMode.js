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
  }

  start() {
    this.shouldRun = true
    this._connect()
  }

  stop() {
    this.shouldRun = false
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.ws) { try { this.ws.close(1000, 'stop') } catch { /* ignore */ } }
  }

  async _connect() {
    if (!this.shouldRun) return
    try {
      const tokenRes = await this.doorayClient.request(SOCKET_MODE_TOKEN_PATH, { method: 'POST', body: {} })
      const t = tokenRes.result
      if (!t?.accessToken || !t?.tenantId || !t?.organizationMemberId) {
        throw new Error('Socket Mode 토큰 응답 형식이 예상과 다릅니다')
      }
      const wsUrl = `wss://${this.domain}${WS_PATH}/${t.tenantId}/${t.organizationMemberId}`
      this.ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${t.accessToken}` } })

      this.ws.on('open', () => {
        this.emit('state', 'CONNECTING')
        this.pingTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, PING_INTERVAL_MS)
      })

      this.ws.on('message', (raw) => {
        let data
        try { data = JSON.parse(raw.toString()) } catch { return }
        if (data.type === 'sessionInfo') { this.emit('state', 'ACTIVE'); return }
        if (data.type === 'pong') return
        this.emit('message', data)
      })

      this.ws.on('close', (code, reasonBuf) => {
        this.emit('state', 'DISCONNECTED')
        this.emit('close', { code, reason: reasonBuf ? reasonBuf.toString() : '' })
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
        if (this.shouldRun) setTimeout(() => this._connect(), RECONNECT_DELAY_MS)
      })

      this.ws.on('error', (err) => this.emit('error', err))
    } catch (err) {
      this.emit('error', err)
      if (this.shouldRun) setTimeout(() => this._connect(), RECONNECT_DELAY_MS)
    }
  }
}

module.exports = { SocketModeClient }
