// 두레이 프로젝트/업무 템플릿 조회 및 템플릿으로 업무 생성 — 대시보드 "템플릿" 탭에서 사용.
// dooray-mcp-server.mjs 에서 이미 검증된 API 호출 로직을 그대로 재사용합니다.
// (여기서는 클로드를 부르지 않고, 대시보드 클릭에 즉시 반응하도록 REST API를 바로 호출합니다.)

const fs = require('fs')
const path = require('path')
const caldavClient = require('./caldavClient')

// getCaldavCreds: () => Promise<{ user, password }> — 설정에 저장된 CalDAV 메일주소/비밀번호를
// 돌려주는 함수를 index.js에서 넘겨받습니다(캘린더 쓰기가 두레이 REST API에서 계속 500 에러가
// 나서 CalDAV로 바꿨습니다 — 자세한 이유는 caldavClient.js 상단 설명 참고).
function createDoorayService(doorayClient, log = () => {}, getCaldavCreds = async () => ({})) {
  // 두레이 공식 API 문서(GET /project/v1/projects) 확인 결과, 필터가 두 겹으로 되어 있음:
  //  - type: private / public (기본값 public)
  //  - scope: type이 public일 때만 적용, private / public (기본값 private)
  //  - size: 기본 20, 최대 100
  // 즉 type=public만 지정하고 scope를 안 주면 "공개타입-비공개범위" 프로젝트만 오고,
  // "공개타입-공개범위"(조직 전체에 공개된) 프로젝트는 빠집니다. 그래서 세 가지 조합을
  // 전부 요청해서 합쳐야 실제로 멤버로 있는 프로젝트가 하나도 안 빠집니다.
  async function listProjects() {
    const [privateType, publicPrivateScope, publicPublicScope] = await Promise.all([
      doorayClient.request('/project/v1/projects', { query: { member: 'me', type: 'private', size: 100 } }),
      doorayClient.request('/project/v1/projects', { query: { member: 'me', type: 'public', scope: 'private', size: 100 } }),
      doorayClient.request('/project/v1/projects', { query: { member: 'me', type: 'public', scope: 'public', size: 100 } })
    ])
    const merged = new Map()
    for (const p of [
      ...(privateType.result || []),
      ...(publicPrivateScope.result || []),
      ...(publicPublicScope.result || [])
    ]) {
      merged.set(p.id, {
        id: p.id,
        code: p.code,
        description: p.description,
        wikiId: p.wiki?.id
      })
    }
    return Array.from(merged.values())
  }

  async function listTemplates(projectId) {
    const res = await doorayClient.request(`/project/v1/projects/${projectId}/templates`)
    return res.result || []
  }

  // 템플릿 미리보기용 — 실제 제목/본문을 그대로 보여줍니다 (업무를 만들지는 않음).
  async function getTemplateDetail(projectId, templateId) {
    const res = await doorayClient.request(
      `/project/v1/projects/${projectId}/templates/${templateId}`,
      { query: { interpolation: true } }
    )
    const t = res.result
    return {
      subject: t.subject || '',
      bodyContent: t.body?.content || '',
      bodyMimeType: t.body?.mimeType || 'text/x-markdown'
    }
  }

  // 두레이 공식 문서(POST .../posts) 확인 결과: users.to = 담당자 목록, users.cc = 참고자 목록,
  // 각 항목은 {type:'member', member:{organizationMemberId}} 형태. tagIds는 태그 id 배열.
  async function createFromTemplate(projectId, templateId, overrides = {}) {
    const tmpl = await doorayClient.request(
      `/project/v1/projects/${projectId}/templates/${templateId}`,
      { query: { interpolation: true } }
    )
    const t = tmpl.result
    // dueDate/dueDateFlag는 항상 같이 보내야 합니다 (문서 확인된 스펙: dueDateFlag가 없으면/false면
    // dueDate 값이 있어도 두레이가 "일정없음"으로 처리해서 만기일이 반영되지 않습니다).
    // override로 새 만기일이 오면 그걸 확정 일정으로, 없으면 템플릿 자체의 설정을 그대로 이어받습니다.
    const hasDueDateOverride = overrides.dueDate !== undefined && overrides.dueDate !== null
    const body = {
      subject: overrides.subject || t.subject,
      body: t.body,
      dueDate: hasDueDateOverride ? overrides.dueDate : t.dueDate,
      dueDateFlag: hasDueDateOverride ? true : !!t.dueDateFlag,
      milestoneId: t.milestoneId,
      tagIds: (overrides.tagIds && overrides.tagIds.length) ? overrides.tagIds : t.tagIds,
      priority: t.priority,
      users: t.users
    }
    if (overrides.body) {
      body.body = { mimeType: t.body?.mimeType || 'text/x-markdown', content: overrides.body }
    }
    if (overrides.assigneeId || (overrides.ccMemberIds && overrides.ccMemberIds.length)) {
      // 참고(cc)는 템플릿에 이미 고정된 값(개별 멤버/외부 이메일/그룹 무엇이든)을 그대로 두고,
      // 앱에서 고른 사람을 "추가"만 합니다 (덮어쓰지 않음). 멤버 id가 템플릿에 이미 있으면
      // 중복으로 추가하지 않습니다.
      const templateCc = t.users?.cc || []
      const existingMemberIds = new Set(
        templateCc
          .filter((c) => c.type === 'member' && c.member?.organizationMemberId)
          .map((c) => c.member.organizationMemberId)
      )
      const extraCc = (overrides.ccMemberIds || [])
        .filter((id) => !existingMemberIds.has(id))
        .map((id) => ({ type: 'member', member: { organizationMemberId: id } }))

      body.users = {
        to: overrides.assigneeId
          ? [{ type: 'member', member: { organizationMemberId: overrides.assigneeId } }]
          : (t.users?.to || []),
        cc: [...templateCc, ...extraCc]
      }
    }
    const res = await doorayClient.request(`/project/v1/projects/${projectId}/posts`, {
      method: 'POST',
      body
    })
    return res.result
  }

  // 자동화 규칙 설정 화면에서 "태그" 체크박스 목록을 보여주기 위해 사용합니다.
  async function listProjectTags(projectId) {
    const res = await doorayClient.request(`/project/v1/projects/${projectId}/tags`, { query: { size: 100 } })
    return res.result || []
  }

  // 자동화 규칙 설정 화면에서 "기본 담당자"/"참고" 를 이름으로 검색해서 고를 수 있게 합니다.
  async function searchMembersByName(name) {
    const res = await doorayClient.request('/common/v1/members', { query: { name, size: 20 } })
    return res.result || []
  }

  // ---- 위키 (매체 소재 사이즈 가이드 등 자료 저장용) --------------------------
  // 두레이 공식 문서 확인된 스펙(MCP 서버의 dooray_wiki_* 도구와 동일한 형태):
  //  - 페이지 목록: 최상위는 쿼리 파라미터 없이 호출해야 함(하나라도 있으면 400 에러 나는
  //    버그성 동작이 실제로 확인됨). 하위 페이지만 볼 때만 parentPageId를 붙임.
  //  - 본문은 항상 { mimeType: 'text/x-markdown', content } 형태.
  async function getWikiPages(wikiId, parentPageId) {
    if (parentPageId) {
      const res = await doorayClient.request(`/wiki/v1/wikis/${wikiId}/pages`, {
        query: { parentPageId, size: 100, page: 0 }
      })
      return res.result || []
    }
    const res = await doorayClient.request(`/wiki/v1/wikis/${wikiId}/pages`)
    return res.result || []
  }

  async function getWikiPage(wikiId, pageId) {
    const res = await doorayClient.request(`/wiki/v1/wikis/${wikiId}/pages/${pageId}`)
    return res.result
  }

  async function createWikiPage(wikiId, { parentPageId, subject, content }) {
    const res = await doorayClient.request(`/wiki/v1/wikis/${wikiId}/pages`, {
      method: 'POST',
      body: {
        parentPageId: parentPageId || undefined,
        subject,
        body: { mimeType: 'text/x-markdown', content }
      }
    })
    return res.result
  }

  async function updateWikiPageContent(wikiId, pageId, { subject, content }) {
    const results = {}
    if (subject) {
      results.title = await doorayClient.request(`/wiki/v1/wikis/${wikiId}/pages/${pageId}/title`, {
        method: 'PUT',
        body: { subject }
      })
    }
    if (content) {
      results.content = await doorayClient.request(`/wiki/v1/wikis/${wikiId}/pages/${pageId}/content`, {
        method: 'PUT',
        body: { body: { mimeType: 'text/x-markdown', content } }
      })
    }
    return results
  }

  // 채팅방(대화방) 목록 조회 — 화면에 "숫자 ID" 대신 사람이 읽을 수 있는 이름을 보여주기
  // 위해 사용합니다. (GET /messenger/v1/channels 문서 확인: 그룹방은 title이 있고,
  // 1:1 대화(type=direct)는 title이 비어 있어서 상대방 이름으로 대신 채웁니다.)
  async function listChannels() {
    const res = await doorayClient.request('/messenger/v1/channels')
    return res.result || []
  }

  // 채팅방 "목록" 조회는 인원이 많은 그룹방 등에서 참여자 정보를 안 주는 경우가 있어서,
  // 그런 방은 이 방 하나만 다시 상세 조회해서 참여자 목록을 확보합니다. (실패해도 조용히
  // null을 돌려주고 숫자 ID로 대체 표시하는 기존 동작을 유지합니다 — 화면이 깨지지 않게.)
  async function getChannelDetail(channelId) {
    try {
      const res = await doorayClient.request(`/messenger/v1/channels/${channelId}`)
      return res.result || null
    } catch {
      return null
    }
  }

  const memberNameCache = new Map()
  async function getMemberName(memberId) {
    if (memberNameCache.has(memberId)) return memberNameCache.get(memberId)
    try {
      const res = await doorayClient.request(`/common/v1/members/${memberId}`)
      const name = res.result?.name || memberId
      memberNameCache.set(memberId, name)
      return name
    } catch {
      return memberId
    }
  }

  function extractOtherIds(ch, myMemberId) {
    return (ch.users?.participants || [])
      .map((p) => p.member?.organizationMemberId)
      .filter((id) => id && id !== myMemberId)
  }

  // 채팅방 1건의 표시용 이름을 만듭니다: 제목 → 나와의 대화 → 참여자 이름(목록 조회에 없으면
  // 상세 조회로 한 번 더 시도) → (그래도 없으면) 빈 문자열(호출한 쪽에서 숫자 ID로 대체 표시).
  async function resolveChannelLabel(ch, myMemberId) {
    if (ch.title) return ch.title
    if (ch.type === 'me') return '나와의 대화'
    let otherIds = extractOtherIds(ch, myMemberId)
    if (!otherIds.length) {
      const detail = await getChannelDetail(ch.id)
      if (detail) otherIds = extractOtherIds(detail, myMemberId)
    }
    if (!otherIds.length) {
      // 이름을 못 만든 경우(나와의 채팅/퇴사자 채팅방 등으로 추정) — 조용히 빈 문자열을 돌려주고
      // 호출한 쪽에서 숫자 ID로 대체 표시하도록 둡니다. (예전에는 진단용으로 로그를 남겼지만,
      // 해당 방들이 반복적으로 로그를 도배해서 제거함)
      return ''
    }
    const names = await Promise.all(otherIds.map((id) => getMemberName(id)))
    return names.filter(Boolean).join(', ')
  }

  // 내가 참여 중인 "모든" 채팅방을 이름과 함께 돌려줍니다 — 대시보드 채팅방 탭/
  // 자동화 규칙/메일 알림 설정에서, 메시지가 아직 감지되지 않은 방도 바로 고를 수 있게.
  // (1:1 대화는 title이 비어 있어서 상대방 이름으로 채웁니다. 이름 조회는 캐시됩니다.)
  async function listAllChannelsLabeled(myMemberId) {
    const channels = await listChannels()
    const out = []
    for (const ch of channels) {
      const label = await resolveChannelLabel(ch, myMemberId)
      out.push({ id: ch.id, label: label || ch.id })
    }
    return out
  }

  // channelId -> 사람이 읽을 수 있는 이름(label) 매핑을 만들어 돌려줍니다.
  async function getChannelLabels(channelIds, myMemberId) {
    const channels = await listChannels()
    const byId = new Map(channels.map((c) => [c.id, c]))
    const labels = {}
    for (const channelId of channelIds) {
      const ch = byId.get(channelId)
      if (!ch) {
        labels[channelId] = channelId
        continue
      }
      const label = await resolveChannelLabel(ch, myMemberId)
      labels[channelId] = label || channelId
    }
    return labels
  }

  // ---- 캘린더 ---------------------------------------------------------------
  // 조회/수정은 두레이 REST API로, 등록만 CalDAV(caldav.dooray.com)로 합니다 — 등록만
  // REST(POST .../events)가 이 조직 계정에서 계속 500 에러가 나서 CalDAV를 씁니다.
  // (자세한 이유와 각 함수가 어느 방식을 쓰는지는 caldavClient.js 상단 설명 참고.)
  async function requireCaldavCreds() {
    const creds = await getCaldavCreds()
    if (!creds || !creds.user || !creds.password) {
      throw new Error('캘린더 연동(CalDAV)이 설정되어 있지 않습니다. 설정 탭에서 메일 주소/비밀번호를 먼저 저장해주세요.')
    }
    return creds
  }

  async function listCalendars() {
    return caldavClient.listCalendars({ request: doorayClient.request })
  }

  async function listEvents({ calendarIds, timeMin, timeMax }) {
    return caldavClient.listEvents({ request: doorayClient.request, calendarIds, timeMin, timeMax, log })
  }

  // 두레이 조직원 ID로 이메일을 찾아봅니다(참석자를 CalDAV ATTENDEE로 넣으려면 이메일이 필요해서).
  // 한 명이라도 조회에 실패하면 그 사람만 빼고 나머지는 계속 진행합니다(참석자 하나 때문에
  // 일정 등록 전체가 실패하지 않도록).
  async function resolveAttendeeEmails(attendeeIds) {
    if (!attendeeIds || !attendeeIds.length) return []
    const emails = await Promise.all(
      attendeeIds.map(async (id) => {
        try {
          const res = await doorayClient.request(`/common/v1/members/${id}`)
          const m = res.result || {}
          return m.externalEmailAddress || m.emailAddress || m.mail || null
        } catch (err) {
          log(`참석자(${id}) 이메일 조회 실패: ${err.message}`)
          return null
        }
      })
    )
    return emails.filter(Boolean)
  }

  async function createEvent({ calendarId, subject, startedAt, endedAt, wholeDayFlag, location, attendeeIds }) {
    const { user, password } = await requireCaldavCreds()
    const attendeeEmails = await resolveAttendeeEmails(attendeeIds)
    return caldavClient.createEvent({
      user,
      password,
      calendarId,
      subject,
      startedAt,
      endedAt,
      wholeDayFlag,
      location,
      attendeeEmails
    })
  }

  // 이미 있는 일정을 고칩니다 — 지금은 캘린더 화면에서 날짜 칸으로 드래그해서 옮길 때만 씁니다.
  async function updateEvent({ calendarId, eventId, subject, startedAt, endedAt, location, wholeDayFlag }) {
    return caldavClient.updateEvent({ request: doorayClient.request, calendarId, eventId, subject, startedAt, endedAt, location, wholeDayFlag })
  }

  // 참고: 회의실(자원) 예약 기능은 시도했다가 되돌렸습니다 — 이 조직은 두레이의 "자원예약"
  // 서비스가 아니라 완전히 별도인 사내 시스템(왓츠업, whatsup.nhnent.com)으로 회의실을
  // 예약하고 있어서, 두레이 공개 API(/reservation/v1/...)로는 애초에 접근이 안 됩니다.

  // ---- 메일 (Common Streams API에서 type=mail 항목만 추림) --------------------
  // 두레이 공식 문서(2026.07.07 기준, "Common > Streams") 확인 결과 메일 전용 API는 없고,
  // GET /common/v1/streams(최근 활동 피드, 최근 2주 이내만 조회됨)에서 type이 "mail"인
  // 항목만 걸러 씁니다. 응답의 cursor를 다음 요청의 before로 넘기면 더 과거 페이지를 볼 수
  // 있고, 결과 배열이 완전히 빈 페이지가 나오면 그게 끝입니다. 메일 이벤트에는 "받는사람"
  // 필드가 없어서(항상 나에게 온 메일이므로) 보낸사람/제목/폴더 정보만 내려줍니다.
  // size를 100으로 요청하면 두레이 서버가 500(내부 오류)을 내는 걸 실제로 확인함
  // (size=50 이하는 정상). 문서에 안 나온 서버 쪽 제약으로 보여서, 기본값을 50으로 낮춤.
  async function fetchMailStreamPage({ before, size = 50 } = {}) {
    const res = await doorayClient.request('/common/v1/streams', { query: { size, before } })
    const items = res.result || []
    const mails = items
      .filter((item) => item.type === 'mail')
      .map((item) => {
        const m = item.mail || {}
        const from = m.users?.from?.emailUser || m.users?.from?.member || {}
        return {
          id: m.id,
          folderId: m.folder?.id || '',
          folderName: m.folder?.name || '',
          sentAt: m.sentAt || '',
          subject: m.subject || '(제목 없음)',
          fromName: from.name || '',
          fromEmail: from.emailAddress || '',
          bodyMimeType: m.body?.mimeType || 'text/plain',
          bodyContent: m.body?.content || ''
        }
      })
    return { mails, cursor: res.cursor || null, rawCount: items.length }
  }

  // 업무 링크(project/post id)로 제목 등 상세 정보를 가져옵니다 — 채팅에서 링크를 직접
  // 붙여줬을 때 "맞나요?" 확인 문구에 실제 제목을 보여주는 용도(실패해도 링크로 계속 진행하면
  // 되므로 호출하는 쪽에서 실패를 조용히 무시해도 됩니다).
  async function getPost(projectId, postId) {
    const res = await doorayClient.request(`/project/v1/projects/${projectId}/posts/${postId}`)
    return res.result
  }

  // 프로젝트 안에서 제목에 특정 단어가 들어간 업무를 최근 생성순으로 찾습니다.
  // (두레이 공식 API 문서 확인된 스펙: GET /project/v1/projects/{id}/posts?subjects=...)
  // 채팅에서 "OO업무에 파일 첨부해줘"처럼 업무를 제목으로 뭉뚱그려 말했을 때, 후보를
  // 추측해 사용자에게 확인받는 용도로 씁니다.
  async function searchPostsByTitle(projectId, titleKeyword, size = 5) {
    const res = await doorayClient.request(`/project/v1/projects/${projectId}/posts`, {
      query: { subjects: titleKeyword, size, order: '-createdAt' }
    })
    return res.result || []
  }

  // ---- 업무(post) 첨부파일 업로드 ------------------------------------------
  // 두레이 공식 문서에는 없지만, 실제 동작이 검증된(dooray-cli 오픈소스에서 실측 확인)
  // 방식으로 올립니다: POST /project/v1/projects/{id}/posts/{id}/files 에 파일 하나를
  // multipart(form-data, 필드명 "file")로 보냅니다. 서버가 307로 다른 주소로 다시
  // 보내라고 할 때가 있어서, 그 경우 같은 내용을 그 주소로 한 번 더 보냅니다.
  async function uploadPostFile(projectId, postId, filePath) {
    const fileName = path.basename(filePath)
    const fileBuffer = await fs.promises.readFile(filePath)
    const buildFormData = () => {
      const fd = new FormData()
      fd.append('file', new Blob([fileBuffer]), fileName)
      return fd
    }
    const url = `${doorayClient.baseUrl}/project/v1/projects/${projectId}/posts/${postId}/files`
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: doorayClient.getAuthHeader() },
      body: buildFormData(),
      redirect: 'manual'
    })
    if (res.status === 307) {
      const location = res.headers.get('location')
      if (!location) throw new Error('파일 업로드 리다이렉트 주소를 받지 못했습니다.')
      const uploadRes = await fetch(location, {
        method: 'POST',
        headers: { Authorization: doorayClient.getAuthHeader() },
        body: buildFormData()
      })
      if (!uploadRes.ok) throw new Error(`파일 업로드 실패 (${uploadRes.status})`)
      return (await uploadRes.json()).result
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`파일 업로드 실패 (${res.status}) ${text.slice(0, 200)}`)
    }
    return (await res.json()).result
  }

  return {
    listProjects,
    listTemplates,
    getTemplateDetail,
    createFromTemplate,
    getChannelLabels,
    listAllChannelsLabeled,
    listCalendars,
    listEvents,
    createEvent,
    updateEvent,
    listProjectTags,
    searchMembersByName,
    fetchMailStreamPage,
    getWikiPages,
    getWikiPage,
    createWikiPage,
    updateWikiPageContent,
    getPost,
    searchPostsByTitle,
    uploadPostFile
  }
}

module.exports = { createDoorayService }
