// 설정 파일(config.json)을 불러오고 저장하는 역할입니다.
// 두레이 API 토큰은 여기 저장하지 않습니다 (tokenStore.js가 OS 자격 증명 관리자에 별도 보관).
// 여기에는 비밀이 아닌 값(도메인, 호출 단어, 허용 채널)만 평문으로 둡니다.

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')

const DEFAULTS = {
  doorayDomain: '',
  trigger: '두레이봇',
  openChannels: [], // 여기 채널ID를 넣으면 그 방에서는 누구나 호출 가능, 안 넣으면 본인만 호출 가능
  autoStart: false, // 컴퓨터 로그인 시 자동 실행 여부
  // 자동 생성되는 업무 인사말(예: "안녕하세요. OO팀 OOO입니다.")에 채워 넣을 고정값.
  // 보통 이 앱을 쓰는 사람이 항상 같아서, 자동화 규칙마다 반복 입력하지 않고 여기 한 번만 저장합니다.
  myTeamName: '',
  myStaffName: '',
  // 채팅방 -> 프로젝트/템플릿 자동화 규칙. 이 방에서 "@트리거 태스크 만들어줘"라고 하면
  // 지정된 프로젝트에 지정된 템플릿으로 업무를 자동 생성합니다.
  // { id, channelId, channelLabel, projectId, projectLabel, templateId, templateLabel,
  //   subjectPrefix,               // 제목 맨 앞에 고정으로 붙는 문구 (예: "[LG유플러스]")
  //   defaultAssigneeId, defaultAssigneeLabel,   // 채팅에서 확인 답장자를 못 찾았을 때 쓰는 기본 담당자
  //   ccMemberIds, ccMemberLabels,  // 참고(참조자) 목록
  //   tagIds, tagLabels }           // 태그 목록
  automations: [],
  // 기록 저장은 기본이 켜짐입니다. 여기 채널ID를 넣은 방만 기록 저장을 끕니다.
  // (꺼둔 설정은 이 파일에 계속 남아서, 프로그램을 껐다 켜도 유지됩니다)
  historyDisabledChannels: [],
  // 메일 탭의 "이 폴더만 저장하기" 설정. 비어있으면 모든 메일을 저장하고,
  // 폴더 이름을 넣으면 그 폴더로 온 메일만 앞으로 저장합니다.
  mailFolderAllowlist: [],
  // 메일 도착 알림 규칙. 지정한 폴더로 새 메일이 오면, 지정한 채팅방으로 AI 요약과
  // 원문 바로가기 링크를 자동으로 보내줍니다.
  // { id, folderName, channelId, channelLabel }
  mailAlertRules: [],
  // MCP 도구 등록 시 토큰을 어떤 방식으로 넘겼는지 기록 ('keytar' = 자격 증명 관리자에서
  // 직접 읽음(파일에 안 남음), 'env' = 예전 방식. ensureMcp.js가 방식이 바뀌면 재등록합니다.)
  mcpTokenMode: '',
  // 클로드(Claude Code) 실행 파일을 자동으로 찾은 뒤 저장해두는 경로.
  // PATH에 등록돼 있으면 그냥 'claude', PATH엔 없지만 다른 위치에서 발견됐으면 그 전체 경로가
  // 저장됩니다. claudeResolver.js가 채워 넣고, 매번 다시 찾지 않도록 여기 캐싱합니다.
  claudeExecPath: '',
  // 이 컴퓨터에서 "클로드 폴더 신뢰 확인" 창을 이미 자동으로 띄워준 적이 있는지 여부.
  // 한 번 띄워주면 그 뒤로는 설정을 다시 저장해도 매번 창이 뜨지 않게 막아줍니다.
  claudeTrustPromptShown: false,
  // 메일 "폴더별 정리"에서 즐겨찾기(★)한 그룹. 목록 맨 위에 고정됩니다.
  // 각 항목은 "폴더이름::person|subject::그룹키" 형태의 문자열입니다.
  mailGroupFavorites: [],
  // 메일 전문 가져오기 (IMAP). 두레이 API는 본문 미리보기만 줘서, 메일함에서 전문을
  // 보려면 IMAP 연결이 필요합니다. 비밀번호는 여기가 아니라 자격 증명 관리자에 저장됩니다.
  imapEnabled: false,
  imapUser: '',
  imapHost: 'imap.dooray.com',
  // 캘린더 연동(CalDAV). 서버 주소는 두레이 고정값(caldav.dooray.com)이라 화면에는 안 보이고
  // 아이디(메일 주소)만 여기 저장하고, 비밀번호는 IMAP과 마찬가지로 자격 증명 관리자에 저장됩니다.
  caldavUser: '',
  // 홈 "오늘 할 일" 카드에 자동으로 모아올 메일함. 비어있으면 관측된 모든 폴더를 다 훑고,
  // 폴더 이름을 넣으면 그 폴더들의 [요청]만 "오늘 할 일"에 올립니다.
  // (공용 메일함처럼 나 말고 다른 사람에게 오는 메일까지 내 할 일로 잡히는 걸 막기 위함)
  todoFolderAllowlist: [],
  // "매체 가이드"(예: 매체별 소재 사이즈 가이드) 기능이 위키에 저장한 페이지 위치 기록.
  // 같은 매체를 다시 "갱신"할 때 새 페이지를 또 만들지 않고 이 pageId를 덮어쓰는 데 씁니다.
  // { [매체명]: { wikiId, pageId, projectId, projectLabel, updatedAt } }
  mediaGuidePages: {},
  // 사내 LLM 연동 (Playground). 왓츠업 게시물 조회/휴가 기안 신청처럼 Playground에 이미
  // 내장된 기능이 필요할 때, 클로드가 이 값들로 Playground를 호출합니다. API 키는 여기가
  // 아니라 IMAP/CalDAV와 마찬가지로 자격 증명 관리자에 저장됩니다.
  playgroundBaseUrl: 'https://litellm-playground.nhncorp.com',
  playgroundModel: 'gpt-oss-120b'
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH, DEFAULTS }
