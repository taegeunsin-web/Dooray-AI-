// 클로드(Claude Code) 실행 파일이 실제로 어디 있는지 자동으로 찾아주는 모듈.
//
// 문제 상황: 어떤 컴퓨터에서는 클로드 코드를 설치했는데도, 이 프로그램이 부르는
// "claude"라는 이름을 못 찾는 경우가 있습니다 (설치 프로그램이 PATH라는 시스템 목록에
// 자기 위치를 안 넣어준 경우 — 사용자 잘못이 아니라 흔히 있는 설치 프로그램의 결함입니다).
// 이 모듈은 사용자가 터미널을 직접 열어볼 필요 없이, 앱이 스스로:
//   1. 우선 그냥 "claude"로 실행해보고
//   2. 안 되면 흔히 설치되는 위치들을 직접 뒤져서 찾고
//   3. 찾은 경로를 설정 파일에 저장해서, 다음부터는 다시 찾지 않고 바로 씁니다.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile, spawn } = require('child_process')
const { loadConfig, saveConfig } = require('./config')

// 이번 프로그램이 켜져 있는 동안에는 메모리에도 캐싱해서, 매번 파일을 다시 읽지 않게 합니다.
let cachedPath = null

// 설치 프로그램들이 실제로 클로드 코드를 놓아두는, 흔히 알려진 위치들.
// 참고: npm으로 설치한 경우 "claude.cmd"라는 파일이 생기는데, 이 프로그램의 실행 방식
// (보안을 위해 shell 없이 실행)으로는 .cmd 파일을 직접 실행할 수 없습니다 (Node.js 보안
// 정책). 그래서 .cmd 대신 그 안에서 실제로 돌아가는 자바스크립트 파일(cli.js)을 찾아
// "node cli.js" 형태로 실행합니다.
function candidatePaths() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
      // npm 전역 설치의 실제 본체 (claude.cmd가 내부적으로 실행하는 파일)
      process.env.APPDATA
        ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
        : null,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'claude', 'claude.exe') : null
    ]
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude')
  ]
}

// 저장된 경로 문자열을 "실제로 실행할 명령 + 앞에 붙는 인자"로 바꿔줍니다.
//  - 'claude' 또는 claude.exe 경로: 그대로 실행
//  - cli.js 경로(npm 설치): node로 실행 ("node cli.js ...")
// askClaude / ensureMcp 등 claude를 실행하는 모든 곳이 이 함수를 거칩니다.
function commandFor(execPath) {
  if ((execPath || '').toLowerCase().endsWith('.js')) {
    return { cmd: 'node', args: [execPath] }
  }
  return { cmd: execPath, args: [] }
}

function tryRun(execPath) {
  const { cmd, args } = commandFor(execPath)
  return new Promise((resolve) => {
    execFile(cmd, [...args, '--version'], { shell: false, timeout: 8000 }, (err) => {
      resolve(!err)
    })
  })
}

function rememberPath(execPath) {
  cachedPath = execPath
  const cfg = loadConfig()
  cfg.claudeExecPath = execPath
  saveConfig(cfg)
}

/**
 * 클로드 실행 파일의 경로를 찾아서 돌려줍니다.
 * - PATH에 등록되어 바로 실행되면: 'claude' 그대로 돌려줍니다.
 * - PATH엔 없지만 다른 위치에서 발견되면: 그 전체 경로를 돌려줍니다.
 * - 어디서도 못 찾으면: null (설치가 안 되어 있거나, 완전히 다른 위치에 있는 경우)
 *
 * log를 넘기면 사람이 읽을 수 있는 문장으로 상황을 기록합니다 (앱의 "로그" 탭용).
 */
async function resolveClaudePath({ log, forceRecheck } = {}) {
  if (cachedPath && !forceRecheck) return cachedPath

  if (!forceRecheck) {
    // 이전에 찾아서 저장해둔 경로가 아직 실제로 존재하면 다시 찾지 않고 바로 재사용합니다.
    // 단, 예전 버전이 저장했을 수 있는 .cmd 경로는 실행이 안 되는 형식이라 무시하고 다시 찾습니다.
    const cfg = loadConfig()
    if (cfg.claudeExecPath && !cfg.claudeExecPath.toLowerCase().endsWith('.cmd')) {
      if (cfg.claudeExecPath === 'claude' || fs.existsSync(cfg.claudeExecPath)) {
        cachedPath = cfg.claudeExecPath
        return cachedPath
      }
    }
  }

  // 1순위: 시스템에 등록된 이름 그대로 시도 (평소 정상적인 경우 여기서 바로 성공합니다)
  if (await tryRun('claude')) {
    rememberPath('claude')
    if (log) log('클로드(Claude Code) 실행을 정상적으로 확인했습니다.')
    return cachedPath
  }

  // 2순위: 설치는 됐지만 시스템에 등록이 안 된 경우를 대비해, 흔한 설치 위치를 직접 확인.
  // 파일이 있어도 손상됐거나 실행이 안 될 수 있어서, 실제로 한 번 실행해보고 성공한 것만 기억합니다.
  for (const candidate of candidatePaths()) {
    if (candidate && fs.existsSync(candidate) && (await tryRun(candidate))) {
      rememberPath(candidate)
      if (log) {
        log(`클로드(Claude Code)가 시스템 기본 경로에는 등록되어 있지 않았지만, 설치된 파일을 직접 찾았습니다: ${candidate}`)
      }
      return cachedPath
    }
  }

  if (log) {
    log('클로드(Claude Code) 실행 파일을 찾지 못했습니다. 설치가 안 되어 있거나, 이 프로그램이 아는 위치와 다른 곳에 설치된 것 같아요. https://claude.ai/download 에서 다시 설치해보세요.')
  }
  return null
}

