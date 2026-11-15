// A local stand-in for the cf-memory MCP endpoint. Records every tools/call (with
// its request size) and answers log_append idempotently by id, like the real
// server (and refuses what src/logs.ts refuses). `rejectEntry(entry)` marks more entries as invalid and
// `appendError(n, args)` returns an isError message for the n-th log_append.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_TOKEN = 'fixture-access-token-not-a-secret';

export async function fakeServer(behavior = {}) {
  const calls = [], stored = new Map();
  let appendCalls = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => { chunks.push(chunk); });
    request.on('end', async () => {
      const body = Buffer.concat(chunks);
      const auth = request.headers.authorization;
      let message = {};
      try { message = JSON.parse(body.toString('utf8')); } catch {}
      const name = message.params?.name, args = message.params?.arguments ?? {};
      calls.push({ name, args, auth, bytes: body.length });
      const reply = (status, payload) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); };
      const ok = result => reply(200, { jsonrpc: '2.0', id: message.id ?? 1, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      const toolError = text => reply(200, { jsonrpc: '2.0', id: message.id ?? 1, result: { content: [{ type: 'text', text }], isError: true } });
      if (behavior.hang?.(name)) return; // never answer
      if (auth !== 'Bearer ' + TEST_TOKEN) return reply(401, { error: 'unauthorized' });
      if (behavior.delay) await new Promise(resolve => setTimeout(resolve, behavior.delay(name) ?? 0));
      if (name === 'log_append') {
        appendCalls++;
        if (behavior.failAppend?.(appendCalls, args)) return reply(503, { error: 'unavailable' });
        const failure = behavior.appendError?.(appendCalls, args);
        if (failure) return toolError(failure);
        const bad = (args.entries ?? []).findIndex(entry => behavior.rejectEntry?.(entry) || serverRejects(entry));
        if (bad >= 0) return toolError('entries[' + bad + '].repo must not contain control characters');
        let fresh = 0, duplicates = 0, clamped = 0;
        for (const entry of args.entries ?? []) {
          if (stored.has(entry.id)) { duplicates++; continue; }
          // Like src/logs.ts: a ts more than 1 hour ahead is stored as the receipt time.
          if (entry.ts > Date.now() + 3600000) { clamped++; entry.ts = Date.now(); }
          stored.set(entry.id, entry); fresh++;
        }
        return ok({ stored: fresh, duplicates, dropped_over_cap: 0, dropped_over_total_cap: behavior.droppedOverTotalCap ?? 0, ts_clamped: clamped });
      }
      if (name === 'recall') {
        if (behavior.failRecall) return reply(500, { error: 'boom' });
        return ok({ text: behavior.recallText ?? 'remembered: the fixture project uses vitest', used: 10, budget: args.budget });
      }
      if (name === 'session_context') {
        return ok(behavior.sessionContext ?? { core_memory: '### persona\nThe owner prefers short answers.', handoff: { session_id: 'previous-session', time: '2026-10-30 22:10 JST', text: 'Last time we finished the spool design.' } });
      }
      if (name === 'whoami') return ok({ handle: 'fixture-user', user_id: 'u_fixture', anonymous: false, token_status: 'active' }); // as src/mcp.ts answers
      return reply(200, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unknown tool' } });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/mcp';
  return {
    url, calls, stored,
    named: name => calls.filter(call => call.name === name),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// src/logs.ts parseEntry, field by field: what the real server refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;
const ENTRY_FIELDS = ['id', 'session_id', 'client', 'repo', 'ts', 'kind', 'text'];
export function serverRejects(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some(key => !ENTRY_FIELDS.includes(key))) return true;
  if (typeof e.id !== 'string' || !/^[0-9a-f]{64}$/.test(e.id)) return true;
  if (typeof e.session_id !== 'string' || !e.session_id.trim() || e.session_id.length > 128 || CONTROL.test(e.session_id)) return true;
  if (!['claude-code', 'codex'].includes(e.client)) return true;
  if (e.repo !== undefined && (typeof e.repo !== 'string' || e.repo.length > 200 || CONTROL.test(e.repo))) return true;
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts) || e.ts < 0) return true;
  return !['prompt', 'reply', 'action', 'error'].includes(e.kind) || typeof e.text !== 'string';
}

export function tempDir(prefix = 'cf-memory-agent-test-') {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** A clean environment: no inherited CF_MEMORY_* settings, no keychain, no real config. */
export function testEnv(home, url, extra = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CF_MEMORY_') && !['CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(key)));
  return {
    ...base, HOME: home, CF_MEMORY_AGENT_HOME: join(home, '.cf-memory', 'v3'), CF_MEMORY_CLAUDE_CONFIG: join(home, 'no-claude.json'),
    CF_MEMORY_KEYCHAIN: 'off', CF_MEMORY_CLAUDE_BIN: join(home, 'no-claude-bin'), CF_MEMORY_CODEX_BIN: join(home, 'no-codex-bin'),
    ...(url ? { CF_MEMORY_MCP_URL: url, CF_MEMORY_ACCESS_TOKEN: TEST_TOKEN } : {}), ...extra,
  };
}
