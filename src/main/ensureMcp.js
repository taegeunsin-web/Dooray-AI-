// 프로그램이 처음 켜질 때, claude 코드에 두레이 MCP 도구가 등록되어 있는지 확인하고
// 없으면 자동으로 "claude mcp add" 명령을 대신 실행해줍니다.
// (지금까지는 사용자가 터미널에 직접 이 명령을 쳤는데, 그 과정을 자동화한 것)
//
// 보안: 예전에는 등록할 때 토큰을 --env로 같이 넘겨서, 토큰이 클로드 설정 파일
// (~/.claude.json)에 평문으로 남았습니다. 이제는 MCP 서버가 OS 자격 증명 관리자
// (keytar)에서 토큰을 직접 읽을 수 있는지 먼저 확인해보고, 가능하면 토큰 없이
// 등록합니다 (= 어떤 파일에도 토큰이 남지 않음). 이 컴퓨터의 node가 keytar를 못
// 읽는 특수한 경우에만 예전 방식(--env)으로 등록하고 로그에 알려줍니다.

const path = require('path')
const { execFile } = require('child_process')
const { loadConfig, saveConfig } = require('./config')
const { resolveClaudePath, commandFor } = require('./claudeResolver')

const MCP_NAME = 'dooray'

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { shell: false, ...opts }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || err.message)); return }
      resolve(stdout)
    })
  })
}

// 이 컴퓨터의 일반 node가 keytar(자격 증명 관리자)에서 토큰을 읽을 수 있는지 실제로
// 테스트해봅니다. (keytar는 Electron용으로 다시 빌드되어 있어서, 환경에 따라 일반
// node에서는 로드가 안 될 수도 있기 때문에 미리 확인이 필요합니다.)
async function probeKeytarUnderNode(appDir) {
  const script =
    "require('keytar').getPassword('dooray-assistant','default')" +
    '.then((t)=>process.exit(t?0:2)).catch(()=>process.exit(3))'
  try {
    await run('node', ['-e', script], { cwd: appDir })
    return true
  } catch {
    return false
  }
}

async function ensureMcpRegistered({ token, appDir, log }) {
  // 'claude' 명령이 이 컴퓨터에서 바로 실행되는지, 아니면 설치는 됐지만 시스템 등록이
  // 안 되어 다른 위치에 있는지 자동으로 확인합니다 (사용자가 터미널을 열 필요 없음).
  const claudePath = await resolveClaudePath({ log })
  if (!claudePath) {
    log('클로드(Claude Code)를 찾지 못해 두레이 MCP 도구 등록을 건너뜁니다.')
    return
  }
  // npm으로 설치된 클로드(cli.js)는 node로 실행해야 해서, 실제 실행 명령으로 변환합니다.
  const { cmd: claudeCmd, args: claudePre } = commandFor(claudePath)
  const runClaude = (args) => run(claudeCmd, [...claudePre, ...args])

  let registered = false
  try {
    const list = await runClaude(['mcp', 'list'])
    registered = list.includes(MCP_NAME)
  } catch (err) {
    log(`claude mcp list 실행 실패: ${err.message}`)
    return
  }

  // keytar 직접 읽기가 가능하면 'keytar' 방식(토큰이 파일에 안 남음), 아니면 'env' 방식.
  const useKeytar = await probeKeytarUnderNode(appDir)
  const mode = useKeytar ? 'keytar' : 'env'

  const cfg = loadConfig()
  if (registered && cfg.mcpTokenMode === mode) {
    log('두레이 MCP 도구가 이미 등록되어 있습니다')
    return
  }

  // 등록 방식이 바뀌었으면(예: 예전 --env 방식 → keytar 방식으로 업그레이드)
  // 기존 등록을 지우고 다시 등록합니다. 이때 설정 파일에 남아있던 토큰도 함께 지워집니다.
  if (registered) {
    try {
      await runClaude(['mcp', 'remove', '--scope', 'user', MCP_NAME])
    } catch (err) {
      log(`기존 MCP 등록 제거 실패 (기존 등록을 그대로 사용합니다): ${err.message}`)
      return
    }
  }

  const serverPath = path.join(appDir, 'src', 'mcp-server', 'dooray-mcp-server.mjs')
  const args = ['mcp', 'add', '--transport', 'stdio', '--scope', 'user']
  if (!useKeytar) args.push('--env', `DOORAY_API_TOKEN=${token}`)
  args.push(MCP_NAME, '--', 'node', serverPath)

  try {
    await runClaude(args)
    const cfgAfter = loadConfig()
    cfgAfter.mcpTokenMode = mode
    saveConfig(cfgAfter)
    log(
      useKeytar
        ? '두레이 MCP 도구 등록 완료 (토큰은 자격 증명 관리자에서 직접 읽음 — 파일에 남지 않음)'
        : '두레이 MCP 도구 등록 완료 (이 컴퓨터에서는 자격 증명 관리자 직접 읽기가 안 되어, 토큰이 클로드 설정 파일에 저장되는 예전 방식을 사용합니다)'
    )
  } catch (err) {
    log(`두레이 MCP 도구 자동 등록 실패: ${err.message}`)
  }
}

module.exports = { ensureMcpRegistered }
