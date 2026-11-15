import { expect, it } from 'vitest';
import { handleMcp } from '../src/mcp';
import { principalFixture } from './helpers';

// 2026-10-31: semantic search is removed. notes_search still accepts every
// mode for old clients and answers all of them with the keyword lanes.
async function search(mode?: string) {
  let options: any;
  const services = { search: { hybrid: async (_p: unknown, _q: string, opts: any) => {
    options = opts;
    return [{ id: 'lexical-result' }];
  } } };
  const response = await handleMcp(new Request('https://example.test/mcp', {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'notes_search', arguments: { q: 'database contract', ...(mode === undefined ? {} : { mode }), scope: 'all' },
    } }),
  }), { principal: principalFixture(), services: services as never, budget: 4000 });
  const envelope: any = await response.json();
  return { envelope, result: envelope.result?.content?.[0]?.text?.startsWith('{') ? JSON.parse(envelope.result.content[0].text) : null, options };
}

it('every accepted mode is keyword search and reports no semantic lane (not_requested, for installed 0.2.x Agents)', async () => {
  for (const mode of [undefined, 'hybrid', 'keyword', 'semantic']) {
    const { result, options } = await search(mode);
    expect(options.context).toBeNull(); // MCP's canonical no-context, all-scope value
    expect(options.semanticDeadline).toBeUndefined();
    expect(result.hits).toEqual([{ id: 'lexical-result' }]);
    expect(result.retrieval).toEqual({ mode: 'keyword', requested_mode: mode ?? 'hybrid', semantic_status: 'not_requested',
      semantic_budget_ms: 0, requested_lanes_complete: true });
    expect(result.retrieval.exhaustive).toBeUndefined();
  }
});

it('an unknown mode is still rejected', async () => {
  const { envelope } = await search('vector');
  expect(envelope.result.isError).toBe(true);
  expect(envelope.result.content[0].text).toContain('invalid search mode');
});
