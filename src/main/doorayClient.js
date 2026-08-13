// 두레이 REST API 호출 공통 함수. dooray-mcp-server.js에서 검증된 것과 동일한 패턴입니다.
//
// (2026-08-11 추가) 모든 호출이 이 파일 하나를 지나가므로, 여기에 공통 안전장치를 깔았습니다:
//  ① 속도 제한 대기표 — 초당 3개. 어떤 기능이 폭주해도 두레이의 429 차단을 안 맞게 합니다
//     (실사고: "내 업무 조회"가 프로젝트 20여 개를 연달아 부르다 전부 429, 소켓 연결까지 불똥).
//  ② 429 재시도 — 그래도 거절되면 1→2→4초 쉬었다 다시 (withRateLimit 내장).
//  ③ 네트워크 오류 재시도 — 절전 복귀 직후처럼 회선이 아직 안 살아난 순간의 실패를
//     GET(조회)에 한해 1초/2초 쉬고 2번 더 시도합니다. POST는 재시도하지 않습니다 —
//     서버가 처리는 했는데 응답만 못 받은 경우 같은 메시지가 두 번 갈 수 있기 때문입니다.

const { doorayApiLimiter, withRateLimit } = require('./rateLimiter')

const BASE_URL = 'https://api.dooray.com'
const NETWORK_ERROR_RE = /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|socket hang up/i

function createDoorayClient(getToken) {
  async function request(reqPath, { method = 'GET', body, query } = {}) {
    const token = getToken()
    if (!token) throw new Error('두레이 API 토큰이 설정되지 않았습니다. 설정 파일을 확인하세요.')
    // (2026-08-13 추가) 메신저 연결(소켓 토큰) 요청은 대기줄을 건너뜁니다 — 앱 시작 직후
    // 미리 불러오기(채팅방 목록 등 호출 수십~백 개)가 대기줄을 채우면, 그 뒤에 선 연결
    // 요청까지 늦어져 "처음 켰을 때 연동이 엄청 느린" 증상이 됩니다(실사용 신고).
    // 한두 개짜리 호출이라 폭주 보호(대량 호출 제한)의 대상이 아닙니다.
    if (reqPath.startsWith('/common/v1/socket-mode')) {
      return requestOnce(reqPath, { method, body, query }, token)
    }
    return withRateLimit(doorayApiLimiter, () => requestOnce(reqPath, { method, body, query }, token))
  }

  async function requestOnce(reqPath, { method = 'GET', body, query } = {}, token, attempt = 0) {

    let url = `${BASE_URL}${reqPath}`
    if (query && Object.keys(query).length > 0) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue
        qs.set(k, String(v))
      }
      const qsStr = qs.toString()
      if (qsStr) url += `?${qsStr}`
    }

    let res
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `dooray-api ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      })
    } catch (err) {
      // 절전 복귀/무선 전환 직후의 일시적 회선 오류 — 조회(GET)만 잠깐 쉬고 다시 시도.
      if (method === 'GET' && attempt < 2 && NETWORK_ERROR_RE.test(String(err.message || ''))) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        return requestOnce(reqPath, { method, body, query }, token, attempt + 1)
      }
      throw err
    }

    const text = await res.text()
    let json
    try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }

    if (!res.ok) {
      const msg = json?.header?.resultMessage || json?.message || text || `HTTP ${res.status}`
      throw new Error(`두레이 API 오류 (${res.status}) ${method} ${reqPath}: ${msg}`)
    }
    return json
  }

  // 파일 업로드(multipart)처럼 doorayClient.request()가 지원하지 않는 방식으로 직접
  // fetch를 호출해야 하는 곳(doorayService.js의 uploadPostFile 등)에서 씁니다.
  function getAuthHeader() {
    const token = getToken()
    if (!token) throw new Error('두레이 API 토큰이 설정되지 않았습니다. 설정 파일을 확인하세요.')
    return `dooray-api ${token}`
  }

  return { request, getAuthHeader, baseUrl: BASE_URL }
}

module.exports = { createDoorayClient }
