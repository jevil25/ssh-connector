// Capture the real app against a disposable, loopback-only SSH/SFTP server.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFixture } = require('../test/ssh-fixture');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-connector-demo-'));
const data = path.join(root, 'app-data');
const remote = path.join(root, 'remote');
const upload = path.join(root, 'upload');
const output = path.join(__dirname, '../docs/screenshots');
for (const directory of [data, remote, upload, output]) fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', data);
for (const directory of ['app', 'backups', 'logs']) fs.mkdirSync(path.join(remote, directory));
fs.writeFileSync(path.join(remote, 'README.txt'), 'Welcome to the local SSH Connector demo.\n');
fs.writeFileSync(path.join(remote, 'app', 'index.html'), '<h1>Hello from SSH Connector</h1>\n');
fs.writeFileSync(path.join(remote, 'logs', 'app.log'), 'Demo service started successfully.\n');
fs.writeFileSync(path.join(upload, 'deploy-notes.txt'), 'Demo deployment notes: upload, inspect, and connect.\n');

let window, fixture;
// Only the generated demo host is connected; no production trust is modified.
dialog.showMessageBox = async () => ({ response: 1 });
const timeout = setTimeout(() => { console.error('Screenshot capture timed out'); app.exit(1); }, 45000);
require('../src/main');
const js = code => window.webContents.executeJavaScript(code, true);
const until = async predicate => {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Demo UI did not become ready');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const capture = async name => {
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const screenshot = await window.webContents.capturePage();
  fs.writeFileSync(path.join(output, name), screenshot.toPNG());
};

app.whenReady().then(async () => {
  await until(() => { window = BrowserWindow.getAllWindows()[0]; return Boolean(window); });
  await until(() => js('Boolean(window.ssh && document.getElementById("keychain-status").textContent !== "Checking credential storage…")').catch(() => false));
  await capture('welcome.png');
  fixture = await startFixture(remote);
  const server = { name: 'Local demo', host: '127.0.0.1', port: fixture.port, username: 'demo', password: 'test-password', group: 'Development', notes: 'Temporary SSH + SFTP server' };
  await js(`(async () => { servers = await window.ssh.saveServer(${JSON.stringify(server)}); renderServers(); await connect(servers[0]); })()`);
  await until(() => js('Boolean(active()?.ready && active()?.directory === "/")'));
  const command = "printf '\\033[1;32mSSH Connector demo\\033[0m\\r\\n\\r\\nTerminal and file transfers in one place.\\r\\n\\r\\n'; for file in *; do printf '%s\\r\\n' \"$file\"; done; printf '\\r\\nReady for your next deployment.\\r\\n'\r";
  await js(`window.ssh.input(activeId, ${JSON.stringify(command)})`);
  await until(() => js('Array.from({length:active().term.buffer.active.length},(_,i)=>active().term.buffer.active.getLine(i).translateToString()).join("\\n").includes("Ready for your next deployment.")'));
  const id = await js(`window.ssh.upload(activeId, '/', 'files', [${JSON.stringify(path.join(upload, 'deploy-notes.txt'))}])`);
  await until(() => js(`jobs.get(${JSON.stringify(id)})?.status === 'complete'`));
  await js("loadFiles(active(), '/')");
  await capture('workspace.png');
  await js(`(async () => { commands = await window.ssh.saveCommands([{name:'List files',command:'ls -lah'},{name:'Disk usage',command:'df -h'},{name:'Follow application logs',command:'tail -f logs/app.log'}]); document.getElementById('commands-button').click(); })()`);
  await capture('saved-commands.png');
  console.log('Captured welcome, connected workspace, and saved commands in docs/screenshots.');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(timeout);
  if (window && !window.isDestroyed()) window.destroy();
  if (fixture) await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
