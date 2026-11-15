// Hook payload → cf-memory log entries. Pure functions: no I/O.
import { createHash } from 'node:crypto';
import { CLIENTS } from './client.mjs';
import { DEFAULT_DENY_PATHS, hasCredentialReader, scrubEntryText } from './redact.mjs';

export const KINDS = ['prompt', 'reply', 'action', 'error'];
export const LIMITS = { prompt: 65536, reply: 65536, action: 400, error: 2048 };
export const TRUNCATED = '…（以下省略）';
export const FAILED = ' → 失敗';
// The detail of an action whose hook payload was too large to read.
export const OVERSIZED_INPUT = '（入力が大きすぎて省略）';
const MAX_SESSION_ID = 128, MAX_REPO = 200, MAX_SCAN = 1024 * 1024;
// What the server refuses in session_id and repo (src/logs.ts shortString).
const CONTROL = /[\u0000-\u001f\u007f]/;

// Agent-to-agent collaboration and wait/clock tools carry no work of their own.
// Compared by base name (after any "server__" prefix), lowercase, letters and
// digits only. Claude: SendMessage, Agent/Task (spawn a subagent), team tools,
// ScheduleWakeup, Monitor, TaskOutput (waits for a background job).
const SKIPPED = new Set([
  'sendmessage', 'followuptask', 'listagents', 'spawnagent', 'waitagent', 'interruptagent', 'closeagent',
  'resumeagent', 'sendinput', 'wait', 'waitforagent', 'waitforagents', 'sleep', 'currtime', 'currenttime', 'getcurrenttime',
  'agent', 'task', 'taskoutput', 'teamcreate', 'teamdelete', 'fetchinboxmessage', 'readnotifications', 'schedulewakeup', 'monitor',
]);
export function isSkippedTool(name) {
  if (typeof name !== 'string' || !name) return false;
  const base = name.split(/__|\./).filter(Boolean).at(-1) || name;
  return SKIPPED.has(base.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

// Markers the scrubber writes. A cut never lands inside one: half a marker is
// not recognized (and is dropped) by the server's second scrub.
const MARKER = /\[(?:REDACTED|DENIED)[A-Z ]*\]|\[DEPTH LIMIT\]|\(email omitted\)/g;
function safeCut(value, cut) {
  for (const match of value.matchAll(MARKER)) {
    if (match.index >= cut) break;
    if (match.index + match[0].length > cut) return match.index;
  }
  return /[\uD800-\uDBFF]/.test(value[cut - 1] || '') ? cut - 1 : cut;
}

/** Cut to `limit` UTF-16 units, ending with `mark` when cut; never splits a surrogate pair or a redaction marker. */
export function clip(text, limit, mark = TRUNCATED) {
  const value = String(text);
  if (value.length <= limit) return value;
  return value.slice(0, safeCut(value, Math.max(0, limit - mark.length))) + mark;
}

/** Scrub before cutting, so a cut can never expose part of a secret. */
export function cleanText(value, limit, mark = TRUNCATED) {
  let text = String(value ?? '');
  // Over MAX_SCAN, the input is cut before scrubbing at a line or word boundary, so no token is
  // scrubbed without its continuation. (Trimming the scrubbed output instead emptied a prompt
  // whose 1.6 MB data: URI scrubbed down to a few characters.)
  if (text.length > MAX_SCAN) {
    const room = MAX_SCAN - 256;
    let cut = text.lastIndexOf('\n', room);
    if (cut < room / 2) cut = Math.max(text.lastIndexOf(' ', room), text.lastIndexOf('\t', room));
    if (cut < room / 2) cut = room;
    text = text.slice(0, safeCut(text, cut));
  }
  return clip(scrubEntryText(text), limit, mark);
}

export const oneLine = text => String(text).replace(/\s+/g, ' ').trim();

/** Plain text of a hook value (string, MCP content array, message object or JSON). */
export function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : part?.type === 'text' || typeof part?.text === 'string' ? String(part.text ?? '') : '').filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (Array.isArray(value.content)) return textOf(value.content);
    if (typeof value.content === 'string') return value.content;
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return String(value);
}

