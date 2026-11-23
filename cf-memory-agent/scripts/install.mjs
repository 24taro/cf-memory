// Installer for Claude Code (plugin, through the official `claude plugin` CLI)
// and Codex (a versioned package copy plus ~/.codex/hooks.json). It never edits
// trust or approval state: Codex asks the user to approve changed hooks in /hooks.
// Install keeps the 2 newest hooks.json backups and Codex package copies, and
// removes the legacy ~/.claude/hooks/cf-memory-recall.sh hook from Claude's
// settings.json (backed up first) once the plugin is installed, so recall is not
// injected twice. Uninstall removes only cf-memory's plugin, hooks and package
// copies; the Agent's own data (spool, health) stays.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentHome } from './client.mjs';
import { PLUGIN_VERSION } from './version.mjs';

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MARKETPLACE = 'cf-memory', PLUGIN = 'cf-memory-agent';
export const CODEX_APPROVAL = 'Codex: open /hooks in Codex once and approve the new "cf-memory agent" hooks. The installer never changes Codex trust or approval state.';
const STATUS = /^cf-memory agent \([A-Za-z]+\)$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const shellQuote = s => "'" + String(s).replace(/'/g, "'\"'\"'") + "'";

const KEEP = 2;

/**
 * Paths for a real install, or everything under `home` when --home is given.
 * The old CF_MEMORY_CODEX_CONFIG_DIR / CF_MEMORY_CODEX_HOOKS_FILE are no longer read
 * (Codex reads $CODEX_HOME/hooks.json): set to anything else, `error` says so
 * and install/uninstall refuse to run.
 */
export function installPaths({ home, env = process.env } = {}) {
  if (home) {
    const root = resolve(home);
    return { home: root, claudeDir: join(root, '.claude'), codexHome: join(root, '.codex'), hooksFile: join(root, '.codex', 'hooks.json'), agentHome: join(root, '.cf-memory', 'v3') };
  }
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex'), hooksFile = join(codexHome, 'hooks.json');
  const legacy = env.CF_MEMORY_CODEX_CONFIG_DIR && resolve(env.CF_MEMORY_CODEX_CONFIG_DIR) !== resolve(codexHome) || env.CF_MEMORY_CODEX_HOOKS_FILE && resolve(env.CF_MEMORY_CODEX_HOOKS_FILE) !== resolve(hooksFile);
  return {
    home: homedir(), claudeDir: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), codexHome, hooksFile, agentHome: agentHome(env),
    ...(legacy ? { error: 'CF_MEMORY_CODEX_CONFIG_DIR and CF_MEMORY_CODEX_HOOKS_FILE are no longer read (Codex reads ' + hooksFile + '); unset them, or set CODEX_HOME or pass --home' } : {}),
  };
}

const exists = path => lstat(path).then(() => true, () => false);
async function writeAtomic(path, bytes) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}

// ---- Legacy Claude recall hook -------------------------------------------------

// The hook the old setup put in ~/.claude/settings.json ($HOME/.claude/hooks/cf-memory-recall.sh).
const legacyRecall = handler => typeof handler?.command === 'string' && /(?:^|[\s'"=])(?:\$HOME|\$\{HOME\}|~|\/[^\s'"]*)\/\.claude\/hooks\/cf-memory-recall\.sh(?:$|[\s'"])/.test(handler.command);

// Only the groups and events this empties go; everything else (an empty
// "Notification": [] included) stays as it was.
export function withoutLegacyRecall(settings) {
  if (!settings?.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) return { settings, removed: 0 };
  const next = structuredClone(settings);
  let removed = 0;
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) continue;
    const before = removed;
    const kept = groups.flatMap(group => {
      if (!Array.isArray(group?.hooks)) return [group];
      const hooks = group.hooks.filter(handler => !legacyRecall(handler));
      if (hooks.length === group.hooks.length) return [group];
      removed += group.hooks.length - hooks.length;
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (removed === before) continue;
    if (kept.length) next.hooks[event] = kept; else delete next.hooks[event];
  }
  return { settings: next, removed };
}

