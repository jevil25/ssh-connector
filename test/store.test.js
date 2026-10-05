const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, validateServer } = require('../src/store');
const { parseConfig, safeRemoteName, walkLocal } = require('../src/ssh');
const encryption = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(`sealed:${s}`), decryptString: b => b.toString().slice(7) };
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-store-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return { dir, store: new Store(dir, encryption) }; }
test('passwords survive restart and editing, are excluded from the UI and exports, and can be cleared', t => {
  const { store, dir } = fixture(t);
  store.save({ name: 'Test', host: '127.0.0.1', password: 'secret-test-password' });
  const server = store.list()[0]; assert.equal(server.hasPassword, true); assert.equal(server.secret, undefined); assert.equal(store.password(server.id), 'secret-test-password');
  assert.equal(JSON.stringify(store.export()).includes('secret-test-password'), false);
  assert.equal(fs.readFileSync(store.file, 'utf8').includes('secret-test-password'), false);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  store.save({ ...server, name: 'Renamed', password: '' });
  const restarted = new Store(dir, encryption); assert.equal(restarted.password(server.id), 'secret-test-password');
  restarted.save({ ...server, clearPassword: true }); assert.equal(restarted.password(server.id), undefined);
});
test('backup imports merge without replacing passwords and invalid backups are atomic', t => {
  const { store } = fixture(t); store.save({ name: 'Original', host: 'example.com', password: 'keep' });
  const before = store.list()[0];
  store.import({ version: 1, servers: [{ name: 'Replacement', host: 'example.com', secret: 'injected' }] });
  assert.equal(store.list().length, 1); assert.equal(store.list()[0].name, 'Original'); assert.equal(store.password(before.id), 'keep');
  assert.throws(() => store.import({ version: 1, servers: [{ name: 'Valid', host: 'valid.com' }, { name: 'Invalid', host: '-bad' }] }));
  assert.equal(store.list().length, 1);
  store.remove(before.id); assert.equal(store.list().length, 0);
});
test('unavailable encryption never saves a plaintext password', t => {
  const { dir } = fixture(t); const store = new Store(dir, { isEncryptionAvailable: () => false });
  assert.throws(() => store.save({ name: 'x', host: 'localhost', password: 'password' }), /unavailable/); assert.equal(store.list().length, 0);
});
test('server and remote filenames reject argument injection, traversal and invalid ports', () => {
  for (const host of ['-oProxyCommand=bad', 'host\ncommand', 'host name']) assert.throws(() => validateServer({ name: 'x', host }));
  for (const port of [0, 65536, 1.5, 'bad']) assert.throws(() => validateServer({ name: 'x', host: 'localhost', port }));
  for (const name of ['..', '.', '/etc/passwd', 'a/b', 'a\\b', 'x\0y']) assert.throws(() => safeRemoteName(name));
  assert.equal(safeRemoteName('file with spaces.txt'), 'file with spaces.txt');
});
test('SSH configuration preserves multiple identities and known_hosts paths', () => {
  const cfg = parseConfig('hostname example.com\nuser root\nport 2222\nidentityfile ~/.ssh/key1\nidentityfile ~/.ssh/key2\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\nproxyjump bastion\n');
  assert.deepEqual(cfg.identityfile, ['~/.ssh/key1', '~/.ssh/key2']); assert.equal(cfg.proxyjump, 'bastion'); assert.equal(cfg.userknownhostsfile.length, 2);
});
test('recursive uploads include empty folders and reject symbolic links', async t => {
  const { dir } = fixture(t); const source = path.join(dir, 'upload'); fs.mkdirSync(path.join(source, 'empty'), { recursive: true }); fs.writeFileSync(path.join(source, 'hello.txt'), 'hello');
  const items = await walkLocal(source); assert.equal(items.length, 3); assert.equal(items.find(i => i.relative === 'hello.txt').size, 5);
  fs.symlinkSync('/etc/hosts', path.join(source, 'link')); await assert.rejects(walkLocal(source), /Symbolic/);
});