// The files a Codex patch touches. The patch may be the whole text, follow a
// command (["apply_patch", patch] joined) or a heredoc (apply_patch <<'EOF').
function patchFiles(text) {
  const start = typeof text === 'string' ? text.search(/(?:^|\s)\*\*\* Begin Patch/) : -1;
  if (start < 0) return null;
  const files = [];
  for (const line of text.slice(start).split(/\r?\n/)) {
    const header = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/);
    if (header && !files.includes(header[1].trim())) files.push(header[1].trim());
  }
  return (/^\s*\*\*\* Begin Patch/.test(text) ? '' : 'apply_patch ') + files.join(', ');
}

function commandText(command) {
  if (Array.isArray(command)) {
    const parts = command.map(String);
    // ["bash", "-lc", "<script>"] → the script.
    if (parts.length >= 3 && /(?:^|\/)(?:ba|z|da)?sh$/.test(parts[0]) && /^-\w*c$/.test(parts[1])) return parts.slice(2).join(' ');
    return parts.join(' ');
  }
  return typeof command === 'string' ? command : '';
}

const patchDetail = input => {
  for (const text of typeof input === 'string' ? [input] : input && typeof input === 'object' ? ['command', 'cmd', 'patch', 'input'].map(key => commandText(input[key])) : []) {
    const files = patchFiles(text);
    if (files !== null) return files;
  }
  return null;
};