// Plan (and with `write`, do) the legacy hook removal; the backup comes first.
// A symlinked settings.json (dotfile managers) is edited at its target, with
// the backup next to the target; a target that cannot be written is reported
// with what to remove by hand.
async function cleanLegacyRecall(paths, { write, now }) {
  const file = join(paths.claudeDir, 'settings.json');
  const target = (await lstat(file).catch(() => null))?.isSymbolicLink() ? await realpath(file).catch(() => null) : file;
  if (!target || !(await lstat(target).catch(() => null))?.isFile()) return { settings_file: file, legacy_recall_hooks: 0 };
  const where = { settings_file: file, ...(target !== file ? { target } : {}) };
  let current;
  try { current = JSON.parse(await readFile(target, 'utf8')); } catch { return { ...where, legacy_recall_hooks: 0, error: 'unreadable settings.json (left unchanged)' }; }
  const { settings, removed } = withoutLegacyRecall(current);
  if (!removed) return { ...where, legacy_recall_hooks: 0 };
  const backup = target + '.cf-memory-backup-' + now;
  if (write) {
    try {
      await writeFile(backup, await readFile(target), { mode: 0o600, flag: 'wx' });
      await writeAtomic(target, JSON.stringify(settings, null, 2) + '\n');
    } catch (error) {
      return { ...where, legacy_recall_hooks: removed, error: 'could not write ' + target + ' (' + (error.code || 'error') + '): remove the hooks running ~/.claude/hooks/cf-memory-recall.sh from it by hand' };
    }
  }
  return { ...where, legacy_recall_hooks: removed, backup };
}

/** Package files, relative paths sorted. Symlinks are refused. */
export async function packageFiles(root = PACKAGE_ROOT, dirs = ['.claude-plugin', 'hooks', 'scripts', 'skills'], single = ['plugin.json', 'README.md']) {
  const files = [];
  async function walk(dir) {
    for (const name of (await readdir(join(root, dir))).sort()) {
      const path = join(dir, name), info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw Error('symlink in Agent package: ' + path);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) files.push({ path, bytes: await readFile(join(root, path)) });
    }
  }
  for (const dir of dirs) if ((await lstat(join(root, dir)).catch(() => null))?.isDirectory()) await walk(dir);
  for (const name of single) if ((await lstat(join(root, name)).catch(() => null))?.isFile()) files.push({ path: name, bytes: await readFile(join(root, name)) });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export const fingerprint = files => sha256(JSON.stringify(files.map(file => [file.path, sha256(file.bytes)])));
const describe = (path, bytes) => ({ path, bytes: bytes.length, sha256: sha256(bytes) });

// ---- Claude Code --------------------------------------------------------------

