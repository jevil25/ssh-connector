const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Store } = require('./store');
const { SSHConnection, discoverAliases, expandHome, walkLocal, safeRemoteName } = require('./ssh');

let window, store;
const sessions = new Map(), questions = new Map(), transfers = new Map(), queues = new Map();
const page = path.join(__dirname, 'index.html');
const send = (type, payload) => { if (window && !window.isDestroyed()) window.webContents.send(type, payload); };
function ask(question) {
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => { questions.delete(id); resolve(null); send('credential-expired', id); }, 180000);
    const finish = answer => { clearTimeout(timer); questions.delete(id); resolve(answer); };
    finish.sessionId = question.sessionId;
    questions.set(id, finish);
    send('credential', { ...question, id });
  });
}
async function confirm(message, detail, action = 'Continue') {
  const result = await dialog.showMessageBox(window, { type: 'warning', message, detail, buttons: ['Cancel', action], defaultId: 0, cancelId: 0, noLink: true });
  return result.response === 1;
}
function connection(id) {
  const session = sessions.get(id);
  if (!session || session.closed) throw new Error('This connection is closed. Reconnect to continue.');
  return session;
}
function remotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw new Error('Invalid remote path.');
  return path.posix.normalize(value);
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unauthorized request.');
    try { return await fn(...args); } catch (error) { throw new Error(error.message || 'Operation failed'); }
  });
}
async function gatherRemote(conn, root) {
  const manifest = [];
  async function walk(remote, relative) {
    const attrs = await conn.call('lstat', remote);
    if (attrs.isSymbolicLink()) throw new Error(`Symbolic link transfer is unsupported: ${remote}`);
    if (!attrs.isDirectory() && !attrs.isFile()) throw new Error(`Unsupported file: ${remote}`);
    manifest.push({ remote, relative, directory: attrs.isDirectory(), size: attrs.size, mode: attrs.mode & 0o777 });
    if (attrs.isDirectory()) {
      const entries = await conn.call('readdir', remote);
      for (const entry of entries) {
        safeRemoteName(entry.filename);
        await walk(path.posix.join(remote, entry.filename), path.posix.join(relative, entry.filename));
      }
    }
  }
  await walk(root, '');
  return manifest;
}
function startTransfer(sessionId, name, task) {
  const id = crypto.randomUUID(), controller = new AbortController();
  transfers.set(id, { controller, sessionId });
  const state = { id, sessionId, name, status: 'queued', bytes: 0, total: 0, files: 0 };
  let last = 0;
  const report = (force = false) => { if (force || Date.now() - last > 150) { last = Date.now(); send('transfer', { ...state }); } };
  const progress = size => { state.bytes += size; report(); };
  report(true);
  const job = (queues.get(sessionId) || Promise.resolve()).catch(() => {}).then(() => {
    controller.signal.throwIfAborted(); state.status = 'running'; report(true);
    return task(state, progress, controller.signal, report);
  }).then(() => {
    state.status = controller.signal.aborted ? 'cancelled' : 'complete';
  }).catch(error => { state.status = controller.signal.aborted || state.status === 'cancelled' ? 'cancelled' : 'failed'; state.error = error.message; }).finally(() => {
    report(true); transfers.delete(id);
    if (queues.get(sessionId) === job) queues.delete(sessionId);
  });
  queues.set(sessionId, job);
  return id;
}
async function ensureOverwrite(paths, direction) {
  if (!paths.length) return true;
  return confirm(`Overwrite ${paths.length} existing ${direction} file${paths.length === 1 ? '' : 's'}?`, paths.slice(0, 12).join('\n') + (paths.length > 12 ? '\n…' : ''), 'Overwrite');
}

