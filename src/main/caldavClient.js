// 두레이 캘린더 연동 — 기능별로 실제 검증된 방식을 따로 씁니다.
//
//  - 목록/조회 (listCalendars, listEvents): 두레이 REST API. 원래부터 조회는 항상 잘 됐던
//    방식입니다.
//  - 등록 (createEvent): CalDAV(caldav.dooray.com). REST로 등록(POST .../events)하면 이
//    조직 계정에서 계속 500 에러가 나서, 사내 오픈소스 "클로데이(Clauday)"를 참고해 CalDAV로
//    등록합니다. 다만 tsdav 라이브러리의 createCalendarObject()는 두레이 응답을 파싱하다
//    깨지는 버그가 있어서(클로데이 소스에도 같은 문제가 적혀 있음), tsdav를 거치지 않고
//    직접 서버에 fetch(PUT)로 요청합니다.
//  - 수정 (updateEvent, 캘린더 화면에서 드래그로 날짜 옮길 때 씀): 두레이 REST API.
//    CalDAV로 "기존" 일정을 PUT 수정하면 두레이 서버가 200(성공)이라고 답하면서 실제로는
//    아무것도 반영하지 않는 것을 클로데이 소스에서 확인했습니다(신규 등록만 CalDAV로 되고,
//    수정은 안 됨). 그래서 수정은 REST API로 합니다.
//
// 이 파일은 doorayService.js(대시보드/일렉트론)와 dooray-mcp-server.mjs(두레이봇 채팅) 양쪽에서
// 그대로 재사용합니다 — 두 프로세스가 완전히 분리되어 있어서, 여기에 두레이 전용 지식(날짜 형식
// 등)을 다 모아두면 한쪽만 고치고 다른 쪽을 깜빡하는 일을 줄일 수 있습니다. REST 호출은 두
// 프로세스가 이미 갖고 있는 "request(path, {method, body, query})" 형태 함수를 그대로
// 넘겨받아서 씁니다(doorayService.js는 doorayClient.request, mcp쪼은 doorayFetch).
//
// 두레이(및 이 프로그램)가 캘린더 시각을 주고받을 때 쓰는 형식:
//  - 종일 일정: "YYYY-MM-DD+09:00" (시간 없음, 종료일은 마지막 날의 "다음 날")
//  - 시간 일정: "YYYY-MM-DDTHH:MM:SS+09:00"
// 아래 함수들은 이 형식과 iCalendar(VEVENT) 형식을 서로 변환합니다(등록에서만 씀).

'use strict'

const { createDAVClient } = require('tsdav')

const CALDAV_SERVER = 'https://caldav.dooray.com/'

function pad(n) {
  return String(n).padStart(2, '0')
}

