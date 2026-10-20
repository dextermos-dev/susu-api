import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { configureTestEnv } from './support/fixtures';

configureTestEnv();

let app: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import('../src/server');
  // The readiness probe is injected so the suite does not need a database. The
  // real probe's failure path is covered explicitly below.
  app = await buildServer({ probeDatabase: async () => {} });
});

afterAll(async () => {
  await app?.close();
});

describe('health routes', () => {
  it('reports liveness', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness with each check named', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: { config: 'ok', database: 'ok' },
    });
  });
});

describe('readiness when the database is unreachable', () => {
  it('reports unavailable without leaking the failure', async () => {
    const { buildServer } = await import('../src/server');
    const failing = await buildServer({
      probeDatabase: async () => {
        throw new Error('connection refused to postgresql://user:password@localhost:5432');
      },
    });

    try {
      const response = await failing.inject({ method: 'GET', url: '/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'unavailable',
        checks: { config: 'ok', database: 'unavailable' },
      });
      // The connection string must not reach the client, even inside an error.
      expect(response.body).not.toContain('password');
    } finally {
      await failing.close();
    }
  });
});

describe('unknown routes', () => {
  it('returns a generic 404 without internal detail', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });
});

describe('CORS allowlist', () => {
  it('allows a configured origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not allow an origin outside the allowlist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('response headers', () => {
  it('applies secure headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBeDefined();
  });
});

describe('trustProxy and rate limit protection', () => {
  it('shares one limiter bucket when X-Forwarded-For is forged from an untrusted peer', async () => {
    const { buildServer } = await import('../src/server');
    const server = await buildServer({
      probeDatabase: async () => {},
      trustProxy: ['10.0.0.0/8'],
      rateLimitMax: 2,
    });

    try {
      const res1 = await server.inject({
        method: 'GET',
        url: '/health',
        remoteAddress: '198.51.100.1',
        headers: { 'x-forwarded-for': '1.1.1.1' },
      });
      expect(res1.statusCode).toBe(200);

      const res2 = await server.inject({
        method: 'GET',
        url: '/health',
        remoteAddress: '198.51.100.1',
        headers: { 'x-forwarded-for': '2.2.2.2' },
      });
      expect(res2.statusCode).toBe(200);

      const res3 = await server.inject({
        method: 'GET',
        url: '/health',
        remoteAddress: '198.51.100.1',
        headers: { 'x-forwarded-for': '3.3.3.3' },
      });
      expect(res3.statusCode).toBe(429);
    } finally {
      await server.close();
    }
  });

  it('respects X-Forwarded-For when request arrives from a trusted proxy CIDR', async () => {
    const { buildServer } = await import('../src/server');
    const server = await buildServer({
      probeDatabase: async () => {},
      trustProxy: ['10.0.0.0/8'],
      rateLimitMax: 2,
    });

    try {
      const res1 = await server.inject({
        method: 'GET',
        url: '/health',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '1.1.1.1' },
      });
      expect(res1.statusCode).toBe(200);

      const res2 = await server.inject({
        method: 'GET',
        url: '/health',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '2.2.2.2' },
      });
      expect(res2.statusCode).toBe(200);

      const res3 = await server.inject({
        method: 'GET',
        url: '/health',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '3.3.3.3' },
      });
      expect(res3.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('reads trusted CIDRs from TRUSTED_PROXY_CIDRS environment variable', async () => {
    const original = process.env['TRUSTED_PROXY_CIDRS'];
    process.env['TRUSTED_PROXY_CIDRS'] = '10.0.0.0/8';
    try {
      const { buildServer } = await import('../src/server');
      const server = await buildServer({
        probeDatabase: async () => {},
        rateLimitMax: 1,
      });

      try {
        const res1 = await server.inject({
          method: 'GET',
          url: '/health',
          remoteAddress: '198.51.100.1',
          headers: { 'x-forwarded-for': '1.1.1.1' },
        });
        expect(res1.statusCode).toBe(200);

        const res2 = await server.inject({
          method: 'GET',
          url: '/health',
          remoteAddress: '198.51.100.1',
          headers: { 'x-forwarded-for': '2.2.2.2' },
        });
        expect(res2.statusCode).toBe(429);
      } finally {
        await server.close();
      }
    } finally {
      if (original === undefined) delete process.env['TRUSTED_PROXY_CIDRS'];
      else process.env['TRUSTED_PROXY_CIDRS'] = original;
    }
  });

  it('resolves trustProxy properly based on inputs', async () => {
    const { resolveTrustProxy } = await import('../src/server');
    expect(resolveTrustProxy(undefined, undefined)).toBe(false);
    expect(resolveTrustProxy('', undefined)).toBe(false);
    expect(resolveTrustProxy('   ', undefined)).toBe(false);
    expect(resolveTrustProxy('10.0.0.0/8, 172.16.0.0/12', undefined)).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
    ]);
    expect(resolveTrustProxy('10.0.0.0/8', false)).toBe(false);
    expect(resolveTrustProxy(undefined, true)).toBe(true);
  });
});

