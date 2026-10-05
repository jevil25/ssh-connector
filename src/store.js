const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function validateServer(input) {
  const clean = {};
  for (const key of ['name', 'host', 'username', 'group', 'keyPath', 'jumpHost', 'notes']) {
    clean[key] = String(input[key] || '').trim();
    if (clean[key].length > 10000 || /[\r\n\0]/.test(clean[key])) throw new Error(`Invalid ${key}`);
  }
  if (!clean.name || !clean.host) throw new Error('A name and hostname/IP are required.');
  if (!/^[a-zA-Z0-9_.:\-]+$/.test(clean.host) || clean.host.startsWith('-')) throw new Error('Enter a hostname, SSH alias, or IP address.');
  clean.port = input.port === '' || input.port == null ? null : Number(input.port);
  if (clean.port !== null && (!Number.isInteger(clean.port) || clean.port < 1 || clean.port > 65535)) throw new Error('Port must be between 1 and 65535.');
  clean.id = typeof input.id === 'string' && /^[\w-]+$/.test(input.id) ? input.id : crypto.randomUUID();
  return clean;
}

class Store {
  constructor(directory, encryption) {
    this.file = path.join(directory, 'servers.json');
    this.encryption = encryption;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, servers: [], commands: [], trustedHosts: {} };
    if (this.data.version !== 1 || !Array.isArray(this.data.servers)) throw new Error('Unsupported or damaged server database.');
    this.data.commands ||= [];
    this.data.trustedHosts ||= {};
  }
  persist() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    fs.chmodSync(this.file, 0o600);
  }
  list() { return this.data.servers.map(({ secret, ...server }) => ({ ...server, hasPassword: Boolean(secret) })); }
  get(id) {
    const server = this.data.servers.find(s => s.id === id);
    if (!server) throw new Error('Server no longer exists.');
    return server;
  }
  password(id) {
    const secret = this.get(id).secret;
    return secret ? this.encryption.decryptString(Buffer.from(secret, 'base64')) : undefined;
  }
  save(input) {
    const server = validateServer(input);
    const old = this.data.servers.find(s => s.id === server.id);
    if (old?.secret) server.secret = old.secret;
    if (input.clearPassword) delete server.secret;
    if (typeof input.password === 'string' && input.password) {
      if (!this.encryption.isEncryptionAvailable()) throw new Error('Keychain encryption is unavailable. Password was not saved.');
      server.secret = this.encryption.encryptString(input.password).toString('base64');
    }
    const index = this.data.servers.findIndex(s => s.id === server.id);
    if (index === -1) this.data.servers.push(server); else this.data.servers[index] = server;
    this.persist();
    return this.list();
  }
  remove(id) { this.data.servers = this.data.servers.filter(s => s.id !== id); this.persist(); return this.list(); }
  export() { return { version: 1, servers: this.list().map(({ hasPassword, ...s }) => s), commands: this.data.commands }; }
  import(input) {
    if (input.version !== 1 || !Array.isArray(input.servers)) throw new Error('Invalid SSH Connector backup.');
    const servers = input.servers.map(validateServer);
    const commands = validateCommands(input.commands || []);
    for (const server of servers) {
      server.id = crypto.randomUUID();
      if (!this.data.servers.some(s => s.host === server.host && s.username === server.username && s.port === server.port)) this.data.servers.push(server);
    }
    for (const command of commands) if (!this.data.commands.some(c => c.name === command.name && c.command === command.command)) this.data.commands.push(command);
    this.persist();
    return this.list();
  }
  trust(host, key) { this.data.trustedHosts[host] = key; this.persist(); }
  saveCommands(commands) { this.data.commands = validateCommands(commands); this.persist(); return this.data.commands; }
}
function validateCommands(commands) {
  if (!Array.isArray(commands) || commands.length > 500) throw new Error('Invalid saved commands.');
  return commands.map(c => {
    if (typeof c.name !== 'string' || !c.name.trim() || typeof c.command !== 'string' || !c.command.trim() || c.command.length > 10000) throw new Error('Each command needs a name and command text.');
    return { name: c.name.trim().slice(0, 100), command: c.command };
  });
}
module.exports = { Store, validateServer, validateCommands };
