# apps/indexer — Envio HyperIndex over Kuru

Indexes `Router.MarketRegistered`, `OrderBook.OrderCreated`, `OrderBook.OrdersCanceled`
and `OrderBook.Trade` on Monad mainnet (chain 143) and serves them as GraphQL to
`/portfolio` and order history. Spec `docs/03-technical-spec.md` §9.

**Why this exists.** Monad's public RPC caps `eth_getLogs` at a **100-block range** —
anything wider is refused with `{"code":-32614,"message":"eth_getLogs is limited to a
100 range"}` (re-measured 2026-09-02). At 400 ms blocks that is forty seconds of
history per request, so rebuilding one user's order history from the node would take
thousands of sequential calls. The indexer is load-bearing, not a convenience.
`packages/core/src/kuru/fills.ts` is the reference decoder and the short-range
fallback.

## Status

| Piece                                       | State                                                        |
| ------------------------------------------- | ------------------------------------------------------------ |
| `config.yaml`, `schema.graphql`, handlers   | written                                                      |
| Decoding + normalisation, vs. **real** logs | tested — 68 tests over 4 fixtures pulled off chain 143       |
| `envio codegen` / `envio dev`               | **never run here.** Docker is not installed on this machine. |
| Hosted deploy                               | **not done.** Owner runs it; steps below.                    |

Nothing in this package has been executed as an indexer. What _has_ been executed is
every line of decoding and normalisation logic, against real Kuru logs, offline. See
"What is and is not verified" at the bottom before trusting anything here.

## Layout

```
config.yaml          Envio network/contract/event config
schema.graphql       Market, Order, Fill, Cancel, UserStats
src/events.ts        the four event ABIs + their topic0
src/normalize.ts     ALL the logic. Pure functions, no Envio import.
src/markets.ts       verified pricePrecision seed for the four live books
src/EventHandlers.ts Envio handlers — a thin shell over normalize.ts
scripts/             fixture fetcher + market-params reader (both read-only)
test/fixtures/       REAL logs from chain 143, with provenance in every file
```

The split between `normalize.ts` and `EventHandlers.ts` is deliberate. `envio codegen`
needs Docker; logic that only runs under Docker is logic that never gets tested on a
machine without it. So the logic lives in `normalize.ts`, which imports nothing from
Envio, and the tests drive it with real logs.

`src/EventHandlers.ts` is excluded from `tsconfig.json` because it imports `generated`,
which does not exist until codegen has run — otherwise the repo-wide `pnpm typecheck`
would fail on a machine without Docker. It is typechecked after codegen (below).

## Commands

```bash
pnpm --filter @tradepro/indexer test           # 68 tests, offline, real fixtures
pnpm --filter @tradepro/indexer typecheck      # excludes EventHandlers.ts, see above

# Opt-in: re-read getMarketParams() from the live chain and fail if src/markets.ts
# has drifted. Read-only (eth_call), no key, no writes.
INDEXER_LIVE_CHECK=1 pnpm --filter @tradepro/indexer test

# Re-fetch the real log fixtures (read-only RPC). Run `pnpm format` afterwards —
# the script writes JSON.stringify output and Prettier reindents it.
pnpm --filter @tradepro/indexer fetch-fixtures

# Reprint the seed table from the chain.
pnpm --filter @tradepro/indexer exec tsx scripts/read-market-params.ts
```

## Deploying to Envio's hosted service

You run this; nothing here deploys itself. Requires Docker only for the local
`codegen`/`dev` steps — the hosted service builds from the repo.

1. **Get an API token.** <https://app.envio.dev/api-tokens>. HyperSync's `POST /query`
   requires one (`/height` does not). Put it in the environment as `ENVIO_API_TOKEN`;
   it is a secret — it does not go in a committed file.

2. **Choose `start_block`.** `config.yaml` currently says `101000000` (~2026-09-01 at
   400 ms blocks). Lower it to widen history. HyperSync has no 100-block cap, so a
   wider range costs sync time, not request count. Note that lowering it below a
   market's registration block is what makes `Router.MarketRegistered` discovery work
   for that market; above it, `src/markets.ts` supplies the scales instead.

3. **Generate and check locally** (needs Docker):

   ```bash
   cd apps/indexer
   pnpm codegen                 # writes generated/
   pnpm exec tsc --noEmit       # now typechecks EventHandlers.ts too
   pnpm dev                     # local indexer + GraphQL at http://localhost:8080
   ```

   Sanity-check the local run before deploying: query a market you know has traffic
   (MON_USDC is the busiest of the four) and confirm `Fill` rows appear and
   `Order.status` moves off `OPEN`.

