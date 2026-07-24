// 클로드(Claude Code) 호출 1건마다 사용량(토큰/비용)을 기록해두고, "사용량" 대시보드에서
// 보여줄 통계를 계산하는 모듈.
//
// 비용은 클로드 코드의 `--output-format json` 응답에 들어있는 공식 값을 그대로 기록합니다
// (직접 요금표를 만들어 계산하지 않기 때문에, 나중에 요금이 바뀌어도 항상 정확합니다).
//
// ⚠️ 여기 기록/집계되는 건 "지금까지 이 프로그램이 실제로 사용한 양"의 이력일 뿐입니다.
// 구독 요금제(Pro/Max)의 "이번 주 남은 한도(%)" 같은 값은 클로드 서버에만 있는 정보라
// 로컬에서는 알 수 없고, 클로드 데스크탑 앱/대화창의 /usage로만 확인 가능합니다.

const fs = require('fs')
const path = require('path')
const os = require('os')

const USAGE_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'usage')
const USAGE_FILE = path.join(USAGE_DIR, 'usage-history.jsonl')

// 호출 1건 기록. feature: 'mail_single' | 'mail_batch' | 'dashboard_chat' | 'channel_mention' | 'task_automation' 등
function appendUsage({
  feature = 'other',
  model = '(알수없음)',
  inputTokens = 0,
  outputTokens = 0,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
  costUsd = 0,
  ts = Date.now()
} = {}) {
  fs.mkdirSync(USAGE_DIR, { recursive: true })
  const line = JSON.stringify({
    feature, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, costUsd, ts
  }) + '\n'
  fs.appendFileSync(USAGE_FILE, line, 'utf-8')
}

function readAll() {
  if (!fs.existsSync(USAGE_FILE)) return []
  const raw = fs.readFileSync(USAGE_FILE, 'utf-8')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// period: '24h' | '7d' | '30d'
function getStats(period = '7d') {
  const windowMs =
    period === '24h' ? 24 * 3600_000 :
    period === '30d' ? 30 * 24 * 3600_000 :
    7 * 24 * 3600_000
  const cutoff = Date.now() - windowMs
  const rows = readAll().filter((r) => r.ts >= cutoff)

  const totalCostUsd = rows.reduce((s, r) => s + (r.costUsd || 0), 0)
  const totalInputTokens = rows.reduce((s, r) => s + (r.inputTokens || 0), 0)
  const totalOutputTokens = rows.reduce((s, r) => s + (r.outputTokens || 0), 0)
  const totalCacheCreation = rows.reduce((s, r) => s + (r.cacheCreationTokens || 0), 0)
  const totalCacheRead = rows.reduce((s, r) => s + (r.cacheReadTokens || 0), 0)
  const totalTokens = totalInputTokens + totalOutputTokens + totalCacheCreation + totalCacheRead
  const totalCalls = rows.length

  // 캐시 히트율: 입력 쪽 토큰(일반 입력 + 캐시 생성 + 캐시 읽기) 중 캐시로 읽어서 절약된 비율
  const cacheDenominator = totalInputTokens + totalCacheCreation + totalCacheRead
  const cacheHitRate = cacheDenominator > 0 ? totalCacheRead / cacheDenominator : 0

  const activeDaysSet = new Set(rows.map((r) => new Date(r.ts).toISOString().slice(0, 10)))
  const daysInWindow = Math.max(1, Math.round(windowMs / (24 * 3600_000)))
  const avgCostPerDay = totalCostUsd / daysInWindow

  // 일별 추이
  const dailyMap = new Map()
  for (const r of rows) {
    const day = new Date(r.ts).toISOString().slice(0, 10)
    if (!dailyMap.has(day)) dailyMap.set(day, { day, costUsd: 0, tokens: 0, calls: 0 })
    const d = dailyMap.get(day)
    d.costUsd += r.costUsd || 0
    d.tokens += (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheCreationTokens || 0) + (r.cacheReadTokens || 0)
    d.calls += 1
  }
  const daily = Array.from(dailyMap.values()).sort((a, b) => a.day.localeCompare(b.day))

  // 모델별 비율
  const modelMap = new Map()
  for (const r of rows) {
    const key = r.model || '(알수없음)'
    if (!modelMap.has(key)) modelMap.set(key, { model: key, costUsd: 0, tokens: 0, calls: 0 })
    const m = modelMap.get(key)
    m.costUsd += r.costUsd || 0
    m.tokens += (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheCreationTokens || 0) + (r.cacheReadTokens || 0)
    m.calls += 1
  }
  const byModel = Array.from(modelMap.values()).sort((a, b) => b.costUsd - a.costUsd)

  // 기능별 호출 횟수
  const featureMap = new Map()
  for (const r of rows) {
    const key = r.feature || '(기타)'
    if (!featureMap.has(key)) featureMap.set(key, { feature: key, calls: 0, costUsd: 0 })
    const f = featureMap.get(key)
    f.calls += 1
    f.costUsd += r.costUsd || 0
  }
  const byFeature = Array.from(featureMap.values()).sort((a, b) => b.calls - a.calls)

  // 시간대별 패턴 (0~23시, 이 컴퓨터의 로컬 시각 기준)
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, calls: 0 }))
  for (const r of rows) {
    hourly[new Date(r.ts).getHours()].calls += 1
  }
  const peak = hourly.reduce((best, cur) => (cur.calls > best.calls ? cur : best), hourly[0])

  return {
    period,
    totalCostUsd,
    totalTokens,
    totalInputTokens,
    totalOutputTokens,
    totalCalls,
    cacheHitRate,
    activeDays: activeDaysSet.size,
    avgCostPerDay,
    daily,
    byModel,
    byFeature,
    hourly,
    peakHour: peak.calls > 0 ? peak.hour : null
  }
}

module.exports = { appendUsage, getStats }