async function getClient(user, password) {
  if (!user || !password) throw new Error('CalDAV 계정 정보(메일 주소/비밀번호)가 없습니다. 설정에서 먼저 저장해주세요.')
  return createDAVClient({
    serverUrl: CALDAV_SERVER,
    credentials: { username: user, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav'
  })
}

// 일정(VEVENT)을 쓸 수 있는 캘린더만 골라서 돌려줍니다.
async function fetchWritableCalendars(client) {
  const calendars = await client.fetchCalendars()
  return calendars.filter((c) => !c.components || c.components.includes('VEVENT'))
}

// 두레이 REST의 calendarId(숫자)로 CalDAV 캘린더 주소를 찾습니다 — 등록(createEvent)이
// CalDAV PUT을 보낼 주소를 알아야 해서 필요합니다. CalDAV 캘린더 주소의 마지막 경로가
// 두레이 calendarId와 같습니다(예: .../calendars/3533031635679666602/).
async function findCalendarUrl(client, calendarId) {
  const writable = await fetchWritableCalendars(client)
  if (calendarId) {
    const found = writable.find((c) => c.url.replace(/\/$/, '').endsWith(`/${calendarId}`))
    if (found) return found.url
  }
  if (!writable.length) throw new Error('CalDAV에서 쓸 수 있는 캘린더를 찾지 못했습니다.')
  return writable[0].url
}

// ---------------------------------------------------------------------------
// 날짜 변환: 두레이 형식 → iCalendar
// ---------------------------------------------------------------------------

function isDoorayWholeDay(v) {
  return /^\d{4}-\d{2}-\d{2}\+\d{2}:\d{2}$/.test(v || '')
}

function doorayDateToICalLine(propName, doorayStr) {
  if (isDoorayWholeDay(doorayStr)) {
    return `${propName};VALUE=DATE:${doorayStr.slice(0, 10).replace(/-/g, '')}`
  }
  const d = new Date(doorayStr)
  if (isNaN(d.getTime())) throw new Error(`날짜 값이 올바르지 않습니다: ${doorayStr}`)
  const y = d.getUTCFullYear()
  const mo = pad(d.getUTCMonth() + 1)
  const da = pad(d.getUTCDate())
  const h = pad(d.getUTCHours())
  const mi = pad(d.getUTCMinutes())
  const s = pad(d.getUTCSeconds())
  return `${propName}:${y}${mo}${da}T${h}${mi}${s}Z`
}

function escapeICalText(v) {
  return String(v || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

function buildVEventICal({ uid, subject, startedAt, endedAt, location, attendeeEmails }) {
  const now = new Date()
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//dooray-assistant//caldav//KO',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    doorayDateToICalLine('DTSTART', startedAt),
    doorayDateToICalLine('DTEND', endedAt),
    `SUMMARY:${escapeICalText(subject)}`
  ]
  if (location) lines.push(`LOCATION:${escapeICalText(location)}`)
  for (const email of attendeeEmails || []) {
    if (email) lines.push(`ATTENDEE;CN=${escapeICalText(email)}:mailto:${email}`)
  }
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.join('\r\n')
}

// ---------------------------------------------------------------------------
// 외부에 공개하는 함수들
// ---------------------------------------------------------------------------
// listCalendars/listEvents/updateEvent는 REST용 request(path, {method, body, query})
// 함수를 넘겨받습니다. createEvent만 CalDAV용 user/password를 넘겨받습니다.

// 내가 접근 가능한 캘린더 목록(개인 + 공용 포함).
async function listCalendars({ request }) {
  const res = await request('/calendar/v1/calendars', { query: { size: 100 } })
  return (res.result || []).map((c) => ({
    id: c.id,
    name: c.name || c.subject || c.title || '캘린더'
  }))
}

// 두레이 REST API는 "/calendar/v1/calendars/{id}/events"의 {id} 자리에 특정 캘린더ID를
// 넣으면 404("Expected: '*'")를 돌려줍니다 — 이 경로는 항상 "*"(전체)로만 조회하고, 어느
// 캘린더 것인지는 결과 안의 필드로 구분해야 합니다. calendarIds를 넘기면 결과를 그걸로
// 걸러내되, 그 필드가 무엇인지 확실치 않아 못 찾으면(null) 안전하게 그대로 포함시킵니다
// (걸러내다 실수로 다 지워버리는 것보다, 좀 더 나오는 게 낫습니다).
async function listEvents({ request, calendarIds, timeMin, timeMax, log = () => {} }) {
  let res
  try {
    res = await request('/calendar/v1/calendars/*/events', { query: { timeMin, timeMax } })
  } catch (err) {
    log(`캘린더 일정 조회 실패: ${err.message}`)
    return []
  }
  const items = res.result || []
  const wanted = calendarIds && calendarIds.length ? new Set(calendarIds.map(String)) : null
  const all = []
  for (const e of items) {
    const calId =
      e.calendarId != null ? String(e.calendarId)
      : e.calendar?.id != null ? String(e.calendar.id)
      : e.calId != null ? String(e.calId)
      : null
    if (wanted && calId && !wanted.has(calId)) continue
    all.push({
      id: e.id,
      calendarId: calId,
      subject: e.subject || '(제목 없음)',
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      wholeDayFlag: !!e.wholeDayFlag,
      location: e.location || ''
    })
  }
  // 필터로 실제 뭔가 걸러졌을 때만 로그를 남깁니다 (평소엔 전부 통과하므로 조용히 동작).
  if (all.length !== items.length) {
    log(`캘린더 일정 전체 ${items.length}건 중 ${all.length}건 사용 (calendarIds 필터 적용됨)`)
  }
  return all
}

// calendarId를 안 넘기면 첫 번째로 찾은(쓸 수 있는) 캘린더에 등록합니다.
async function createEvent({ user, password, calendarId, subject, startedAt, endedAt, location, attendeeEmails }) {
  const client = await getClient(user, password)
  const calendarUrl = await findCalendarUrl(client, calendarId)
  const uid = `dooray-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@dooray-assistant`
  const iCalString = buildVEventICal({ uid, subject, startedAt, endedAt, location, attendeeEmails })
  const objectUrl = `${calendarUrl}${calendarUrl.endsWith('/') ? '' : '/'}${uid}.ics`
  const auth = Buffer.from(`${user}:${password}`).toString('base64')
  const res = await fetch(objectUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'If-None-Match': '*',
      Authorization: `Basic ${auth}`
    },
    body: iCalString
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`CalDAV 일정 등록 실패 (${res.status}) ${text.slice(0, 200)}`)
  }
  return { id: uid, subject, startedAt, endedAt, wholeDayFlag: isDoorayWholeDay(startedAt), location: location || '' }
}

// 이미 있는 일정을 고칩니다(캘린더 화면에서 날짜 칸으로 드래그해서 옮길 때 씀). 두레이
// REST API로 직접 수정합니다(위 상단 설명 참고 — CalDAV 수정은 두레이가 무시함).
// 참석자(users)는 지금은 비워서 보냅니다 — 참석자 보존은 아직 안 되는 부분이라, 참석자가
// 있는 일정을 드래그로 옮기면 참석자가 빠질 수 있습니다(클로데이도 같은 제한이 있습니다).
async function updateEvent({ request, calendarId, eventId, subject, startedAt, endedAt, location, wholeDayFlag }) {
  if (!calendarId || !eventId) throw new Error('일정을 수정하려면 캘린더ID/일정ID가 필요합니다.')
  const detailRes = await request(`/calendar/v1/calendars/${calendarId}/events/${eventId}`)
  const detail = detailRes.result || {}
  const payload = {
    users: { to: [], cc: [] },
    subject: subject ?? detail.subject,
    body: {
      mimeType: detail.body?.mimeType || 'text/x-markdown',
      content: detail.body?.content || ''
    },
    startedAt,
    endedAt,
    wholeDayFlag: wholeDayFlag ?? !!detail.wholeDayFlag,
    location: location ?? detail.location ?? '',
    personalSettings: {
      busy: detail.personalSettings?.busy ?? true,
      class: detail.personalSettings?.class ?? 'public'
    }
  }
  const res = await request(`/calendar/v1/calendars/${calendarId}/events/${eventId}`, { method: 'PUT', body: payload })
  if (!res.header?.isSuccessful) {
    throw new Error(`두레이 일정 수정 실패: ${res.header?.resultMessage || '알 수 없는 오류'}`)
  }
  return {
    id: eventId,
    calendarId,
    subject: payload.subject,
    startedAt,
    endedAt,
    wholeDayFlag: payload.wholeDayFlag,
    location: payload.location
  }
}

module.exports = { listCalendars, listEvents, createEvent, updateEvent }