export async function claudePlan(paths, { root = PACKAGE_ROOT, executable } = {}) {
  const marketplace = dirname(root);
  const manifest = JSON.parse(await readFile(join(marketplace, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const entry = manifest.plugins?.find(plugin => plugin.name === PLUGIN);
  if (manifest.name !== MARKETPLACE || !entry || resolve(marketplace, entry.source) !== resolve(root)) throw Error('marketplace manifest does not point at this package');
  const files = await packageFiles(root, ['.claude-plugin', 'hooks', 'scripts', 'skills'], ['plugin.json', 'README.md']);
  const cache = join(paths.claudeDir, 'plugins', 'cache', MARKETPLACE, PLUGIN, PLUGIN_VERSION);
  const cli = executable || process.env.CF_MEMORY_CLAUDE_BIN || 'claude';
  return {
    client: 'claude-code', version: PLUGIN_VERSION, marketplace: { name: MARKETPLACE, path: marketplace },
    commands: [
      { executable: cli, args: ['plugin', 'marketplace', 'add', marketplace] },
      { executable: cli, args: ['plugin', 'install', PLUGIN + '@' + MARKETPLACE, '--scope', 'user'] },
      { executable: cli, args: ['plugin', 'update', PLUGIN + '@' + MARKETPLACE, '--scope', 'user'] },
    ],
    // Written by the `claude plugin` commands (Claude Code's plugin cache), not by this installer.
    files: files.map(file => ({ ...describe(join(cache, file.path), file.bytes), written_by: 'claude plugin install/update' })),
    trust: 'No trust or permission settings are changed.',
  };
}

async function claudePluginRecords(claudeDir) {
  try {
    const installed = JSON.parse(await readFile(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'));
    const plugins = Object.hasOwn(installed, 'plugins') ? installed.plugins : installed;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return null;
    const name = PLUGIN + '@' + MARKETPLACE;
    const records = Object.hasOwn(plugins, name) ? plugins[name] : [];
    return Array.isArray(records) && records.every(record => record && typeof record === 'object') ? records : null;
  } catch (error) { return error.code === 'ENOENT' ? [] : null; }
}

export async function claudeInstalledVersion(claudeDir) {
  const records = await claudePluginRecords(claudeDir);
  return records?.find(record => record.scope === 'user')?.version ?? records?.[0]?.version ?? null;
}

async function claudeUserPlugin(claudeDir) {
  const records = await claudePluginRecords(claudeDir);
  if (!records?.every(record => typeof record.scope === 'string')) return undefined;
  return records.find(record => record.scope === 'user') ?? null;
}

async function installClaude(paths, options) {
  const plan = await claudePlan(paths, options), now = options.now ?? Date.now();
  if (options.dryRun) return { ...plan, dry_run: true, legacy: await cleanLegacyRecall(paths, { write: false, now }) };
  const env = { ...process.env, ...(options.home ? { HOME: paths.home, CLAUDE_CONFIG_DIR: paths.claudeDir } : {}) };
  const results = [];
  for (const command of plan.commands) {
    try {
      execFileSync(command.executable, command.args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, encoding: 'utf8' });
      results.push({ args: command.args, ok: true });
    } catch (error) {
      results.push({ args: command.args, ok: false, status: error.status ?? null });
    }
  }
  const plugin = await claudeUserPlugin(paths.claudeDir);
  const installed = plugin?.version ?? null;
  const registered = installed === PLUGIN_VERSION && results.some(result => result.ok && result.args[1] !== 'marketplace');
  // Only once the plugin (which recalls) is in place does the old hook go.
  const legacy = registered ? await cleanLegacyRecall(paths, { write: true, now }) : undefined;
  const next = plugin === undefined ? 'Could not verify the Claude Code plugin registry.' : !registered
    ? 'Could not install cf-memory-agent@cf-memory ' + PLUGIN_VERSION + ' in the Claude Code user scope. Check the plugin command results.'
    : legacy?.error;
  return {
    ...plan, dry_run: false, results, installed_version: installed, verified: !next, ...(legacy ? { legacy } : {}),
    ...(next ? { next } : {}),
  };
}

// ---- Codex ------------------------------------------------------------------

// NODE_OPTIONS is cleared, as in the Claude hooks: a --require/--import from
// the user's shell must not run inside every hook.
export function codexHooks(template, packageDir, executable = process.execPath) {
  const hooks = structuredClone(template);
  for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const handler of group.hooks) handler.command = 'NODE_OPTIONS= ' + shellQuote(executable) + ' ' + shellQuote(join(packageDir, 'scripts', 'codex-hook.mjs'));
  return hooks;
}

/** cf-memory agent handlers (old and new) are recognized by status message and script. */
export const ownedCodexHandler = handler => handler?.type === 'command' && STATUS.test(handler.statusMessage || '') && typeof handler.command === 'string' && handler.command.includes('codex-hook.mjs');

export function mergeCodexHooks(current, desired = { hooks: {} }) {
  if (!current || typeof current !== 'object' || Array.isArray(current) || current.hooks != null && (typeof current.hooks !== 'object' || Array.isArray(current.hooks))) throw Error('invalid existing Codex hooks file');
  const next = structuredClone(current);
  next.hooks ||= {};
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups) || groups.some(group => !group || !Array.isArray(group.hooks))) throw Error('invalid existing Codex hook groups');
    next.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(handler => !ownedCodexHandler(handler)) })).filter(group => group.hooks.length);
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  for (const [event, groups] of Object.entries(desired.hooks)) next.hooks[event] = [...(next.hooks[event] || []), ...groups];
  return next;
}

