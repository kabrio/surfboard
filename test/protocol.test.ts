import { describe, expect, it } from 'vitest';
import {
  boundsSchema,
  browserWaitSchema,
  safeUrl,
  tabSchema,
  terminalInputSchema,
} from '../src/shared/protocol';

describe('Surfboard protocol', () => {
  it('accepts HTTP(S) URLs and rejects privileged schemes', () => {
    expect(safeUrl('https://example.com')?.hostname).toBe('example.com');
    expect(safeUrl('http://localhost:4321')?.port).toBe('4321');
    expect(safeUrl('file:///etc/passwd')).toBeNull();
    expect(safeUrl('surfboard://open')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
  });

  it('bounds renderer geometry and terminal input', () => {
    expect(
      boundsSchema.parse({ x: 0, y: 40, width: 800, height: 600 }),
    ).toEqual({ x: 0, y: 40, width: 800, height: 600 });
    expect(() =>
      boundsSchema.parse({ x: 0, y: 40, width: -1, height: 600 }),
    ).toThrow();
    expect(() =>
      terminalInputSchema.parse({
        tabId: crypto.randomUUID(),
        data: 'x'.repeat(1_000_001),
      }),
    ).toThrow();
  });

  it('applies bounded wait defaults', () => {
    expect(browserWaitSchema.parse({ condition: '#ready' })).toMatchObject({
      timeoutMs: 10_000,
    });
    expect(() =>
      browserWaitSchema.parse({ condition: '#ready', timeoutMs: 60_001 }),
    ).toThrow();
  });

  it('validates stable tab identity', () => {
    expect(
      tabSchema.parse({
        id: crypto.randomUUID(),
        kind: 'terminal',
        title: 'Shell',
      }),
    ).toMatchObject({ kind: 'terminal', title: 'Shell' });
    expect(() =>
      tabSchema.parse({ id: 'not-uuid', kind: 'browser', title: 'Tab' }),
    ).toThrow();
  });
});