4. **Deploy.** Push the branch, then connect the repo at <https://envio.dev/app> and
   point it at `apps/indexer`. The hosted service builds from `config.yaml` and
   `schema.graphql` in that directory.

5. **Wire the app.** Set `NEXT_PUBLIC_INDEXER_URL` to the deployment's GraphQL
   endpoint. `.env.example` currently defaults it to `http://localhost:8080/v1/graphql`.
   The query shapes `/portfolio` should use are in `NOTES-for-portfolio.md`.

6. **Verify by hand.** Query order `13130679` on MON_AUSD
   (`0x131A2e70A5b31a517A74b8c567149bc294470Da9`). It should come back `CANCELED`, owner
   `0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961`, created in block 101310782, with
   `priceWire` `24933000000000000`. That is the same assertion `test/groundTruth.test.ts`
   makes offline, so a mismatch means the deployed indexer disagrees with the logic
   that was tested.

## Venue facts this package encodes

These are the things a plausible-looking implementation gets wrong.

**No Kuru event indexes anything.** Every parameter of all four events is
`indexed: false`, so a log carries exactly one topic — the signature — and everything
else is in `data`. Verified against every real log in `test/fixtures/`: not one has a
`topics[1]`. Two consequences: there is no node-side filter by owner (attribution is a
client-side comparison, which is the other half of why the indexer exists), and adding
`indexed` to a signature in `config.yaml` would change its topic0 and the indexer would
silently match nothing forever.

**`OrdersCanceled` is plural and carries a `uint40[]`.** Not an edge case. Over blocks
101,340,850–101,341,449 on the four live books, **1,152 cancel logs carried 1,841 order
ids** — an indexer reading one id per log would leave **689** cancelled orders showing
as `OPEN`, and `/portfolio` would show users resting orders they had already cancelled.
Real batches up to 8 ids are in `test/fixtures/batch-cancels.json`.

**Two price scales in one market.** `OrderCreated.price` is a `uint32` in the market's
`pricePrecision`; `Trade.price` is a `uint256` already at 1e18. Both appear in the same
book in the same 60-block window (`recent-sweep.json`). Everything stored is normalised
to 1e18; `priceRaw` is kept so the conversion stays auditable.

**`pricePrecision` differs per market.** WBTC_AUSD is **1e4**; the three MON/AUSD/USDC
books are 1e8. A single hardcoded constant would misprice every WBTC order by four
orders of magnitude. This is why `src/markets.ts` is a table and why the live check
exists.

**`Trade.updatedSize` is the remainder, not the amount filled.** Reading it as the fill
amount inverts every order's progress.

**viem returns `number`, not `bigint`, for integers ≤48 bits.** `uint40 orderId` and
`uint32 price` come back as `number` while the `uint96` size in the same event comes
back as `bigint`. This is a real bug that 12 tests caught on first run. `normalize.ts`
coerces every integer parameter exactly once at the boundary (`big()`), so it is
correct whether driven by viem or by Envio's generated types.

## What is and is not verified

**Verified** — against real data, offline:

- All four topic0 hashes match real logs fetched from chain 143.
- `OrderCreated`, `OrdersCanceled`, `Trade` and `MarketRegistered` decode to values
  cross-checked against independently known facts (the raw `data` words, the spec's
  order id and owner, and a live `getMarketParams()` read).
- Order 13130679 round-trips: the key `OrderCreated` writes is the key
  `OrdersCanceled` looks up.
- Price normalisation, over every real `OrderCreated` in the fixtures.
- The seed table matches the live chain (`INDEXER_LIVE_CHECK=1`, run 2026-09-02).

**Not verified** — and no test here can close these:

- **The indexer has never run.** No `envio codegen`, no `envio dev`, no GraphQL server,
  no database. Docker is not installed on this machine.
- **`src/EventHandlers.ts` has never executed and does not typecheck**, because
  `generated` does not exist. Its _logic_ is tested via `normalize.ts`; its _wiring_ —
  entity field names, the `_id` relation suffixes, `context.addOrderBook`,
  `event.srcAddress`, `event.transaction.hash` — is written against Envio's documented
  API and is unconfirmed. Expect to fix names on the first `pnpm codegen`.
- **`config.yaml` has never been parsed by Envio.** Same reason.
- **HyperSync bulk fetching is unconfirmed.** `/height` answers unauthenticated
  (`{"height":101339919}`, 2026-09-02) but `POST /query` returned
  `{"error":"Your token is malformed..."}` — no Envio API token in this repo. Fixtures
  were fetched via paged `eth_getLogs` instead.
- **Reorg behaviour.** `rollback_on_reorg: true` is set and untested.
