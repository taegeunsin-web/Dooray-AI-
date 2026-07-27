// 대시보드 화면(renderer)이 프로그램 내부 기능(IPC)을 안전하게 호출할 수 있게 만들어주는 다리.
// renderer 쪽에서는 Node.js 기능에 직접 접근하지 못하고, 여기서 허용한 것만 쓸 수 있습니다.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('doorayAssistant', {
  getConfig: () => ipcRenderer.invoke('dooray:get-config'),
  hasToken: () => ipcRenderer.invoke('dooray:has-token'),
  saveSettings: (settings) => ipcRenderer.invoke('dooray:save-settings', settings),
  saveMyInfo: (info) => ipcRenderer.invoke('dooray:save-my-info', info),
  getStatus: () => ipcRenderer.invoke('dooray:get-status'),
  getClaudeStatus: () => ipcRenderer.invoke('dooray:get-claude-status'),
  getChannels: () => ipcRenderer.invoke('dooray:get-channels'),
  toggleChannel: (channelId, allowed) => ipcRenderer.invoke('dooray:toggle-channel', { channelId, allowed }),
  toggleHistory: (channelId, enabled) => ipcRenderer.invoke('dooray:toggle-history', { channelId, enabled }),
  searchHistoryAll: (query) => ipcRenderer.invoke('dooray:search-history-all', { query }),
  testConnection: () => ipcRenderer.invoke('dooray:test-connection'),
  reconnect: () => ipcRenderer.invoke('dooray:reconnect'),
  listProjects: () => ipcRenderer.invoke('dooray:list-projects'),
  listTemplates: (projectId) => ipcRenderer.invoke('dooray:list-templates', projectId),
  getTemplateDetail: (projectId, templateId) =>
    ipcRenderer.invoke('dooray:get-template-detail', { projectId, templateId }),
  createFromTemplate: (projectId, templateId, subject, body, extra) =>
    ipcRenderer.invoke('dooray:create-from-template', { projectId, templateId, subject, body, ...(extra || {}) }),
  getAutomations: () => ipcRenderer.invoke('dooray:get-automations'),
  addAutomation: (rule) => ipcRenderer.invoke('dooray:add-automation', rule),
  removeAutomation: (id) => ipcRenderer.invoke('dooray:remove-automation', { id }),
  listProjectTags: (projectId) => ipcRenderer.invoke('dooray:list-project-tags', projectId),
  searchMembers: (name) => ipcRenderer.invoke('dooray:search-members', name),
  listCalendars: () => ipcRenderer.invoke('dooray:list-calendars'),
  listEvents: (calendarIds, timeMin, timeMax) =>
    ipcRenderer.invoke('dooray:list-events', { calendarIds, timeMin, timeMax }),
  createCalendarEvent: (event) => ipcRenderer.invoke('dooray:create-calendar-event', event),
  updateCalendarEvent: (event) => ipcRenderer.invoke('dooray:update-calendar-event', event),
  getMailFolders: () => ipcRenderer.invoke('dooray:get-mail-folders'),
  getMailFolderAllowlist: () => ipcRenderer.invoke('dooray:get-mail-folder-allowlist'),
  saveMailFolderAllowlist: (folderNames) =>
    ipcRenderer.invoke('dooray:save-mail-folder-allowlist', { folderNames }),
  getTodoFolderAllowlist: () => ipcRenderer.invoke('dooray:get-todo-folder-allowlist'),
  saveTodoFolderAllowlist: (folderNames) =>
    ipcRenderer.invoke('dooray:save-todo-folder-allowlist', { folderNames }),
  addManualTodo: (mailId, folderName, text, mailUrl, groupLabel) =>
    ipcRenderer.invoke('dooray:add-manual-todo', { mailId, folderName, text, mailUrl, groupLabel }),
  removeManualTodo: (mailId) => ipcRenderer.invoke('dooray:remove-manual-todo', { mailId }),
  setMailRequestOptIn: (folderName, mailId, text, optedIn) =>
    ipcRenderer.invoke('dooray:set-mail-request-optin', { folderName, mailId, text, optedIn }),
  refreshMailNow: () => ipcRenderer.invoke('dooray:refresh-mail-now'),
  listSavedMail: (filters) => ipcRenderer.invoke('dooray:list-saved-mail', filters),
  getMailDetail: (id) => ipcRenderer.invoke('dooray:get-mail-detail', { id }),
  getMailSummary: (id, forceRefresh) => ipcRenderer.invoke('dooray:get-mail-summary', { id, forceRefresh }),
  retryMailImap: (id) => ipcRenderer.invoke('dooray:retry-mail-imap', { id }),
  getUsageStats: (period) => ipcRenderer.invoke('dooray:get-usage-stats', { period }),
  getImapSettings: () => ipcRenderer.invoke('dooray:get-imap-settings'),
  saveImapSettings: (settings) => ipcRenderer.invoke('dooray:save-imap-settings', settings),
  testImapConnection: () => ipcRenderer.invoke('dooray:test-imap-connection'),
  getCaldavSettings: () => ipcRenderer.invoke('dooray:get-caldav-settings'),
  saveCaldavSettings: (settings) => ipcRenderer.invoke('dooray:save-caldav-settings', settings),
  testCaldavConnection: () => ipcRenderer.invoke('dooray:test-caldav-connection'),
  getImapMailboxes: () => ipcRenderer.invoke('dooray:get-imap-mailboxes'),
  getImapUnseenCount: (mailboxPath) => ipcRenderer.invoke('dooray:get-imap-unseen-count', { mailboxPath }),
  getMailFolderGroups: (folderName, groupType, filters) =>
    ipcRenderer.invoke('dooray:get-mail-folder-groups', { folderName, groupType, ...(filters || {}) }),
  getMailFolderGroupDetail: (folderName, groupType, groupKey, filters) =>
    ipcRenderer.invoke('dooray:get-mail-folder-group-detail', { folderName, groupType, groupKey, ...(filters || {}) }),
  refreshMailFolderGroupSummary: (folderName, groupType, groupKey, filters) =>
    ipcRenderer.invoke('dooray:refresh-mail-folder-group-summary', { folderName, groupType, groupKey, ...(filters || {}) }),
  toggleMailGroupFavorite: (folderName, groupType, key, favorite) =>
    ipcRenderer.invoke('dooray:toggle-mail-group-favorite', { folderName, groupType, key, favorite }),
  getMailRequests: (folderName) => ipcRenderer.invoke('dooray:get-mail-requests', { folderName }),
  getMailRequestsAll: () => ipcRenderer.invoke('dooray:get-mail-requests-all'),
  setMailRequestDone: (id, done) => ipcRenderer.invoke('dooray:set-mail-request-done', { id, done }),
  getMailAlertRules: () => ipcRenderer.invoke('dooray:get-mail-alert-rules'),
  addMailAlertRule: (rule) => ipcRenderer.invoke('dooray:add-mail-alert-rule', rule),
  removeMailAlertRule: (id) => ipcRenderer.invoke('dooray:remove-mail-alert-rule', { id }),
  getDashboardChatHistory: () => ipcRenderer.invoke('dooray:dashboard-chat-history'),
  resetDashboardChat: () => ipcRenderer.invoke('dooray:dashboard-chat-reset'),
  sendDashboardChat: (text) => ipcRenderer.invoke('dooray:dashboard-chat-send', { text }),
  openClaudeTrustWindow: () => ipcRenderer.invoke('dooray:open-claude-trust-window'),
  resetAllData: () => ipcRenderer.invoke('dooray:reset-all-data'),
  listMediaGuides: () => ipcRenderer.invoke('dooray:list-media-guides'),
  refreshMediaGuide: (mediaName, projectId, projectLabel, wikiId) =>
    ipcRenderer.invoke('dooray:refresh-media-guide', { mediaName, projectId, projectLabel, wikiId }),
  getMediaGuide: (mediaName) => ipcRenderer.invoke('dooray:get-media-guide', { mediaName })
})
