// 두레이 파일 API 속도 제한(rate limit) 대응.
//
// (2026-08-10 신규) 두레이 파일 API에는 속도 제한이 걸려 있습니다 — 응답 헤더에
// "버킷 20개, 초당 5개 충전"으로 적혀 있다는 것이 클로데이(Clauday) v2.0.5에서 확인됐고,
// 그쪽은 한 업무의 스크린샷 여러 장을 한꺼번에 받다가 일부만 뜨는 증상을 겪었습니다.
// ⚠️ 우리 환경에서 헤더를 직접 확인한 것은 아직 아닙니다(정제문서의 "확인 필요한 가정" 참고).
// 다만 지키는 쪽이 손해가 없어서, 파일을 여러 개 받는 길목에 이 대기표를 세워둡니다.
//
// 동작: 물통(버킷)에 토큰이 20개 차 있고 초당 5개씩 다시 채워집니다. 요청 하나가 토큰
// 하나를 씁니다. 토큰이 없으면 채워질 때까지 기다립니다. 그래서 잠깐 몰리는 것(최대 20개)은
// 그대로 통과하고, 계속 몰리면 초당 5개 속도로 줄을 세웁니다.
//
// ⚠️ 이 대기표는 "프로세스 하나 안에서만" 유효합니다. 이 앱(main)과 MCP 서버는 서로 다른
// 프로그램으로 돌기 때문에 각자 별도의 물통을 갖습니다. 둘이 동시에 파일을 왕창 받으면
// 합계로는 제한을 넘을 수 있는데, 실제로 그럴 일이 거의 없어서 그대로 둡니다.

function createRateLimiter({ capacity = 20, refillPerSec = 5 } = {}) {
  let tokens = capacity
  let lastRefillAt = Date.now()
  let chain = Promise.resolve()

  function refill() {
    const now = Date.now()
    const gained = ((now - lastRefillAt) / 1000) * refillPerSec
    if (gained > 0) {
      tokens = Math.min(capacity, tokens + gained)
      lastRefillAt = now
    }
  }

  async function take() {
    for (;;) {
      refill()
      if (tokens >= 1) { tokens -= 1; return }
      // 토큰 하나가 채워질 때까지만 짧게 기다렸다 다시 확인합니다.
      const waitSec = (1 - tokens) / refillPerSec
      await new Promise((r) => setTimeout(r, Math.max(20, Math.ceil(waitSec * 1000))))
    }
  }

  // 여러 요청이 동시에 들어와도 들어온 순서대로 통과시킵니다.
  function acquire() {
    const next = chain.then(take, take)
    chain = next.catch(() => {})
    return next
  }

  return { acquire }
}

// 두레이가 "너무 많이 불렀다"고 거절하면(429) 잠깐 쉬었다 다시 시도합니다.
// 그 외의 오류는 그대로 던져서 호출부가 평소대로 처리하게 둡니다.
async function withRateLimit(limiter, fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    await limiter.acquire()
    try {
      return await fn()
    } catch (err) {
      const msg = String((err && err.message) || '')
      const throttled = /\b429\b|rate limit|too many requests/i.test(msg)
      if (!throttled || attempt >= retries) throw err
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt))) // 1초 → 2초 → 4초
    }
  }
}

// 파일 API 전용 공용 대기표. 파일을 받는 곳은 전부 이걸 씁니다.
const doorayFileLimiter = createRateLimiter({ capacity: 20, refillPerSec: 5 })

// (2026-08-11 추가) 일반 두레이 API용 대기표 — "내 업무 조회"가 프로젝트 20여 개를
// 쉼 없이 연달아 부르다 429로 전부 차단당하고, 같은 시간대의 소켓 연결 요청까지 불똥을
// 맞은 실사고 대응. 일반 API의 정확한 한도는 헤더로 확인 전이라(가정), 보수적으로
// 초당 3개로 잡습니다 — 프로젝트 25개 기준 한 바퀴에 8초쯤 걸리지만 배경 작업이라 무방.
const doorayApiLimiter = createRateLimiter({ capacity: 5, refillPerSec: 3 })

module.exports = { createRateLimiter, withRateLimit, doorayFileLimiter, doorayApiLimiter }
