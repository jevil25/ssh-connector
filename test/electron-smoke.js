const { app, BrowserWindow, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startFixture } = require('./ssh-fixture');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-electron-test-'));
const data = path.join(root, 'app-data'); fs.mkdirSync(data); app.setPath('userData', data);
const remote = path.join(root, 'remote'), upload = path.join(root, 'upload'), download = path.join(root, 'download');
for (const directory of [remote, upload, download]) fs.mkdirSync(directory);
const folder = path.join(upload, 'folder with spaces'); fs.mkdirSync(path.join(folder, 'empty'), { recursive: true }); fs.writeFileSync(path.join(folder, 'hello.txt'), 'test transfer contents\n'); fs.writeFileSync(path.join(folder, 'binary.bin'), crypto.randomBytes(130000));
fs.chmodSync(path.join(folder, 'hello.txt'), 0o755);
let acceptConfirm = true, fixture, window;
dialog.showMessageBox = async () => ({ response: acceptConfirm ? 1 : 0 });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [download] });
const timeout = setTimeout(() => { console.error('Electron integration test timed out'); app.exit(1); }, 60000);
require('../src/main');
const js = code => window.webContents.executeJavaScript(code, true);
const until = async (predicate, message) => { const deadline = Date.now() + 10000; while (!await predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 30)); } };
const transfer = async expression => {
  const id = await js(expression); assert(id); await until(() => js(`jobs.has(${JSON.stringify(id)}) && !['running','queued'].includes(jobs.get(${JSON.stringify(id)}).status)`), 'Transfer did not finish');
  return js(`jobs.get(${JSON.stringify(id)})`);
};

