# `market-kit` — deploy and seed an AUSD market on Kuru

Phase 1 of `tradepro`. Spec §8. Operator tooling: a CLI and a local web page that
deploy a Kuru market, build a flip-order ladder, fund it, check on it, and take the
money back out.

Every number below was read from Monad mainnet (chain 143) on **2026-09-02**. Nothing
in this package is copied from `@kuru-labs/kuru-sdk`, and nothing in it is a guess.
Where something could not be read, it says so.

---

## 1. The measurement

Kuru's AUSD books are close to empty, and its own vaults are dust.

| Read on 2026-09-02                                            | Value                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| MON/AUSD `0x131a2e70…` `bestBidAsk()`                         | 0.025442 / 0.025952 — a **200.4 bps** spread                                |
| MON/USDC `0x065c9d28…` `bestBidAsk()`, the same asset in USDC | 0.025723 / 0.025730 — a **2.7 bps** spread                                  |
| MON/AUSD's KuruAMMVault `0xf7Fbe88e…` `totalAssets()`         | **5,885,231,097 wei of MON and one base unit of AUSD**, against 1000 shares |
| AUSD/USDC `0x699abc15…`                                       | 1.000141 / 1.000142 — one tick wide, so AUSD itself is not the problem      |
| WBTC/AUSD                                                     | no book at all                                                              |
| USDT0/AUSD                                                    | does not exist                                                              |

The same asset trades 74x tighter against USDC than against AUSD on the same venue, in
the same block (200.4 / 2.7). The gap is not price discovery; it is that nobody has put orders there.

## 2. The gap

Seeding one of those books correctly is harder than it looks, and the two places it
goes wrong are both in Kuru's own documentation.

**`minFeesPps` is parts-per-million, not basis points.** Kuru's liquidity example passes
a basis-point number. On a 1e8-precision market that builds a ladder **100× too tight** —
and, measured rather than assumed, the OrderBook **accepts it**. A flip price one tick
above its order price passes `batchProvisionLiquidity` without complaint. The venue
enforces tick alignment and says nothing about the economics, so the mistake does not
revert. It rests, quotes 0.4 bps of edge instead of 30, and gets picked off.

**The SDK's `asks` array is sorted descending**, so `asks[0]` is the _worst_ ask.
Anchoring a sell ladder on it puts the whole side in the wrong place.

Two more, found while building this and equally expensive:

**The KuruAMMVault is not ERC-4626**, and the vendored SDK ABI for it is stale. Its
`deposit` takes four arguments, not two. A tool built from that ABI produces a call
whose selector does not exist in the deployed bytecode.

**A market that does not exist cannot be dry-run with `eth_call`.** A call to an address
with no code returns empty **success**, so a naive simulation of a new market's first
ladder prints "ok" for every level and means nothing.

## 3. The tool

`market-kit` makes all four structural rather than remembered.

- `--fee-bps` is the only way a fee enters the ladder builder, and it is multiplied by
  100 on the way in. `assertLadderSpacing` then fails loudly if the resulting gap is
  under one tick.
- The anchor comes from `bestBidAsk()` read from the chain. When there is no two-sided
  book, `resolveAnchor` **throws** rather than inventing a price — and `--ref` now
  requires `--ref-source`, so the dry run records where that number came from.
- `kit vault` uses `core/abi/kuruAmmVaultDeployed.ts`, read from the verified
  deployment, and names the SDK's version as stale.
- A market that does not exist yet is simulated with **`eth_simulateV1`**: deploy the
  market in a simulated block, then provision the ladder on the contract that deploy
  created.

Both original corrections are unit-tested against the real market's parameters, and the
dry run prints the whole ladder, the total capital, and the exact calldata before
anything is signed.

---

## 4. Commands