export async function codexPlan(paths, { root = PACKAGE_ROOT, executable = process.execPath, now = Date.now() } = {}) {
  const files = await packageFiles(root, ['hooks', 'scripts'], ['plugin.json', 'README.md']);
  const print = fingerprint(files);
  const packageDir = join(paths.codexHome, 'cf-memory-agent', PLUGIN_VERSION + '-' + print.slice(0, 16));
  const hooksFile = paths.hooksFile;
  const template = JSON.parse(await readFile(join(root, 'hooks', 'codex-hooks.json'), 'utf8'));
  const desired = codexHooks(template, packageDir, executable);
  const status = await lstat(hooksFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (status?.isSymbolicLink()) throw Error('refusing a symlinked Codex hooks file');
  const current = status ? JSON.parse(await readFile(hooksFile, 'utf8')) : {};
  const next = mergeCodexHooks(current, desired);
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  const hooksBytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
  const record = join(paths.agentHome, 'install-codex.json');
  const packageExists = Boolean(await lstat(packageDir).catch(() => null));
  const written = [
    ...(packageExists ? [] : files.map(file => describe(join(packageDir, file.path), file.bytes))),
    ...(changed ? [describe(hooksFile, hooksBytes)] : []),
    ...(changed && status ? [{ path: hooksFile + '.cf-memory-backup-' + now, bytes: status.size, copy_of: hooksFile }] : []),
    { path: record, bytes: null, note: 'install record (version, package path, hook hash)' },
  ];
  // What stays after this install: the 2 newest backups (counting a new one) and package copies (counting this one).
  const backups = (await codexBackups(hooksFile)).concat(changed && status ? [hooksFile + '.cf-memory-backup-' + now] : []);
  const packages = (await codexPackages(paths.codexHome)).filter(dir => dir !== packageDir);
  const pruned = [...backups.slice(0, Math.max(0, backups.length - KEEP)), ...packages.slice(0, Math.max(0, packages.length - (KEEP - 1)))];
  return {
    client: 'codex', version: PLUGIN_VERSION, package_dir: packageDir, package_exists: packageExists, package_hash: print,
    hooks_file: hooksFile, hooks_changed: changed, hooks: desired.hooks, hook_hash: sha256(JSON.stringify(desired)),
    files: written, pruned, approval: CODEX_APPROVAL, internal: { files, hooksBytes, status, now, record },
  };
}

// hooks.json.cf-memory-backup-<ms> files, oldest first.
async function codexBackups(hooksFile) {
  const names = await readdir(dirname(hooksFile)).catch(() => []), prefix = basename(hooksFile) + '.cf-memory-backup-';
  return names.filter(name => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length))).map(name => join(dirname(hooksFile), name));
}
// <codexHome>/cf-memory-agent/<version>-<hash> package copies, oldest first.
async function codexPackages(codexHome) {
  const root = join(codexHome, 'cf-memory-agent'), found = [];
  for (const name of await readdir(root).catch(() => [])) {
    if (!/^\d[\w.+-]*-[0-9a-f]{16}$/.test(name)) continue;
    const info = await lstat(join(root, name)).catch(() => null);
    if (info?.isDirectory()) found.push({ path: join(root, name), at: info.mtimeMs });
  }
  return found.sort((a, b) => a.at - b.at).map(entry => entry.path);
}

async function installCodex(paths, options) {
  if (process.platform === 'win32') throw Error('the Codex installer needs a POSIX host');
  const plan = await codexPlan(paths, options);
  const { internal, ...report } = plan;
  if (options.dryRun) return { ...report, dry_run: true };
  if (!plan.package_exists) {
    await mkdir(dirname(plan.package_dir), { recursive: true, mode: 0o700 });
    const temporary = plan.package_dir + '.' + randomUUID() + '.tmp';
    try {
      for (const file of internal.files) {
        await mkdir(dirname(join(temporary, file.path)), { recursive: true, mode: 0o700 });
        await writeFile(join(temporary, file.path), file.bytes, { mode: 0o600, flag: 'wx' });
      }
      await rename(temporary, plan.package_dir);
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }
  if (plan.hooks_changed) {
    await mkdir(dirname(plan.hooks_file), { recursive: true, mode: 0o700 });
    if (internal.status) await writeFile(plan.hooks_file + '.cf-memory-backup-' + internal.now, await readFile(plan.hooks_file), { mode: 0o600, flag: 'wx' });
    const temporary = plan.hooks_file + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, internal.hooksBytes, { mode: 0o600 });
    await rename(temporary, plan.hooks_file);
  }
  await mkdir(paths.agentHome, { recursive: true, mode: 0o700 });
  await writeFile(internal.record, JSON.stringify({ version: PLUGIN_VERSION, package_dir: plan.package_dir, package_hash: plan.package_hash, hooks_file: plan.hooks_file, hook_hash: plan.hook_hash, installed_at: internal.now }, null, 1), { mode: 0o600 });
  for (const path of plan.pruned) await rm(path, { recursive: true, force: true });
  return { ...report, dry_run: false };
}

// ---- Uninstall --------------------------------------------------------------

