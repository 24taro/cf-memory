// Shared by the local hook and Worker. Never hash or persist the raw payload.
export const DEFAULT_DENY_PATHS = ['.env', '.env.*', '*.pem', '*.key', 'credentials*', 'secrets*'];
const sensitiveKey = /(?:authorization|cookie|password|passwd|passphrase|private[_-]?key|api[_-]?key|token|secret|oauth|credential|client[_-]?(?:key|certificate)[_-]?data)/i;
// Log entries: "auth"/"_auth" (docker, npm) and "oauth" only as whole keys, so "author" and "oauth_url" stay.
const entryKey = /(?:authorization|cookie|password|passwd|passphrase|private[_-]?key|api[_-]?key|token|secret|credential|client[_-]?(?:key|certificate)[_-]?data)|^_?o?auth$/i;
// An auth mode ("auth": "basic") is not a credential; anything else under "auth" is.
const authKey = /^_?o?auth$/i, authWord = /^(["']?)(?:none|basic|bearer|digest|token|o?auth2?|oidc|saml|jwt|api[_-]?key|m?tls|ldap|kerberos|ntlm|negotiate|password|anonymous|session|cookie|header|sigv4|aws|iam|md5|trust|peer|cert|sso|true|false|null|required|optional|enabled|disabled|default|custom)\1$/i;
// Token counts ("max_tokens": 1024, input_tokens, token_count) are not credentials.
const countKey = key => /^(?:\w*tokens|(?:max|min|input|output|total|prompt|completion|reasoning|num)tokens?|tokens?(?:count|counts|total|used|usage|limit|budget|remaining))$/.test(String(key).toLowerCase().replace(/[\s_-]/g, ''));
const mediaMarker = '[REDACTED MEDIA CONTENT]';
// Recognize the header only: never scan an unbounded parameter/body tail from
// every potential URI start in a malformed log. Incomplete headers fail closed.
const dataUri = /(?:^|[^\w])data:(?:[\w.+-]+\/[\w.+-]+[;,]|[;,])/i;
// Log entries keep the text around a data URI and replace only its payload. The
// header parts are bounded; the payload stops at whitespace, a quote or a JSON
// escape, and runs on over wrapped base64 lines.
const dataUriPayload = /(?<!\w)(data:(?:[\w.+-]{1,127}\/[\w.+-]{1,127})?(?=[;,])(?:;[\w.+-]{1,127}(?:=[\w.+-]{0,127})?){0,8},?)([^\s"'<>`\\)]*(?:\r?\n[A-Za-z0-9+/]{16,}={0,2}(?=\r?\n|$))*)/gi;
const mediaPayload = (match, head, payload) => !payload || payload.startsWith('[REDACTED') ? match : head + mediaMarker;
const mediaType = /^(?:image|image_url|input_image|audio|audio_url|input_audio|video|base64)$/i;
const binaryMime = /^(?:(?:image|audio|video)\/|application\/(?:pdf|octet-stream|zip)(?:;|$))/i;
function mediaEnvelope(value) {
  return typeof value.type === 'string' && mediaType.test(value.type) ||
    [value.mimeType, value.mime_type, value.media_type].some(v => typeof v === 'string' && binaryMime.test(v)) ||
    typeof value.encoding === 'string' && /^(?:base64|binary)$/i.test(value.encoding);
}
// A JSON document whose media payloads or nested private objects must be dropped (rebuilt, not scanned as text).
const ENVELOPE_KEYS = new Set(['private', 'text', 'content', 'body', 'message', 'prompt', 'reply', 'data', 'type', 'id']);
const privateEnvelope = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && value.private === true && Object.keys(value).every(key => ENVELOPE_KEYS.has(key));
function hasMedia(value, budget = { n: 10000 }) {
  if (!value || typeof value !== 'object' || --budget.n < 0) return false;
  if (!Array.isArray(value) && (mediaEnvelope(value) || privateEnvelope(value))) return true;
  for (const v of Array.isArray(value) ? value : Object.values(value)) if (hasMedia(v, budget)) return true;
  return false;
}
function mediaField(key, envelope) {
  // MCP binary resources and encoded assets are opaque even without a MIME tag.
  // A named data field in ordinary JSON/code is still normal text evidence.
  return /^(?:blob|content_base64|file_data)$/i.test(key) || envelope &&
    /^(?:data|base64|bytes|buffer|content|source|input_audio|image_url|audio_url|url)$/i.test(key);
}
function jsonValueEnd(value, start) {
  const opening=value[start];
  if(opening!=='"' && opening!=='{' && opening!=='['){
    const scalar=value.slice(start).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=$|[\s,}\]])/);
    return scalar?start+scalar[0].length:value.length;
  }
  const end=jsonEnd(value,start);
  return end>0?end:value.length; // incomplete credential values never expose their tail
}
// The end of the complete JSON string, object or array at start, or minus the offset where the scan gave up.
function jsonEnd(value, start) {
  let quoted=value[start]==='"',end=start+1;const stack=quoted?[]:[value[start]];
  for(;end<value.length;end++){
    const c=value[end];
    if(quoted){if(c==='\\'){end++;continue;}if(c==='"'){quoted=false;if(stack.length===0)return end+1;}continue;}
    if(c==='"')quoted=true;
    else if(c==='{'||c==='['){stack.push(c);if(stack.length>24)break;}
    else if(c==='}'||c===']'){if(stack.pop()!==(c==='}'?'{':'['))break;if(stack.length===0)return end+1;}
  }
  return -Math.min(end,value.length);
}
const lineEnd = (value, at) => { const n = value.indexOf('\n', at); return n < 0 ? value.length : value[n - 1] === '\r' ? n - 1 : n; };
const valueToken = /[^\s,;}\])"']*/y;
// A log entry redacts the complete JSON value of a credential key, or else one
// token on its line, so "token": is optional / "authToken": string stay text;
// a value cut off loses the rest of its line, never the rest of the entry.
// Returns where the redaction ends, or -1 to keep the value.
function entryValueEnd(value, first, key, scan) {
  const c = value[first];
  if (c === '"' || c === "'") {
    let i = first + 1;
    for (; i < value.length && value[i] !== '\n' && value[i] !== '\r' && value[i] !== c; i++) if (value[i] === '\\') i++;
    if (value[i] !== c) return Math.min(i, value.length);
    return keptEntryValue(key, value.slice(first + 1, i), true) ? -1 : i + 1;
  }
  if (value.startsWith('[REDACTED', first)) return -1;
  if (c === '{' || c === '[') {
    // A failed scan marks how far it read; later keys before that point do not rescan it.
    // An auth object ({"auth": {"username": …}}) is scanned key by key, like settings objects.
    if (authKey.test(key)) return -1;
    if (first >= scan.floor) { const end = jsonEnd(value, first); if (end > 0) return settingsObject(value.slice(first, end)) ? -1 : end; scan.floor = -end; }
    return lineEnd(value, first);
  }
  valueToken.lastIndex = first;
  const token = valueToken.exec(value)[0];
  return keptEntryValue(key, token, false) ? -1 : first + token.length;
}
// {"type":"string","minLength":8} under "password", {"secure":true,"httpOnly":true} under "cookie".
const SETTING_KEYS = new Set(['type', 'format', 'minLength', 'maxLength', 'pattern', 'description', 'title', 'enum', 'nullable', 'readOnly', 'writeOnly', '$ref',
  'minimum', 'maximum', 'required', 'secure', 'httpOnly', 'sameSite', 'maxAge', 'path', 'domain', 'expires', 'signed', 'overwrite', 'partitioned', 'priority']);
