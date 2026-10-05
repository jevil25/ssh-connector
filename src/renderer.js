/* global Terminal, FitAddon */
const $ = id => document.getElementById(id);
let servers = [], commands = [], activeId = null, filesHidden = false, noticeTimer;
const sessions = new Map(), jobs = new Map();
const promptQueue = [];
let currentPrompt = null;

function element(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
function action(text, fn, className) { const button = element('button', text, className); button.type = 'button'; button.onclick = () => attempt(fn); return button; }
function notice(message, failure = false) { $('notice').textContent = message; $('notice').classList.toggle('failure', failure); $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, failure ? 12000 : 6000); }
async function attempt(fn) { try { return await fn(); } catch (error) { notice(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''), true); } }
const active = () => sessions.get(activeId);
const formatSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function renderServers() {
  const group = $('group-filter').value;
  const groups = [...new Set(servers.map(s => s.group).filter(Boolean))].sort();
  $('group-filter').replaceChildren(new Option('All groups', ''), ...groups.map(g => new Option(g, g)));
  $('group-filter').value = groups.includes(group) ? group : '';
  $('groups').replaceChildren(...groups.map(g => new Option(g, g)));
  const query = $('server-search').value.toLowerCase();
  const filtered = servers.filter(s => [s.name, s.host, s.username, s.group, s.notes].join(' ').toLowerCase().includes(query) && (!group || s.group === group));
  $('server-list').replaceChildren();
  for (const server of filtered) {
    const card = element('article', null, 'server-card');
    card.append(element('strong', server.name, 'server-name'), element('div', `${server.username ? server.username + '@' : ''}${server.host}${server.port ? ':' + server.port : ''}`, 'server-address'));
    if (server.group || server.notes) card.append(element('div', [server.group, server.notes].filter(Boolean).join(' · '), 'server-note'));
    const buttons = element('div', null, 'server-buttons');
    buttons.append(action('Connect', () => connect(server), 'primary'), action('Edit', () => editServer(server)), action('Delete', async () => { servers = await window.ssh.deleteServer(server.id); renderServers(); }, 'danger'));
    card.append(buttons); card.ondblclick = event => { if (!event.target.closest('button')) attempt(() => connect(server)); }; $('server-list').append(card);
  }
  if (!filtered.length) $('server-list').append(element('p', servers.length ? 'No matching servers.' : 'No saved servers yet. Add one or import SSH config.', 'muted'));
}

async function editServer(server = {}) {
  const form = $('server-form'); form.reset();
  for (const key of ['id', 'name', 'host', 'username', 'port', 'group', 'keyPath', 'jumpHost', 'notes']) form.elements[key].value = server[key] ?? '';
  $('server-dialog-title').textContent = server.id ? 'Edit server' : 'Add server';
  form.elements.password.placeholder = server.hasPassword ? 'Saved password — leave blank to keep it' : 'Optional: save a password';
  $('server-error').textContent = '';
  const keys = await window.ssh.listKeys(); $('keys').replaceChildren(...keys.map(k => new Option(k, k)));
  $('server-dialog').showModal(); form.elements.name.focus();
}
$('server-form').onsubmit = async event => {
  event.preventDefault(); const input = Object.fromEntries(new FormData(event.target)); input.clearPassword = event.target.elements.clearPassword.checked;
  try { servers = await window.ssh.saveServer(input); event.target.elements.password.value = ''; $('server-dialog').close(); renderServers(); notice('Server saved.'); }
  catch (error) { $('server-error').textContent = error.message; }
};
$('cancel-server').onclick = () => { $('server-form').elements.password.value = ''; $('server-dialog').close(); };
$('browse-key').onclick = () => attempt(async () => { const key = await window.ssh.chooseKey(); if (key) $('server-form').elements.keyPath.value = key; });
$('new-server').onclick = $('welcome-add').onclick = () => attempt(() => editServer());
$('server-search').oninput = $('group-filter').onchange = renderServers;
$('import-ssh').onclick = () => attempt(async () => { const result = await window.ssh.importSSH(); servers = result.servers; renderServers(); notice(result.count ? `Found ${result.count} SSH config aliases. Existing servers were kept.` : 'No named hosts found in ~/.ssh/config.'); });