```
kit deploy   --base <addr> --quote <addr> --min-size <human> --max-size <human>
             [--preset-from <market>] [--price-precision 1e8] [--size-precision 1e10]
             [--tick 100] [--taker-fee-bps 0] [--maker-fee-bps 0] [--amm-spread 30]
             [--symbol NAME] [--markets-dir DIR]

kit seed     --market <addr> --fee-bps <n> --size-per-level <quote amount>
             [--band 0.98..1.02] [--levels 6] [--side buy|sell|both]
             [--ref <price> --ref-source <where it came from>] [--no-deposit]

kit vault    --market <addr> | --pending <markets/X.pending.json>
             --deposit-base <amt> --deposit-quote <amt>
             [--min-quote-consumed <amt>] [--receiver <addr>]

kit swap     --token-in <addr> --token-out <addr> --amount <human>
             [--slippage <pct>] [--referrer <addr>] [--referrer-bps <n>]

kit status   --market <addr> [--scan 2000]

kit teardown --market <addr> [--order-ids 1,2,3] [--scan 2000] [--batch-size 50]
             [--no-withdraw]
```

Common flags: `--from <operator address>`, `--chain mainnet|testnet`, `--rpc <url>`,
`--simulate`, `--out <file>`, `--dry-run`.

`--levels` is **per side**: `--levels 6 --side both` builds twelve orders.

### The mode gate

`MODE=dryrun` is the default everywhere. A dry run reads the chain, builds every
transaction, prints it, optionally simulates it, and stops. Submitting requires
`CHAIN=mainnet`, `MODE=live` **and** `I_UNDERSTAND_THIS_USES_REAL_FUNDS=true`. Nothing
in this repo sets them.

The dry-run and live paths are the same array of `PlannedCall`s in the same order.
`submitPlan` is the only door to the chain and it throws in a dry run, so "the dry run
showed something different" cannot happen.

### The key

The operator key is generated by `pnpm generate-deployer` into
`.secrets/deployer-keystore.json` — Web3 Secret Storage v3, git-ignored, and it prints
an address and never a key. It is deliberately **not** the owner's wallet: this key
signs approvals, deposits and provisions, so a mis-typed `--size-per-level` should
reach the seeding float and nothing else.

---

## 5. `kit deploy`

`Router.deployProxy` at `0xd651346d7c789536ebf06dc72aE3C8502cd695CC`, selector
`0xce186ec3`.

Parameter **presets are read live from an existing market**. Copied: `pricePrecision`,
`sizePrecision`, `tickSize`, `takerFeeBps`, `makerFeeBps`, and the AMM spread from
`getVaultParams()`.

**`--min-size` and `--max-size` are never copied.** They are denominated in the base
asset: MON/AUSD's `minSize` of `2_000_000_000_000` sizePrecision units is _200 MON_, and
the same number on a six-decimal stablecoin base would be twelve orders of magnitude
out. `sizePrecision` has the same problem and is overridden explicitly when the preset's
base has different decimals.

Before building the call the kit checks what the Router checks — both precisions exact
powers of ten, the tick non-zero and no coarser than the precision, `minSize <= maxSize`
— so a typo costs a line of output rather than a reverted transaction.

`Router.computeAddress` and `computeVaultAddress` give the addresses the deploy would
produce; if the market address already has code the kit refuses, because the CREATE2
salt _is_ the parameter set and a redeploy reverts.

A dry run writes **`markets/<symbol>.pending.json`**: the derived `_type`, all eleven
arguments, the calldata and the predicted addresses. On the live path the kit waits for
`MarketRegistered`, checks the event's `market` against the prediction, reads
`getMarketParams()` back off the new contract, compares it to the pending record, and
only then writes `markets/<symbol>.json`. A deployment that disagrees with what was
reviewed is refused, not recorded.

### `_type` — spec §8.2 `[?]`, open item 5: **closed**

`_type` is `IOrderBook.OrderBookType`, and it is **not a free choice**:

```solidity
enum OrderBookType { NO_NATIVE, NATIVE_IN_BASE, NATIVE_IN_QUOTE }   // 0, 1, 2
```

from the verified Router implementation `0x0f2a2a5c0a78c406c26adb2f1681d3e47322a9cd`.
`deployProxy` requires it to agree with which side is the zero address, or reverts with
`MarketTypeMismatch()`:

| `_type`           | value | requires                                    |
| ----------------- | ----- | ------------------------------------------- |
| `NO_NATIVE`       | 0     | both assets non-zero and different          |
| `NATIVE_IN_BASE`  | 1     | `base == address(0)`, `quote != address(0)` |
| `NATIVE_IN_QUOTE` | 2     | `base != address(0)`, `quote == address(0)` |

