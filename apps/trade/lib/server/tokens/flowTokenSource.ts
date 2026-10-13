import type { SourceToken, TokenListSource } from './tokenRegistry.js';

/**
 * Kuru Flow's token list as a registry source (spec A1).
 *
 * // UNVERIFIED: Kuru Flow token-list endpoint. Flow's documented API surface is
 * `POST /generate-token` and `POST /quote` (`packages/core/src/kuru/flow.ts`,
 * `docs.kuru.io/api-reference/calculate-best-path-quote`); neither the documentation
 * nor the SDK names an endpoint that lists the tokens Flow can route. Rule A2.5 forbids
 * guessing one, so this source answers with nothing until an endpoint is confirmed and
 * written here with its source. The registry is correct with the other two sources;
 * a token Flow can route but no list names still reaches the wallet through the
 * Transfer-log scan (A2b) or add-by-address (A2c), and is priced by a Flow quote (A4).
 */
export const flowTokenSource: TokenListSource = {
  name: 'kuru-flow',
  async list(): Promise<readonly SourceToken[]> {
    return [];
  },
};
