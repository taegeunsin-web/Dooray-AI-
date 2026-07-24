// "대시보드" 창을 띄우는 역할. 이전 setupWindow.js(작은 설정 팝업)를 대체합니다.
// 토큰이 없을 때(첫 실행) 자동으로 뜨고, 트레이 메뉴 "대시보드 열기"로도 다시 열 수 있습니다.

const { app, BrowserWindow, shell } = require('electron')
const path = require('path')

// 창/작업표시줄 아이콘 (assets/icon.png). 없으면 Electron 기본 아이콘으로 뜹니다.
const ICON_PATH = path.join(app.getAppPath(), 'assets', 'icon.png')

let win = null

function openDashboard() {
  if (win && !win.isDestroyed()) {
    win.focus()
    return win
  }

  win = new BrowserWindow({
    // 템플릿 탭(가로 920px 기준)이 처음부터 가로 스크롤 없이 보이도록 넉넉하게 시작합니다.
    width: 1140,
    height: 760,
    minWidth: 800,
    minHeight: 520,
    title: '두레이 AI 어시스턴트',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.setMenuBarVisibility(false)
  // 메일 탭의 "원문 보기" 링크처럼, 화면 안의 외부 링크(target="_blank")를 누르면 이 앱 안에
  // 새 창을 띄우는 대신 평소 쓰는 웹 브라우저로 열어줍니다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'dashboard.html'))
  win.on('closed', () => { win = null })

  return win
}

function closeDashboard() {
  if (win && !win.isDestroyed()) win.close()
}

module.exports = { openDashboard, closeDashboard }