Confirmed against **all 38 `deployProxy` calls in the Router's history**. MON/AUSD
itself was created by `0x8642018193e395f73e79d0f5bc357de4c735ae37baa28194565816f39ba6d57e`
(block 45440066) with `_type = 1`. So the kit **derives** the type from the pair
(`core/kuru/marketType.ts`) instead of asking for it. `MarketRegistered` does not carry
`_type`; it is recoverable only from the creating transaction, or by the rule above.

---

## 6. `kit seed` — the corrections, enforced

### The ladder

The anchor comes from `bestBidAsk()`. If both sides are non-zero the buy ladder hangs
below the bid and the sell ladder above the ask. If the book is empty or one-sided,
`--ref` is **required** and so is `--ref-source`; a crossed book is rejected outright
(invariant I1) and never averaged away.

Levels are evenly spaced across `--band low..high` of the mid, tick-aligned in the
direction of their side. Flip prices come from the fee:

```
buy  at p  ->  flip sell at roundUpToTick(p * (1e6 + feePps) / 1e6)
sell at q  ->  flip buy  at roundDownToTick(q * (1e6 - feePps) / 1e6)
```

That direction is not assumed. `s_orders(13130678)` on MON/AUSD, read 2026-09-02, is a
resting **sell** at `2595200` with `flippedPrice 2544200` — 196 bps _below_ it.

Sizes come from `--size-per-level`, a **quote** notional, converted in integers:

```
size = quote * pricePrecision * sizePrecision / (price * 10**quoteDecimals)
```

Everything is `bigint`. Floats appear only in the display formatters.

### The assertions

Every ladder must pass, or the command fails before it builds any calldata: every flip
gap ≥ 1 tick and ≤ 5% of its price; every gap between consecutive levels the same; every
price a whole multiple of the tick, positive, inside `uint32`; every size between the
market's `minSize` and `maxSize` and inside `uint96`; the highest buy strictly below the
lowest sell; a buy's flip above it and a sell's flip below it.

### The plan

In order: an exact-amount `approve` for each ERC-20 leg that needs one, a
`MarginAccount.deposit` for each leg's **shortfall** (existing margin balances are read
first, so a funded operator is not asked to move money twice), then

```
batchProvisionLiquidity(prices, flipPrices, sizes, isBuy[], provisionOrRevert = true)
```

selector `0xcca97a3c`. Native legs travel as `msg.value`; ERC-20 legs are pulled by
`safeTransferFrom`, which is why the approve is there.

### `--simulate`

On a **live** market: every planned call is `eth_call`ed against current state — which
honestly reports that the deposits fail while the operator has not moved the money yet —
and then the provision alone is `eth_call`ed with the operator's MarginAccount balances
overridden to exactly the ladder's requirement. The storage layout for that override is
`balances` at slot 1 keyed by `keccak256(abi.encodePacked(user, token))`, read from the
verified MarginAccount and then _confirmed_ by reading a known balance back through both
`getBalance` and `eth_getStorageAt`.

On a market that **does not exist yet**: one `eth_simulateV1` block containing
`Router.deployProxy` and then `batchProvisionLiquidity` against the OrderBook that deploy
created. `PriceError`, `TickSizeError`, `SizeError`, `PostOnlyError` and `ProvisionError`
all fire for real. Monad's RPC rejects `"validation": false`, so the caller's native
balance is overridden to cover gas — an override, not a funding.

The approvals and deposits are deliberately **not** in that bundle: including them would
mean overriding two ERC-20 balance slots whose layouts have not been read from verified
source. AUSD's balance mapping is at no plain slot 0..39 and at none of the ERC-7201
namespaces tried, so it would have to be guessed, and a simulation that needs a guessed
storage layout to pass is not evidence.

---

## 7. `kit swap`

Seeding USDT0/AUSD needs USDT0, and there is no USDT0/AUSD book to buy it on — that is
the market being created. `kit swap` takes one Kuru Flow quote and builds the exact-amount
approve plus the swap.

Two things about the Flow API that this command exists to keep straight, both measured:
`transaction.calldata` comes back **without an `0x` prefix**, and passed straight to a
wallet it produces an empty call that succeeds and swaps nothing; and the quote JWT is
rate-limited to **one request per second, burst one**, so the command takes exactly one
quote per run and never polls.