async function connect(server) {
  const result = await window.ssh.connect(server.id);
  const container = element('div', null, 'terminal-container'); $('terminals').append(container);
  const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, Monaco, monospace', scrollback: 10000, theme: { background: '#11151b', foreground: '#dce4ef', cursor: '#79aaf4' } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(container);
  const session = { id: result.id, server: result.server, term, fit, container, ready: false, status: 'Connecting…', files: [], directory: '', selected: null };
  sessions.set(result.id, session);
  term.writeln(`Connecting to ${server.name}…`);
  term.onData(data => { if (session.ready) window.ssh.input(session.id, data).catch(error => notice(error.message, true)); });
  term.onResize(({ cols, rows }) => { if (session.ready) window.ssh.resize(session.id, cols, rows).catch(() => {}); });
  selectTab(result.id);
}
function renderTabs() {
  $('tabs').replaceChildren();
  for (const session of sessions.values()) {
    const tab = element('div', null, `tab${session.id === activeId ? ' active' : ''}${session.ready ? '' : ' disconnected'}`);
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(session.id === activeId)); tab.tabIndex = 0;
    tab.append(element('span', `${session.ready ? '●' : '○'} ${session.server.name}`), action('×', () => closeTab(session.id)));
    tab.onclick = event => { if (!event.target.closest('button')) selectTab(session.id); };
    tab.onkeydown = event => { if (event.key === 'Enter') selectTab(session.id); };
    $('tabs').append(tab);
  }
}
function selectTab(id) {
  activeId = id;
  $('welcome').hidden = Boolean(id); $('workspace').hidden = !id;
  for (const session of sessions.values()) session.container.hidden = session.id !== id;
  renderTabs(); renderConnection(); renderFiles(); fitActive();
  if (active()) active().term.focus();
}
async function closeTab(id) {
  const session = sessions.get(id); if (!session) return;
  await window.ssh.disconnect(id); session.term.dispose(); session.container.remove(); sessions.delete(id);
  selectTab(activeId === id ? [...sessions.keys()].at(-1) || null : activeId);
}
function renderConnection() {
  const session = active(); if (!session) return;
  $('connection-status').textContent = session.status;
  $('disconnect').disabled = !session.ready;
  $('reconnect').disabled = session.status === 'Connecting…';
  for (const id of ['upload-files', 'upload-folder', 'new-folder', 'refresh-files', 'parent-folder', 'remote-path']) $(id).disabled = !session.ready;
}
function fitActive() { requestAnimationFrame(() => { const session = active(); if (session) { try { session.fit.fit(); } catch {} } }); }
new ResizeObserver(fitActive).observe($('terminal-area'));
window.ssh.onSession(event => {
  const session = sessions.get(event.id); if (!session) return;
  if (event.type === 'terminal') session.term.write(event.value);
  if (event.type === 'error') { session.term.writeln(`\r\nError: ${event.value}`); notice(event.value, true); }
  if (event.type === 'ready') {
    session.ready = true; session.status = `${event.value.username}@${event.value.host}:${event.value.port}`;
    attempt(() => loadFiles(session));
    session.fit.fit(); window.ssh.resize(session.id, session.term.cols, session.term.rows).catch(() => {});
  }
  if (event.type === 'closed') { session.ready = false; session.status = event.value + ' — click Reconnect to try again'; session.term.writeln(`\r\n[${event.value}]`); }
  if (event.id === activeId) { renderConnection(); renderFiles(); } renderTabs();
});
$('disconnect').onclick = () => attempt(async () => { const session = active(); if (!session) return; await window.ssh.disconnect(session.id); session.ready = false; session.status = 'Disconnected — click Reconnect to connect again'; renderConnection(); renderTabs(); renderFiles(); });
$('reconnect').onclick = () => attempt(async () => { const session = active(); if (!session) return; const server = servers.find(s => s.id === session.server.id); if (!server) throw new Error('This saved server was deleted. Add it again before reconnecting.'); await closeTab(session.id); await connect(server); });
$('toggle-files').onclick = () => { filesHidden = !filesHidden; $('files-panel').hidden = filesHidden; $('toggle-files').textContent = filesHidden ? 'Show files' : 'Hide files'; fitActive(); };

