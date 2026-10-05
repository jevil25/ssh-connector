const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const exec = promisify(execFile);
const { Store } = require('../src/store');
const { SSHConnection } = require('../src/ssh');
const { startFixture } = require('./ssh-fixture');
const encryption = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };

test('real SSH password authentication, terminal, SFTP operations, reconnect and changed host rejection', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-connection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello remote');
  const fixture = await startFixture(root); t.after(() => fixture.close());
  const store = new Store(path.join(root, 'data'), encryption); store.save({ name: 'Test', host: '127.0.0.1', port: fixture.port, username: 'fixture', password: 'test-password' });
  let trusted = 0; let output = '';
  const options = { store, server: store.get(store.list()[0].id), ask: async () => { throw new Error('Saved password should work'); }, confirmHost: async () => { trusted++; return true; }, emit: (type, value) => { if (type === 'terminal') output += value; } };
  const conn = new SSHConnection(options); t.after(() => conn.close());
  await conn.open(); assert.equal(trusted, 1);
  conn.input("printf 'terminal-ok\\n'\r");
  await new Promise((resolve, reject) => { const deadline = Date.now() + 3000; const timer = setInterval(() => { if (output.includes('terminal-ok')) { clearInterval(timer); resolve(); } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Terminal output missing')); } }, 20); });
  const listing = await conn.list('.'); assert.equal(listing.path, '/'); assert(listing.files.some(f => f.name === 'hello.txt'));
  await conn.call('mkdir', '/new-directory'); await conn.call('rename', '/hello.txt', '/new-directory/renamed.txt');
  const sftp = await conn.getSftp(); const contents = await new Promise((resolve, reject) => sftp.readFile('/new-directory/renamed.txt', (e, data) => e ? reject(e) : resolve(data.toString()))); assert.equal(contents, 'hello remote');
  await conn.call('unlink', '/new-directory/renamed.txt'); await conn.call('rmdir', '/new-directory'); conn.close();
  const again = new SSHConnection(options); t.after(() => again.close()); await again.open(); assert.equal(trusted, 1); again.close();
  store.trust(`\[127.0.0.1\]:${fixture.port}`, Buffer.from('wrong-key').toString('base64'));
  const changed = new SSHConnection(options); t.after(() => changed.close()); await assert.rejects(changed.open(), /Host key changed[\s\S]*Presented fingerprint: SHA256:/); assert.equal(trusted, 1);
});

test('local private key authentication and password-protected jump host forwarding', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-key-jump-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyPath = path.join(root, 'id_ed25519'); await exec('/usr/bin/ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath]);
  const target = await startFixture(root, fs.readFileSync(keyPath)); const jump = await startFixture(root); t.after(() => target.close()); t.after(() => jump.close());
  const store = new Store(path.join(root, 'data'), encryption); store.save({ name: 'Jump', host: '127.0.0.1', port: jump.port, username: 'jump', password: 'test-password' });
  store.save({ name: 'Target', host: '127.0.0.1', port: target.port, username: 'target', keyPath, jumpHost: `jump@127.0.0.1:${jump.port}` });
  const conn = new SSHConnection({ store, server: store.get(store.list()[1].id), ask: async () => { throw new Error('Authentication should not ask for credentials'); }, confirmHost: async () => true, emit: () => {} });
  t.after(() => conn.close()); await conn.open(); assert.equal(conn.clients.length, 2); const list = await conn.list('/'); assert(list.files.some(f => f.name === 'id_ed25519.pub'));
});

test('encrypted local SSH key prompts for its passphrase', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-encrypted-key-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyPath = path.join(root, 'encrypted-key'); await exec('/usr/bin/ssh-keygen', ['-t', 'ed25519', '-N', 'test-passphrase', '-f', keyPath]);
  // The fixture uses an unencrypted copy solely to identify the accepted public key.
  const key = require('ssh2').utils.parseKey(fs.readFileSync(keyPath), 'test-passphrase');
  const fixture = await startFixture(root, key); t.after(() => fixture.close());
  const store = new Store(path.join(root, 'data'), encryption); store.save({ name: 'Encrypted key', host: '127.0.0.1', port: fixture.port, username: 'fixture', keyPath });
  let prompts = 0;
  const conn = new SSHConnection({ store, server: store.get(store.list()[0].id), ask: async question => { assert(question.label.includes(keyPath)); prompts++; return { value: 'test-passphrase' }; }, confirmHost: async () => true, emit: () => {} });
  t.after(() => conn.close()); await conn.open(); assert.equal(prompts, 1);
});

test('authentication can use a local SSH agent without copying private keys', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-agent-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyPath = path.join(root, 'agent-key'); await exec('/usr/bin/ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath]);
  const socket = path.join(root, 'agent.sock'); const { stdout } = await exec('/usr/bin/ssh-agent', ['-a', socket, '-s']);
  const pid = Number(stdout.match(/SSH_AGENT_PID=(\d+)/)[1]); t.after(() => { try { process.kill(pid); } catch {} });
  await exec('/usr/bin/ssh-add', [keyPath], { env: { ...process.env, SSH_AUTH_SOCK: socket } });
  const original = process.env.SSH_AUTH_SOCK; process.env.SSH_AUTH_SOCK = socket;
  t.after(() => { if (original === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = original; });
  const fixture = await startFixture(root, fs.readFileSync(keyPath)); t.after(() => fixture.close());
  const store = new Store(path.join(root, 'data'), encryption); store.save({ name: 'Agent', host: '127.0.0.1', port: fixture.port, username: 'fixture' });
  const conn = new SSHConnection({ store, server: store.get(store.list()[0].id), ask: async () => { throw new Error('Agent authentication must not prompt'); }, confirmHost: async () => true, emit: () => {} });
  t.after(() => conn.close()); await conn.open();
});