async function uninstallClaude(paths, options) {
  const cli = options.executable || process.env.CF_MEMORY_CLAUDE_BIN || 'claude', now = options.now ?? Date.now();
  const command = { executable: cli, args: ['plugin', 'uninstall', PLUGIN + '@' + MARKETPLACE, '--scope', 'user'] };
  const report = { client: 'claude-code', commands: [command], dry_run: Boolean(options.dryRun) };
  if (options.dryRun) return { ...report, legacy: await cleanLegacyRecall(paths, { write: false, now }) };
  const env = { ...process.env, ...(options.home ? { HOME: paths.home, CLAUDE_CONFIG_DIR: paths.claudeDir } : {}) };
  try { execFileSync(cli, command.args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, encoding: 'utf8' }); report.results = [{ args: command.args, ok: true }]; }
  catch (error) { report.results = [{ args: command.args, ok: false, status: error.status ?? null }]; }
  const plugin = await claudeUserPlugin(paths.claudeDir);
  const legacy = plugin === null ? await cleanLegacyRecall(paths, { write: true, now }) : undefined;
  const next = plugin === undefined ? 'Could not verify the Claude Code plugin registry.' : plugin
    ? 'cf-memory-agent@cf-memory is still installed in the Claude Code user scope. Check the plugin command result.'
    : legacy?.error;
  return { ...report, installed_version: plugin?.version ?? null, verified: !next, ...(legacy ? { legacy } : {}), ...(next ? { next } : {}) };
}

async function uninstallCodex(paths, options) {
  const hooksFile = paths.hooksFile, now = options.now ?? Date.now();
  const status = await lstat(hooksFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (status?.isSymbolicLink()) throw Error('refusing a symlinked Codex hooks file');
  const current = status ? JSON.parse(await readFile(hooksFile, 'utf8')) : null;
  const next = current ? mergeCodexHooks(current) : null;
  const changed = Boolean(current) && JSON.stringify(current) !== JSON.stringify(next);
  const packages = await codexPackages(paths.codexHome), record = join(paths.agentHome, 'install-codex.json');
  const report = {
    client: 'codex', hooks_file: hooksFile, hooks_changed: changed, ...(changed ? { backup: hooksFile + '.cf-memory-backup-' + now } : {}),
    removed: [...packages, ...(await exists(record) ? [record] : [])], kept: 'the Agent data in ' + paths.agentHome + ' (spool, health)', dry_run: Boolean(options.dryRun),
  };
  if (options.dryRun) return report;
  if (changed) {
    await writeFile(report.backup, await readFile(hooksFile), { mode: 0o600, flag: 'wx' });
    await writeAtomic(hooksFile, JSON.stringify(next, null, 2) + '\n');
  }
  for (const path of report.removed) await rm(path, { recursive: true, force: true });
  if (!(await readdir(join(paths.codexHome, 'cf-memory-agent')).catch(() => ['x'])).length) await rm(join(paths.codexHome, 'cf-memory-agent'), { recursive: true, force: true });
  return report;
}

export async function uninstall(options = {}) {
  const paths = installPaths({ home: options.home, env: options.env });
  if (paths.error) throw Error(paths.error);
  const report = { version: PLUGIN_VERSION, dry_run: Boolean(options.dryRun), home: paths.home, clients: {} };
  for (const client of options.clients || ['claude-code', 'codex']) {
    report.clients[client] = client === 'codex' ? await uninstallCodex(paths, options) : await uninstallClaude(paths, options);
  }
  return report;
}

export function parseInstallArgs(argv) {
  const options = { clients: ['claude-code', 'codex'], dryRun: false, home: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--home') { options.home = argv[++i]; if (!options.home) throw Error('--home needs a directory'); }
    else if (arg.startsWith('--home=')) { options.home = arg.slice(7); if (!options.home) throw Error('--home needs a directory'); }
    else if (arg === '--client') {
      const value = argv[++i];
      if (value === 'all') options.clients = ['claude-code', 'codex'];
      else if (['claude-code', 'claude', 'codex'].includes(value)) options.clients = [value === 'claude' ? 'claude-code' : value];
      else throw Error('--client must be claude-code, codex or all');
    } else throw Error('unknown install option: ' + arg);
  }
  return options;
}

export async function install(options = {}) {
  const paths = installPaths({ home: options.home, env: options.env });
  if (paths.error) throw Error(paths.error);
  const report = { version: PLUGIN_VERSION, dry_run: Boolean(options.dryRun), home: paths.home, clients: {} };
  for (const client of options.clients || ['claude-code', 'codex']) {
    report.clients[client] = client === 'codex' ? await installCodex(paths, options) : await installClaude(paths, options);
  }
  if (report.clients.codex) report.next = [CODEX_APPROVAL];
  return report;
}

