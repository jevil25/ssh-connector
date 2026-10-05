const { Client, utils } = require('ssh2');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { StringDecoder } = require('node:string_decoder');
const exec = promisify(execFile);

const expandHome = value => value?.replace(/^~(?=\/|$)/, os.homedir()).replace(/%d/g, os.homedir()).replace(/%u/g, os.userInfo().username);
const fingerprint = key => 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
function parseConfig(text) {
  const cfg = { identityfile: [], userknownhostsfile: [] };
  for (const line of text.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space), value = line.slice(space + 1).trim();
    if (key === 'identityfile') cfg.identityfile.push(value);
    else if (key === 'userknownhostsfile') cfg.userknownhostsfile.push(...value.split(/\s+/));
    else cfg[key] = value;
  }
  return cfg;
}
async function resolveConfig(server) {
  const args = ['-G'];
  if (server.username) args.push('-l', server.username);
  if (server.port) args.push('-p', String(server.port));
  if (server.keyPath) args.push('-i', expandHome(server.keyPath));
  if (server.jumpHost) args.push('-J', server.jumpHost);
  args.push('--', server.host);
  const { stdout } = await exec('/usr/bin/ssh', args, { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  const cfg = parseConfig(stdout);
  if (!cfg.hostname || !cfg.user) throw new Error('Could not resolve SSH connection settings.');
  cfg.port = Number(cfg.port || 22);
  cfg.identityfile = [...new Set([server.keyPath, ...cfg.identityfile].filter(Boolean).map(expandHome))];
  let agent = cfg.identityagent;
  if (!agent || agent === 'SSH_AUTH_SOCK') {
    agent = process.env.SSH_AUTH_SOCK;
    if (!agent) {
      try { agent = (await exec('/bin/launchctl', ['getenv', 'SSH_AUTH_SOCK'])).stdout.trim(); } catch {}
    }
  }
  cfg.agent = agent && agent !== 'none' ? expandHome(agent) : undefined;
  return cfg;
}

async function discoverAliases(file = path.join(os.homedir(), '.ssh/config'), seen = new Set()) {
  if (seen.has(file) || seen.size > 100 || !fs.existsSync(file)) return [];
  seen.add(file);
  const aliases = [];
  const text = await fsp.readFile(file, 'utf8');
  for (const line of text.split('\n')) {
    const tokens = line.trim().replace(/\s+#.*$/, '').match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(s => s.replace(/^["']|["']$/g, '')) || [];
    if (tokens[0]?.toLowerCase() === 'host') aliases.push(...tokens.slice(1).filter(s => /^[a-zA-Z0-9_.:-]+$/.test(s) && !s.startsWith('-')));
    if (tokens[0]?.toLowerCase() === 'include') {
      for (const token of tokens.slice(1)) {
        const pattern = path.isAbsolute(expandHome(token)) ? expandHome(token) : path.join(os.homedir(), '.ssh', token);
        const files = fs.globSync ? [...fs.globSync(pattern)] : [pattern];
        for (const included of files) aliases.push(...await discoverAliases(included, seen));
      }
    }
  }
  return [...new Set(aliases)];
}

class SSHConnection {
  constructor({ store, server, ask, confirmHost, emit }) {
    Object.assign(this, { store, server, ask, confirmHost, emit });
    this.clients = [];
    this.closed = false;
  }
  async verify(cfg, key) {
    const host = cfg.port === 22 ? cfg.hostname : `[${cfg.hostname}]:${cfg.port}`;
    const encoded = key.toString('base64');
    const trusted = this.store.data.trustedHosts[host];
    if (trusted) {
      if (trusted !== encoded) throw new Error(`Host key changed for ${host}. Connection blocked.\nSaved fingerprint: ${fingerprint(Buffer.from(trusted, 'base64'))}\nPresented fingerprint: ${fingerprint(key)}\nVerify the new fingerprint through your provider’s console before changing saved trust.`);
      return true;
    }
    let known = [], revoked = [];
    for (const file of [...cfg.userknownhostsfile, '/etc/ssh/ssh_known_hosts'].map(expandHome)) {
      if (!fs.existsSync(file)) continue;
      try {
        const { stdout } = await exec('/usr/bin/ssh-keygen', ['-F', host, '-f', file]);
        for (const line of stdout.split('\n').filter(s => s && !s.startsWith('#'))) {
          const fields = line.split(/\s+/);
          if (fields[0] === '@revoked') revoked.push(fields[3]);
          else if (fields[0] !== '@cert-authority') known.push(fields[2]);
        }
      } catch (error) { if (error.code !== 1) throw error; }
    }
    if (revoked.includes(encoded)) throw new Error(`The host key for ${host} has been revoked.`);
    if (known.includes(encoded)) return true;
    if (known.length) throw new Error(`Host key does not match your known_hosts entry for ${host}. Connection blocked.\nPresented fingerprint: ${fingerprint(key)}\nSaved fingerprints:\n${known.map(k => fingerprint(Buffer.from(k, 'base64'))).join('\n')}\nIf the server was rebuilt, verify the new fingerprint through your provider’s console before replacing its known_hosts entries.`);
    if (!await this.confirmHost(host, fingerprint(key))) return false;
    this.store.trust(host, encoded);
    return true;
  }
  async connectOne(server, cfg, sock) {
    const client = new Client();
    this.clients.push(client);
    let password = server.id ? this.store.password(server.id) : undefined;
    let passwordTries = 0, keyIndex = 0, agentTried = false, noneTried = false;
    const request = async (methods, _partial, callback) => {
      try {
        if (this.closed) return callback(false);
        if (!noneTried) { noneTried = true; return callback({ type: 'none', username: cfg.user }); }
        if (password && passwordTries === 0 && (!methods || methods.includes('password'))) {
          passwordTries++;
          return callback({ type: 'password', username: cfg.user, password });
        }
        if ((!methods || methods.includes('publickey')) && cfg.agent && cfg.identitiesonly !== 'yes' && !agentTried) {
          agentTried = true;
          return callback({ type: 'agent', username: cfg.user, agent: cfg.agent });
        }
        if (!methods || methods.includes('publickey')) {
          while (keyIndex < cfg.identityfile.length) {
            const filename = cfg.identityfile[keyIndex++];
            if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) continue;
            const privateKey = await fsp.readFile(filename);
            let parsed = utils.parseKey(privateKey);
            let passphrase;
            if (parsed instanceof Error && /encrypt|passphrase/i.test(parsed.message)) {
              const answer = await this.ask({ title: `Unlock SSH key for ${server.name || cfg.hostname}`, label: `Passphrase for ${filename}`, secret: true });
              if (!answer) continue;
              passphrase = answer.value;
              parsed = utils.parseKey(privateKey, passphrase);
            }
            if (parsed instanceof Error) continue;
            return callback({ type: 'publickey', username: cfg.user, key: privateKey, passphrase });
          }
        }
        if ((!methods || methods.includes('password')) && passwordTries < 3) {
          if (!password || passwordTries > 0) {
            const answer = await this.ask({ title: `Sign in to ${server.name || cfg.hostname}`, label: `Password for ${cfg.user}@${cfg.hostname}`, secret: true, canSave: Boolean(server.id) });
            if (!answer) return callback(false);
            password = answer.value;
            if (answer.save && server.id) this.store.save({ ...server, password });
          }
          passwordTries++;
          return callback({ type: 'password', username: cfg.user, password });
        }
        if (methods?.includes('keyboard-interactive') && passwordTries < 4) {
          passwordTries++;
          return callback({ type: 'keyboard-interactive', username: cfg.user, prompt: async (_name, instructions, _lang, prompts, finish) => {
            try {
              const answers = [];
              for (const prompt of prompts) {
                if (password && /password/i.test(prompt.prompt)) { answers.push(password); password = undefined; }
                else {
                  const answer = await this.ask({ title: `Authentication: ${cfg.hostname}`, label: instructions + '\n' + prompt.prompt, secret: !prompt.echo });
                  if (!answer) { finish(prompts.map(() => '')); client.end(); return; }
                  answers.push(answer.value);
                }
              }
              finish(answers);
            } catch { finish(prompts.map(() => '')); }
          } });
        }
        callback(false);
      } catch (error) { this.emit('error', error.message); callback(false); }
    };
    let authenticated = false;
    let verificationError;
    await new Promise((resolve, reject) => {
      client.once('ready', () => { authenticated = true; resolve(); });
      client.once('error', error => reject(verificationError || error));
      client.once('close', () => reject(new Error('Connection closed before authentication completed.')));
      client.on('error', error => { if (authenticated) this.emit('error', error.message); });
      client.connect({ host: cfg.hostname, port: cfg.port, username: cfg.user, sock,
        readyTimeout: 180000, keepaliveInterval: 15000, keepaliveCountMax: 3,
        authHandler: (...args) => { void request(...args); },
        hostVerifier: (key, callback) => { this.verify(cfg, key).then(callback).catch(error => { verificationError = error; callback(false); }); }
      });
    });
    return client;
  }
  async open() {
    const cfg = await resolveConfig(this.server);
    if (cfg.proxycommand && cfg.proxycommand !== 'none') throw new Error('This SSH profile uses ProxyCommand. Use ProxyJump or enter a jump host in the server settings.');
    const hops = cfg.proxyjump && cfg.proxyjump !== 'none' ? cfg.proxyjump.split(',') : [];
    if (hops.length > 8) throw new Error('Too many jump hosts (maximum 8).');
    let prior;
    for (const hop of hops) {
      const match = hop.match(/^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
      if (!match) throw new Error(`Invalid jump host: ${hop}`);
      const host = match[2].replace(/^\[|\]$/g, '');
      const saved = this.store.data.servers.find(s => s.host === host && (!match[1] || s.username === match[1]));
      const server = { ...saved, name: saved?.name || host, host, username: match[1] || saved?.username, port: match[3] ? Number(match[3]) : saved?.port };
      const hopConfig = await resolveConfig(server);
      if (hopConfig.proxycommand && hopConfig.proxycommand !== 'none') throw new Error('ProxyCommand jump hosts are unsupported; use ProxyJump.');
      const sock = prior ? await this.forward(prior, hopConfig) : undefined;
      prior = await this.connectOne(server, hopConfig, sock);
    }
    this.client = await this.connectOne(this.server, cfg, prior ? await this.forward(prior, cfg) : undefined);
    this.client.on('close', () => { this.close(); this.emit('closed', 'Connection closed'); });
    this.shell = await new Promise((resolve, reject) => this.client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (e, shell) => e ? reject(e) : resolve(shell)));
    const output = new StringDecoder('utf8'), errors = new StringDecoder('utf8');
    this.shell.on('data', data => this.emit('terminal', output.write(data)));
    this.shell.stderr.on('data', data => this.emit('terminal', errors.write(data)));
    this.shell.on('close', () => { this.close(); this.emit('closed', 'Shell exited'); });
    return { host: cfg.hostname, username: cfg.user, port: cfg.port };
  }
  forward(client, cfg) { return new Promise((resolve, reject) => client.forwardOut('127.0.0.1', 0, cfg.hostname, cfg.port, (e, sock) => e ? reject(e) : resolve(sock))); }
  async getSftp() {
    if (this.closed || !this.client) throw new Error('Connect to the server first.');
    if (!this.sftpPromise) this.sftpPromise = new Promise((resolve, reject) => this.client.sftp((e, sftp) => e ? reject(e) : resolve(sftp))).catch(error => { this.sftpPromise = undefined; throw error; });
    return this.sftpPromise;
  }
  async call(method, ...args) { const sftp = await this.getSftp(); return new Promise((resolve, reject) => sftp[method](...args, (e, result) => e ? reject(e) : resolve(result))); }
  input(data) { if (!this.shell || this.closed) throw new Error('Terminal is disconnected.'); this.shell.write(data); }
  resize(cols, rows) { if (this.shell && !this.closed) this.shell.setWindow(rows, cols, 0, 0); }
  close() { if (this.closed) return; this.closed = true; for (const client of [...this.clients].reverse()) client.end(); }
  async list(directory) {
    const resolved = await this.call('realpath', directory || '.');
    const files = await this.call('readdir', resolved);
    return { path: resolved, files: files.map(f => ({ name: f.filename, directory: f.attrs.isDirectory(), symlink: f.attrs.isSymbolicLink(), size: f.attrs.size, modified: f.attrs.mtime, mode: f.attrs.mode })) };
  }
  async exists(remote) {
    try { return await this.call('lstat', remote); } catch (error) { if (error.code === 2) return null; throw error; }
  }
}

async function walkLocal(source) {
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links are skipped for safety: ${source}`);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Unsupported file: ${source}`);
  if (!stat.isDirectory()) return [{ local: source, relative: '', size: stat.size, mode: stat.mode & 0o777, directory: false }];
  const result = [{ local: source, relative: '', directory: true }];
  async function walk(directory, relative) {
    for (const name of await fsp.readdir(directory)) {
      const local = path.join(directory, name), rel = path.posix.join(relative, name);
      const stat = await fsp.lstat(local);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are skipped for safety: ${local}`);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Unsupported file: ${local}`);
      result.push({ local, relative: rel, directory: stat.isDirectory(), size: stat.size, mode: stat.mode & 0o777 });
      if (stat.isDirectory()) await walk(local, rel);
    }
  }
  await walk(source, '');
  return result;
}
function safeRemoteName(name) {
  if (!name || name === '.' || name === '..' || /[\/\\\0]/.test(name)) throw new Error('Enter a single file or folder name.');
  return name;
}
module.exports = { SSHConnection, resolveConfig, parseConfig, discoverAliases, expandHome, fingerprint, walkLocal, safeRemoteName };
