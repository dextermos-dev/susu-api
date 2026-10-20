import { buildServer } from './server';
import { getEnv } from './lib/env';
import { closeDb } from './db/client';

/**
 * Process entrypoint.
 *
 * Fatal startup errors are written to stderr without dumping configuration, so
 * that a misconfiguration can never leak a secret into logs.
 */
async function main(): Promise<void> {
  const env = getEnv();
  const app = await buildServer();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeDb();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : 'unknown startup failure';
  process.stderr.write(`Fatal startup error (${name}): ${message}\n`);
  process.exit(1);
});
