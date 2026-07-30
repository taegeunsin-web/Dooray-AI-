// 채팅방 공유 투두리스트에서 "완료 처리"된 항목들의 이력을 쌓아두는 곳.
// 예전에 쓰던 개인용 투두 앱(todo_app/history.py)의 "완료 시 히스토리.xlsx에 매체별 시트로
// 적재" 개념을 참고했습니다. 다만 이 앱은 여러 사람이 같이 쓰는 채팅봇이라, 실시간으로
// 매번 엑셀 파일을 열었다 닫았다 하면(파일 잠금/느려짐) 무리가 갈 수 있어서, 평소엔 가벼운
// JSONL로 계속 쌓아두기만 하고(usageStore.js와 같은 패턴), 사람이 대시보드에서 "엑셀로
// 내보내기"를 눌렀을 때만 그 시점 데이터로 엑셀을 새로 만들어줍니다.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')

const HISTORY_DIR = path.join(os.homedir(), 'Dooray-Assistant-Workspaces', 'shared-todo')
const HISTORY_PATH = path.join(HISTORY_DIR, 'todo-history.jsonl')

// 완료 처리 1건 기록.
// { channelId, cardId, text, tagName, subTagName, createdAt, completedAt }
// tagName/subTagName은 "그 당시 이름"을 그대로 남깁니다 — 나중에 태그 이름이 바뀌거나
// 삭제돼도 히스토리 기록 자체는 그때 기준으로 남아있어야 하기 때문입니다.
function appendHistory({
  channelId,
  cardId,
  text,
  tagName = null,
  subTagName = null,
  createdAt = Date.now(),
  completedAt = Date.now()
} = {}) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true })
  const line = JSON.stringify({
    channelId, cardId, text: text || '', tagName, subTagName, createdAt, completedAt
  }) + '\n'
  fs.appendFileSync(HISTORY_PATH, line, 'utf-8')
}

function readAll(channelId) {
  if (!fs.existsSync(HISTORY_PATH)) return []
  const raw = fs.readFileSync(HISTORY_PATH, 'utf-8')
  const rows = raw
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
  return channelId ? rows.filter((r) => r.channelId === channelId) : rows
}

// exceljs는 정상적으로는 package.json에 등록돼 있어서 npm install만 하면(실행.bat/설치
// 과정에 이미 포함) 항상 같이 설치돼 있습니다. 그래도 예전에 받은 폴더를 그대로 쓰다가
// node_modules를 새로 안 받은 경우 등 예외 상황을 대비해, 없으면 이 자리에서 바로 설치를
// 시도합니다(사람이 따로 터미널을 열 필요 없게).
function loadExceljs({ appDir, log } = {}) {
  try {
    return require('exceljs')
  } catch {
    if (log) log('엑셀 생성에 필요한 구성 요소(exceljs)가 없어서 지금 자동으로 설치합니다. 잠시만 기다려주세요...')
    try {
      execSync('npm install exceljs --no-save --no-audit --no-fund', {
        cwd: appDir || process.cwd(),
        stdio: 'ignore'
      })
    } catch (installErr) {
      throw new Error(`exceljs 자동 설치 실패: ${installErr.message}. 이 컴퓨터에 인터넷 연결이 되는지 확인해주세요.`)
    }
    // 설치 명령 자체는 성공했는데도(오류 없이 끝남) 이 프로그램이 이미 메모리에 띄운 채로
    // 있어서 새로 생긴 폴더를 못 찾는 경우가 있을 수 있습니다 — 이럴 땐 프로그램을 완전히
    // 껐다 켜야 다음 시도에서 정상적으로 잡힙니다. 원인을 알 수 없는 원본 오류 메시지 대신
    // 사람이 바로 따라할 수 있는 안내를 줍니다.
    try {
      return require('exceljs')
    } catch {
      throw new Error(
        '엑셀 구성 요소를 설치했지만 이 프로그램이 아직 인식하지 못했어요. ' +
        '프로그램을 완전히 껐다가 다시 켠 다음 한 번 더 시도해주세요.'
      )
    }
  }
}

function formatDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const HEADERS = ['완료일시', '제목', '매체', '담당', '등록일']
const HEADER_BG = 'FF4B6CB7'
const COL_WIDTHS = [18, 40, 14, 12, 14]

// channelId의 완료 이력을 매체(subTagName)별 시트로 나눠서 엑셀 파일로 저장하고,
// 저장한 경로를 돌려줍니다. 매체가 없는(미분류) 항목은 "미분류" 시트로 모입니다.
async function exportToExcel({ channelId, outputPath, appDir, log }) {
  const ExcelJS = loadExceljs({ appDir, log })
  const rows = readAll(channelId).sort((a, b) => a.completedAt - b.completedAt)

  const workbook = new ExcelJS.Workbook()
  const sheetByMedia = new Map()

  const getSheet = (mediaName) => {
    const name = (mediaName || '미분류').slice(0, 31)
    if (sheetByMedia.has(name)) return sheetByMedia.get(name)
    const ws = workbook.addWorksheet(name)
    ws.addRow(HEADERS)
    const headerRow = ws.getRow(1)
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } }
      cell.alignment = { horizontal: 'center' }
    })
    HEADERS.forEach((_, i) => { ws.getColumn(i + 1).width = COL_WIDTHS[i] })
    sheetByMedia.set(name, ws)
    return ws
  }

  for (const r of rows) {
    const ws = getSheet(r.subTagName)
    ws.addRow([
      formatDateTime(r.completedAt),
      r.text || '',
      r.subTagName || '',
      r.tagName || '',
      formatDate(r.createdAt)
    ])
  }

  if (sheetByMedia.size === 0) {
    // 완료 이력이 아예 없으면 빈 시트라도 하나 만들어서, "왜 파일이 비어있지"라는
    // 혼란 대신 헤더만 있는 정상적인 빈 엑셀을 받게 합니다.
    getSheet('미분류')
  }

  await workbook.xlsx.writeFile(outputPath)
  return outputPath
}

module.exports = { appendHistory, readAll, exportToExcel, HISTORY_PATH }