The router the quote points at (`0xb3e6778480b2E488385E8205eA05E20060B813cb`) answers
neither `isTrustedForwarder(address)` nor `TRUSTED_FORWARDER()`, so this swap **cannot be
relayed** (open item 9): the operator signs it and pays its gas.

**The route is not decoded.** The function at selector `0xce1e7030` is undocumented and
was not read from verified source, so no ABI is attached to it and the calldata is
printed whole. What _is_ checked is that `tokenIn`, `tokenOut`, `amount` and `minOut`
from the quote's own JSON all appear in the bytes it returned — the failure that would
otherwise swap the wrong amount or send the output elsewhere.

---

## 8. `kit vault` — spec §8.4 `[?]`, open item 6: **closed**

**The KuruAMMVault is not ERC-4626.** The spec said it was. It is not.

Read from the verified implementation `0xDC2A82E321866C30d62077945e067172C5f970F4`
(`KuruAMMVault`, solc 0.8.30) and confirmed against the live MON/AUSD vault:

| ERC-4626 expects           | the deployed vault has                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `asset()`                  | reverts. Two assets: `token1()` = base, `token2()` = quote                                                    |
| `deposit(uint256,address)` | `deposit(uint256 base, uint256 quote, uint256 minQuoteConsumed, address receiver) payable` — **`0xfad3cc4b`** |
| `totalAssets() → uint256`  | `totalAssets() → (uint256, uint256)`, the vault's **MarginAccount** balances                                  |
| `redeem`/`previewRedeem`   | absent; `withdraw(shares, receiver, owner) → (uint256, uint256)`                                              |
| `previewDeposit(uint256)`  | `previewDeposit(uint256, uint256) → uint256`                                                                  |

The SDK 0.0.95 ABI in `core/abi/kuruAmmVault.ts` is **stale**: it carries a
three-argument `deposit(uint256,uint256,address)` whose selector does not appear anywhere
in the deployed bytecode.

Two semantics worth knowing before spending money:

- **`--deposit-quote` is a ceiling, not an amount.** Once the vault has shares
  outstanding, `_mintAndDeposit` recomputes the quote leg from the base leg at
  `vaultBestAsk()` and requires the recomputed value to be at or below what was passed
  (`InsufficientQuoteToken()` otherwise). Only the recomputed amount is pulled;
  `minQuoteConsumed` is the floor on it. On the first deposit (`totalSupply() == 0`) both
  legs are taken as given and shares are `sqrt(base * quote) - 1000`.
- **MON/AUSD's vault cannot be deposited into, and this kit does not work around it.**
  It holds 1000 shares against 5,885,231,097 wei of MON and one unit of AUSD;
  `_returnVirtuallyRebalancedTotalAssets` rounds the half-valuation to zero and
  `_convertToShares` divides by it. `previewDeposit` and `deposit` both return
  `0xad251c27` — solady's `MulDivFailed()` — verified by `eth_call`. Vault seeding
  therefore targets USDT0/AUSD, whose fresh vault takes the working branch.

`kit vault --pending markets/<symbol>.pending.json` builds the deposit for a market that
has not been deployed yet, from the record the deploy dry run wrote. It computes the
shares the first deposit will mint, and it is explicit that it is **prepared, not
simulated** — see §6 for why the token balances cannot honestly be overridden.

---

## 9. `kit status` and `kit teardown`

`status` reads params from `getMarketParams()` (the 11-tuple), best bid/ask from
`bestBidAsk()`, vault TVL from `totalAssets()`, your MarginAccount balances, and your
resting orders.

