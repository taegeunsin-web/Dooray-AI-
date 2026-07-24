// 두레이 REST API 호출 공통 함수. dooray-mcp-server.js에서 검증된 것과 동일한 패턴입니다.

const BASE_URL = 'https://api.dooray.com'

function createDoorayClient(getToken) {
  async function request(reqPath, { method = 'GET', body, query } = {}) {
    const token = getToken()
    if (!token) throw new Error('두레이 API 토큰이 설정되지 않았습니다. 설정 파일을 확인하세요.')

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

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `dooray-api ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    })

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