function setupIPC() {
  handle('state', () => ({ servers: store.list(), commands: store.data.commands, home: os.homedir(), encrypted: safeStorage.isEncryptionAvailable() }));
  handle('save-server', input => store.save(input));
  handle('delete-server', async id => {
    const server = store.get(id);
    if (!await confirm(`Delete saved server “${server.name}”?`, 'This removes its saved settings and password.', 'Delete')) return store.list();
    return store.remove(id);
  });
  handle('ssh-import', async () => {
    const aliases = await discoverAliases();
    for (const alias of aliases) if (!store.data.servers.some(s => s.host === alias)) store.save({ name: alias, host: alias, group: 'SSH config' });
    return { servers: store.list(), count: aliases.length };
  });
  handle('key-list', async () => {
    const directory = path.join(os.homedir(), '.ssh');
    if (!fs.existsSync(directory)) return [];
    const result = [];
    for (const name of await fsp.readdir(directory)) {
      const file = path.join(directory, name);
      if ((await fsp.stat(file)).isFile() && !name.endsWith('.pub')) {
        const fd = await fsp.open(file);
        try { const buffer = Buffer.alloc(100); await fd.read(buffer, 0, 100, 0); if (/PRIVATE KEY/.test(buffer.toString())) result.push(file); } finally { await fd.close(); }
      }
    }
    return result;
  });
  handle('choose-key', async () => {
    const picked = await dialog.showOpenDialog(window, { title: 'Choose a private SSH key', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
    return picked.canceled ? null : picked.filePaths[0];
  });
  handle('connect', serverId => {
    const server = { ...store.get(serverId) };
    const id = crypto.randomUUID();
    const conn = new SSHConnection({ store, server,
      ask: question => ask({ ...question, sessionId: id }),
      confirmHost: (host, fp) => confirm(`Trust this SSH server: ${host}?`, `Compare this fingerprint with your server administrator or provider:\n\n${fp}\n\nThe fingerprint will be remembered on this Mac.`, 'Trust and connect'),
      emit: (type, value) => send('session', { id, type, value })
    });
    sessions.set(id, conn);
    conn.open().then(info => { if (!conn.closed) send('session', { id, type: 'ready', value: info }); }).catch(error => {
      conn.close(); send('session', { id, type: 'error', value: error.message }); send('session', { id, type: 'closed', value: 'Connection failed' });
    });
    return { id, server: store.list().find(s => s.id === serverId) };
  });
  handle('disconnect', id => {
    for (const transfer of transfers.values()) if (transfer.sessionId === id) transfer.controller.abort();
    sessions.get(id)?.close(); sessions.delete(id);
    for (const [questionId, resolve] of questions) if (resolve.sessionId === id) { resolve(null); send('credential-expired', questionId); }
  });
  handle('terminal-input', (id, input) => {
    if (typeof input !== 'string' || input.length > 1024 * 1024) throw new Error('Invalid terminal input.');
    connection(id).input(input);
  });
  handle('terminal-resize', (id, cols, rows) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return;
    connection(id).resize(cols, rows);
  });
  handle('credential-answer', (id, answer) => {
    if (answer && (typeof answer.value !== 'string' || answer.value.length > 10000)) throw new Error('Invalid answer');
    questions.get(id)?.(answer);
  });
  handle('list-files', (id, directory) => connection(id).list(directory ? remotePath(directory) : '.'));
  handle('mkdir', (id, directory, name) => connection(id).call('mkdir', path.posix.join(remotePath(directory), safeRemoteName(name)), { mode: 0o755 }));
  handle('rename', async (id, oldPath, name) => {
    const conn = connection(id), source = remotePath(oldPath);
    if (source === '/') throw new Error('Cannot rename the remote root.');
    const target = path.posix.join(path.posix.dirname(source), safeRemoteName(name));
    if (source === target) return;
    if (await conn.exists(target)) throw new Error('A file with that name already exists. Choose a different name.');
    await conn.call('rename', source, target);
  });
  handle('delete-remote', async (id, target) => {
    const conn = connection(id), root = remotePath(target);
    if (root === '/') throw new Error('Cannot delete the remote root.');
    if (!await confirm(`Delete “${path.posix.basename(root)}” from the server?`, `${root}\n\nFolders and all their contents will be permanently deleted.`, 'Delete permanently')) return false;
    async function remove(file) {
      const attrs = await conn.call('lstat', file);
      if (attrs.isDirectory() && !attrs.isSymbolicLink()) {
        for (const item of await conn.call('readdir', file)) { safeRemoteName(item.filename); await remove(path.posix.join(file, item.filename)); }
        await conn.call('rmdir', file);
      } else await conn.call('unlink', file);
    }
    await remove(root);
    return true;
  });
  handle('upload', async (id, directory, kind, droppedPaths) => {
    const conn = connection(id), remoteDirectory = remotePath(directory);
    let sources;
    if (Array.isArray(droppedPaths) && droppedPaths.length) {
      if (droppedPaths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Invalid dropped file.');
      sources = droppedPaths;
    } else {
      const picked = await dialog.showOpenDialog(window, { title: 'Select items to upload', properties: [kind === 'folder' ? 'openDirectory' : 'openFile', 'multiSelections'] });
      if (picked.canceled) return null;
      sources = picked.filePaths;
    }
    return startTransfer(id, `Upload ${sources.length} item${sources.length === 1 ? '' : 's'}`, async (state, progress, signal, report) => {
      const manifest = [];
      for (const source of sources) {
        const name = safeRemoteName(path.basename(source));
        for (const item of await walkLocal(source)) manifest.push({ ...item, remote: path.posix.join(remoteDirectory, name, item.relative) });
      }
      const clashes = [];
      for (const item of manifest) {
        signal.throwIfAborted();
        const existing = await conn.exists(item.remote);
        if (existing?.isSymbolicLink()) throw new Error(`Refusing to overwrite a symbolic link: ${item.remote}`);
        if (existing && Boolean(existing.isDirectory()) !== item.directory) throw new Error(`File/folder conflict: ${item.remote}`);
        if (existing && !item.directory) clashes.push(item.remote);
      }
      if (!await ensureOverwrite(clashes, 'remote')) { state.status = 'cancelled'; throw new Error('Overwrite cancelled.'); }
      const approved = new Set(clashes);
      state.total = manifest.filter(i => !i.directory).reduce((sum, i) => sum + i.size, 0); report(true);
      const sftp = await conn.getSftp();
      for (const item of manifest) {
        signal.throwIfAborted();
        if (item.directory) {
          const existing = await conn.exists(item.remote);
          if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error(`Folder changed during upload: ${item.remote}`);
          if (!existing) await conn.call('mkdir', item.remote, { mode: 0o755 });
          continue;
        }
        const temp = path.posix.join(path.posix.dirname(item.remote), `.sshconnector-${crypto.randomUUID()}.partial`);
        try {
          const read = fs.createReadStream(item.local); read.on('data', chunk => progress(chunk.length));
          await pipeline(read, sftp.createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
          const existing = await conn.exists(item.remote);
          if (existing?.isSymbolicLink() || existing?.isDirectory()) throw new Error(`Destination changed during upload: ${item.remote}`);
          if (existing && !approved.has(item.remote) && !await ensureOverwrite([item.remote], 'remote')) throw new Error('Overwrite cancelled.');
          await conn.call('setstat', temp, { mode: existing ? existing.mode & 0o777 : item.mode });
          if (existing) {
            // Prefer atomic replacement; other SFTP servers retain a rollback copy.
            try { await conn.call('ext_openssh_rename', temp, item.remote); }
            catch (error) {
              if (error.code !== 8 && !/does not support|unsupported/i.test(error.message)) throw error;
              const backup = `${temp}.previous`;
              await conn.call('rename', item.remote, backup);
              try { await conn.call('rename', temp, item.remote); }
              catch (replaceError) { await conn.call('rename', backup, item.remote); throw replaceError; }
              await conn.call('unlink', backup);
            }
          } else await conn.call('rename', temp, item.remote);
          state.files++;
        } finally { try { await conn.call('unlink', temp); } catch {} }
      }
    });
  });
  handle('download', async (id, target) => {
    const conn = connection(id), source = remotePath(target);
    if (source === '/') throw new Error('Choose a file or folder within the remote root.');
    const picked = await dialog.showOpenDialog(window, { title: 'Choose download destination', properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled) return null;
    const base = path.join(picked.filePaths[0], safeRemoteName(path.posix.basename(source)));
    return startTransfer(id, `Download ${path.posix.basename(source)}`, async (state, progress, signal, report) => {
      const manifest = (await gatherRemote(conn, source)).map(item => ({ ...item, local: path.join(base, item.relative) }));
      const clashes = [];
      for (const item of manifest) {
        signal.throwIfAborted();
        let stat; try { stat = await fsp.lstat(item.local); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (stat?.isSymbolicLink()) throw new Error(`Refusing to overwrite a local symbolic link: ${item.local}`);
        if (stat && Boolean(stat.isDirectory()) !== item.directory) throw new Error(`File/folder conflict: ${item.local}`);
        if (stat && !item.directory) clashes.push(item.local);
      }
      if (!await ensureOverwrite(clashes, 'local')) { state.status = 'cancelled'; throw new Error('Overwrite cancelled.'); }
      const approved = new Set(clashes);
      state.total = manifest.filter(i => !i.directory).reduce((sum, i) => sum + i.size, 0); report(true);
      const sftp = await conn.getSftp();
      for (const item of manifest) {
        signal.throwIfAborted();
        if (item.directory) { await fsp.mkdir(item.local, { recursive: true, mode: 0o755 }); continue; }
        const temp = path.join(path.dirname(item.local), `.sshconnector-${crypto.randomUUID()}.partial`);
        try {
          const read = sftp.createReadStream(item.remote); read.on('data', chunk => progress(chunk.length));
          await pipeline(read, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
          let existing; try { existing = await fsp.lstat(item.local); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (existing?.isSymbolicLink() || existing?.isDirectory()) throw new Error(`Destination changed during download: ${item.local}`);
          if (existing && !approved.has(item.local) && !await ensureOverwrite([item.local], 'local')) throw new Error('Overwrite cancelled.');
          await fsp.chmod(temp, existing ? existing.mode & 0o777 : item.mode);
          await fsp.rename(temp, item.local); state.files++;
        } finally { await fsp.rm(temp, { force: true }).catch(() => {}); }
      }
    });
  });
  handle('cancel-transfer', id => transfers.get(id)?.controller.abort());
  handle('save-commands', commands => store.saveCommands(commands));
  handle('export', async () => {
    const picked = await dialog.showSaveDialog(window, { title: 'Export servers and saved commands', defaultPath: 'ssh-connector-backup.json', filters: [{ name: 'JSON backup', extensions: ['json'] }] });
    if (picked.canceled) return false;
    await fsp.writeFile(picked.filePath, JSON.stringify(store.export(), null, 2), { mode: 0o600 });
    return true;
  });
  handle('import', async () => {
    const picked = await dialog.showOpenDialog(window, { title: 'Import SSH Connector backup', filters: [{ name: 'JSON backup', extensions: ['json'] }], properties: ['openFile'] });
    if (picked.canceled) return null;
    const stat = await fsp.stat(picked.filePaths[0]);
    if (stat.size > 10 * 1024 * 1024) throw new Error('Backup is too large.');
    store.import(JSON.parse(await fsp.readFile(picked.filePaths[0], 'utf8')));
    return { servers: store.list(), commands: store.data.commands };
  });
  handle('forget-host', async () => {
    if (!await confirm('Clear saved server fingerprints?', 'Only do this after independently verifying a legitimate server key change. Entries in your Mac’s known_hosts file remain in effect.', 'Clear saved fingerprints')) return false;
    store.data.trustedHosts = {}; store.persist(); return true;
  });
}

function createWindow() {
  window = new BrowserWindow({ width: 1320, height: 850, minWidth: 960, minHeight: 620, title: 'SSH Connector', backgroundColor: '#11151b',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(page);
  window.on('closed', () => {
    for (const transfer of transfers.values()) transfer.controller.abort();
    for (const conn of sessions.values()) conn.close(); sessions.clear();
    for (const resolve of questions.values()) resolve(null);
    window = null;
  });
}
app.whenReady().then(() => {
  store = new Store(app.getPath('userData'), safeStorage);
  setupIPC();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
  ]));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}).catch(error => { dialog.showErrorBox('SSH Connector could not start', error.message); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { for (const conn of sessions.values()) conn.close(); });
