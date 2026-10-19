/**
 * Soroban RPC access, from the server.
 *
 * WHY THIS EXISTS AT ALL
 * The document's API surface includes `POST /transactions/prepare`, and its
 * transaction UX is "Validate → Build → Simulate → Show details → Wallet
 * signature → …". Simulation is the step where the contract itself decides whether
 * a call would be accepted, which is why it happens before the wallet is asked to
 * approve anything.
 *
 * WHAT THIS IS NOT ALLOWED TO BECOME
 * This service never holds a key, never signs, and never submits. `prepare` takes
 * an envelope the client built and hands back the same call with a footprint and
 * resource fee filled in; the wallet signs it and the client submits it. So a
 * compromise of this API cannot move funds: it cannot change which contract is
 * called or with what arguments, and it has nothing to sign with.
 *
 * The client is free to ignore this path entirely and simulate against RPC itself.
 * That matters: a write must not depend on this service being up, and the web app
 * keeps its own path for exactly that reason.
 */
import { rpc, type Transaction } from '@stellar/stellar-sdk';

/** The one RPC operation this service needs. Injected so tests need no network. */
export type SorobanSimulator = (
  transaction: Transaction,
) => Promise<rpc.Api.SimulateTransactionResponse>;

/**
 * Builds a simulator against one RPC endpoint.
 *
 * The server is constructed on first use rather than at startup, so a bad or
 * unreachable RPC endpoint is a failing request rather than a service that will
 * not boot. `allowHttp` follows the URL scheme: a local Soroban node is spoken to
 * over plain HTTP, and refusing that would mean `prepare` could not be exercised
 * against the network it is developed on.
 */
export type CreateSorobanSimulatorOptions = {
  readonly timeoutMs?: number;
  readonly allowHttp?: boolean;
};

export function createSorobanSimulator(
  url: string,
  options?: CreateSorobanSimulatorOptions,
): SorobanSimulator {
  let server: rpc.Server | undefined;
  const timeoutMs = options?.timeoutMs;

  return async (transaction) => {
    if (!server) {
      server = new rpc.Server(url, {
        allowHttp: options?.allowHttp ?? url.startsWith('http://'),
      });
      if (timeoutMs !== undefined && timeoutMs > 0 && server.httpClient?.defaults) {
        server.httpClient.defaults.timeout = timeoutMs;
      }
    }
    return await server.simulateTransaction(transaction);
  };
}