// 클로드 코드는 "처음 보는 폴더"에서 실행되면 "이 폴더를 신뢰하시겠습니까?"라고 사람에게
// 직접 물어봅니다 (보안 장치라 코드로 대신 눌러줄 수 없음). 터미널을 열고 명령어를 치는 법을
// 모르는 사람도 승인만 누르면 되도록, 새 콘솔/터미널 창을 대신 띄워서 그 안에서 claude를
// 실행해줍니다. 사람은 뜬 창에서 "Yes, I trust this folder"만 선택하면 됩니다.
// 주의: 'claude'라는 이름이 시스템에 등록 안 된 컴퓨터(이 기능이 가장 필요한 경우)도 있어서,
// 여기서도 위에서 찾아낸 "실제 경로"로 실행합니다.
async function openTrustPromptWindow({ cwd, log } = {}) {
  const targetDir = cwd || os.homedir()
  const claudePath = (await resolveClaudePath({ log })) || 'claude'
  const { cmd, args } = commandFor(claudePath)
  // 경로에 공백이 있어도 안전하게, 실행 명령을 한 줄 문자열로 만듭니다 (예: node "C:\...\cli.js").
  const quote = (s) => (/\s/.test(s) ? `"${s}"` : s)
  const commandLine = [quote(cmd), ...args.map(quote)].join(' ')
  try {
    if (process.platform === 'win32') {
      // /k 로 실행해서 claude가 끝나도 창이 바로 닫히지 않게 합니다 (확인 화면을 볼 시간을 줌).
      spawn('cmd.exe', ['/c', 'start', '"클로드 코드 최초 확인"', 'cmd.exe', '/k', commandLine], {
        shell: true,
        cwd: targetDir,
        detached: true,
        stdio: 'ignore'
      }).unref()
    } else if (process.platform === 'darwin') {
      const escapedDir = targetDir.replace(/"/g, '\\"')
      const escapedCmd = commandLine.replace(/"/g, '\\"')
      spawn('osascript', ['-e', `tell application "Terminal" to do script "cd \\"${escapedDir}\\" && ${escapedCmd}"`], {
        detached: true,
        stdio: 'ignore'
      }).unref()
    } else {
      spawn('x-terminal-emulator', ['-e', commandLine], { cwd: targetDir, detached: true, stdio: 'ignore' }).unref()
    }
    if (log) {
      log('클로드(Claude Code) 확인 창을 새로 띄웠습니다. 뜬 창에서 "이 폴더를 신뢰하시겠습니까?"라고 물으면 "Yes, I trust this folder"를 선택해주세요. 완료 후엔 창을 닫아도 됩니다.')
    }
    return true
  } catch (err) {
    if (log) log(`클로드 확인 창을 띄우지 못했습니다: ${err.message}`)
    return false
  }
}

// 클로드 코드가 "설치는 됐지만 로그인은 안 된" 상태를 걸러내기 위한 확인입니다.
// 실제로 로그인이 되어 있는지 클로드에게 직접 물어보면(AI를 실행해보면) 확인이 정확하지만
// 그건 매번 비용/시간이 드니, 대신 로그인하면 클로드 코드가 이 컴퓨터에 남기는 자격 증명
// 파일이 있는지만 확인합니다 (실행/네트워크 요청 없음, 비용 없음).
// 참고: macOS는 파일이 아니라 시스템 키체인에 저장돼서 이 방법으로 확인할 수 없어
// null(확인 불가)을 돌려줍니다 — 이 경우 화면에서 "설치는 됐지만 로그인 여부는 실제로
// 써봐야 알 수 있다"는 식으로 안내해야 합니다.
function credentialsPath() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, '.credentials.json')
}

function checkLoggedIn() {
  if (process.platform === 'darwin') return null
  try {
    const p = credentialsPath()
    if (!fs.existsSync(p)) return false
    const raw = fs.readFileSync(p, 'utf-8').trim()
    return raw.length > 0
  } catch {
    return false
  }
}

module.exports = { resolveClaudePath, openTrustPromptWindow, commandFor, checkLoggedIn }