Resting orders come from a **bounded backwards scan** of `s_orders` from
`s_orderIdCounter()`, batched through Multicall3 at
`0xcA11bde05977b3631167028862bE2a173976CA11` (3808 bytes of code on Monad mainnet;
viem's chain definition does not list it, so the kit passes the address explicitly). The
window is `--scan N`, default 2000, and the scanned range is printed. It is a scan and
not a log query because the public Monad RPC caps `eth_getLogs` at a **100-block range**
(`{"code":-32614}`), and the Envio indexer that spec §9 makes load-bearing is Phase 3
work.

`teardown` cancels and withdraws. Flip orders and plain orders cancel through
**different** functions — `batchCancelFlipOrders(uint40[])` `0xba42d8bd` and
`batchCancelOrders(uint40[])` `0x23afbff3` — and the contract has a
`WrongOrderTypeCancel()` error for confusing them. `s_orders(id).flippedPrice != 0` is
how a flip order identifies itself, so the kit splits the two lists by that and batches
each at `--batch-size` (default 50). Then `MarginAccount.withdraw(amount, token)` for
each side.

The withdrawable amounts printed are read **before** the cancels; cancelling releases
the ladder's collateral, so the real balance afterwards is larger. Run teardown twice.

---

## 10. The web UI

```
pnpm --filter @tradepro/market-kit web        # http://127.0.0.1:8788
```

Design §5.7: market select, the parameters grid, the seed form with a live read-only
"Stored as N pps" beside the spacing input, a staggered ladder table with a notice
stating the conversion and the anchor, and a teardown card.

Three things about its shape are deliberate.

**No key reaches the browser.** The page has no wallet connection and no signing code.
`POST /api/sign` runs in the local process, unlocks `.secrets/deployer-keystore.json`,
and submits — and refuses unless the same three switches are set. The Sign button is
disabled otherwise and carries the reason in its own label. Spec §8.5 originally said the
UI would sign "via injected wallet"; that contradicts rule A2.2 and was corrected
(conflict C11).

**The page runs the CLI's own builders.** Every endpoint builds the exact `ParsedArgs`
the command line would produce and calls `buildSeedReport`, `buildDeployPlan` or
`buildTeardownReport`. There is no second implementation to drift from the first, and
every response carries the equivalent `kit …` command so a review can be repeated in a
terminal. Every endpoint forces `--dry-run`, so rendering a plan cannot send one, and
`/api/sign` rebuilds the plan from flags rather than accepting calldata from the page.

**It binds to 127.0.0.1** and has no authentication, because it must never be reachable
by anything that would need any.

It is styled from `packages/ui/src/tokens.css` directly rather than a copy, so this
surface and `apps/trade` cannot drift apart.

---

## 11. The two markets it will seed

Both plans are on file in `dryruns/`, generated against live mainnet reads with the
deployer address `0x6B99d03Da4F8FC4E390AB31B14016bEF7611a70a`. **Nothing has been
submitted.** The ordered procedure is `reports/phase1-live-procedure.md`.

### MON/AUSD `0x131A2e70A5b31a517A74b8c567149bc294470Da9`

The only live-allowlisted market, and the one quoting 200 bps. Twelve flip orders,
`--fee-bps 30` → 3000 pps, `--band 0.98..1.02`, **5.50 of quote a level**: 33.00 AUSD on
the buy side and 1265.2630697618 MON on the sell side.

`--size-per-level` cannot go much below that. `minSize` is `2e12` sizePrecision units =
**200 MON**, so at the band top a level must carry at least 5.2422 AUSD; 5.50 leaves
about 5% of headroom before a price move makes the build fail.

Simulated with the operator's MarginAccount balances overridden to exactly the ladder's
requirement: **`batchProvisionLiquidity` ACCEPTED**.

### USDT0/AUSD — not deployed

`_type = 0` (`NO_NATIVE`). Price precision 1e8, tick 100 and 0/0 fees copied from
MON_USDC `0x065C9d28…`; `sizePrecision` set to **1e6** to match USDT0's six decimals —
the scheme the live AUSD/USDC book uses, the only AUSD-quoted six-decimal-base market on
the venue. `minSize` **1 USDT0**, so a $6-capped user order is legal on it, which is not
true of MON/AUSD (conflict C5).

Predicted market `0xE9E448ab704E0b5F83261342D0DB8aC00651E70F`, predicted vault
`0x40f09C3d5471098bB98E121A03ED7F88B7d76F6b`, both from the Router's own
`computeAddress` / `computeVaultAddress`.

Twelve flip orders, `--fee-bps 5` → 500 pps, `--band 0.997..1.003`, **2.50 of quote a
level**: 15.00 AUSD and 14.977547 USDT0.

Anchored on **`--ref 1.0`**, and the cross-check is recorded rather than assumed. On
2026-09-02 the AUSD/USDC book quoted 1.000141 / 1.000142, and a Kuru Flow round-trip from
the deployer returned 25 AUSD → 25.010421 USDT0 and 25 USDT0 → 24.987070 AUSD — a mid of
**0.999533 AUSD per USDT0**. The 1.0000 anchor therefore sits about **47 bps above** the
measured mid, so the top buy level is above fair value. That is stated in the dry run
rather than smoothed over.

Simulated with `eth_simulateV1`: `deployProxy` **ok**, returning exactly the predicted
address, then `batchProvisionLiquidity` **ACCEPTED** on the book it created.

### Together

**96.00 AUSD of notional across both ladders**, against the 100 USD ceiling in
`DECISIONS.md` → M1. The 1265.263 MON is not additional capital — it _is_ the MON/AUSD
sell side.

### Transaction hashes

| What                            | Hash               |
| ------------------------------- | ------------------ |
| Kuru Flow swap, 25 AUSD → USDT0 | _pending live run_ |
| `Router.deployProxy` USDT0/AUSD | _pending live run_ |
| MON/AUSD ladder                 | _pending live run_ |
| USDT0/AUSD ladder               | _pending live run_ |
| USDT0/AUSD vault deposit        | _pending live run_ |
| Teardown and re-seed            | _pending live run_ |

Every row says **pending live run** because nothing has been submitted. They are filled
in from `reports/phase1-live-procedure.md` §7 after the run.

---

## 12. Dry runs on file

`dryruns/` holds reviewed output, generated against live mainnet reads on 2026-09-02.

| File                    | What                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `MON_AUSD.seed.txt`     | the 12-order ladder on the live book, 5.50 a level, `--fee-bps 30`, **ACCEPTED**       |
| `MON_AUSD.status.txt`   | the market as read: params, book, vault, balances, resting orders                      |
| `MON_AUSD.teardown.txt` | a teardown plan over 43 real resting flip orders, batched into `batchCancelFlipOrders` |
| `MON_AUSD.vault.txt`    | the vault deposit, and the `MulDivFailed()` it returns today                           |
| `USDT0_AUSD.quote.txt`  | a real Kuru Flow quote for 25 AUSD of USDT0, with the swap calldata                    |
| `USDT0_AUSD.deploy.txt` | the `deployProxy` call that would create the market, `eth_call` **ok**                 |
| `USDT0_AUSD.seed.txt`   | the ladder, simulated by deploying the market first, **ACCEPTED**                      |
| `USDT0_AUSD.vault.txt`  | the prepared first vault deposit, 999,000 shares                                       |

`markets/USDT0_AUSD.pending.json` is the machine-readable version of the deploy: the
eleven arguments, the calldata and the predicted addresses, written before anything is
signed and checked against the chain afterwards.

---

## 13. Capital caps

`core/chain/caps.ts` caps a _user_ order at $6 and allowlists one market. Those caps
govern the sponsored path in spec §5 — a leaked relayer key, a mis-typed amount. Seeding
is the operator spending their own capital from their own key, so the kit does **not**
apply them; when a level is above the cap the dry run says so in as many words, rather
than silently ignoring it or refusing to run.

The ceiling that does apply to seeding is the M1 one: 100 USD across both ladders.

---

## 14. Tests

```
pnpm --filter @tradepro/market-kit test
```

106 tests. Every pure function is covered; the two corrections have dedicated blocks
(`correction 1: --fee-bps is multiplied by 100…`, `correction 2: the ladder anchors on
bestBidAsk()…`) plus a block recording what the contract does and does not check, which
is the argument for why the assertions have to be client-side. The web server's two
security-relevant pure functions have their own file: that a request can never turn into
a submission by itself, and that every rendered plan carries the command that reproduces
it.

Fixtures in `src/__fixtures__/markets.ts` are the real MON/AUSD parameters and best
bid/ask, pasted from a live read at block 101315410. `core`'s `_type` derivation is
tested separately against five real `deployProxy` transactions.

---

## 15. What is not here

- **No testnet path.** Kuru's public testnet runs an older, incompatible build:
  `getMarketParams()` returns 7 words instead of 11, and `addBuyOrder`, `getL2Book` and
  `isTrustedForwarder` all revert (open item 7). `--chain testnet` fails with a sentence
  explaining why rather than a hardcoded address that does not work. This is why M1 is a
  capped mainnet gate.
- **No decoded Kuru Flow route.** See §7.
- **No simulated token balances.** See §6.
- **Nothing submitted.** Every number in this README came from a read, an `eth_call`, or
  an `eth_simulateV1`.