app.whenReady().then(async () => {
  await until(() => { window = BrowserWindow.getAllWindows()[0]; return window; }, 'No app window');
  await until(() => js('Boolean(window.ssh && typeof renderServers === "function")').catch(() => false), 'Renderer did not load');
  const errors = []; window.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error('Renderer:', event.message); } });
  fixture = await startFixture(remote);
  const server = { name: 'Integration test', host: '127.0.0.1', port: fixture.port, username: 'fixture', password: 'test-password', group: 'Test' };
  const saved = await js(`window.ssh.saveServer(${JSON.stringify(server)})`); assert.equal(saved.length, 1); assert.equal(saved[0].hasPassword, true);
  assert(!fs.readFileSync(path.join(data, 'servers.json'), 'utf8').includes('test-password'));
  await js(`(async () => { servers = await window.ssh.state().then(s => s.servers); renderServers(); await connect(servers[0]); })()`);
  await until(() => js('Boolean(active()?.ready && active()?.directory === "/")'), 'Connection or file manager did not become ready');
  assert.equal(await js('document.querySelectorAll(".xterm").length'), 1);
  await js('window.ssh.input(activeId, "echo app-terminal-ok\\r")');
  await until(() => js('Array.from({length:active().term.buffer.active.length},(_,i)=>active().term.buffer.active.getLine(i).translateToString()).join("\\n").includes("app-terminal-ok")'), 'Terminal input/output failed');
  const uploaded = await transfer(`window.ssh.upload(activeId, '/', 'folder', [${JSON.stringify(folder)}])`);
  assert.equal(uploaded.status, 'complete', uploaded.error); assert.equal(uploaded.files, 2);
  const remoteFolder = path.join(remote, path.basename(folder)); assert.equal(fs.readFileSync(path.join(remoteFolder, 'hello.txt'), 'utf8'), 'test transfer contents\n'); assert(fs.statSync(path.join(remoteFolder, 'empty')).isDirectory());
  assert(fs.readFileSync(path.join(remoteFolder, 'binary.bin')).equals(fs.readFileSync(path.join(folder, 'binary.bin'))));
  assert.equal(fs.statSync(path.join(remoteFolder, 'hello.txt')).mode & 0o777, 0o755);
  const downloaded = await transfer(`window.ssh.download(activeId, '/folder with spaces')`);
  assert.equal(downloaded.status, 'complete', downloaded.error); assert(fs.readFileSync(path.join(download, 'folder with spaces', 'binary.bin')).equals(fs.readFileSync(path.join(folder, 'binary.bin'))));
  assert.equal(fs.statSync(path.join(download, 'folder with spaces', 'hello.txt')).mode & 0o777, 0o755);
  acceptConfirm = false; fs.writeFileSync(path.join(folder, 'hello.txt'), 'new content');
  const cancelled = await transfer(`window.ssh.upload(activeId, '/', 'folder', [${JSON.stringify(folder)}])`);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(fs.readFileSync(path.join(remoteFolder, 'hello.txt'), 'utf8'), 'test transfer contents\n');
  acceptConfirm = true;
  const overwritten = await transfer(`window.ssh.upload(activeId, '/', 'folder', [${JSON.stringify(folder)}])`);
  assert.equal(overwritten.status, 'complete', overwritten.error); assert.equal(fs.readFileSync(path.join(remoteFolder, 'hello.txt'), 'utf8'), 'new content');
  acceptConfirm = false;
  const downloadCancelled = await transfer(`window.ssh.download(activeId, '/folder with spaces')`);
  assert.equal(downloadCancelled.status, 'cancelled'); assert.equal(fs.readFileSync(path.join(download, 'folder with spaces', 'hello.txt'), 'utf8'), 'test transfer contents\n');
  acceptConfirm = true;
  const downloadOverwrite = await transfer(`window.ssh.download(activeId, '/folder with spaces')`);
  assert.equal(downloadOverwrite.status, 'complete', downloadOverwrite.error); assert.equal(fs.readFileSync(path.join(download, 'folder with spaces', 'hello.txt'), 'utf8'), 'new content');
  const cancelledId = await js(`(async () => { const id = await window.ssh.upload(activeId, '/', 'folder', [${JSON.stringify(folder)}]); await window.ssh.cancelTransfer(id); return id; })()`);
  await until(() => js(`jobs.get(${JSON.stringify(cancelledId)})?.status === 'cancelled'`), 'Transfer cancellation did not finish');
  await js(`window.ssh.rename(activeId, '/folder with spaces/hello.txt', 'renamed.txt')`); assert(fs.existsSync(path.join(remoteFolder, 'renamed.txt')));
  acceptConfirm = false; assert.equal(await js(`window.ssh.deleteRemote(activeId, '/folder with spaces')`), false); assert(fs.existsSync(remoteFolder));
  acceptConfirm = true; await js(`window.ssh.deleteRemote(activeId, '/folder with spaces')`); assert(!fs.existsSync(remoteFolder));
  await js(`(async () => { commands = await window.ssh.saveCommands([{name:'List',command:'ls -la'}]); renderCommands(); })()`); assert.equal(await js('document.querySelectorAll(".command-row").length'), 1);
  await js(`loadFiles(active(), '/')`);
  const screenshot = await window.webContents.capturePage(); fs.writeFileSync(path.join(os.tmpdir(), 'ssh-connector-smoke.png'), screenshot.toPNG());
  await js('closeTab(activeId)'); assert.equal(await js('sessions.size'), 0);
  await js('connect(servers[0])'); await until(() => js('Boolean(active()?.ready)'), 'Reconnect failed'); await js('closeTab(activeId)');
  await js(`window.ssh.saveServer({...servers[0], password:'wrong-test-password'})`);
  await js('connect(servers[0])');
  // OpenSSH config may offer encrypted keys from the developer's Mac first.
  // Skip those without unlocking them; this case verifies password retry only.
  await until(() => js(`(() => {
    if (!document.getElementById('prompt-dialog').open) return false;
    if (document.getElementById('prompt-title').textContent.startsWith('Unlock SSH key')) {
      document.getElementById('prompt-cancel').click(); return false;
    }
    return document.getElementById('prompt-title').textContent.startsWith('Sign in to');
  })()`), 'Password retry prompt did not open');
  await js('document.getElementById("prompt-value").value="test-password"; document.getElementById("prompt-form").requestSubmit()');
  await until(() => js('Boolean(active()?.ready)'), 'Password retry did not authenticate'); await js('closeTab(activeId)');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: Electron UI, Keychain encryption, terminal, recursive binary uploads/downloads, empty folders, local/remote overwrite approval/cancellation, transfer cancellation, rename, delete approval/cancellation, commands, reconnect.');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(timeout); if (window && !window.isDestroyed()) window.destroy(); if (fixture) await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); app.exit(process.exitCode || 0);
});