const DETAIL_FIELDS = ['command', 'cmd', 'file_path', 'notebook_path', 'path', 'url', 'query', 'pattern', 'description'];
/** The one interesting input of a tool call: command | cmd | file_path | path | url | query | pattern | description (a patch: its files). */
export function toolDetail(toolName, input) {
  const files = patchDetail(input);
  if (files !== null) return files;
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  for (const key of DETAIL_FIELDS) {
    const value = key === 'command' || key === 'cmd' ? commandText(input[key]) : input[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    // Grep/Glob: the pattern is what was looked for; keep the path too.
    if (key === 'path' && typeof input.pattern === 'string' && input.pattern.trim()) return input.pattern + ' (' + value + ')';
    return value;
  }
  return '';
}

// Shell words of one command line (quotes stay inside their word) and operators.
const SHELL_OPERATOR = /^(?:\d?>>?&?|&>>?|<<<|<<-?|<|&&|\|\||[;|&()])/;
function shellTokens(line) {
  const tokens = [];
  let word = '';
  const flush = () => { if (word) tokens.push({ word }); word = ''; };
  for (let i = 0; i < line.length;) {
    const ch = line[i];
    if (/\s/.test(ch)) { flush(); i++; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += ch === '"' && line[j] === '\\' ? 2 : 1;
      word += line.slice(i, j + 1); i = j + 1; continue;
    }
    const op = SHELL_OPERATOR.exec(line.slice(i, i + 4));
    if (op && (!word || /^\d$/.test(word) && ch === '>')) { tokens.push({ op: word + op[0] }); word = ''; i += op[0].length; continue; }
    if (op && !/^\d/.test(op[0])) { flush(); continue; }
    word += ch; i++;
  }
  flush();
  return tokens;
}

// The detail of a call that touches a credential file: its first command line
// reduced to each program name, the arguments that name a denied path, the
// operators and heredoc delimiters; everything else (values, flags, quoted
// code, echo/printf text, here-strings) becomes "…". A patch: its file names.
function sensitiveDetail(input) {
  const files = patchDetail(input);
  if (files !== null) return files;
  const command = typeof input === 'string' ? input : input && typeof input === 'object' ? commandText(input.command) || commandText(input.cmd) : '';
  if (!command.trim()) return toolDetail('', input);
  const out = [], hidden = () => { if (out.at(-1) !== '…') out.push('…'); };
  let program = null, wrapper = false, next = null;
  for (const token of shellTokens(command.split(/\r?\n/, 1)[0])) {
    if (token.op) {
      if (/^(?:&&|\|\||[;|&()])$/.test(token.op)) program = null;
      out.push(token.op); next = /^<<-?$/.test(token.op) ? 'delimiter' : token.op === '<<<' ? 'string' : null;
      continue;
    }
    const word = token.word;
    if (next === 'delimiter') { out[out.length - 1] += /^(['"]?)[A-Za-z_]\w*\1$/.test(word) ? word : '…'; next = null; continue; }
    if (next === 'string') { hidden(); next = null; continue; }
    if (word.startsWith('#') && (program === null || out.at(-1) !== word)) { hidden(); break; }
    if (program === null || wrapper && !word.startsWith('-')) {
      const assignment = /^([A-Za-z_]\w*)=/.exec(word);
      if (assignment) { out.push(assignment[1] + '=…'); continue; }
      program = word; wrapper = /^(?:\S*\/)?(?:sudo|env|command|exec|nohup|time|nice|xargs|doas)$/.test(word); out.push(word);
      continue;
    }
    const paths = (word.replace(/["']/g, '').match(PATH_RUN) ?? []).filter(run => deniedText(run));
    if (paths.length) out.push(paths.join(' ')); else hidden();
  }
  return out.join(' ').replace(/ ;/g, ';');
}

/**
 * One line, at most 400 chars: "<tool>: <detail>" (cut with …（以下省略）) plus
 * " → 失敗" when it failed. `sensitive`: the input touches a credential file.
 */
export function actionLine(toolName, input, failed = false, sensitive = false) {
  const tool = oneLine(textOf(toolName)) || 'tool';
  const detail = sensitive ? sensitiveDetail(input) : toolDetail(tool, input);
  // Join shell continuations (`\` + newline) first so the command-argument rules see one line.
  const line = oneLine(cleanText((detail ? tool + ': ' + detail : tool).replace(/\\\r?\n/g, ' '), MAX_SCAN, ''));
  const room = LIMITS.action - (failed ? FAILED.length : 0);
  return clip(line, room) + (failed ? FAILED : '');
}

// Credential files DEFAULT_DENY_PATHS does not name, and commands that print
// credentials without naming a file (hasCredentialReader knows only the macOS
// keychain and `gh auth token`).
export const EXTRA_DENY_PATHS = ['*.env', '.env~', '.envrc', '.dev.vars', '.dev.vars.*', '*.tfvars', '*.tfvars.json', '.netrc', '_netrc', '.pgpass',
  '.npmrc', '.pypirc', '.git-credentials', '.htpasswd', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '*.p12', '*.pfx', '.docker/config.json',
  '.kube/config', 'application_default_credentials.json', '.config/gh/hosts.yml'];
const CREDENTIAL_COMMAND = new RegExp([
  String.raw`\bgcloud\s+auth\s+(?:application-default\s+)?print-(?:access|identity)-token\b`, String.raw`\bgcloud\s+secrets\s+versions\s+access\b`,
  String.raw`\baz\s+(?:account\s+get-access-token|keyvault\s+secret\s+(?:show|download))\b`,
  String.raw`\baws\s+(?:sts\s+get-session-token|configure\s+(?:get|export-credentials)|ecr\s+get-login-password|codeartifact\s+get-authorization-token|secretsmanager\s+get-secret-value)\b`,
  String.raw`\baws\s+ssm\s+get-parameters?(?:-by-path)?\b[^\n;|&]{0,256}--with-decryption`,
  String.raw`\bop\s+(?:read|item\s+get)\b`, String.raw`\bvault\s+(?:read|kv\s+get)\b`, String.raw`\b(?:pass|lpass)\s+show\b`, String.raw`\bbw\s+get\b`,
  String.raw`\bkubectl\s+get\s+secrets?\b`, String.raw`\bkubectl\s+config\s+view\b[^\n;|&]{0,256}--(?:raw|flatten)`,
  String.raw`\bdocker(?:-compose|\s+compose)\s+(?:[^\n;|&]{0,256}\s)?config\b`, String.raw`\bheroku\s+(?:auth:token|config)\b`, String.raw`\bfirebase\s+functions:config:get\b`,
  String.raw`\bgit\s+credential(?:-[\w-]+)?\s+(?:fill|get)\b`, String.raw`\bnpm\s+token\b`, String.raw`\bgh\s+auth\s+status\b[^\n;|&]{0,256}\s(?:-t|--show-token)\b`,
  String.raw`\bsecurity\s+(?:dump-keychain|find-(?:generic|internet)-password)\b`,
  String.raw`\bterraform\s+(?:output\b|state\s+(?:pull|show)\b)`, String.raw`\bpulumi\b[^\n;|&]{0,256}\s--show-secrets\b`, String.raw`\bpulumi\s+config\s+get\b`,
  String.raw`\bdocker\s+(?:inspect|container\s+inspect)\b`, String.raw`\b(?:docker|podman|kubectl)\s+exec\b[^\n;|&]{0,256}\s(?:--\s+)?(?:printenv|env|cat\s+/proc/[^\s/]+/environ)(?:$|[\s;&|)])`,
  String.raw`\bhelm\s+get\s+(?:values|all)\b`, String.raw`\bsops\s+(?:[^\n;|&]{0,256}\s)?(?:-d|--decrypt|decrypt|exec-env)\b`, String.raw`\bansible-vault\s+(?:view|decrypt)\b`,
  String.raw`\bchamber\s+(?:export|read|exec)\b`, String.raw`\bwrangler\s+secret\s+(?:get|bulk)\b`, String.raw`(?:^|[;&|(\x60]\s*|\s)(?:[^\s;&|()\x60]{0,256}/)?(?:command\s+)?env\s*(?:$|[;&|)>])`,
  // Whole-environment dumps: printenv, env, export -p, set, declare -x/-p, /proc/*/environ, process.env, os.environ.
  String.raw`(?:^|[;&|(\x60]\s*|\bsudo\s+)(?:printenv\b|(?:env|set|export\s+-p|(?:declare|typeset)\s+-(?=[a-zA-Z]{0,32}[xp])[a-zA-Z]{1,32})\s*(?:$|[;&|)>]))`,
  String.raw`/proc/[^\s/]+/environ\b`, String.raw`\b(?:process\.env|os\.environ|Deno\.env\.toObject\(\))(?![\w.[])`,
].join('|'), 'i');
// A path is any run between these separators; a glob matches one run or a
// trailing part of it ("a/b/.env" ends in ".env"). One linear scan per string.
const SEPARATORS = String.raw`\s"'<>;|&()=\x60{},:\\/`;
const PATH_RUN = /[^\s"'<>;|&()=\x60{},:]+/g;
const DENY_PATTERNS = [...DEFAULT_DENY_PATHS, ...EXTRA_DENY_PATHS];
const globSource = pattern => pattern.split('*').map(part => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^' + SEPARATORS + ']*');
const DENIED = new RegExp('(?:^|[' + SEPARATORS + '])(?:' + DENY_PATTERNS.map(globSource).join('|') + ')(?=$|[' + SEPARATORS + '])', 'i');
// A shell glob in a command (cat .en?, cat .[e]nv, cat .en*) is denied when it
// matches a concrete name of a deny pattern and has at least two literal characters.
const DENY_SAMPLES = DENY_PATTERNS.filter(pattern => !pattern.includes('/')).map(pattern => pattern.replaceAll('*', 'x'));
// A shell glob as tokens (*, ?, [class], literal), matched by a linear two-pointer walk: a
// `.*` regex backtracked exponentially on "**********1234" (11 s, and the hook was killed).
function globTokens(run) {
  const tokens = [];
  for (const piece of run.match(/\[!?[^\]]+\]|[*?]|\[|[^*?[]+/g) ?? []) {
    if (piece === '*') { if (tokens.at(-1)?.type !== 'star') tokens.push({ type: 'star' }); }
    else if (piece === '?') tokens.push({ type: 'any' });
    else if (piece.length > 2 && piece.startsWith('[') && piece.endsWith(']')) {
      const negate = piece[1] === '!', body = piece.slice(negate ? 2 : 1, -1).toLowerCase(), ranges = [];
      for (let i = 0; i < body.length; i++) ranges.push(body[i + 1] === '-' && i + 2 < body.length ? [body[i], body[(i += 2)]] : [body[i], body[i]]);
      tokens.push({ type: 'class', test: c => ranges.some(([a, b]) => c >= a && c <= b) !== negate });
    } else for (const ch of piece.toLowerCase()) tokens.push({ type: 'lit', ch });
  }
  return tokens;
}
function globMatches(tokens, text) {
  let p = 0, i = 0, star = -1, mark = 0;
  while (i < text.length) {
    const token = tokens[p], ch = text[i];
    if (token?.type === 'star') { star = p++; mark = i; continue; }
    if (token && (token.type === 'any' || token.type === 'lit' && token.ch === ch || token.type === 'class' && token.test(ch))) { p++; i++; continue; }
    if (star < 0) return false;
    p = star + 1; i = ++mark;
  }
  while (tokens[p]?.type === 'star') p++;
  return p === tokens.length;
}
function deniedGlob(text) {
  // One split, then only the short pieces that hold a glob character: a regex scanning for the
  // glob character inside a 200 KB token restarted at every position (20 s on a Codex patch).
  for (const run of text.split(/[\s"'<>;|&()=\x60{},:\\/]+/)) {
    if (run.length > 256 || !/[*?[]/.test(run)) continue;
    const tokens = globTokens(run);
    if (tokens.filter(t => t.type === 'lit').length >= 2 && DENY_SAMPLES.some(sample => globMatches(tokens, sample.toLowerCase()))) return true;
  }
  return false;
}
// Shell spellings: quotes and backslash escapes removed (.e""nv, .e\\nv), one level of
// brace expansion (.{e,}nv), %-encoding and globs.
const braceVariants = text => {
  const m = /\{([^{},]{0,256},[^{}]{0,256})\}/.exec(text);
  return m ? m[1].split(',').slice(0, 16).map(part => text.slice(0, m.index) + part + text.slice(m.index + m[0].length)) : [];
};
const deniedText = text => DENIED.test(text) || /["'\\]/.test(text) && DENIED.test(text.replace(/["'\\]/g, '')) ||
  /\{[^{},]{0,256},/.test(text) && braceVariants(text.replace(/["'\\]/g, '')).some(variant => DENIED.test(variant)) ||
  /%[0-9a-f]{2}/i.test(text) && DENIED.test((() => { try { return decodeURIComponent(text); } catch { return ''; } })()) || /[*?[]/.test(text) && deniedGlob(text);
// Input fields that hold paths or commands (any depth, arrays included).
const PATH_KEY = /(?:path|file|command|cmd|directory|dir|cwd|script|args|argv|input|patch|target|source|dest|uri|url|location)/i;

// A long string is checked at its first and last SENSITIVE_SCAN chars: a denied path or a credential
// printer sits at the start of a command or after a heredoc at its end, and the bound keeps every
// check fast whatever a pattern costs.
const SENSITIVE_SCAN = 65536;
// At most SENSITIVE_TOTAL chars in all, so no pattern's cost is multiplied by 1,000 strings.
const SENSITIVE_TOTAL = 262144;
function keyedStrings(value, keyed, depth = 0, out = Object.assign([], { left: SENSITIVE_TOTAL })) {
  if (depth > 24 || out.length >= 1000 || out.left <= 0) return out;
  if (typeof value === 'string') {
    if (!keyed) return out;
    let text = value.length > 2 * SENSITIVE_SCAN ? value.slice(0, SENSITIVE_SCAN) + '\n' + value.slice(-SENSITIVE_SCAN) : value;
    if (text.length > out.left) text = text.slice(0, out.left);
    out.left -= text.length; out.push(text);
  }
  else if (Array.isArray(value)) for (const part of value.slice(0, 1000)) keyedStrings(part, keyed, depth + 1, out);
  else if (value && typeof value === 'object') for (const [key, part] of Object.entries(value).slice(0, 1000)) keyedStrings(part, keyed || PATH_KEY.test(key), depth + 1, out);
  return out;
}

/**
 * True when a tool input touches a credential file (DEFAULT_DENY_PATHS or
 * EXTRA_DENY_PATHS) or runs a command that prints credentials. Such an action
 * keeps only its action line: no failure or output text.
 */
export function sensitiveInput(input) {
  if (input && typeof input === 'object' && !Array.isArray(input) && hasCredentialReader({ ...input, command: commandText(input.command), cmd: commandText(input.cmd) })) return true;
  return keyedStrings(input, typeof input === 'string').some(text => deniedText(text) || CREDENTIAL_COMMAND.test(text));
}

/** The action line, then the head of the failure output; 2,048 chars in all. */
export function errorText(line, failureOutput) {
  const output = cleanText(textOf(failureOutput).trim(), MAX_SCAN, '');
  if (!output) return clip(line, LIMITS.error);
  return clip(line + '\n' + output, LIMITS.error);
}

/** session_id as stored and as sent to session_context: trimmed; hashed when longer than 128 chars or holding control characters. */
export function sessionKey(value) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : 'unknown-session';
  return text.length <= MAX_SESSION_ID && !CONTROL.test(text) ? text : createHash('sha256').update(text).digest('hex');
}

/** repo as stored and as sent to session_context: control characters become spaces; at most 200 chars. */
export const repoKey = value => clip(String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' '), MAX_REPO, '');

export function entryId({ client, session_id, ts, kind, text }) {
  return createHash('sha256').update(JSON.stringify([client, session_id, ts, kind, text])).digest('hex');
}

export function makeEntry({ client, session_id, repo = '', ts, kind, text }) {
  const entry = { session_id: sessionKey(session_id), client, repo: repoKey(repo), ts, kind, text: clip(text, LIMITS[kind]) };
  return { id: entryId(entry), ...entry };
}

/** Exactly what log_append accepts (src/logs.ts parseEntry); a ts far in the future is clamped there, not refused. */
export function validEntry(entry) {
  return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string' && /^[0-9a-f]{64}$/.test(entry.id) &&
    typeof entry.session_id === 'string' && entry.session_id.trim() !== '' && entry.session_id.length <= MAX_SESSION_ID && !CONTROL.test(entry.session_id) &&
    CLIENTS.includes(entry.client) && (entry.repo === undefined || typeof entry.repo === 'string' && entry.repo.length <= MAX_REPO && !CONTROL.test(entry.repo)) &&
    typeof entry.ts === 'number' && Number.isFinite(entry.ts) && entry.ts >= 0 && KINDS.includes(entry.kind) && typeof entry.text === 'string');
}

/** Event time in epoch ms: a payload timestamp when plausible, else now. */
export function eventTime(payload, now = Date.now()) {
  let ts = payload?.timestamp;
  if (typeof ts === 'string') ts = /^\d+(?:\.\d+)?$/.test(ts) ? Number(ts) : Date.parse(ts);
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return now;
  if (ts < 1e12) ts *= 1000; // seconds
  ts = Math.floor(ts);
  return ts > now + 60000 || ts < now - 7 * 86400000 ? now : ts;
}

/**
 * Entries for one normalized hook event.
 * event: 'UserPromptSubmit' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop' (others → []).
 * hook: { session_id, prompt, tool_name, tool_input, failed, failure_output, reply }.
 */
export function buildEntries({ client, event, hook, repo, ts }) {
  const base = { client, session_id: hook.session_id, repo, ts };
  if (event === 'UserPromptSubmit') {
    const text = cleanText(textOf(hook.prompt), LIMITS.prompt);
    return text.trim() ? [makeEntry({ ...base, kind: 'prompt', text })] : [];
  }
  if (event === 'Stop') {
    const text = cleanText(textOf(hook.reply), LIMITS.reply);
    return text.trim() ? [makeEntry({ ...base, kind: 'reply', text })] : [];
  }
  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    if (!hook.tool_name || isSkippedTool(hook.tool_name)) return [];
    const failed = event === 'PostToolUseFailure' || hook.failed === true;
    const sensitive = sensitiveInput(hook.tool_input);
    const input = hook.oversized && !toolDetail(hook.tool_name, hook.tool_input) ? OVERSIZED_INPUT : hook.tool_input;
    const line = actionLine(hook.tool_name, input, failed, sensitive && input !== OVERSIZED_INPUT);
    const entries = [makeEntry({ ...base, kind: 'action', text: line })];
    if (failed && !sensitive) entries.push(makeEntry({ ...base, kind: 'error', text: errorText(line, hook.failure_output) }));
    return entries;
  }
  return [];
}

// ---- Client payload mapping -------------------------------------------------

/** Claude Code hook payload → normalized hook. */
export function claudeHook(payload) {
  const event = payload.hook_event_name;
  const hook = { session_id: payload.session_id, cwd: payload.cwd, prompt: payload.prompt, tool_name: payload.tool_name, tool_input: payload.tool_input, reply: payload.last_assistant_message, oversized: payload.cf_memory_oversized === true };
  if (event === 'PostToolUseFailure') {
    hook.failed = true;
    // The failure text is `error`; older payloads carried it in tool_response.
    hook.failure_output = payload.error ?? payload.tool_response;
    if (payload.is_interrupt === true && !textOf(hook.failure_output).trim()) hook.failure_output = 'interrupted';
  }
  return hook;
}

/** Failure text when a Codex tool_response reports a failure, else null. */
export function codexFailure(response) {
  if (response === undefined || response === null) return null;
  if (typeof response === 'string') {
    const code = response.match(/^\s*(?:Exit code|Process exited with code|exit status)\s*:?\s*(-?\d+)/i);
    return code && Number(code[1]) !== 0 ? response : null;
  }
  if (typeof response !== 'object' || Array.isArray(response)) return null;
  const code = [response.exit_code, response.exitCode].find(Number.isInteger);
  const failed = code !== undefined && code !== 0 || response.success === false || response.is_error === true || response.isError === true ||
    typeof response.error === 'string' && response.error.trim() !== '';
  if (!failed) return null;
  const parts = [];
  if (code !== undefined && code !== 0) parts.push('Exit code ' + code);
  for (const key of ['error', 'stderr', 'output', 'stdout', 'aggregated_output', 'formatted_output', 'message']) {
    const text = textOf(response[key]).trim();
    if (text && !parts.includes(text)) parts.push(text);
  }
  if (Array.isArray(response.content)) parts.push(textOf(response.content));
  return parts.filter(Boolean).join('\n') || JSON.stringify(response);
}

/** Codex hook payload → normalized hook. Codex has no PostToolUseFailure event: failures come from tool_response. */
export function codexHook(payload) {
  const hook = { session_id: payload.session_id, cwd: payload.cwd, prompt: payload.prompt, tool_name: payload.tool_name, tool_input: payload.tool_input ?? payload.input, reply: payload.last_assistant_message, oversized: payload.cf_memory_oversized === true };
  if (payload.hook_event_name === 'PostToolUseFailure') {
    hook.failed = true; hook.failure_output = payload.error ?? payload.tool_response;
  } else if (payload.hook_event_name === 'PostToolUse') {
    const failure = codexFailure(payload.tool_response);
    if (failure !== null) { hook.failed = true; hook.failure_output = failure; }
  }
  return hook;
}