async function loadFiles(session = active(), directory = session?.directory) {
  if (!session?.ready) return;
  session.fileError = ''; session.loading = true; if (session.id === activeId) renderFiles();
  const requestId = (session.fileRequest || 0) + 1; session.fileRequest = requestId;
  try {
    const result = await window.ssh.listFiles(session.id, directory || undefined);
    if (requestId !== session.fileRequest) return;
    session.directory = result.path; session.files = result.files; session.selected = null;
  } catch (error) { if (requestId === session.fileRequest) session.fileError = error.message; }
  finally { if (requestId === session.fileRequest) session.loading = false; if (session.id === activeId) renderFiles(); }
}
function renderFiles() {
  const session = active(); $('file-list').replaceChildren();
  for (const id of ['download-file', 'rename-file', 'delete-file']) $(id).disabled = !session?.ready || !session?.selected || session.loading;
  if (!session) return;
  if (document.activeElement !== $('remote-path')) $('remote-path').value = session.directory;
  $('file-empty').textContent = session.fileError || (session.loading ? 'Loading…' : !session.ready ? 'Connect to browse remote files.' : '');
  if (session.loading || session.fileError || !session.ready) return;
  const query = $('file-search').value.toLowerCase();
  const files = session.files.filter(f => f.name.toLowerCase().includes(query)).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  if (!files.length) $('file-empty').textContent = query ? 'No matching files.' : 'This folder is empty.';
  for (const file of files) {
    const row = element('tr', null, file.name === session.selected?.name ? 'selected' : '');
    row.append(element('td', `${file.directory ? '▸ ' : file.symlink ? '↗ ' : ''}${file.name}`), element('td', file.directory ? '—' : formatSize(file.size)), element('td', new Date(file.modified * 1000).toLocaleDateString()));
    row.onclick = () => { session.selected = file; renderFiles(); };
    row.ondblclick = () => attempt(async () => {
      const fullPath = session.directory.replace(/\/$/, '') + '/' + file.name;
      if (file.directory || file.symlink) {
        // SFTP resolves links when navigating; transfers deliberately refuse symlinks.
        await loadFiles(session, fullPath);
      } else await window.ssh.download(session.id, fullPath);
    });
    $('file-list').append(row);
  }
}
function selectedPath() { const session = active(); if (!session?.selected) throw new Error('Select a remote file or folder first.'); return session.directory.replace(/\/$/, '') + '/' + session.selected.name; }
$('path-form').onsubmit = event => { event.preventDefault(); attempt(() => loadFiles(active(), $('remote-path').value)); };
$('parent-folder').onclick = () => attempt(() => { const session = active(); return loadFiles(session, session.directory.replace(/\/[^/]+\/?$/, '') || '/'); });
$('refresh-files').onclick = () => attempt(() => loadFiles());
$('file-search').oninput = renderFiles;
$('upload-files').onclick = () => attempt(() => window.ssh.upload(activeId, active().directory, 'files'));
$('upload-folder').onclick = () => attempt(() => window.ssh.upload(activeId, active().directory, 'folder'));
$('new-folder').onclick = () => attempt(async () => { const session = active(); const answer = await prompt({ title: 'New remote folder', label: 'Folder name' }); if (!answer) return; await window.ssh.mkdir(session.id, session.directory, answer.value); await loadFiles(session); });
$('download-file').onclick = () => attempt(() => window.ssh.download(activeId, selectedPath()));
$('rename-file').onclick = () => attempt(async () => { const session = active(), target = selectedPath(); const answer = await prompt({ title: 'Rename remote item', label: 'New name', value: session.selected.name }); if (!answer) return; await window.ssh.rename(session.id, target, answer.value); await loadFiles(session); });
$('delete-file').onclick = () => attempt(async () => { const session = active(); if (await window.ssh.deleteRemote(session.id, selectedPath())) await loadFiles(session); });
$('files-panel').ondragover = event => { event.preventDefault(); if (active()?.ready) $('files-panel').classList.add('dragover'); };
$('files-panel').ondragleave = () => $('files-panel').classList.remove('dragover');
$('files-panel').ondrop = event => { event.preventDefault(); $('files-panel').classList.remove('dragover'); if (!active()?.ready) return; const paths = [...event.dataTransfer.files].map(file => window.ssh.filePath(file)); if (paths.length) attempt(() => window.ssh.upload(activeId, active().directory, 'files', paths)); };
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());

function prompt(question) { return new Promise(resolve => { promptQueue.push({ question, resolve }); nextPrompt(); }); }
function nextPrompt() {
  if (currentPrompt || !promptQueue.length) return;
  currentPrompt = promptQueue.shift(); const { question } = currentPrompt;
  $('prompt-title').textContent = question.title; $('prompt-label').textContent = question.label;
  $('prompt-value').type = question.secret ? 'password' : 'text'; $('prompt-value').value = question.value || '';
  $('prompt-save-label').hidden = !question.canSave; $('prompt-save').checked = false;
  $('prompt-dialog').showModal(); $('prompt-value').focus(); $('prompt-value').select();
}
function finishPrompt(answer) { if (!currentPrompt) return; const pending = currentPrompt; currentPrompt = null; $('prompt-value').value = ''; $('prompt-dialog').close(); pending.resolve(answer); nextPrompt(); }
$('prompt-form').onsubmit = event => { event.preventDefault(); finishPrompt({ value: $('prompt-value').value, save: $('prompt-save').checked }); };
$('prompt-cancel').onclick = () => finishPrompt(null);
$('prompt-dialog').addEventListener('cancel', event => { event.preventDefault(); finishPrompt(null); });
window.ssh.onCredential(question => { prompt(question).then(answer => window.ssh.answer(question.id, answer)).catch(error => notice(error.message, true)); });
window.ssh.onCredentialExpired(id => {
  if (currentPrompt?.question.id === id) finishPrompt(null);
  const index = promptQueue.findIndex(p => p.question.id === id); if (index !== -1) { promptQueue[index].resolve(null); promptQueue.splice(index, 1); }
});

