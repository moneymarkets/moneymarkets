# ABI provenance

Every file in this directory is a verbatim copy of an ABI array taken from the
published npm package, converted from JSON to a `const`-asserted TypeScript array so
viem can infer types. Nothing else was changed: no entries added, removed, renamed or
reordered.

| File               | Export             | Source                                                           |
| ------------------ | ------------------ | ---------------------------------------------------------------- |
| `orderBook.ts`     | `orderBookAbi`     | `@kuru-labs/kuru-sdk@0.0.95` → `abi/OrderBook.json` (`.abi`)     |
| `marginAccount.ts` | `marginAccountAbi` | `@kuru-labs/kuru-sdk@0.0.95` → `abi/MarginAccount.json` (`.abi`) |
| `router.ts`        | `routerAbi`        | `@kuru-labs/kuru-sdk@0.0.95` → `abi/Router.json` (`.abi`)        |
| `kuruAmmVault.ts`  | `kuruAmmVaultAbi`  | `@kuru-labs/kuru-sdk@0.0.95` → `abi/KuruAMMVault.json` (`.abi`)  |
| `monadDeployer.ts` | `monadDeployerAbi` | `@kuru-labs/kuru-sdk@0.0.95` → `abi/MonadDeployer.json` (`.abi`) |
| `kuruUtils.ts`     | `kuruUtilsAbi`     | `@kuru-labs/kuru-sdk@0.0.95` → `abi/KuruUtils.json` (`.abi`)     |

Retrieved 2026-09-02 via `npm pack @kuru-labs/kuru-sdk@0.0.95`.

## Why copied and not imported

`@kuru-labs/kuru-sdk` is **not** a runtime dependency of this repo (spec §4.2, rule
A6). It pins ethers v5, sorts `asks` descending, documents `minFeesPps` in basis
points when the contract reads parts-per-million, performs "tick alignment" by string
truncation, and hardcodes stale testnet addresses in `PoolFetcher` (verified: the
hardcoded values in `src/pools/fetcher.ts@0.0.95` are testnet USDC
`0xf817257fed379853cDe0fa4F97AB987181B1E5Ea` and WMON
`0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701`). The ABIs are correct; the wrapper code
around them is what this repo reimplements.

## Verified against the chain

Every ABI here was cross-checked against the deployed Monad mainnet (chain 143)
contracts on 2026-09-02 by comparing the ABI-derived 4-byte selectors with the PUSH4
selectors in the deployed dispatcher, and by live `eth_call`:

- `OrderBook` at `0x065C9d28E428A0db40191a54d33d5b7c71a9C394` (MON/USDC):
  `isTrustedForwarder(0x974E61BB…23FAA)` → `true`.
- `MarginAccount` at `0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5`:
  `isTrustedForwarder(0x974E61BB…23FAA)` → `true`.
- `Router` at `0xd651346d7c789536ebf06dc72aE3C8502cd695CC`:
  `TRUSTED_FORWARDER()` → `0x974e61bba9c4704e8bcc1923fdc3527b41323faa`.

## Not in this directory

**KuruForwarder has no ABI in the SDK** and none was published elsewhere. See
`../forwarder/` and `DECISIONS.md` open item 1. What is known about it came from
reading the deployed contract directly, not from any ABI file.