const settingKey = key => SETTING_KEYS.has(key) || /^(?:min|max|require|allow|disallow|expires?|history|lockout|strength|complexity|reuse)(?:[A-Z_]|$)/.test(key);
function settingsObject(text) {
  if (text[0] !== '{' || text.length > 4096) return false;
  try { const o = JSON.parse(text); return o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0 && Object.keys(o).every(settingKey) && Object.values(o).every(v => v === null || typeof v !== 'object' || Array.isArray(v) && v.every(x => typeof x !== 'object')); } catch { return false; }
}
function keptEntryValue(key, value, quoted) {
  if (!value || value.startsWith('[REDACTED') || countKey(key) && /^\d+$/.test(value) || authKey.test(key) && authWord.test(value) || referenceKey(key, value)) return true;
  if (quoted || /^-?\d+(?:\.\d+)?$/.test(value)) return false;
  return placeholder(value) || !looksSecret(/pass|pwd/i.test(key) ? 'password' : 'token', value, 'explicit');
}
const jsonString = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"$/;
function scrubQuotedText(value, depth, entry) {
  let result = '', cursor = 0;
  const scan = { floor: 0 }, seen = new Map();
  // Walk each character once. Retrying a quoted-token regex at every escaped
  // quote makes malformed logs quadratic; no partial token is decoded here.
  for (let start = 0; start < value.length; start++) {
    if (value[start] === '\\') { start++; continue; }
    if (value[start] !== '"') continue;
    let end = start + 1, closed = false;
    while (end < value.length) {
      if (value[end] === '\\') { end += 2; continue; }
      if (value[end++] === '"') { closed = true; break; }
    }
    if (!closed) break;
    const quoted = value.slice(start, end);
    let replacement = quoted;
    // Only a valid JSON string is decoded: a parse that throws costs more than the scan (32k "\t" strings took 57 ms).
    if (jsonString.test(quoted)) try {
      // No rule matches fewer than six characters; skip the chain for "a", "id" and the like.
      // Repeated strings are cleaned once: a log of the same quoted line stays cheap.
      const decoded = JSON.parse(quoted), cleaned = decoded.length < 6 ? decoded : seen.get(decoded) ??
        (entry ? scrubFreeTextSecrets(scrubCommandSecrets(cleanText(decoded, depth + 1, true))) : cleanText(decoded, depth + 1, entry));
      if (seen.size < 256 && decoded.length <= 256) seen.set(decoded, cleaned);
      if (cleaned !== decoded) replacement = JSON.stringify(cleaned);
      // Keep the decoded key/value association. Merely normalizing the key
      // before assignment regexes misses escaped keys containing spaces or
      // control characters. Consume the complete bounded JSON value instead.
      let colon=end;while(colon<value.length&&/\s/.test(value[colon]))colon++;
      if(value[colon]===':'){
        let first=colon+1;while(first<value.length&&/\s/.test(value[first]))first++;
        // A log entry that merely mentions "private": true keeps its text.
        if(!entry&&decoded==='private'&&value.startsWith('true',first)&&!/[\w$]/.test(value[first+4]||''))return '[REDACTED PRIVATE CONTENT]';
        if(entry?entryKey.test(decoded):sensitiveKey.test(decoded)){
          const last=entry?entryValueEnd(value,first,decoded,scan):jsonValueEnd(value,first);
          if(last>first){
            result+=value.slice(cursor,start)+replacement+value.slice(end,first)+'"[REDACTED]"';
            cursor=last;start=last-1;continue;
          }
        }
      }
    } catch { /* Invalid JSON escapes remain text; assignment scrubbing follows. */ }
    result += value.slice(cursor, start) + replacement;
    cursor = end; start = end - 1;
  }
  return result + value.slice(cursor);
}
// Every pattern below stays linear on hostile text: open runs are bounded or
// anchored by a lookbehind, so a long word never restarts a scan at each
// character ("[\w.-]*TOKEN[\w.-]*" took 0.5 s on 64 KB of "TOKEN").
const ASSIGNED = String.raw`"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*(?=\r|\n|$)|'(?:\\.|[^'\\\r\n])*(?=\r|\n|$)|[^\s,;\r\n}]+`;
const SECRET_NAME = String.raw`API[_-]?KEY|ACC(?:OUNT|ESS)[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PRIVATE[_-]?KEY|AUTHORIZATION|COOKIE|OAUTH|CREDENTIAL|CLIENT[_-]?(?:KEY|CERTIFICATE)[_-]?DATA`;
const ENTRY_NAME = SECRET_NAME.replace('|OAUTH', '');
// A shell continuation: KEY=\ then the value on the next line.
const CONTINUED = String.raw`(?:\\\r?\n[ \t]*)?`;
const assignment = new RegExp(String.raw`(?<![\w.-])(?=[\w.-]{0,128}?(?:${SECRET_NAME}))([\w.-]{1,256}["']?\s*[=:]\s*${CONTINUED})(${ASSIGNED})`, 'gi');
// Log entries: never inside URL userinfo (https://oauth2:X@host keeps its host and path), and "auth" only as a whole name.
const entryAssignment = new RegExp(String.raw`(?<![\w.-])(?<!\/\/)(?=[\w.-]{0,128}?(?:${ENTRY_NAME})|_?o?auth(?![\w.-]))([\w.-]{1,256}(?:["'\x60]|\*{1,2})?\s*[=:]\s*(?:\*{1,2}[ \t]*)?${CONTINUED})(${ASSIGNED})`, 'gi');
// Upper-case environment names that end in a credential word: SMTP_PASS, MYSQL_PWD, REDIS_AUTH, SENDGRID_KEY.
const envAssignment = new RegExp(String.raw`(?<![\w.-])([A-Z][A-Z0-9_]{0,127}_(?:PASS|PWD|AUTH|KEY|PIN|PASSPHRASE|SALT|SIGNING)(?![\w.-])["']?[ \t]*[=:][ \t]*${CONTINUED})(?!\[REDACTED|\\\r?\n)(?:${ASSIGNED})`, 'g');
// Any armored private key, PGP included, up to its END line or the end of the text.
// A dash run starts a match only at its first dash: from every dash it was quadratic.
// A key block up to its END line; without one (a header quoted in prose, a truncated paste) the
// header and only the key-body lines after it (base64, "Proc-Type: …" headers), never the rest of
// the text. One pass: once no END follows a header, later headers do not search again.
const keyHeader = /(?<!-)-{2,}[ \t]?BEGIN (?:[A-Z0-9]+ ){0,4}(?:PRIVATE|SECRET) KEY(?: BLOCK)?-*/g;
const keyEnd = /(?<!-)-{2,}[ \t]?END (?:[A-Z0-9]+ ){0,4}(?:PRIVATE|SECRET) KEY(?: BLOCK)?-*/g;
const keyBody = /(?:[ \t]+[A-Za-z0-9+\/=]{8,4096})*(?:\r?\n(?:[A-Za-z0-9+\/=]{8,4096}|[A-Za-z][\w-]{0,40}: [^\r\n]{0,256}|(?=\r?\n[A-Za-z0-9+\/=]{8})))*/y;
function scrubPrivateKeys(text) {
  if (!text.includes('BEGIN')) return text;
  let out = '', last = 0, noEndAfter = Infinity, match;
  keyHeader.lastIndex = 0;
  while ((match = keyHeader.exec(text))) {
    let end = -1;
    if (match.index < noEndAfter) {
      keyEnd.lastIndex = keyHeader.lastIndex;
      const close = keyEnd.exec(text);
      if (close) end = close.index + close[0].length; else noEndAfter = match.index;
    }
    if (end < 0) { keyBody.lastIndex = keyHeader.lastIndex; keyBody.exec(text); end = keyBody.lastIndex; }
    out += text.slice(last, match.index) + '[REDACTED PRIVATE KEY]';
    last = keyHeader.lastIndex = end;
  }
  return out + text.slice(last);
}
const vendorToken = /(?<![\w-])(?:hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|SG\.[\w-]{8,}\.[\w-]{8,}|ya29\.[\w-]{4,}|GOCSPX-[\w-]{10,}|shp(?:at|ca|pa|ss)_[A-Fa-f0-9]{20,}|pypi-[\w-]{16,}|do[por]_v1_[A-Fa-f0-9]{20,}|whsec_[A-Za-z0-9+/]{16,}={0,2}|AGE-SECRET-KEY-1[0-9A-Z]{20,}|xapp-[\w-]{10,}|glptt-[\w-]{20,}|hv[sbr]\.[\w-]{16,})/g;
const webhook = /(https?:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)|(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks)\/)[^\s"'<>`]+/gi;
// Is this offset within a "scheme://..." run? A bounded look back, not a regex
// over the whole prefix for every address.
function insideUrl(input, offset) {
  const before = input.slice(Math.max(0, offset - 2048), offset), at = before.lastIndexOf('://');
  return at > 0 && !/[\s"'<>]/.test(before.slice(at)) && /[a-z][a-z0-9+.-]{0,31}$/i.test(before.slice(Math.max(0, at - 32), at));
}
// YAML block scalars: "password: >-" or "|" with the value on the more indented lines below.
const blockScalar = new RegExp(String.raw`^([ \t]*)(?:-[ \t]+)?(?=[\w.-]{0,128}?(?:${SECRET_NAME}))[\w.-]{1,256}["']?[ \t]*:[ \t]*[|>][1-9+-]{0,2}[ \t]*(?:#[^\r\n]*)?$`, 'gim');
function scrubBlockScalars(text) {
  if (!/[|>]/.test(text)) return text;
  let out = '', last = 0, match;
  blockScalar.lastIndex = 0;
  while ((match = blockScalar.exec(text))) {
    const indent = match[1].length, br = /\r?\n/y;
    let at = match.index + match[0].length, from = -1, to = -1, lead = '';
    for (br.lastIndex = at; br.test(text); br.lastIndex = at) {
      const start = br.lastIndex, line = text.slice(start, lineEnd(text, start)), space = /^[ \t]*/.exec(line)[0];
      if (space.length < line.length && space.length <= indent) break;
      if (space.length < line.length) { if (from < 0) { from = start; lead = space; } to = start + line.length; }
      at = start + line.length;
    }
    if (from >= 0) { out += text.slice(last, from) + lead + '[REDACTED]'; last = to; }
    if (at > blockScalar.lastIndex) blockScalar.lastIndex = at;
  }
  return out + text.slice(last);
}
// AWS SSM and Key Vault output: "Value" is the secret when its object names a parameter or vault secret.
const holderMark = /"SecureString"|:(?:ssm|secretsmanager):|\.vault\.azure\.net\/secrets\//;
const credentialName = new RegExp(String.raw`(?:${ENTRY_NAME})|_(?:PASS|PWD|KEY|AUTH|PIN)$`, 'i');
const holderName = new RegExp(String.raw`"(?:name|key|ParameterKey)"\s*:\s*"[^"\n]{0,128}?(?:${ENTRY_NAME}|_(?:PASS|PWD|KEY|AUTH|PIN)")`, 'i');
const secretHolder = o => typeof o.ARN === 'string' && /:(?:ssm|secretsmanager):/.test(o.ARN) || Object.values(o).includes('SecureString') ||
  typeof o.id === 'string' && /\.vault\.azure\.net\/secrets\//i.test(o.id) || [o.name, o.Name, o.key, o.Key, o.ParameterKey].some(n => typeof n === 'string' && credentialName.test(n));
const scrubHolders = text => !/"(?:[Vv]alue|ParameterValue)"/.test(text) ? text : text.replace(/\{[^{}]{0,4096}\}/g, object =>
  /"(?:[Vv]alue|ParameterValue)"\s*:\s*"/.test(object) && (holderMark.test(object) || holderName.test(object)) ? object.replace(/("(?:[Vv]alue|ParameterValue)"\s*:\s*)"(?:\\.|[^"\\])*"/g, '$1"[REDACTED]"') : object);
// YAML name/value pairs (k8s env, Helm values): "- name: DB_PASSWORD" then "value: XXXX" in the same
// item, or the flow form "{name: API_KEY, value: XXXX}".
const CRED_NAME = String.raw`["']?[\w.-]{0,64}?(?:${ENTRY_NAME}|_(?:PASS|PWD|KEY|AUTH|PIN|SALT|SIGNING))[\w.-]{0,64}["']?`;
const yamlPair = new RegExp(String.raw`(^[ \t]*-[ \t]+(?:name|key)[ \t]*:[ \t]*${CRED_NAME}[ \t]*\r?\n[ \t]{1,64}value[ \t]*:[ \t]*)(?!\[REDACTED|[|>]|\r?\n)(["']?)([^\s#][^\r\n#]{0,511}?)\2[ \t]*(?=#|\r?\n|$)`, 'gim');
const yamlFlowPair = new RegExp(String.raw`(\{[ \t]*(?:name|key)[ \t]*:[ \t]*${CRED_NAME}[ \t]*,[ \t]*value[ \t]*:[ \t]*)(["']?)([^\s,}][^,}\r\n]{0,511}?)\2[ \t]*(?=[,}])`, 'gi');
const scrubYamlPairs = text => !/value[ \t]*:/i.test(text) ? text : text
  .replace(yamlPair, (match, head, quote, value) => /^\$\{|^\{\{|^\[REDACTED/.test(value) ? match : head + quote + '[REDACTED]' + quote)
  .replace(yamlFlowPair, (match, head, quote, value) => /^\$\{|^\{\{|^\[REDACTED/.test(value) ? match : head + quote + '[REDACTED]' + quote);
// XML: <password>XXXX</password>, <property name="db.password" value="XXXX"/>, <add key="ApiToken" value="XXXX"/>,
// Android <string name="api_key">XXXX</string>.
const XML_NAME = String.raw`(?=[\w.:-]{0,64}?(?:${ENTRY_NAME}|_(?:PASS|PWD|KEY|AUTH)\b))[\w.:-]{1,128}`;
const xmlElement = new RegExp(String.raw`(<(${XML_NAME})(?:\s[^<>]{0,256})?>)(?!\[REDACTED|\$\{)([^<>\r\n]{1,512})(?=</\2>)`, 'gi');
const xmlAttrPair = new RegExp(String.raw`(\b(?:name|key)\s*=\s*(["'])[^"'<>]{0,128}?(?:${ENTRY_NAME}|_(?:PASS|PWD|KEY|AUTH))[^"'<>]{0,128}\2[^<>]{0,256}?\bvalue\s*=\s*(["']))(?!\[REDACTED|\$\{)([^"'<>]{1,512})(?=\3)`, 'gi');
const xmlNamedText = new RegExp(String.raw`(<(string|entry|item|value|secret)\b[^<>]{0,256}\bname\s*=\s*(["'])[^"'<>]{0,128}?(?:${ENTRY_NAME}|api[_-]?key|_(?:PASS|PWD|KEY|AUTH))[^"'<>]{0,128}\3[^<>]{0,128}>)(?!\[REDACTED|\$\{)([^<>\r\n]{1,512})(?=</\2>)`, 'gi');
const scrubXml = text => !text.includes('<') ? text : text
  .replace(xmlElement, (match, open, name, value) => placeholder(value.trim()) || referenceKey(name.replace(/^[\w.-]*:/, ''), value) || /^(?:tokeni[sz]|token[_-]?type)/i.test(name) ? match : open + '[REDACTED]')
  .replace(xmlAttrPair, (match, head, q1, q2, value) => placeholder(value) ? match : head + '[REDACTED]')
  .replace(xmlNamedText, (match, open, tag, quote, value) => placeholder(value.trim()) ? match : open + '[REDACTED]');
// Markdown tables: the cell right of a credential name, and the column under a credential header.
// A password-like name redacts any single value; a bare Token / Key / Pass (design tokens,
// map keys, test passes) only a random-looking one.
const CELL_WORD = String.raw`password|passwd|passphrase|passcode|pwd|pw|pin|secret|api[ _-]?key|access[ _-]?key|secret[ _-]?key|private[ _-]?key|signing[ _-]?(?:key|secret)|credentials?`;
const JA_CELL = String.raw`[^|]{0,12}(?:パスワード|パスフレーズ|暗証番号|シークレット|[AＡ][PＰ][IＩ]キー)`;
const WEAK_CELL = String.raw`token|key|pass|トークン|キー`;
const DESIGN = /^(?:design|color|colour|spacing|space|radius|font|theme|css|style|semantic|motion|size|shadow|typography|ui|brand|layout|z[ _-]?index|border|grid)\b/i;
// Up to three words before the credential word; a word holds no separator, so a long cell cannot backtrack.
const strongCell = new RegExp(String.raw`^(?:(?:[a-z][a-z0-9.]*[ _-]){0,3}(?:${CELL_WORD})|${JA_CELL})$`, 'i');
const weakCell = new RegExp(String.raw`^(?:(?:[a-z][a-z0-9.]*[ _-]){0,3}(?:${WEAK_CELL})|[^|]{0,12}(?:トークン))$`, 'i');
const cellText = cell => cell.trim().replace(/^\*{1,2}([^*]*)\*{1,2}$/, '$1');
function cellPolicy(cell) {
  if (cell.length > 64) return null;
  const text = cellText(cell);
  return strongCell.test(text) ? 'strong' : weakCell.test(text) && !DESIGN.test(text) ? 'weak' : null;
}
const separatorCells = cells => cells.length > 0 && cells.every(c => /^[ \t]*:?-+:?[ \t]*$/.test(c));
const KEPT_CELL = /^(?:#[0-9a-f]{3,8}|-?\d+(?:\.\d+)?(?:px|rem|em|%|ms|s|pt|vh|vw|dp|sp)|(?:rgb|hsl)a?\([^)]*\)|yes|no|y|n|true|false|on|off|none|optional|required|unknown|—|–|-|n\/a|tbd|todo|\?+|✓|✔|✗|✘|×|○|◯|〇|✅|❌)$/i;
function redactCell(cell, policy) {
  const text = cellText(cell), quoted = /^(`|["'])[^`"']+\1$/.test(text), value = quoted ? text.slice(1, -1) : text;
  if (value.length < 2 || value.startsWith('[REDACTED') || KEPT_CELL.test(value) || !quoted && /\s/.test(value)) return cell;
  if (!quoted && (placeholder(value) || KNOWN_TERM.test(value.replace(/^[~^<>=]+/, '')))) return cell;
  if (policy === 'weak' && !(/\d/.test(value) && /[A-Za-z]/.test(value) && value.length >= 6 || value.length >= 16 && /^[\w+/=.-]+$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value))) return cell;
  return cell.replace(text, '[REDACTED]');
}
// The cells of a table row, with or without outer pipes; null when the line is no table row.
function rowCells(line) {
  if (!line.includes('|')) return null;
  const outer = /^[ \t]*\|/.test(line), cells = line.split('|');
  if (cells.length > 258) return null;
  return { outer, cells, from: outer ? 1 : 0, to: outer && /\|[ \t\r]*$/.test(line) ? cells.length - 1 : cells.length };
}
function scrubTables(text) {
  if (!text.includes('|')) return text;
  const lines = text.split('\n');
  let columns = null, changed = false;
  for (let i = 0; i < lines.length; i++) {
    const row = rowCells(lines[i]);
    if (!row) { columns = null; continue; }
    const body = () => row.cells.slice(row.from, row.to);
    if (separatorCells(body())) continue;
    const next = i + 1 < lines.length ? rowCells(lines[i + 1]) : null;
    if (next && separatorCells(next.cells.slice(next.from, next.to))) { columns = row.cells.map((c, j) => j >= row.from && j < row.to ? cellPolicy(c) : null); continue; }
    if (!row.outer && !columns) continue; // a pipe in prose, not a table
    let touched = false;
    for (let j = row.from; j < row.to; j++) {
      const policy = columns?.[j] ?? (j > row.from ? cellPolicy(row.cells[j - 1]) : null);
      if (!policy) continue;
      const cell = redactCell(row.cells[j], policy);
      if (cell !== row.cells[j]) { row.cells[j] = cell; touched = true; }
    }
    if (touched) { lines[i] = row.cells.join('|'); changed = true; }
  }
  return changed ? lines.join('\n') : text;
}
// "<private>" without "</private>" is a mention: a log entry loses only the rest of that line.
function privateTags(text) {
  const closer = /<\/private>/gi;
  let close = 0;
  while (closer.exec(text)) close = closer.lastIndex;
  // Every opener before the last closer is closed; the lazy scan never runs past it.
  return text.slice(0, close).replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED PRIVATE CONTENT]') + text.slice(close).replace(/<private>[^\r\n]*/gi, '[REDACTED PRIVATE CONTENT]');
}
// Home paths become "~", except inside a URL (https://example.com/home/docs); a file: URL is a path.
const homePaths = text => text.replace(/((?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s"'<>]*)|\/(?:Users|home)\/[^/\s"']+/g, (match, url) =>
  !url ? '~' : /^file:/i.test(url) ? url.replace(/\/(?:Users|home)\/[^/\s"']+/g, '~') : match);
// A header inside a quoted argument ends at its quote; elsewhere at the end of the line or a shell pipe.
const headerValue = /(["'])((?:authorization|set-cookie|cookie)[ \t]*:[ \t]*)(?:(?!\1)[^\r\n])+|(^[ \t]*(?:[<>][ \t]*)?|(?<=\s)(?:-H|--header)[ \t=]+)((?:authorization|set-cookie|cookie)\s*:\s*)[^\r\n]+?(?=(?<![ \t])[ \t]+(?:\|\|?|&&)[ \t]|\r|\n|$)/gim;
const queryParam = /([?&#](?:access_token|token|key|api_?key|password|secret|sig|signature|x-amz-signature|x-amz-security-token|x-goog-signature|client_secret|refresh_token|id_token|private_token|auth_token)=)(?!\[REDACTED)[^&#\s'"]+/gi;
const luhn = digits => { let sum = 0; for (let i = digits.length - 1, odd = false; i >= 0; i--, odd = !odd) { let d = digits.charCodeAt(i) - 48; if (odd && (d *= 2) > 9) d -= 9; sum += d; } return sum % 10 === 0; };
const cardNumber = /(?<![\w.,-])(?:[3-6]\d|2[2-7])\d{2}(?:[ -]?\d){9,15}(?![\w-]|[.,]\d)/g;
const cardCode = /(?<![A-Za-z0-9])((?:cvv2?|cvc2?|security code|セキュリティー?コード)(?:[ \t]*[:：=＝][ \t]*|[ \t]+is[ \t]+|[ \t　]*(?:は[ \t　]*)?))\d{3,4}(?!\d)/gi;
// A TOTP seed (base32) after seed/2FA/TOTP/MFA/secret, possibly a few words later: "2FA backup seed: XXXX".
const otpSeed = /(?<![A-Za-z0-9])((?:seed|2fa|totp|mfa|otp|secret)(?:[ \t]+[A-Za-z][\w-]{0,15}){0,3}?(?:[ \t]*[:：=][ \t]*|[ \t]+is[ \t]+|[ \t]+))([A-Z2-7]{16,128}=*|[A-Z2-7]{4}(?: [A-Z2-7]{4}){3,31})(?![A-Za-z0-9])/gi;
const seedValue = (match, head, seed) => /^(?:[A-Z2-7 ]+|[a-z2-7 ]+)=*$/.test(seed) && (/[2-7]/.test(seed) || /^[A-Z ]{24,}/.test(seed)) ? head + '[REDACTED]' : match;
// .pgpass: host:port:database:user:password.
const pgpassLine = /(?<![\w.:\/-])((?:(?=[\w.-]{0,252}[A-Za-z])[\w.-]{1,253}|\d{1,3}(?:\.\d{1,3}){3}|\*):(?:\d{1,5}|\*):(?:(?=[\w.-]{0,127}[A-Za-z_])[\w.-]{1,128}|\*):(?:[\w.@+-]{1,128}|\*):)(?!\[REDACTED)(?:\\.|[^\s:'"\\]){1,512}(?=[\s'"]|$)/g;
const telegramToken = /(?<![\w-])((?:bot)?\d{6,12}:)(?=[\w-]{0,63}[A-Z])(?=[\w-]{0,63}[a-z])[\w-]{30,64}(?![\w-])/g;
function cleanText(value, depth, entry = false) {
  if (depth > 24) return '[DEPTH LIMIT]';
  let original = String(value);
  // Bound scanning and decoding work, before hashing or writing any preview.
  if (original.length > 1024 * 1024) return '[REDACTED OVERSIZE CONTENT]';
  // Text redaction cannot inspect pixels, audio or encoded files. Suppress the
  // entire containing text field, rather than keep an unsafe URI prefix/tail.
  // Never decode/hash the binary; redaction precedes payload identity/truncation.
  // A log entry (a prompt or reply that shows a data URI) loses only the payload.
  if (entry) original = original.replace(dataUriPayload, mediaPayload);
  else if (dataUri.test(original)) return mediaMarker;
  // stdout often contains JSON (including a JSON string containing more JSON).
  // Decode only complete JSON; preserve safe text byte-for-byte for source
  // review. Never infer implementation output from an input or old preview.
  if (/^\s*[\[{"]/.test(original)) {
    try {
      const decoded = JSON.parse(original);
      // A log entry is wiped only when the whole text is a privacy envelope.
      if(entry?privateEnvelope(decoded):markedPrivate(decoded,depth+1))return '[REDACTED PRIVATE CONTENT]';
      // A log entry keeps its own text (no re-serialization, nothing sliced off at 1,000
      // items): the quoted-text scan below redacts values in place. Only a JSON
      // document carrying media is rebuilt, so the payload can be dropped.
      if (!entry || hasMedia(decoded)) {
        const cleaned = scrubValue(decoded, depth + 1, entry);
        return JSON.stringify(cleaned) !== JSON.stringify(decoded) ? JSON.stringify(cleaned) : original;
      }
    } catch { /* Non-JSON logs/code still use the text scrubber below. */ }
  }
  // JSON embedded in a log line is not a complete document. Inspect its
  // quoted strings too, decoding only JSON's escapes (never eval/code).
  let text = scrubBlockScalars(scrubQuotedText(original, depth, entry));
  text = entry ? scrubPrivateKeys(privateTags(homePaths(scrubTables(scrubXml(scrubYamlPairs(scrubHolders(text)))))))
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(headerValue, (match, quote, quoted, lead, head) => quote ? quote + quoted + '[REDACTED]' : lead + head + '[REDACTED]')
    .replace(/(\bauthorization[ \t]*:[ \t]*(?:[A-Za-z][\w-]{0,31}[ \t]+)?)(?!\[REDACTED)([^\s"'<>,;]{6,512})/gi, (match, head, value) =>
      /\d/.test(value) && /[A-Za-z]/.test(value) || value.length >= 16 ? head + '[REDACTED]' : match)
    // Hyphenated key headers: Ocp-Apim-Subscription-Key: XXXX, DD-APPLICATION-KEY: XXXX, X-Auth-Token: XXXX.
    .replace(/((?:^|(?<=[\s"'{,]))(?:[A-Za-z][A-Za-z0-9]{0,31}-){1,6}(?:Key|Token|Secret|Signature|Auth)[ \t]*:[ \t]*)(?!\[REDACTED)([^\s"'<>,;]{8,512})/gim, (match, head, value) =>
      /\d/.test(value) && /[A-Za-z]/.test(value) || value.length >= 16 ? head + '[REDACTED]' : match)
    // Query and fragment parameters first, so the assignment rule below never swallows the next one.
    .replace(queryParam, '$1[REDACTED]')
    .replace(entryAssignment, (match, head, assigned, offset, input) => {
      if (keptLabel(head, assigned, offset, input, offset + match.length)) return match;
      // A quoted value keeps its quotes; an unquoted one keeps closing brackets after it ("password=X')").
      const quote = /^["']/.test(assigned) && assigned.length > 1 && assigned.endsWith(assigned[0]) ? assigned[0] : '';
      return head + quote + '[REDACTED]' + (quote || (/^["']/.test(assigned) ? '' : assigned.match(/(?<!["')\]])["')\]]*$/)[0]));
    })
    .replace(telegramToken, '$1[REDACTED TOKEN]')
    .replace(otpSeed, seedValue)
    .replace(cardNumber, digits => luhn(digits.replace(/\D/g, '')) && !/^(?:\d0{3}[ -]?)+$/.test(digits) ? '[REDACTED CARD]' : digits)
    .replace(cardCode, '$1[REDACTED]')
    .replace(pgpassLine, '$1[REDACTED]')
    : scrubPrivateKeys(text.replace(/\/(?:Users|home)\/[^/\s"']+/g, '~')
      .replace(/<private>[\s\S]*?(?:<\/private>|$)/gi, '[REDACTED PRIVATE CONTENT]'))
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
      .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
      .replace(assignment, '$1[REDACTED]');
  return text
    .replace(envAssignment, (match, head, offset, input) => entry && (NOT_SECRET.test(match.slice(head.length).replace(/^["']|["']$/g, '')) ||
      /:\s*$/.test(head) && /^[ \t]*=(?![=>])/.test(input.slice(offset + match.length, offset + match.length + 16))) ? match : head + '[REDACTED]')
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|A(?:KIA|SIA)[A-Z0-9]{16}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED TOKEN]')
    .replace(vendorToken, '[REDACTED TOKEN]')
    .replace(/(?<![\w-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED JWT]')
    .replace(webhook, '$1[REDACTED]')
    // Any scheme: a password in the userinfo (connection strings) is a secret.
    // Without this, symbols in the password left most of it before the email
    // placeholder below. Removing the whole userinfo keeps the marker. It never
    // crosses "/" or quotes, so an @ path segment of an ordinary URL (for
    // example /@vite/client) is left as it is; unencoded ? or # in a password
    // still count, as they appear in real connection strings.
    .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s\/@"'<>:]*:[^\s\/@"'<>]*@/gi, '$1[REDACTED]@')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (address, offset, input) => address.startsWith('git@') && /[:/]/.test(input[offset + address.length] || '') ? address :
      // Inside a URL (a malformed userinfo such as a password with "/"), keep the marker.
      insideUrl(input, offset) ? '[REDACTED]' : '(email omitted)')
    .replace(queryParam, '$1[REDACTED]');
}
export function scrubText(value) { return cleanText(value, 0); }
function glob(pattern) {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}
export function deniedPath(path, patterns = DEFAULT_DENY_PATHS) {
  if (typeof path !== 'string') return false;
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/');
  return patterns.some(raw => {
    const pattern = raw.trim().replaceAll('\\', '/');
    if (!pattern) return false;
    const match = glob(pattern);
    return match.test(normalized) || (!pattern.startsWith('/') &&
      parts.some((_, index) => match.test(parts.slice(index).join('/')) || match.test(parts[index])));
  });
}
function scrubValue(value, depth, entry) {
  if (depth > 24) return '[DEPTH LIMIT]';
  if (typeof value === 'string') return cleanText(value, depth, entry);
  if (Array.isArray(value)) return value.slice(0, 1000).map(v => scrubValue(v, depth + 1, entry));
  if (value && typeof value === 'object') {
    // Inside a log entry's JSON, a private object is replaced, not the whole text.
    if (entry && privateEnvelope(value)) return '[REDACTED PRIVATE CONTENT]';
    const envelope = mediaEnvelope(value), holder = entry && secretHolder(value);
    return Object.fromEntries(Object.entries(value).slice(0, 1000).map(([k, v]) =>
      [cleanText(k, 0, entry), (entry ? entryRedacts(k, v, holder) : sensitiveKey.test(k)) ? '[REDACTED]' : mediaField(k, envelope) ? mediaMarker : scrubValue(v, depth + 1, entry)]));
  }
  return value;
}
// A log entry keeps token counts, booleans, plain "auth" modes ("basic") and auth objects;
// the "Value" of an SSM parameter or a vault secret is redacted.
const entryRedacts = (key, value, holder) => entryKey.test(key)
  ? !(typeof value === 'boolean' || value === null || countKey(key) && /^\d+$/.test(String(value)) || authKey.test(key) && (typeof value !== 'string' || authWord.test(value)))
  : holder && /^[Vv]alue$/.test(key) && typeof value === 'string';
export function scrub(value, depth = 0) { return scrubValue(value, depth, false); }
export function hasDeniedPath(value, patterns = DEFAULT_DENY_PATHS, depth = 0) {
  if (depth > 24 || !value || typeof value !== 'object') return false;
  return Object.entries(value).some(([k, v]) =>
    (/(?:path|file|command|directory)/i.test(k) && typeof v === 'string' &&
      v.split(/[\s"'<>;|]+/).some(p => deniedPath(p, patterns))) || hasDeniedPath(v, patterns, depth + 1));
}
export function hasCredentialReader(value, depth = 0) {
  if (depth > 24) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, part]) => {
    // Known readers can return opaque unlabelled passwords. Match their source,
    // not the value. This is a conservative recognizer, not a shell evaluator.
    if (/^(?:command|cmd|shell_command)$/i.test(key) && typeof part === 'string') {
      const command = part.replace(/["']/g, '');
      if (/\bsecurity(?:\s+-[hilqv]+)*\s+find-(?:generic|internet)-password\b|\bgh\s+auth\s+token\b/i.test(command)) return true;
    }
    return hasCredentialReader(part, depth + 1);
  });
}
export function markedPrivate(value, depth = 0) {
  if (depth > 24) return true; // fail closed on an uninspectable deep payload
  if(typeof value==='string'){
    if(value.length>1024*1024||/<private>/i.test(value))return true;
    if(/^\s*[\[{"]/.test(value))try{return markedPrivate(JSON.parse(value),depth+1);}catch{ /* ordinary code/prose */ }
    return false;
  }
  return Boolean(value && typeof value === 'object' && (value.private === true || Object.values(value).some(v => markedPrivate(v, depth + 1))));
}
export function redactPayload(input, output, patterns = DEFAULT_DENY_PATHS) {
  if (markedPrivate(input) || markedPrivate(output)) return { input: '[REDACTED PRIVATE CONTENT]', output: '[REDACTED PRIVATE CONTENT]', denied: true };
  if (hasCredentialReader(input)) return { input: '[DENIED CREDENTIAL SOURCE]', output: '[DENIED CREDENTIAL SOURCE]', denied: true };
  if (hasDeniedPath(input, patterns)) return { input: '[DENIED PATH]', output: '[DENIED PATH]', denied: true };
  return { input: scrub(input ?? null), output: scrub(output ?? null), denied: false };
}
export function boundPayload(payload, maxBytes = 32768) {
  const encoded = JSON.stringify(payload);
  if (new TextEncoder().encode(encoded).length <= maxBytes) return { payload, truncated: false };
  // Slice before UTF-8 encoding, then cut bytes: bounded storage even for emoji/CJK.
  let preview = new TextDecoder().decode(new TextEncoder().encode(encoded.slice(0, maxBytes)).slice(0, Math.max(0, maxBytes - 512)));
  // Encoding a JSON preview again escapes quotes/backslashes. Bound the actual
  // stored representation too; a log of escaped quotes otherwise doubles size.
  while (new TextEncoder().encode(JSON.stringify({ preview, truncated: true })).length > maxBytes) preview = preview.slice(0, Math.floor(preview.length * 0.8));
  return { payload: { preview, truncated: true }, truncated: true };
}
const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
function clipStrings(value, cap) {
  if (typeof value === 'string') {
    if (value.length <= cap) return value;
    let prefix = value.slice(0, cap);
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    return prefix + '\n[TRUNCATED]';
  }
  if (Array.isArray(value)) return value.map(v => clipStrings(v, cap));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,clipStrings(v,cap)]));
  return value;
}
function boundedSide(value, bytes) {
  if (jsonBytes(value) <= bytes) return value;
  if (bytes < 32) return null; // even a JSON preview envelope cannot fit
  // Preserve nested Read content as actual strings, not serialized JSON. This
  // retains literal code/newlines for source review and lexical admission.
  if (jsonBytes(clipStrings(value, 0)) > bytes) return boundPayload(value, bytes).payload;
  let low = 0, high = bytes;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(clipStrings(value, middle)) <= bytes) low = middle;
    else high = middle - 1;
  }
  return clipStrings(value, low);
}
/** Input is never output evidence, including when either side exceeds its budget.
 * Call only AFTER full redaction; hashing remains the caller's pre-truncation step.
 * Legacy previews are not decoded or upgraded into output. */
export function boundToolPayload(payload, maxBytes = 32768) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw Error('invalid tool payload budget');
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload,'input') || !Object.hasOwn(payload,'output')) return boundPayload(payload,maxBytes);
  if (jsonBytes(payload) <= maxBytes) return {payload,truncated:false};
  const {input,output,...metadata} = payload;
  const header = boundPayload(metadata,Math.floor(maxBytes/8)).payload;
  const available = maxBytes - jsonBytes({...header,input:null,output:null,truncated:true}) - 128;
  const inputBudget = Math.min(jsonBytes(input),Math.floor(available/4));
  const result = {...header,input:boundedSide(input,inputBudget),output:boundedSide(output,available-inputBudget),truncated:true};
  if (jsonBytes(result)>maxBytes) throw Error('tool payload budget exceeded');
  return {payload:result,truncated:true};
}

// Free-text secrets written in prose, which the assignment rules above miss:
// "パスワードXXXXで接続", "パスワードは XXXX", "password is XXXX", "pw: XXXX",
// "暗証番号 1234", "the password for the staging db is XXXX". The keyword and
// connector stay; only the value is replaced. What joins the value to the
// keyword sets how credential-like it must look: "=" always redacts; after ":"
// a short value must look like a credential ("パスワード: 8文字以上" stays);
// after "is"/"は" it needs digits and letters or symbols; after bare
// whitespace six such characters, so "pass --dry-run" and "pass userId" stay.
const FREE_CATEGORY = {
  'パスワード': 'password', 'パスフレーズ': 'password', '暗証番号': 'pin', 'パスコード': 'pin', '認証コード': 'pin', 'pin番号': 'pin', 'pinコード': 'pin',
  'パス': 'jpass', 'アクセスキー': 'token', '認証キー': 'token', 'apiキー': 'token', 'トークン': 'token', 'アクセストークン': 'token', 'シークレット': 'token',
  password: 'password', passwd: 'password', passphrase: 'password', pass: 'password', pwd: 'password', pw: 'password', passcode: 'pin',
  pin: 'pin', token: 'token', authtoken: 'token', accesstoken: 'token', secret: 'token', apikey: 'token', accesskey: 'token', cookie: 'token',
};
const JA_KEYWORD = String.raw`アクセストークン|パスワード|パスフレーズ|暗証番号|パスコード|認証コード|アクセスキー|認証キー|[PＰ][IＩ][NＮ](?:番号|コード)|[AaＡａ][PpＰｐ][IiＩｉ]\s?キー|トークン|シークレット|パス(?![ァ-ヶー])`;
// Japanese particles and arrows that join a keyword to its value ("passwordは XXXX", "pw→XXXX").
const JA_JOIN = String.raw`\s*(?:は|が|を|に|も|として)[、,，]?\s*|\s*[、,，]\s*`;
const ARROW = String.raw`\s*(?:->|→|=>)\s*`;
// Markdown around a label: **Password:** XXXX, - **Password**: XXXX, `JWT_SECRET`: `XXXX`.
const MARK = String.raw`(?:\*{1,2}|\x60)`;
const EN_KEYWORD = String.raw`password|passwd|passphrase|passcode|pass|pwd|pw|pin|(?:auth|access)[_-]?token|token|secret|api[ _-]?key|access[ _-]?key|cookie`;
const EXPLICIT = String.raw`\s*(?:[:：＝]|=(?![>=]))\s*`;
const ADVERB = String.raw`(?:(?:now|still|just|currently|actually|simply)\s+)?`;
// Full-width letters, digits and symbols count too: "パスワード：Ｆａｋｅ１２３４".
const VALUE_CHAR = String.raw`A-Za-z0-9!#$%&*+\-./:;=?@^_~|\\\[\]{}<>０-９Ａ-Ｚａ-ｚ！＃＄％＆＊＋－＠＿`;
// A quoted value may hold spaces; an unquoted one ends at a space, a comma
// before a space, or a non-ASCII letter ("パスワードXXXXで接続").
const FREE_VALUE = String.raw`"[^"\n]{1,256}"|'[^'\n]{1,256}'|「[^」\n]{1,256}」|『[^』\n]{1,256}』|“[^”\n]{1,256}”|‘[^’\n]{1,256}’|\x60[^\x60\n]{1,256}\x60|[「『"'“‘\x60(（]?(?:[${VALUE_CHAR}]|,(?=[${VALUE_CHAR}])){1,256}`;
const freeRules = [
  // Japanese keywords: the value may follow without any space.
  new RegExp(String.raw`(${JA_KEYWORD})((?:${MARK})?(?:${EXPLICIT}|${ARROW}|${JA_JOIN}|[ \t　]*)(?:${MARK}[ \t]*)?)(${FREE_VALUE})`, 'g'),
  // A short phrase between: 「暗証番号を教えます: 4821」「パスワードですが、XXXX」
  new RegExp(String.raw`(${JA_KEYWORD})([^\x00-\x7F「」『』（）、。，．：＝\s]{1,12}?(?:${EXPLICIT}|(?:[、,，]|(?:は|が)[、,，]?)\s*))(${FREE_VALUE})`, 'g'),
  // English keywords: whole words only (not "bypass", "tokens", "passport"),
  // though "_" may precede one (SMTP_PASS=, _authToken).
  new RegExp(String.raw`(?<![A-Za-z0-9])(${EN_KEYWORD})(?![A-Za-z0-9])((?:${MARK})?(?:["']?${EXPLICIT}|${ARROW}|${JA_JOIN}|\s+(?:is|was|are|to|as)\s+${ADVERB}|[ \t]+)(?:${MARK}[ \t]*)?)(${FREE_VALUE})`, 'gi'),
  // Up to five words between: "the password for the staging db is XXXX".
  new RegExp(String.raw`(?<![A-Za-z0-9])(${EN_KEYWORD})(?![A-Za-z0-9])((?:[ \t]+[A-Za-z][\w'-]{0,24}){1,5}?(?:\s+(?:is|was|are|to)\s+${ADVERB}|["']?${EXPLICIT}))(${FREE_VALUE})`, 'gi'),
  // A user and password pair: "credentials: admin / XXXX", "login: admin:XXXX".
  new RegExp(String.raw`(?<![A-Za-z0-9])(credentials?|creds|login|認証情報|ログイン情報)(${EXPLICIT}(?:\(email omitted\)|[^\s/:：,]{1,64})\s*[/:／]\s*)(${FREE_VALUE})`, 'gi'),
  new RegExp(String.raw`(?<![A-Za-z0-9])((?:ID|ＩＤ|user(?:name)?|ユーザー(?:名|ID)?)\s*(?:と|/|／|・|&|and)\s*(?:パスワード|パス|PW|ＰＷ|pass(?:word)?))((?:${EXPLICIT}|${JA_JOIN}|\s+(?:is|are)\s+)(?:\(email omitted\)|[^\s/／:：,、]{1,64})\s*[/／:：]\s*)(${FREE_VALUE})`, 'gi'),
];
const KNOWN_TERM = /^(?:v?\d+(?:\.(?:\d+|x|\*))+(?:[-+][\w.]+)?|v\d+|sha-?\d+|md5|bcrypt|scrypt|argon2(?:id|i|d)?|pbkdf2(?:[-_]\w+)?|hmac(?:[-_]?sha-?\d+)?|aes-?\d+(?:-\w+)?|rsa-?\d+|ed25519|ecdsa|[hre]s(?:256|384|512)|base(?:32|58|64)(?:url)?|utf-?(?:8|16)|https?(?:\/[\d.]+)?|http[23]|oauth2?|[23]fa|ipv[46]|tls(?:v?1(?:\.[0-3])?)?|ssl(?:v?[23])?|x\.?509|pkcs#?\d+)$/i;
// Flags, paths, calls, placeholders and masks are not secrets.
const NOT_SECRET = /^(?:-|\.{0,2}\/|~\/|[=>]|(?:your|my|an?)[-_][\w-]{0,64}$|[\w-]{1,64}[-_]here$|[A-Za-z_$][\w$.]{0,127}\(|<[^<>]*>$|\{\{[^{}]*\}\}$|\$\{\{?[^{}]*(?:\}\}?)?$|\$[A-Z_][A-Z0-9_]*$|%[A-Z_][A-Z0-9_]*%$|([*xX•.#])\1{2,}$)/;
// Dotted code references (process.env.X, foo.bar.baz, config.auth.token) are not secrets either; a long dotted
// value with no lower-case segment ("Correct.Horse.Battery.Staple") or a random-looking segment is.
function codeRef(value) {
  if (value.length < 16) return /^[A-Za-z_$][A-Za-z_$]*(?:\.[A-Za-z_$][A-Za-z_$]*)+(?:\(\))?$/.test(value);
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/.test(value)) return false;
  const parts = value.split('.');
  return parts.some(part => /^[a-z_$]/.test(part)) && !parts.some(part => /\d/.test(part) && /[a-z]/.test(part) && /[A-Z]/.test(part));
}
// What a config line holds when it holds no secret: type words, empty quotes, YAML
// block indicators, placeholders, references and masks.
const TYPE_WORD = /^(?:string|number|boolean|bool|int|integer|float|str|any|object|unknown|true|false|null|nil|none|undefined|required|optional|~)$/i;
const placeholder = value => TYPE_WORD.test(value) || /^(?:""|''|[|>][1-9+-]{0,2})$/.test(value) || NOT_SECRET.test(value) || codeRef(value);
function looksSecret(category, raw, strength) {
  const whole = String(raw).normalize('NFKC').replace(/\s+/g, ''), value = whole.replace(/(?<![.,;:!?)\]}>"'])[.,;:!?)\]}>"']+$/, '');
  if (!value || value.startsWith('[REDACTED') || NOT_SECRET.test(whole) || NOT_SECRET.test(value) || codeRef(value)) return false;
  if (strength === 'assigned') return true;
  if (value.length < 4 || KNOWN_TERM.test(value)) return false;
  if (/^\d+$/.test(value)) return category === 'pin' || category === 'password' && strength !== 'bare';
  const upper = value.replace(/[^A-Z]/g, '').length, lower = value.replace(/[^a-z]/g, '').length;
  const strong = /\d/.test(value) && /[A-Za-z]/.test(value) || /[!@#$%^&*+=?~|\\]/.test(value) && /[A-Za-z0-9]/.test(value) ||
    value.length >= 16 && /^[\w+/=-]+$/.test(value) && upper * 4 >= value.length && lower * 4 >= value.length; // random mixed case
  if (category === 'jpass') return strong && value.length >= 6 && !/[\/\\]/.test(value);
  if (category === 'pair') return value.length >= 4 && !placeholder(value);
  if (strength === 'bare') return strong && value.length >= 6;
  if (strong) return true;
  if (strength === 'connector') return value.length >= 20 && /^[A-Za-z]+$/.test(value);
  return value.length >= 12 || value.length >= 8 && /[a-z][A-Z]/.test(value);
}
// In a log entry "token: string" or "secret: true" is a label, not a
// credential: after ":" a short value must look like one, unless the key starts
// a config line (YAML, compose, .env, k8s stringData) and the value ends it.
// "==" and "=>" are comparisons and arrows, not assignments.
// Names that hold no credential although they contain a credential word: tokenize/tokenizer,
// token_type, OAuth *_endpoint/*_url metadata, secretName/secret_ref references, *_file paths.
const referenceName = /(?:tokeni[sz](?:e[rd]?|ation)s?|(?:endpoint|url|uri|name|ref|path|file|dir|header|field|prefix|mode|policy|ttl|type|kind|length|size|format)s?)$/i;
const fetchMode = /^["']?(?:include|omit|same-origin)["']?$/;
const referenceKey = (name, value) => referenceName.test(name) || /^credentials$/i.test(name) && fetchMode.test(value);
const configLead = /(^|\n)[ \t]*(?:[-+>][ \t]*)?$/, configTail = /(?:[ \t]+#[^\r\n]{0,256})?[ \t]*(?:\r?\n|$)/y;
function keptLabel(head, assigned, offset, input, after) {
  const name = /^[\w.-]*/.exec(head)[0], bare = quotedValue(assigned);
  // "password: str = …", "apiKey: string = …": a type annotation; the value after "=" is the code rule's.
  if (/[:]\s*$/.test(head) && /^[ \t]*=(?![=>])/.test(input.slice(after, after + 16))) return true;
  // Already redacted (by the quoted-text scan too), empty, or a JSON object/array (scanned key by key).
  if (/^["']?\[REDACTED/.test(assigned) || /^(["'])\1$/.test(assigned) || /^[{[(]/.test(assigned) || countKey(name) && /^\d+$/.test(bare) || authKey.test(name) && authWord.test(assigned)) return true;
  if (referenceKey(name, assigned)) return true;
  // Code: "token = await getToken()", "password = input(...)", "x = new Foo()".
  if (head.includes('=')) return /^[=>]/.test(assigned) || codeRef(bare.replace(/(?<![;,)])[;,)]+$/, '')) ||
    /^[A-Za-z_$][\w$.]*\[/.test(bare) || /^(?:\$\d+|\?|:[a-z_]\w*|%s|@\w+)$/.test(bare) || /^[A-Z][A-Za-z]+-[A-Z][A-Za-z]+$/.test(bare) || /^(?:(?:your|my|an?)[-_][\w-]{0,64}|[\w-]{1,64}[-_]here|<[^<>]*>|x{3,}|\*{3,})$/i.test(bare) || /^(?:await|new|yield|typeof|async|function|lambda)$/.test(assigned) || /^[A-Za-z_$][\w$.]*\(/.test(assigned);
  if (/^["']/.test(assigned)) return false;
  const from = Math.max(0, offset - 64), lead = configLead.exec(input.slice(from, offset));
  configTail.lastIndex = after;
  if (lead && (lead[1] || from === 0) && !/["']/.test(head) && configTail.test(input)) return placeholder(assigned);
  return !looksSecret(/pass|pwd/i.test(head) ? 'password' : 'token', assigned, 'explicit');
}
const strengthOf = connector => /[=＝]/.test(connector) ? 'assigned' : /[:：]/.test(connector) ? 'explicit' : connector.trim() ? 'connector' : 'bare';
const QUOTE_CLOSE = { '"': '"', "'": "'", '「': '」', '『': '』', '“': '”', '‘': '’', '`': '`', '(': ')', '（': '）' };
function redactFree(match, keyword, connector, value, after) {
  if (/^.?\[REDACTED/.test(value) || value === '\\' && /^\r?\n/.test(after)) return null;
  // "secret: getSecret()" and "password = input(...)" name a call; "token = await …" is code.
  if (/^[A-Za-z_$][\w$.]*$/.test(value) && /^\(/.test(after) || /^(?:await|new|yield|typeof|async|function|lambda)$/.test(value)) return null;
  // Code, not a credential: a type annotation before "=" (password: Optional[str] = …), a subscript
  // (tokens[0], request.form['password']), a query parameter ($1, ?), a PowerShell cmdlet.
  if (/[:：]/.test(connector) && /^[ \t]*[\]\w]*[ \t]*=(?![=>])/.test(after)) return null;
  if (/^[A-Za-z_$][\w$.]*\[/.test(value) || /^(?:\$\d+|\?|:[a-z_]\w*|%s|@\w+)$/.test(value) || /^[A-Z][A-Za-z]+-[A-Z][A-Za-z]+$/.test(value)) return null;
  const category = /^(?:id|ｉｄ|user|ユーザー)/i.test(keyword) && /[と/／・&]|\band\b/i.test(keyword) ? 'pair'
    : FREE_CATEGORY[keyword.normalize('NFKC').toLowerCase().replace(/[\s_-]/g, '')] || 'password';
  const strength = strengthOf(connector);
  // Lower-case "pin" needs a connector ("pin 18.x" pins a version); "PIN 4821" does not.
  if (strength === 'bare' && /^pin$/i.test(keyword) && keyword !== 'PIN') return null;
  const close = QUOTE_CLOSE[value[0]] || '';
  const open = close ? value[0] : '', quoted = close && value.length > 1 && value.endsWith(close) && close !== ')' && close !== '）';
  let core = value.slice(open.length, quoted ? -1 : undefined), tail = quoted ? close : '';
  if (!quoted) { tail = core.match(/(?<![.,;:)\]}>])[.,;:)\]}>]*$/)[0]; core = core.slice(0, core.length - tail.length); }
  const quotedPassword = quoted && (strength !== 'bare' || open === '「' || open === '『') && /^(?:password|pin|jpass)$/.test(category) && core.length >= 3 && !placeholder(core) &&
    (/[0-9０-９]/.test(core) || /[A-Za-zＡ-Ｚａ-ｚ]/.test(core) && !KNOWN_TERM.test(core));
  return quotedPassword || looksSecret(category, quoted ? core : core + tail, strength) ? keyword + connector + open + '[REDACTED]' + tail : null;
}
// Replace accepted matches; after a rejected one, resume right after its
// keyword, so "pass token XXXX" or "the password for the db is XXXX" is still seen.
function replaceSome(text, rule, decide) {
  let out = '', last = 0, match;
  rule.lastIndex = 0;
  while ((match = rule.exec(text))) {
    const replacement = decide(...match, text.slice(rule.lastIndex, rule.lastIndex + 66));
    if (replacement === null) { rule.lastIndex = match.index + match[1].length; continue; }
    out += text.slice(last, match.index) + replacement;
    last = rule.lastIndex;
  }
  return out + text.slice(last);
}
export function scrubFreeTextSecrets(value) {
  const text = String(value);
  return text.length > 1024 * 1024 ? '[REDACTED OVERSIZE CONTENT]' : freeTextSecrets(text);
}
function freeTextSecrets(text) {
  for (const rule of freeRules) text = replaceSome(text, rule, redactFree);
  return text;
}
// Credentials given to well-known commands as arguments. Each rule names its
// command, so "-p 8080" or "-u 1000:1000" elsewhere is left alone.
const ARG = String.raw`"[^"\n]{0,512}"?|'[^'\n]{0,512}'?|(?!\\)[^\s"'|;&<>]{1,512}`;
// Between a flag and its value: spaces, or a "\" + newline continuation.
const GAP = String.raw`(?:[ \t]*\\\r?\n)?[ \t]+`;
const IN_COMMAND = String.raw`(?:[^\n\\]|\\\r?\n|\\(?!\r?\n)){0,240}?[ \t]`;
// Every password flag of a keytool line can be sensitive. Its lookbehind only
// has work to do when the case-sensitive command name is present.
const keytoolPassword = new RegExp(String.raw`((?<=\bkeytool\b(?:[^\n\\]|\\\r?\n|\\(?!\r?\n)){0,400}?)[ \t]-(?:store|key|src(?:store|key)|dest(?:store|key)|new)pass${GAP})(${ARG})`, 'g');
const commandRules = [
  new RegExp(String.raw`(\b(?:mysql|mariadb)[\w-]*\b${IN_COMMAND}-p)(?=[^\s-])(${ARG})`, 'g'), // -pXXXX; a bare -p prompts
  new RegExp(String.raw`(\bredis-cli\b${IN_COMMAND}(?:-a|--pass)${GAP})(${ARG})`, 'g'),
  new RegExp(String.raw`(\bsshpass\b${IN_COMMAND}-p(?:${GAP})?)(${ARG})`, 'g'),
  new RegExp(String.raw`(\b(?:(?:docker|podman|buildah|skopeo|nerdctl|oras|helm[ \t]+registry|az|oc|cf)[ \t]+login|twine[ \t]+upload)\b${IN_COMMAND}(?:-p|--password)(?:${GAP}|=))(${ARG})`, 'g'),
  new RegExp(String.raw`(\b(?:sqlcmd|bcp)\b${IN_COMMAND}-P(?:${GAP})?)(${ARG})`, 'g'),
  new RegExp(String.raw`(\bssh-keygen\b${IN_COMMAND}-N(?:${GAP})?)(?!''|""|\[REDACTED)(${ARG})`, 'g'),
  new RegExp(String.raw`(\bldap(?:search|add|modify|delete|passwd|whoami)\b${IN_COMMAND}-w${GAP})(${ARG})`, 'g'),
  new RegExp(String.raw`(\bcurl\b${IN_COMMAND}(?:-u|--user|-U|--proxy-user)(?:${GAP}|=)?["']?(?:\(email omitted\)|[^\s:"']{0,128}):)([^\s"']{1,512})`, 'g'),
  new RegExp(String.raw`(\bcurl\b${IN_COMMAND}(?:-b|--cookie)(?:[ \t]+|=))(${ARG})`, 'g'),
  new RegExp(String.raw`(\bgh[ \t]+secret[ \t]+set\b${IN_COMMAND}(?:--body|-b)(?:[ \t]+|=)?)(${ARG})`, 'g'),
  new RegExp(String.raw`(\b(?:un)?zip\b${IN_COMMAND}-[a-zA-Z]*P(?:${GAP})?)(${ARG})`, 'g'),
  new RegExp(String.raw`(\b7za?\b${IN_COMMAND}-p)(?=[^\s-])(${ARG})`, 'g'),
  new RegExp(String.raw`(\bopenssl\b${IN_COMMAND}(?:-k${GAP}|-pass(?:in|out)?${GAP}(?:pass|env):|-passphrase${GAP}))(${ARG})`, 'g'),
  new RegExp(String.raw`(\bsecurity[ \t]+add-(?:generic|internet)-password\b${IN_COMMAND}-w${GAP})(${ARG})`, 'g'),
  keytoolPassword,
  new RegExp(String.raw`(\bsmbclient\b${IN_COMMAND}(?:-U|--user)(?:[ \t]+|=)(?:\(email omitted\)|[^\s%]{1,128})%)(${ARG})`, 'g'),
  new RegExp(String.raw`(\b(?:mongosh|mongo|mongodump|mongorestore)\b${IN_COMMAND}(?:-p|--password)(?:${GAP}|=)?)(${ARG})`, 'g'),
  new RegExp(String.raw`(\brabbitmqctl[ \t]+(?:add_user|change_password)[ \t]+\S{1,128}[ \t]+)(${ARG})`, 'g'),
  new RegExp(String.raw`(\bhtpasswd\b(?=[^\n|;&]{0,400}?[ \t]-[a-zA-Z]*b)[^\n|;&]{0,400}[ \t])(${ARG})(?=[ \t]*(?:$|[\r\n|;&]))`, 'gm'),
  // Long credential flags of any command: --password X, --token=X, --client-secret X.
  new RegExp(String.raw`((?<![\w-])--(?:password|passwd|pass|pwd|token|secret|api-?key|auth-token|access-token|client-secret|db-password|secret-key|secret-access-key|private-key-password|key-password|store-password)(?:${GAP}|=))(${ARG})`, 'gi'),
  new RegExp(String.raw`(^[ \t]*(?:requirepass|masterauth)[ \t]+)(${ARG})`, 'gm'),
  // YAML argument lists: "- --password" then "- XXXX" on the next item.
  new RegExp(String.raw`(^[ \t]*-[ \t]+["']?--(?:password|passwd|pass|pwd|token|secret|api-?key|auth-token|access-token|client-secret)["']?[ \t]*\r?\n[ \t]*-[ \t]+)(${ARG})`, 'gim'),
  // npm/yarn/aws/git config: the value of a key that names a credential.
  new RegExp(String.raw`(\b(?:config(?:ure)?[ \t]+set|git[ \t]+config)[ \t]+(?:--?[\w-]+[ \t]+){0,4}["']?(?=[^\s"']{0,200}?(?:token|secret|passw|passphrase|auth|key))[^\s"']{1,256}["']?[ \t]+)(${ARG})`, 'gi'),
  // A value piped into a secret store or a login: echo XXXX | wrangler secret put NAME.
  new RegExp(String.raw`(\b(?:echo|printf)[ \t]+(?:-[neE]{1,3}[ \t]+)?)(${ARG})(?=[ \t]*\|[^\n]{0,160}?(?:secret|passw|token|login|stdin|credential|sudo[ \t]+-S|sudo[ \t]+--stdin|chpasswd))`, 'gi'),
];
const hereString = new RegExp(String.raw`(<<<[ \t]*)(${ARG})`, 'g');
// Owners of a key whose value is a secret (encryption_key, signingKey, masterKey); sort_key, primaryKey,
// partition_key, idempotency_key and storage_key name ordinary keys.
const KEY_OWNER = String.raw`encryption|encrypt|crypt|signing|sign|secret|private|master|hmac|aes|jwt|session[_-]?secret|cookie[_-]?secret|webhook|license|ssh|gpg|pgp|cipher|kms|app[_-]?secret|client[_-]?secret|stripe|twilio|sendgrid|mailgun|recaptcha`;
const CODE_NAME = String.raw`(?=[\w.-]{0,64}?(?:${ENTRY_NAME}|_(?:PASS|PWD|KEY|SALT|AUTH|SIGNING)(?![a-z])))[\w.-]{1,128}`;
const QUOTED = String.raw`(?:"(?:\\.|[^"\\\n]){1,512}"|'(?:\\.|[^'\\\n]){1,512}')`;
const codeRules = [
  // PHP / Ruby hashes: 'password' => 'XXXX', :password => 'XXXX'.
  new RegExp(String.raw`((?<![\w.-])[:"']?${CODE_NAME}["']?[ \t]*=>[ \t]*)(${QUOTED})`, 'gi'),
  // define('DB_PASSWORD', 'XXXX').
  new RegExp(String.raw`(\bdefine[ \t]*\([ \t]*["']${CODE_NAME}["'][ \t]*,[ \t]*)(${QUOTED})`, 'gi'),
  // SQL: IDENTIFIED [WITH plugin] BY 'XXXX', [ENCRYPTED] PASSWORD 'XXXX'.
  new RegExp(String.raw`(\bIDENTIFIED[ \t]+(?:WITH[ \t]+\S{1,64}[ \t]+)?(?:BY|AS)[ \t]+(?:PASSWORD[ \t]*\(?[ \t]*)?)(${QUOTED})`, 'gi'),
  new RegExp(String.raw`(\b(?:WITH|USER[ \t]+\S{1,128}|ROLE[ \t]+\S{1,128})[ \t]+(?:(?:ENCRYPTED|UNENCRYPTED)[ \t]+)?PASSWORD[ \t]+)('(?:[^'\n]|''){1,512}')`, 'gi'),
  // Escaped JSON in text: {\"password\":\"XXXX\"}.
  new RegExp(String.raw`(\\"${CODE_NAME}\\"[ \t]*:[ \t]*\\")((?:[^"\\\n]|\\[^"\n]){1,512})(?=\\")`, 'gi'),
  // A key and its value in an array or tuple: ["X-Api-Key", "XXXX"], ('password', 'XXXX').
  new RegExp(String.raw`([\[(][ \t]*["']${CODE_NAME}["'][ \t]*,[ \t]*)(${QUOTED})`, 'gi'),
  // Lower- and camel-case key names hold a secret when the value looks random: signing_key: 8f7a…, masterKey: "…".
  new RegExp(String.raw`((?<![\w.-])(?:[\w.-]{0,48}?[_.-])?(?:${KEY_OWNER})(?:[_.-]?(?:key|salt)|Key|Salt)["']?[ \t]*[=:][ \t]*|(?<![\w.-])(?:[\w.-]{0,48}?[_.-])?(?:salt|signing(?:[_-]?(?:key|secret))?)["']?[ \t]*[=:][ \t]*)((["']?)[A-Za-z0-9+/_=-]{16,512}\3)(?![\w+/=.-])`, 'gi'),
  // A password passed by position: DriverManager.getConnection(url, "root", "XXXX"), new Sequelize('db', 'root', 'XXXX'),
  // smtp.login('bot@example.com', 'XXXX').
  new RegExp(String.raw`(\bgetConnection[ \t]*\([ \t]*[^,()\n]{1,256},[ \t]*${QUOTED}[ \t]*,[ \t]*)(${QUOTED})`, 'g'),
  new RegExp(String.raw`(\bSequelize[ \t]*\([ \t]*${QUOTED}[ \t]*,[ \t]*${QUOTED}[ \t]*,[ \t]*)(${QUOTED})`, 'g'),
  new RegExp(String.raw`(\.login[ \t]*\([ \t]*(?:${QUOTED}|[A-Za-z_][\w.]{0,64})[ \t]*,[ \t]*)(${QUOTED})(?=[ \t]*\))`, 'g'),
  // A typed assignment: db_password: str = "XXXX", private readonly apiKey: string = "XXXX", const API_KEY: &str = "XXXX".
  new RegExp(String.raw`((?<![\w.-])${CODE_NAME}[ \t]{0,8}:[ \t]{0,8}[\w.&<>\[\]|?,][\w.&<>\[\]|?, ]{0,63}?[ \t]{0,8}=(?![=>])[ \t]*)(${QUOTED})`, 'gi'),
  // A shell/compose default: \${POSTGRES_PASSWORD:-XXXX}.
  new RegExp(String.raw`(\$\{${CODE_NAME}:?[-=?+])([^}\s"']{1,256})(?=\})`, 'gi'),
  // PowerShell: ConvertTo-SecureString "XXXX" -AsPlainText.
  new RegExp(String.raw`(\bConvertTo-SecureString[ \t]+(?:-String[ \t]+)?)(${QUOTED})`, 'gi'),
  // A credential assigned through an index: app.config['SECRET_KEY'] = 'XXXX', os.environ["DB_PASSWORD"] = "XXXX".
  new RegExp(String.raw`(\[[ \t]*["']${CODE_NAME}["'][ \t]*\][ \t]*=(?![=>])[ \t]*)(${QUOTED})`, 'gi'),
  // Go MySQL DSN: user:XXXX@tcp(host:3306)/db.
  new RegExp(String.raw`((?<![\w/:.-])[\w.-]{1,64}:)([^\s@:/'"()]{1,128})(?=@(?:tcp|unix|udp)\()`, 'g'),
  // Basic-auth helpers and setters: httpx/aiohttp.BasicAuth('u', 'XXXX'), auth=(user, 'XXXX'), setPassword("XXXX"), .password("XXXX").
  new RegExp(String.raw`(\b(?:\w+\.)?(?:HTTP)?(?:Basic|Digest|Proxy)Auth[ \t]*\([ \t]*(?:${QUOTED}|[A-Za-z_][\w.]{0,64})[ \t]*,[ \t]*)(${QUOTED})`, 'g'),
  new RegExp(String.raw`(\bauth[ \t]*=[ \t]*\([ \t]*[A-Za-z_][\w.]{0,64}[ \t]*,[ \t]*)(${QUOTED})`, 'g'),
  new RegExp(String.raw`(\.(?:set)?(?:Password|password|Passwd|Secret|secret|ApiKey|apiKey|Token|token)[ \t]*\([ \t]*)(${QUOTED})(?=[ \t]*\))`, 'g'),
  // SQL: SET PASSWORD [FOR user] = 'XXXX'.
  new RegExp(String.raw`(\bSET[ \t]+PASSWORD\b[^;\n=]{0,160}=[ \t]*(?:PASSWORD[ \t]*\([ \t]*)?)('(?:[^'\n]|''){1,512}')`, 'gi'),
  // A credential fallback: process.env.DB_PASSWORD || "XXXX", os.getenv("TOKEN", "XXXX").
  new RegExp(String.raw`((?:${CODE_NAME})[ \t]*(?:\)[ \t]*)?(?:\|\||\?\?)[ \t]*)(${QUOTED})`, 'gi'),
  new RegExp(String.raw`(\bgetenv[ \t]*\([ \t]*["']${CODE_NAME}["'][ \t]*,[ \t]*)(${QUOTED})`, 'gi'),
  // Python requests: auth=('user', 'XXXX'), HTTPBasicAuth('user', 'XXXX').
  new RegExp(String.raw`((?:\bauth[ \t]*=[ \t]*\(|\bHTTP(?:Basic|Digest|Proxy)Auth[ \t]*\()[ \t]*(?:${QUOTED})[ \t]*,[ \t]*)(${QUOTED})`, 'g'),
];
const quotedValue = value => /^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value;
function keepCode(match, head, value) {
  const inner = quotedValue(value);
  // A typed or assigned name that holds no credential (tokenize: str = "trigram", token_url: str = …).
  if (referenceName.test(/^[\w.-]+/.exec(head.trim())?.[0] ?? '')) return match;
  if (inner.startsWith('[REDACTED') || placeholder(inner) || /^\$\{?[A-Za-z_]\w*\}?$/.test(inner) || /^[a-z_]+(?::[\w,.]+)?(?:\|[a-z_]+(?::[\w,.]+)?)+$/.test(inner)) return match;
  // The last rule needs a random-looking value: digits and letters, 16+ characters.
  if (/(?:key|salt|signing(?:[_-]?(?:key|secret))?)["']?[ \t]*[=:][ \t]*["']?$/i.test(head) && !(/\d/.test(inner) && /[A-Za-z]/.test(inner))) return match;
  const q = value !== inner ? value[0] : '';
  return head + q + '[REDACTED]' + q;
}
// Already redacted, or a shell variable ("$TOKEN" expands; '$x' in single quotes would not).
const keepRedacted = (match, head, value) => /^["']?\[REDACTED|^"?\$\{?[A-Za-z_]\w*\}?"?$/.test(value) ? match : head + '[REDACTED]';
// An argv array (MCP server configs, Codex exec): its elements joined are one command line.
const argvArray = /\[(?:[ \t\r\n]*"(?:[^"\\\n]|\\.){0,512}"[ \t\r\n]*,){1,63}[ \t\r\n]*"(?:[^"\\\n]|\\.){0,512}"[ \t\r\n]*\]/g;
function scrubArgv(text) {
  if (!text.includes('",') && !text.includes('", ')) return text;
  return text.replace(argvArray, array => {
    let items;
    try { items = JSON.parse(array); } catch { return array; }
    if (!items.every(item => typeof item === 'string' && item && !/\s/.test(item))) return array;
    const joined = items.join(' '), cleaned = scrubCommandLine(joined);
    const parts = cleaned.split(' ');
    if (cleaned === joined || parts.length !== items.length) return array;
    let i = 0;
    return array.replace(/"(?:[^"\\\n]|\\.)*"/g, quoted => { const k = i++; return parts[k] === items[k] ? quoted : JSON.stringify(parts[k]); });
  });
}
function scrubCommandLine(text) {
  for (const rule of commandRules) {
    if (rule === keytoolPassword && !text.includes('keytool')) continue;
    text = text.replace(rule, keepRedacted);
  }
  return text;
}
function scrubCommandSecrets(text) {
  text = scrubCommandLine(scrubArgv(text));
  for (const rule of codeRules) text = text.replace(rule, keepCode);
  // A here-string on a line that names a secret: wrangler secret put NAME <<< XXXX.
  return text.replace(hereString, (match, head, value, offset, input) => {
    const line = input.slice(Math.max(0, offset - 240), offset);
    return /secret|passw|token|login|credential|key/i.test(line.slice(line.lastIndexOf('\n') + 1)) ? keepRedacted(match, head, value) : match;
  });
}
/** The one scrubber for cf-memory log text (agent and server): structured secrets,
 * command arguments, then prose. Never wipes the whole text for a mention. */
export function scrubEntryText(value) {
  const text = String(value);
  // The size is checked once, on the input: a redaction may lengthen the text later.
  if (text.length > 1024 * 1024) return '[REDACTED OVERSIZE CONTENT]';
  return freeTextSecrets(scrubCommandSecrets(cleanText(text, 0, true)));
}
