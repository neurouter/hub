import { describe, expect, it } from 'vitest';
import { formatTraceparent, parseTraceparent, startCallTrace } from './tracing.js';

const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('trace propagation (OTel SDK disabled → gateway-minted span ids)', () => {
  it('parses and formats W3C traceparent', () => {
    expect(parseTraceparent(TP)).toEqual({ version: '00', traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', flags: '01' });
    expect(parseTraceparent('00-00000000000000000000000000000000-b7ad6b7169203331-01')).toBeNull();
    expect(parseTraceparent('ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(formatTraceparent({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), flags: '01' })).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
  });

  it('_meta.traceparent wins over the HTTP header; upstream gets the same trace with a new span id', async () => {
    const t = startCallTrace({ method: 'tools/call', toolName: 'gh__x', metaTraceparent: TP, metaTracestate: 'v=1', httpTraceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`, protocolVersion: '2026-07-28' });
    expect(t.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(t.spanId).not.toBe('b7ad6b7169203331');
    const meta = await t.upstream('gh', async (m) => m);
    const up = parseTraceparent(meta.traceparent)!;
    expect(up.traceId).toBe(t.traceId);
    expect(up.spanId).not.toBe('b7ad6b7169203331');
    expect(meta.tracestate).toBe('v=1');
    t.end({ error: null });
  });

  it('falls back to the HTTP header, else starts a new trace', async () => {
    const h = startCallTrace({ method: 'tools/call', toolName: null, metaTraceparent: null, metaTracestate: null, httpTraceparent: TP, protocolVersion: null });
    expect(h.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    const n = startCallTrace({ method: 'tools/call', toolName: null, metaTraceparent: 'bad', metaTracestate: null, httpTraceparent: null, protocolVersion: null });
    expect(n.traceId).toMatch(/^[0-9a-f]{32}$/);
    await expect(n.upstream('gh', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    n.end({ error: 'upstream_error' });
  });
});