describe('expired wallet-link nonces', () => {
  /**
   * A nonce row is kept past its expiry on purpose, so a replay is refused as a
   * replay rather than as an unknown token. That means something has to remove
   * them, and for a while nothing did — `reap` was written, tested, and never
   * called, so the table grew by a row per abandoned link attempt with no bound.
   */
  it('are cleared on a timer', async () => {
    const { startNonceReaping } = await import('../src/server');

    vi.useFakeTimers();
    try {
      const reap = vi.fn(async () => 3);
      const log = { info: vi.fn(), warn: vi.fn() };

      const timer = startNonceReaping({ reap }, log as never, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(reap).toHaveBeenCalledTimes(1);
      expect(reap).toHaveBeenCalledWith(expect.any(Date));

      // Something was cleared, so it is worth a line in the log.
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'nonce_reap', count: 3 }),
        expect.any(String),
      );

      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survive a failing reap, which is logged rather than fatal', async () => {
    const { startNonceReaping } = await import('../src/server');

    vi.useFakeTimers();
    try {
      const reap = vi.fn(async () => {
        throw new Error('database is unreachable');
      });
      const log = { info: vi.fn(), warn: vi.fn() };

      const timer = startNonceReaping({ reap }, log as never, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'nonce_reap_failed' }),
        expect.any(String),
      );

      // An untidy table is not a reason to take the service down, so the next
      // tick tries again.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reap).toHaveBeenCalledTimes(2);

      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing when there was nothing to clear', async () => {
    const { startNonceReaping } = await import('../src/server');

    vi.useFakeTimers();
    try {
      const reap = vi.fn(async () => 0);
      const log = { info: vi.fn(), warn: vi.fn() };

      const timer = startNonceReaping({ reap }, log as never, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(reap).toHaveBeenCalledTimes(1);
      expect(log.info).not.toHaveBeenCalled();

      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('nonce reaper server lifecycle', () => {
  it('does not start a reaper interval when enableNonceReaping is not opted into', async () => {
    const { buildServer } = await import('../src/server');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const server = await buildServer({ probeDatabase: async () => {} });
    try {
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
      setIntervalSpy.mockRestore();
    }
  });

  it('stops the reaper interval when the server closes and prevents subsequent ticks', async () => {
    const { buildServer } = await import('../src/server');

    vi.useFakeTimers();
    try {
      const reap = vi.fn(async () => 1);
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      const server = await buildServer({
        enableNonceReaping: true,
        walletLinkStore: { reap } as never,
        probeDatabase: async () => {},
      });

      expect(reap).not.toHaveBeenCalled();

      // Close the server and assert clearInterval was called
      await server.close();
      expect(clearIntervalSpy).toHaveBeenCalled();

      // Advancing time past the reap interval should NOT trigger any reap
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(reap).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
