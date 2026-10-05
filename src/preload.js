const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = channel => listener => { const wrapped = (_event, data) => listener(data); ipcRenderer.on(channel, wrapped); return () => ipcRenderer.removeListener(channel, wrapped); };
contextBridge.exposeInMainWorld('ssh', {
  state: invoke('state'), saveServer: invoke('save-server'), deleteServer: invoke('delete-server'), importSSH: invoke('ssh-import'),
  listKeys: invoke('key-list'), chooseKey: invoke('choose-key'), connect: invoke('connect'), disconnect: invoke('disconnect'),
  input: invoke('terminal-input'), resize: invoke('terminal-resize'), answer: invoke('credential-answer'),
  listFiles: invoke('list-files'), mkdir: invoke('mkdir'), rename: invoke('rename'), deleteRemote: invoke('delete-remote'),
  upload: invoke('upload'), download: invoke('download'), cancelTransfer: invoke('cancel-transfer'),
  saveCommands: invoke('save-commands'), exportBackup: invoke('export'), importBackup: invoke('import'), forgetHosts: invoke('forget-host'),
  filePath: file => webUtils.getPathForFile(file),
  onSession: subscribe('session'), onCredential: subscribe('credential'), onCredentialExpired: subscribe('credential-expired'), onTransfer: subscribe('transfer')
});
