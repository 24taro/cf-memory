import { describe, it, expect } from 'vitest';
import { boundedJson } from '../src/bounded-body';
import { handleMcp } from '../src/mcp';
import { principalFixture } from './helpers';
const ctx = { principal: principalFixture(), services: {} as any, budget: 4000 };
describe('bounded MCP envelopes', () => {
  it('rejects excessive streamed bytes before parsing', async () => {
    await expect(boundedJson(new Request('https://memory.test', { method: 'POST', body: JSON.stringify({ data: 'x'.repeat(1000) }) }), 100)).rejects.toThrow('large');
  });
  it('rejects malformed single, batch, params and tool arguments without crashing', async () => {
    for (const body of [null, 3, [], [null], { method: 'tools/list', params: 'bad' }, { method: 'tools/call', params: { name: 'recall', arguments: [] } }]) {
      const response = await handleMcp(new Request('https://memory.test/mcp', { method: 'POST', body: JSON.stringify(body) }), ctx);
      const result = await response.json() as any;
      expect(Array.isArray(result) ? result[0].error : result.error).toBeTruthy();
    }
  });
});