window.ssh.onTransfer(job => {
  jobs.set(job.id, job); renderTransfers();
  if (job.status === 'complete') { const session = sessions.get(job.sessionId); if (session?.ready) attempt(() => loadFiles(session)); }
});
function renderTransfers() {
  $('transfer-list').replaceChildren();
  if (!jobs.size) $('transfer-list').append(element('span', 'No transfers yet.', 'muted'));
  for (const job of [...jobs.values()].reverse()) {
    const item = element('div', null, 'transfer-item'), info = element('div', null, 'transfer-info');
    info.append(element('span', `${job.name} · ${job.status}`));
    info.append(element('small', job.error || `${formatSize(job.bytes)} / ${formatSize(job.total)} · ${job.files} file${job.files === 1 ? '' : 's'}`));
    const bar = element('progress'); bar.max = job.total || 1; bar.value = job.status === 'complete' ? bar.max : job.bytes; info.append(bar); item.append(info);
    if (job.status === 'running' || job.status === 'queued') item.append(action('Cancel', () => window.ssh.cancelTransfer(job.id)));
    $('transfer-list').append(item);
  }
}
$('clear-transfers').onclick = () => { for (const [id, job] of jobs) if (job.status !== 'running' && job.status !== 'queued') jobs.delete(id); renderTransfers(); };

function renderCommands() {
  $('command-list').replaceChildren();
  commands.forEach((command, index) => {
    const row = element('div', null, 'command-row'); row.append(element('strong', command.name), element('code', command.command));
    const run = action('Run', async () => { if (!active()?.ready) throw new Error('Connect a terminal first.'); await window.ssh.input(activeId, command.command.replace(/\n/g, '\r') + '\r'); $('commands-dialog').close(); active().term.focus(); }, 'primary'); run.disabled = !active()?.ready;
    row.append(run, action('Edit', () => { $('command-name').value = command.name; $('command-text').value = command.command; $('command-form').dataset.editIndex = String(index); $('command-name').focus(); }), action('Delete', async () => { commands = await window.ssh.saveCommands(commands.filter((_, i) => i !== index)); renderCommands(); })); $('command-list').append(row);
  });
}
$('commands-button').onclick = () => { renderCommands(); $('commands-dialog').showModal(); };
$('close-commands').onclick = () => $('commands-dialog').close();
$('command-form').onsubmit = event => {
  event.preventDefault(); attempt(async () => {
    const command = { name: $('command-name').value, command: $('command-text').value }, updated = [...commands];
    if (event.target.dataset.editIndex !== undefined) updated[Number(event.target.dataset.editIndex)] = command; else updated.push(command);
    commands = await window.ssh.saveCommands(updated); event.target.reset(); delete event.target.dataset.editIndex; renderCommands();
  });
};
$('settings-button').onclick = () => $('settings-dialog').showModal();
$('close-settings').onclick = () => $('settings-dialog').close();
$('export-backup').onclick = () => attempt(async () => { if (await window.ssh.exportBackup()) notice('Backup exported. Passwords and keys are excluded.'); });
$('import-backup').onclick = () => attempt(async () => { const result = await window.ssh.importBackup(); if (result) { servers = result.servers; commands = result.commands; renderServers(); notice('Backup imported.'); } });
$('forget-hosts').onclick = () => attempt(async () => { if (await window.ssh.forgetHosts()) notice('Saved fingerprints cleared.'); });
document.addEventListener('keydown', event => {
  if (!event.metaKey || document.querySelector('dialog[open]')) return;
  if (event.key === 'k') { event.preventDefault(); $('server-search').focus(); }
  if (event.key === 'n') { event.preventDefault(); attempt(() => editServer()); }
  if (event.key === 'w' && activeId) { event.preventDefault(); attempt(() => closeTab(activeId)); }
});
attempt(async () => { const state = await window.ssh.state(); servers = state.servers; commands = state.commands; $('keychain-status').textContent = state.encrypted ? 'Passwords protected by macOS Keychain' : 'Keychain unavailable — saved passwords disabled'; renderServers(); });
