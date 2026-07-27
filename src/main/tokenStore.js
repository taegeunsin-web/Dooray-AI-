// 두레이 API 토큰을 OS 자격 증명 관리자(윈도우: 자격 증명 관리자, macOS: 키체인)에
// 안전하게 저장/조회하는 역할. 클로데이(Clauday)도 같은 방식(keytar)을 씁니다.
// 이걸 쓰면 config.json 파일에 토큰을 평문으로 적어둘 필요가 없어집니다.

const keytar = require('keytar')

const SERVICE = 'dooray-assistant'
const ACCOUNT = 'default'
const IMAP_ACCOUNT = 'imap-password' // 메일 전문 가져오기(IMAP)용 메일 비밀번호
const CALDAV_ACCOUNT = 'caldav-password' // 캘린더 연동(CalDAV)용 전용 비밀번호

async function getToken() {
  return keytar.getPassword(SERVICE, ACCOUNT)
}

async function saveToken(token) {
  await keytar.setPassword(SERVICE, ACCOUNT, token)
}

async function deleteToken() {
  await keytar.deletePassword(SERVICE, ACCOUNT)
}

async function getImapPassword() {
  return keytar.getPassword(SERVICE, IMAP_ACCOUNT)
}

async function saveImapPassword(password) {
  await keytar.setPassword(SERVICE, IMAP_ACCOUNT, password)
}

async function deleteImapPassword() {
  await keytar.deletePassword(SERVICE, IMAP_ACCOUNT)
}

async function getCaldavPassword() {
  return keytar.getPassword(SERVICE, CALDAV_ACCOUNT)
}

async function saveCaldavPassword(password) {
  await keytar.setPassword(SERVICE, CALDAV_ACCOUNT, password)
}

async function deleteCaldavPassword() {
  await keytar.deletePassword(SERVICE, CALDAV_ACCOUNT)
}

module.exports = {
  getToken,
  saveToken,
  deleteToken,
  getImapPassword,
  saveImapPassword,
  deleteImapPassword,
  getCaldavPassword,
  saveCaldavPassword,
  deleteCaldavPassword
}
