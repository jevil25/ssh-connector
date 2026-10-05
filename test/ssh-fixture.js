const { Server, utils } = require('ssh2');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { STATUS_CODE, flagsToString } = utils.sftp;

async function startFixture(root, keyPair) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const publicKey = keyPair ? (typeof keyPair.getPublicSSH === 'function' ? keyPair : utils.parseKey(keyPair)).getPublicSSH() : null;
  const clients = new Set();
  const server = new Server({ hostKeys: [privateKey] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.password === 'test-password') return ctx.accept();
      if (ctx.method === 'publickey' && publicKey && ctx.key.data.equals(publicKey)) {
        if (!ctx.signature || utils.parseKey(ctx.key.data).verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.accept();
      }
      ctx.reject(['publickey', 'password', 'keyboard-interactive']);
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1') return reject();
        const socket = net.connect(info.destPort, info.destIP, () => { const stream = accept(); stream.pipe(socket).pipe(stream); });
        socket.on('error', () => { try { reject(); } catch {} });
      });
      client.on('session', accept => {
        const session = accept(); session.on('pty', accept => accept()); session.on('window-change', accept => accept?.());
        session.on('shell', accept => {
          const stream = accept(), child = spawn('/bin/sh', [], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
          stream.on('data', data => child.stdin.write(data.toString().replace(/\r/g, '\n'))); child.stdout.pipe(stream); child.stderr.on('data', data => stream.stderr.write(data));
          child.on('exit', code => { stream.exit(code || 0); stream.end(); }); stream.on('close', () => child.kill());
        });
        session.on('sftp', accept => installSftp(accept(), root));
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, privateKey, close: async () => { for (const c of clients) { c.end(); c._sock?.destroy(); } await new Promise(resolve => server.close(resolve)); } };
}
function installSftp(sftp, root) {
  let next = 0; const handles = new Map();
  const local = remote => {
    const resolved = path.resolve(root, '.' + (remote.startsWith('/') ? remote : '/' + remote));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Invalid path');
    return resolved;
  };
  const attrs = stat => ({ mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
  const status = (id, error) => sftp.status(id, error ? error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : error.code === 'EACCES' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE : STATUS_CODE.OK);
  const wrap = handler => (id, ...args) => { try { handler(id, ...args); } catch (e) { status(id, e); } };
  const makeHandle = object => { const handle = Buffer.alloc(4); handle.writeUInt32BE(++next); handles.set(handle.toString('hex'), object); return handle; };
  const get = handle => { const object = handles.get(handle.toString('hex')); if (!object) throw new Error('Invalid handle'); return object; };
  sftp.on('REALPATH', wrap((id, remote) => sftp.name(id, [{ filename: remote === '.' ? '/' : path.posix.resolve('/', remote), longname: '', attrs: {} }])));
  for (const event of ['STAT', 'LSTAT']) sftp.on(event, wrap((id, remote) => { const stat = (event === 'STAT' ? fs.statSync : fs.lstatSync)(local(remote)); sftp.attrs(id, attrs(stat)); }));
  sftp.on('FSTAT', wrap((id, handle) => sftp.attrs(id, attrs(fs.fstatSync(get(handle).fd)))));
  sftp.on('OPENDIR', wrap((id, remote) => { const directory = local(remote); const entries = fs.readdirSync(directory).map(name => ({ filename: name, longname: name, attrs: attrs(fs.lstatSync(path.join(directory, name))) })); sftp.handle(id, makeHandle({ entries, read: false })); }));
  sftp.on('READDIR', wrap((id, handle) => { const object = get(handle); if (object.read || !object.entries.length) sftp.status(id, STATUS_CODE.EOF); else { object.read = true; sftp.name(id, object.entries); } }));
  sftp.on('OPEN', wrap((id, remote, flags, attributes) => { const fd = fs.openSync(local(remote), flagsToString(flags), attributes.mode || 0o600); sftp.handle(id, makeHandle({ fd })); }));
  sftp.on('READ', wrap((id, handle, offset, length) => { const buffer = Buffer.alloc(length); const bytes = fs.readSync(get(handle).fd, buffer, 0, length, offset); if (bytes) sftp.data(id, buffer.subarray(0, bytes)); else sftp.status(id, STATUS_CODE.EOF); }));
  sftp.on('WRITE', wrap((id, handle, offset, data) => { fs.writeSync(get(handle).fd, data, 0, data.length, offset); status(id); }));
  sftp.on('CLOSE', wrap((id, handle) => { const object = get(handle); if (object.fd !== undefined) fs.closeSync(object.fd); handles.delete(handle.toString('hex')); status(id); }));
  sftp.on('MKDIR', wrap((id, remote, attributes) => { fs.mkdirSync(local(remote), { mode: attributes.mode || 0o755 }); status(id); }));
  sftp.on('SETSTAT', wrap((id, remote, attributes) => { if (attributes.mode !== undefined) fs.chmodSync(local(remote), attributes.mode); status(id); }));
  sftp.on('RMDIR', wrap((id, remote) => { fs.rmdirSync(local(remote)); status(id); }));
  sftp.on('REMOVE', wrap((id, remote) => { fs.unlinkSync(local(remote)); status(id); }));
  sftp.on('RENAME', wrap((id, from, to) => { if (fs.existsSync(local(to))) throw new Error('Destination exists'); fs.renameSync(local(from), local(to)); status(id); }));
  sftp.on('EXTENDED', wrap((id, name, ...args) => {
    if (name !== 'posix-rename@openssh.com') return sftp.status(id, STATUS_CODE.OP_UNSUPPORTED);
    // ssh2 exposes extension payload as raw bytes on the server.
    const data = args[0]; let cursor = 0;
    const string = () => { const length = data.readUInt32BE(cursor); cursor += 4; const value = data.subarray(cursor, cursor + length).toString(); cursor += length; return value; };
    fs.renameSync(local(string()), local(string())); status(id);
  }));
  sftp.on('end', () => { for (const handle of handles.values()) if (handle.fd !== undefined) { try { fs.closeSync(handle.fd); } catch {} } });
}
module.exports = { startFixture };
