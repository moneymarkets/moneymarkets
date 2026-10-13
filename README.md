# MoneyMarkets

MoneyMarkets is a passkey wallet and trading app for Kuru Exchange, the on-chain order
book on Monad. You sign in with Face ID or a fingerprint, add dollars from almost any
chain, and trade against a real order book from an address that only you control.

Live at [moneymarkets.trade](https://moneymarkets.trade). It runs on Monad mainnet.

## What it does

- **Passkey accounts.** One passkey prompt creates the account. There is no seed phrase
  to write down first and no wallet extension to install. The key is derived on your
  device with [Mera](https://www.npmjs.com/package/@category-labs/mera) and never
  reaches our server. The same passkey always brings back the same address.
- **Money from another chain.** Pick what you hold (USDC on Base, USDT on Tron, SOL and
  others), type an amount, and get a live quote and a deposit address through NEAR
  Intents. You send from any wallet or exchange. Nothing has to be connected.
- **Trading on Kuru Exchange.** Limit and market orders on the live order book. Prices
  are read from the chain at a known block, not from a cache.
- **No gas to buy first.** Each account gets 20 free actions a day. After that the fee
  can be paid from the trading balance, so nobody needs MON just to get started.
- **A wallet for any Monad token.** Search by name or paste a contract address, then
  send it, swap it or move it into the trading balance.
- **Your keys stay yours.** A recovery phrase can be shown after a fresh passkey check.
  It is a standard phrase that restores the same address in other wallets.

## How it works

The passkey produces a secret on the device. Mera turns that secret into the account
key. The account is a normal Monad address that delegates to a smart account under
EIP-7702, so it can send ERC-4337 user operations.

When you place an order, the app builds the operation, you sign it, and the relayer
submits it. The relayer is deliberately small. It only forwards operations the user
signed, only to an allowlist of Kuru contracts, under a size cap and rate limits. It
never holds user funds and it cannot sign for anyone.

Balances, prices and market rules are read straight from Monad. Activity is written
when a transaction receipt confirms.

## What is in this repository

| Path               | What it is                                                             |
| ------------------ | ---------------------------------------------------------------------- |
| `apps/trade`       | The Next.js app: sign in, add money, wallet, trade, activity, settings |
| `apps/relayer`     | Fastify service that pays gas for allowed actions                      |
| `apps/market-kit`  | Command line tool for reading and seeding order books                  |
| `apps/indexer`     | Envio HyperIndex handlers. Written and tested, not deployed            |
| `packages/core`    | Chain reads, order maths, sponsorship rules, account derivation        |
| `packages/ui`      | Shared components and design tokens                                    |
| `mobile/capacitor` | Empty package reserved for a native shell. Nothing built yet           |

Everything is TypeScript. Chain access uses viem, tests use vitest, and every outside
response is checked with zod.

## Install

You need Node 22.5 or newer and pnpm 10.

```sh
git clone https://github.com/moneymarkets/moneymarkets.git
cd moneymarkets
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

The defaults in `.env.example` point at Monad testnet in dry-run mode. That is enough
to open the app and look around. No keys are needed for that.

## Run it locally

```sh
pnpm --filter @tradepro/trade dev
```

Open `http://localhost:3000`. Use `localhost`, not `127.0.0.1`, because passkeys do not
work on an IP address.

To sponsor transactions on your own machine, start the relayer too:

```sh
pnpm generate-keys                 # creates an encrypted relayer key in .secrets/
pnpm --filter @tradepro/relayer dev
```

The relayer listens on port 8787. It also needs a bundler key, which goes in
`PIMLICO_API_KEY`.

## Real funds

The app will not send anything on mainnet unless all three of these are set:

```
CHAIN=mainnet
MODE=live
I_UNDERSTAND_THIS_USES_REAL_FUNDS=true
```

Leave them alone unless you mean it. Sponsored order size is capped in
`packages/core/src/chain/caps.ts`, and an environment value can only make that cap
smaller.

## Tests

```sh
pnpm test         # every package
pnpm typecheck
pnpm lint
```

## Build for production

```sh
pnpm build
```

`apps/trade` builds as a standalone Next.js server. `apps/relayer` builds to
`dist/server.js` and should only be reachable from the app server, never from the
public internet.

## Built with

Monad, Kuru Exchange, Mera passkeys, NEAR Intents, Pimlico, LayerZero (for AUSD),
Next.js, Fastify and viem.

The internal package names still start with `@tradepro`. That was the working name of
the project before it became MoneyMarkets.

## License

MIT. See [LICENSE](./LICENSE).
