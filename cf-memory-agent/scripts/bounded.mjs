// Bound streamed input before allocating the whole response. Never include raw
// payloads or provider error bodies in exceptions.
export async function responseText(response, limit) {
  if (Number(response.headers?.get('content-length')) > limit) {
    void response.body?.cancel().catch(() => {});
    throw Error('response exceeds limit');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => {}); throw Error('response exceeds limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(all);
}
// Where the complete JSON value (object, array or string) at `start` ends, or
// -1 when it does not end inside `text`.
function valueEnd(text, start) {
  if (!'{["'.includes(text[start] || 'x')) return -1;
  let depth = 0, quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '\\') i++; else if (c === '"') { quoted = false; if (!depth) return i + 1; } continue; }
    if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
  }
  return -1;
}
// tool_input from a window of an oversized envelope: the whole value when it
// is complete there, else its complete short fields (the action line needs one).
function windowInput(text) {
  const at = /"tool_input"\s*:\s*/.exec(text);
  if (!at) return null;
  const start = at.index + at[0].length, end = valueEnd(text, start);
  if (end > 0) { try { return JSON.parse(text.slice(start, end)); } catch {} }
  const fields = {};
  for (const match of text.slice(start).matchAll(/"(command|file_path|notebook_path|path|url|query|pattern|description)"\s*:\s*("(?:[^"\\]|\\.)*"|\[\s*(?:"(?:[^"\\]|\\.)*"\s*(?:,\s*)?)*\])/g)) {
    if (!(match[1] in fields)) { try { fields[match[1]] = JSON.parse(match[2]); } catch {} }
  }
  return Object.keys(fields).length ? fields : null;
}
const windowExit = text => {
  const match = /"(?:exit_code|exitCode)"\s*:\s*(-?\d{1,6})\b|"(?:tool_response|error|output)"\s*:\s*"\s*(?:Exit code|Process exited with code|exit status)\s*:?\s*(-?\d{1,6})\b/.exec(text);
  return match ? Number(match[1] ?? match[2]) : undefined;
};
export const OVERSIZED_OUTPUT = '（出力が大きすぎて省略）';
// The head of a JSON string value that does not end inside `text` (an oversized
// prompt or reply): at most `max` characters, decoded, cut before a partial escape.
function stringHead(text, key, max = 1048576) {
  const at = new RegExp('"' + key + '"\\s*:\\s*"').exec(text);
  if (!at) return undefined;
  const start = at.index + at[0].length, end = valueEnd(text, start - 1);
  if (end > 0) { try { return JSON.parse(text.slice(start - 1, end)); } catch { return undefined; } }
  // Drop what is left of an escape sequence cut at the end (a lone backslash, or "u" and up to 3 hex digits after one).
  let raw = text.slice(start, start + max);
  for (let i = 0; i < 6; i++, raw = raw.slice(0, -1)) { try { return JSON.parse('"' + raw + '"'); } catch {} }
  return undefined;
}

export async function hookInput(stream, limit = 4000000) {
  let bytes = 0, tail = Buffer.alloc(0);
  const pieces = [];
  for await (const piece of stream) {
    const chunk = Buffer.from(piece);
    if (bytes < limit) pieces.push(chunk.subarray(0, limit - bytes));
    bytes += chunk.length;
    tail = Buffer.concat([tail, chunk.subarray(Math.max(0, chunk.length - 16384))]).subarray(-16384);
  }
  const prefix = Buffer.concat(pieces).toString('utf8');
  if (bytes <= limit) return JSON.parse(prefix || '{}');
  // Claude's hook envelope puts identifiers before tool_response. For an
  // oversized envelope keep the identifiers, the tool input (or its short
  // fields) and the exit code, all from complete JSON values only: never
  // persist an unparsed prefix which may cut through a secret value. The
  // output itself is replaced by a marker.
  const head = prefix.slice(0, 65536), end = tail.toString('utf8');
  const envelope = {};
  for (const key of ['session_id', 'tool_use_id', 'tool_name', 'cwd', 'hook_event_name']) {
    const match = (key === 'tool_use_id' ? end + head.slice(0, 16384) : head.slice(0, 16384) + end).match(new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")'));
    if (match) { try { envelope[key] = JSON.parse(match[1]); } catch {} }
  }
  const input = windowInput(head) ?? windowInput(end), code = windowExit(head) ?? windowExit(end);
  // A prompt or reply that is itself the oversized part keeps its head (the
  // entry builder scrubs it and cuts it to 65,536 characters with the marker).
  const texts = {};
  for (const key of ['prompt', 'last_assistant_message']) { const value = stringHead(prefix, key); if (value !== undefined) texts[key] = value; }
  return { ...envelope, ...texts, tool_input: input ?? {}, tool_response: (code === undefined ? '' : 'Exit code ' + code + '\n') + OVERSIZED_OUTPUT, cf_memory_oversized: true };
}
