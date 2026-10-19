import { describe, expect, it } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { parseEnv, PROTOCOL_FEE_BPS_MVP } from './env';

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${encodeSegment({ alg: 'HS256', typ: 'JWT' })}.${encodeSegment(payload)}.signature`;
}

function validEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgresql://user:password@localhost:5432/postgres',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: fakeJwt({ role: 'service_role' }),
    STELLAR_NETWORK: 'testnet',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    FACTORY_CONTRACT_ID: '',
    USDC_CONTRACT_ID: '',
    TREASURY_ADDRESS: '',
    PROTOCOL_FEE_BPS: String(PROTOCOL_FEE_BPS_MVP),
    WALLET_NONCE_SECRET: 'a'.repeat(32),
    ALLOW_MAINNET: 'false',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  };
}

describe('parseEnv', () => {
  it('accepts a valid testnet environment', () => {
    const env = parseEnv(validEnv());
    expect(env.STELLAR_NETWORK).toBe('testnet');
    expect(env.PORT).toBe(3000);
  });

  it('accepts a hosted database once the CA is supplied', () => {
    const env = parseEnv(
      validEnv({
        DATABASE_URL: 'postgresql://u:p@aws-1-eu-west-1.pooler.supabase.com:5432/postgres',
        DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      }),
    );
    expect(env.DATABASE_SSL_ALLOW_UNVERIFIED).toBe(false);
  });

  it('refuses to start against a hosted database it cannot authenticate', () => {
    // The deployment trap. Without this, the API connects to Supabase with TLS
    // configured but the server unverified, which behaves identically to a
    // verified connection and would go unnoticed for the life of the project.
    expect(() =>
      parseEnv(
        validEnv({
          DATABASE_URL: 'postgresql://u:p@aws-1-eu-west-1.pooler.supabase.com:5432/postgres',
        }),
      ),
    ).toThrow(/Unsafe database TLS configuration/);
  });

  it('starts against a hosted database once the risk is acknowledged', () => {
    const env = parseEnv(
      validEnv({
        DATABASE_URL: 'postgresql://u:p@aws-1-eu-west-1.pooler.supabase.com:5432/postgres',
        DATABASE_SSL_ALLOW_UNVERIFIED: 'true',
      }),
    );
    expect(env.DATABASE_SSL_ALLOW_UNVERIFIED).toBe(true);
  });

  it('does not require the acknowledgement for a local database', () => {
    // Local development must stay frictionless, or the flag becomes noise that
    // gets set everywhere and stops meaning anything.
    const env = parseEnv(validEnv({ DATABASE_URL: 'postgresql://u:p@localhost:54322/postgres' }));
    expect(env.DATABASE_SSL_ALLOW_UNVERIFIED).toBe(false);
  });

  it('coerces numeric values from strings', () => {
    const env = parseEnv(validEnv({ PORT: '8080', PROTOCOL_FEE_BPS: '50' }));
    expect(env.PORT).toBe(8080);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => parseEnv(validEnv({ DATABASE_URL: 'mysql://localhost/db' }))).toThrow(
      /Invalid server environment configuration/,
    );
  });

  it('rejects a missing service role key', () => {
    const env = validEnv();
    delete env['SUPABASE_SERVICE_ROLE_KEY'];
    expect(() => parseEnv(env)).toThrow(/Invalid server environment configuration/);
  });

  it('rejects an anon key in the service-role variable', () => {
    const anonKey = fakeJwt({ role: 'anon' });
    expect(() => parseEnv(validEnv({ SUPABASE_SERVICE_ROLE_KEY: anonKey }))).toThrow(
      /service_role token/,
    );
  });

  it('rejects a service-role key that is not a decodable JWT', () => {
    // An opaque or publishable key cannot be shown to carry the service_role
    // claim, so it fails closed rather than being trusted on shape alone.
    expect(() =>
      parseEnv(validEnv({ SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_not-a-jwt' })),
    ).toThrow(/not a decodable JWT/);
  });

  it('rejects a JWT whose payload has no role claim', () => {
    expect(() =>
      parseEnv(validEnv({ SUPABASE_SERVICE_ROLE_KEY: fakeJwt({ sub: 'someone' }) })),
    ).toThrow(/service_role token/);
  });

  it('rejects a protocol fee that differs from the on-chain fee', () => {
    expect(() => parseEnv(validEnv({ PROTOCOL_FEE_BPS: '100' }))).toThrow(/must be 50/);
  });

  it('rejects a short wallet nonce secret', () => {
    expect(() => parseEnv(validEnv({ WALLET_NONCE_SECRET: 'too-short' }))).toThrow(
      /Invalid server environment configuration/,
    );
  });

  it('refuses mainnet without explicit opt-in', () => {
    expect(() => parseEnv(validEnv({ STELLAR_NETWORK: 'mainnet' }))).toThrow(/ALLOW_MAINNET/);
  });

  it('allows mainnet only with explicit opt-in and public network passphrase', () => {
    const env = parseEnv(
      validEnv({
        STELLAR_NETWORK: 'mainnet',
        STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
        ALLOW_MAINNET: 'true',
      }),
    );
    expect(env.STELLAR_NETWORK).toBe('mainnet');
  });

  it('rejects STELLAR_NETWORK / STELLAR_NETWORK_PASSPHRASE mismatches', () => {
    expect(() =>
      parseEnv(
        validEnv({
          STELLAR_NETWORK: 'testnet',
          STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
        }),
      ),
    ).toThrow(/does not match STELLAR_NETWORK/);

    expect(() =>
      parseEnv(
        validEnv({
          STELLAR_NETWORK: 'mainnet',
          STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
          ALLOW_MAINNET: 'true',
        }),
      ),
    ).toThrow(/does not match STELLAR_NETWORK/);

    expect(() =>
      parseEnv(
        validEnv({
          STELLAR_NETWORK: 'local',
          STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
        }),
      ),
    ).toThrow(/does not match STELLAR_NETWORK/);
  });

  it('accepts valid local network passphrase', () => {
    const env = parseEnv(
      validEnv({
        STELLAR_NETWORK: 'local',
        STELLAR_NETWORK_PASSPHRASE: Networks.STANDALONE,
      }),
    );
    expect(env.STELLAR_NETWORK).toBe('local');
  });

  it('accepts a well-formed treasury account address', () => {
    const treasury = `G${'A'.repeat(55)}`;
    expect(() => parseEnv(validEnv({ TREASURY_ADDRESS: treasury }))).not.toThrow();
  });

  it('rejects a malformed treasury address', () => {
    expect(() => parseEnv(validEnv({ TREASURY_ADDRESS: 'not-an-address' }))).toThrow(
      /Invalid server environment configuration/,
    );
  });

  it('does not leak the service role key in error messages', () => {
    const secretKey = fakeJwt({ role: 'anon', marker: 'super-secret-xyz' });
    try {
      parseEnv(validEnv({ SUPABASE_SERVICE_ROLE_KEY: secretKey }));
      expect.unreachable('expected parseEnv to throw');
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-xyz');
    }
  });

  it('accepts and defaults TRUSTED_PROXY_CIDRS', () => {
    const envDefault = parseEnv(validEnv());
    expect(envDefault.TRUSTED_PROXY_CIDRS).toBe('');

    const envConfigured = parseEnv(
      validEnv({ TRUSTED_PROXY_CIDRS: '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16' }),
    );
    expect(envConfigured.TRUSTED_PROXY_CIDRS).toBe('10.0.0.0/8,172.16.0.0/12,192.168.0.0/16');
  });

  it('rejects http:// SUPABASE_URL in production', () => {
    expect(() =>
      parseEnv(
        validEnv({
          NODE_ENV: 'production',
          SUPABASE_URL: 'http://example.supabase.co',
        }),
      ),
    ).toThrow(/SUPABASE_URL must use https:\/\/ in production/);
  });

  it('rejects http:// STELLAR_RPC_URL in production', () => {
    expect(() =>
      parseEnv(
        validEnv({
          NODE_ENV: 'production',
          STELLAR_RPC_URL: 'http://soroban-testnet.stellar.org',
        }),
      ),
    ).toThrow(/STELLAR_RPC_URL must use https:\/\/ in production/);
  });

  it('allows http:// SUPABASE_URL and STELLAR_RPC_URL in non-production environments', () => {
    const envTest = parseEnv(
      validEnv({
        NODE_ENV: 'test',
        SUPABASE_URL: 'http://localhost:54321',
        STELLAR_RPC_URL: 'http://localhost:8000',
      }),
    );
    expect(envTest.SUPABASE_URL).toBe('http://localhost:54321');
    expect(envTest.STELLAR_RPC_URL).toBe('http://localhost:8000');

    const envDev = parseEnv(
      validEnv({
        NODE_ENV: 'development',
        SUPABASE_URL: 'http://localhost:54321',
        STELLAR_RPC_URL: 'http://localhost:8000',
      }),
    );
    expect(envDev.SUPABASE_URL).toBe('http://localhost:54321');
    expect(envDev.STELLAR_RPC_URL).toBe('http://localhost:8000');
  });

  it('defaults SOROBAN_SIMULATE_TIMEOUT_MS to 10000 and allows custom positive values', () => {
    const envDefault = parseEnv(validEnv());
    expect(envDefault.SOROBAN_SIMULATE_TIMEOUT_MS).toBe(10000);

    const envCustom = parseEnv(
      validEnv({
        SOROBAN_SIMULATE_TIMEOUT_MS: '5000',
      }),
    );
    expect(envCustom.SOROBAN_SIMULATE_TIMEOUT_MS).toBe(5000);

    expect(() =>
      parseEnv(
        validEnv({
          SOROBAN_SIMULATE_TIMEOUT_MS: '-1',
        }),
      ),
    ).toThrow(/SOROBAN_SIMULATE_TIMEOUT_MS/);
  });
});
