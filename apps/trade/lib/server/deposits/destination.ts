import { decodeEventLog, getAddress, parseAbiItem, type Address, type PublicClient } from 'viem';
import { PUBLIC_RPC_GET_LOGS_MAX_RANGE } from '@tradepro/core';

/**
 * Independent proof that a deposit actually arrived on Monad — the step-4 evidence
 * the tracker rebuild needs and the watcher never had before.
 *
 * Before this, "delivered" meant the vendor's own status reached `SUCCESS`. Nothing
 * here trusts that word: every source below is either a receipt this app fetched
 * itself, or a log this app scanned itself. The vendor's own `destinationChainTxHashes`
 * entry is used only as a **candidate** to check, via `eth_getTransactionReceipt` — its
 * presence in a status payload proves nothing until that receipt comes back mined,
 * successful, and carrying a log that actually paid this recipient this token.
 *
 * ## What "independent" does not mean (security review, this session)
 *
 * A chain read proves a transaction happened. It does not, by itself, prove that
 * transaction was *this deposit's own delivery* rather than something else that
 * happened to land on the same recipient around the same time — the recipient's own
 * unrelated send, a margin withdrawal that looks like a wallet arrival, a swap fill, a
 * second concurrent deposit of the same token, or a `transfer(recipient, 0)` a bad
 * actor sent for free. Every function below that scans logs rather than confirming a
 * vendor-claimed hash therefore requires a `quotedAmount` and only accepts a match
 * within `AMOUNT_TOLERANCE` of it — the one signal that actually distinguishes "this
 * deposit" from "any transfer to this address". A row with no quote on record gets no
 * automatic match, rather than a guessed one.
 */

const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/**
 * MarginAccount's own `Deposit(address owner, address token, uint256 amount)` — none of
 * its three fields are indexed (`packages/core/src/abi/marginAccount.ts`), so this
 * cannot be topic-filtered the way `Transfer` is; every match in the window is fetched
 * and `owner`/`token` are checked client-side. This exists because a margin-landing
 * rail (`landsIn === 'margin'`) never sends the recipient a wallet `Transfer` at all —
 * the fill's own destination call deposits straight into MarginAccount, so scanning for
 * an ERC-20 transfer *to the recipient* would never find it.
 */
const MARGIN_DEPOSIT = parseAbiItem(
  'event Deposit(address owner, address token, uint256 amount)',
);

/**
 * How far a found amount may sit from the quoted one and still count as this deposit's
 * own arrival. Wide enough for real bridge slippage and fees (a solver's actual fill is
 * routinely a few percent under quote); narrow enough that an unrelated transfer — a
 * different-sized deposit, a spoofed zero-value transfer, a stray send — essentially
 * never lands inside it.
 */
const AMOUNT_TOLERANCE_MIN = 0.5;
const AMOUNT_TOLERANCE_MAX = 1.5;

export function withinTolerance(found: bigint, quoted: bigint): boolean {
  if (quoted <= 0n) return false;
  const min = (quoted * 5n) / 10n;
  const max = (quoted * 15n) / 10n;
  return found >= min && found <= max && found > 0n;
}
// Documents the fractional constants above against the integer arithmetic actually
// used (bigint has no decimals) — kept as a runtime assertion so the two can never
// silently drift apart.
if (AMOUNT_TOLERANCE_MIN !== 0.5 || AMOUNT_TOLERANCE_MAX !== 1.5) {
  throw new Error('withinTolerance was written for 0.5x-1.5x; update its arithmetic too');
}

export interface DestinationEvidence {
  readonly hash: string;
  readonly block: string;
  readonly amount?: string;
  readonly source: 'eth_getTransactionReceipt' | 'balance-poll';
}

/**
 * A destination hash the vendor has claimed, from its own raw status payload — a
 * candidate only. Covers 1Click's `swapDetails.destinationChainTxHashes` and Relay's
 * `txHashes`; an unrecognised shape yields nothing, which is a candidate not found,
 * not an error.
 */
export function extractVendorDestinationCandidate(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const asOneClick = raw as { swapDetails?: { destinationChainTxHashes?: { hash?: string }[] } };
  const oneClickHash = asOneClick.swapDetails?.destinationChainTxHashes?.[0]?.hash;
  if (oneClickHash) return oneClickHash;
  const asRelay = raw as { txHashes?: string[] };
  return asRelay.txHashes?.[0];
}

/**
 * Confirm a candidate hash on chain — and confirm what it actually did, not merely that
 * it succeeded (security review finding M2). A successful receipt proves nothing about
 * *who* it paid on its own; a vendor's own claimed hash could point at any successful
 * transaction, including one of theirs that has nothing to do with this deposit. This
 * requires the receipt to carry a matching log: a `Transfer(*, recipient, *)` on `token`
 * for a wallet-landing deposit, or MarginAccount's own `Deposit(recipient, token, *)`
 * for a margin-landing one.
 *
 * `undefined` means "not proven yet" — a pending transaction, a hash the RPC does not
 * know, or a receipt with no log that actually pays this recipient this token. Not an
 * error to surface; the caller keeps polling or falls back to a log scan.
 */
export async function confirmDestinationTx(
  client: PublicClient,
  hash: string,
  input: { recipient: Address; token: Address; landsIn: 'wallet' | 'margin'; marginAccount?: Address },
): Promise<DestinationEvidence | undefined> {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
  } catch {
    // Not mined yet, or the RPC does not know it yet. Not an error to surface — the
    // next tick tries again.
    return undefined;
  }
  if (receipt.status !== 'success') return undefined;

  if (input.landsIn === 'margin') {
    if (!input.marginAccount) return undefined;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== input.marginAccount.toLowerCase()) continue;
      let decoded;
      try {
        decoded = decodeEventLog({ abi: [MARGIN_DEPOSIT], data: log.data, topics: log.topics });
      } catch {
        continue;
      }
      const args = decoded.args as { owner: Address; token: Address; amount: bigint };
      if (
        args.owner.toLowerCase() === input.recipient.toLowerCase() &&
        args.token.toLowerCase() === input.token.toLowerCase()
      ) {
        return {
          hash,
          block: receipt.blockNumber.toString(),
          amount: args.amount.toString(),
          source: 'eth_getTransactionReceipt',
        };
      }
    }
    return undefined;
  }

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== input.token.toLowerCase()) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    const args = decoded.args as { from: Address; to: Address; value: bigint };
    if (args.to.toLowerCase() === input.recipient.toLowerCase()) {
      return {
        hash,
        block: receipt.blockNumber.toString(),
        amount: args.value.toString(),
        source: 'eth_getTransactionReceipt',
      };
    }
  }
  return undefined;
}

/**
 * The recipient's own `Transfer` history for one token, scanned directly — what
 * `/api/account/incoming` already did for the "attach an explorer link" case, extracted
 * so the watcher can run the identical scan on a schedule rather than only on request.
 * One definition, one evidence source (the tracker rebuild's own rule): both callers
 * now go through this.
 *
 * Bounded to `windows` lookbacks of the public RPC's 100-block `eth_getLogs` cap —
 * the right tool for "did this land recently", the wrong one for full history.
 *
 * `quotedAmount` is required. Without it there is nothing that ties a matching
 * `Transfer` to *this* deposit rather than to anything else the recipient received in
 * the window (security review finding H1), so this returns `undefined` rather than
 * guess. A transfer *from* `excludeSender` (MarginAccount, when known) is skipped —
 * a margin withdrawal reads as a wallet arrival on chain and is not this deposit either.
 */
export async function findIncomingTransfer(
  client: PublicClient,
  account: Address,
  token: Address,
  quotedAmount: bigint | undefined,
  options: { windows?: number; excludeSender?: Address } = {},
): Promise<DestinationEvidence | undefined> {
  if (quotedAmount === undefined) return undefined;
  const windows = options.windows ?? 4;
  const head = await client.getBlockNumber();
  const span = PUBLIC_RPC_GET_LOGS_MAX_RANGE;

  for (let i = 0n; i < BigInt(windows); i += 1n) {
    const toBlock = head - i * span;
    const fromBlock = toBlock > span ? toBlock - span + 1n : 0n;
    const logs = await client.getLogs({
      address: token,
      event: TRANSFER,
      args: { to: account },
      fromBlock,
      toBlock,
    });
    const match = logs
      .filter((log) => {
        const args = log.args as { from?: Address; value?: bigint };
        if (options.excludeSender && args.from?.toLowerCase() === options.excludeSender.toLowerCase()) {
          return false;
        }
        return args.value !== undefined && withinTolerance(args.value, quotedAmount);
      })
      .at(-1);
    if (match?.transactionHash) {
      return {
        hash: match.transactionHash,
        block: (match.blockNumber ?? toBlock).toString(),
        amount: (match.args as { value: bigint }).value.toString(),
        source: 'balance-poll',
      };
    }
    if (fromBlock === 0n) break;
  }
  return undefined;
}

/**
 * The recipient's most recent `Transfer` of one token, with **no** attribution check —
 * for `/api/account/incoming`'s explorer-link lookup, which already knows a balance
 * rose some other way and only wants a transaction to link to it. Never use this for
 * deposit-tracker evidence: it carries none of `findIncomingTransfer`'s amount-
 * tolerance guarantee (security review finding H1) and would match any transfer to the
 * account, deposit-related or not.
 */
export async function findMostRecentTransferUnattributed(
  client: PublicClient,
  account: Address,
  token: Address,
  windows = 4,
): Promise<DestinationEvidence | undefined> {
  const head = await client.getBlockNumber();
  const span = PUBLIC_RPC_GET_LOGS_MAX_RANGE;

  for (let i = 0n; i < BigInt(windows); i += 1n) {
    const toBlock = head - i * span;
    const fromBlock = toBlock > span ? toBlock - span + 1n : 0n;
    const logs = await client.getLogs({ address: token, event: TRANSFER, args: { to: account }, fromBlock, toBlock });
    const last = logs.at(-1);
    if (last?.transactionHash) {
      return {
        hash: last.transactionHash,
        block: (last.blockNumber ?? toBlock).toString(),
        ...((last.args as { value?: bigint }).value !== undefined
          ? { amount: (last.args as { value: bigint }).value.toString() }
          : {}),
        source: 'balance-poll',
      };
    }
    if (fromBlock === 0n) break;
  }
  return undefined;
}

/**
 * `MarginAccount.Deposit(owner, token, amount)` for one recipient and token, scanned
 * the same bounded-window way as `findIncomingTransfer` — the margin-landing
 * equivalent of it, since a margin-landing rail's money never reaches the recipient's
 * own wallet to show up as a `Transfer` there. Same `quotedAmount` requirement, for the
 * same reason: MarginAccount's `deposit()` is callable by anyone naming any owner, so
 * an unrelated caller can emit a same-shaped event for this recipient at any time.
 */
export async function findMarginDeposit(
  client: PublicClient,
  marginAccount: Address,
  recipient: Address,
  token: Address,
  quotedAmount: bigint | undefined,
  windows = 4,
): Promise<DestinationEvidence | undefined> {
  if (quotedAmount === undefined) return undefined;
  const head = await client.getBlockNumber();
  const span = PUBLIC_RPC_GET_LOGS_MAX_RANGE;

  for (let i = 0n; i < BigInt(windows); i += 1n) {
    const toBlock = head - i * span;
    const fromBlock = toBlock > span ? toBlock - span + 1n : 0n;
    const logs = await client.getLogs({
      address: marginAccount,
      event: MARGIN_DEPOSIT,
      fromBlock,
      toBlock,
    });
    const match = logs
      .filter((log) => {
        const args = log.args as { owner?: Address; token?: Address; amount?: bigint };
        return (
          args.owner?.toLowerCase() === recipient.toLowerCase() &&
          args.token?.toLowerCase() === token.toLowerCase() &&
          args.amount !== undefined &&
          withinTolerance(args.amount, quotedAmount)
        );
      })
      .at(-1);
    if (match?.transactionHash) {
      return {
        hash: match.transactionHash,
        block: (match.blockNumber ?? toBlock).toString(),
        amount: (match.args as { amount: bigint }).amount.toString(),
        source: 'balance-poll',
      };
    }
    if (fromBlock === 0n) break;
  }
  return undefined;
}

/**
 * One deposit's destination check — a candidate hash confirmed by receipt if the
 * vendor claimed one, otherwise a direct scan of the recipient's own arrivals.
 * `outTokenAddress` must be resolved by the caller (`out_token` on the row is a symbol,
 * chain-config resolves it to an address) — this module has no opinion on chain config.
 *
 * `landsIn === 'margin'` scans `MarginAccount`'s own `Deposit` event instead of a
 * wallet `Transfer` — see `findMarginDeposit`'s own doc comment for why the two are not
 * interchangeable.
 *
 * `quotedAmountOut` gates the log-scan fallback (see `findIncomingTransfer`); the
 * receipt-confirm path needs it too, now that `confirmDestinationTx` validates the log
 * itself rather than merely the receipt's success — a candidate confirmed by a real log
 * to the real recipient is already attributable, but nothing here relaxes that check
 * just because a candidate hash was offered.
 */
export async function detectDestination(
  client: PublicClient,
  input: {
    recipient: Address;
    outTokenAddress: Address | undefined;
    vendorRaw: unknown;
    landsIn?: 'wallet' | 'margin';
    marginAccount?: Address;
    quotedAmountOut?: bigint;
  },
): Promise<DestinationEvidence | undefined> {
  const landsIn = input.landsIn ?? 'wallet';
  const token = input.outTokenAddress ? getAddress(input.outTokenAddress) : undefined;

  if (token) {
    const candidate = extractVendorDestinationCandidate(input.vendorRaw);
    if (candidate) {
      const confirmed = await confirmDestinationTx(client, candidate, {
        recipient: input.recipient,
        token,
        landsIn,
        ...(input.marginAccount ? { marginAccount: input.marginAccount } : {}),
      });
      // Paying the right recipient the right token is most of the proof; when a
      // quoted amount is also on record, the confirmed log must roughly match it too
      // — belt and suspenders against a vendor handing back a stale or wrong hash
      // that still happens to pay this same recipient in this same token.
      if (confirmed && (input.quotedAmountOut === undefined || (confirmed.amount && withinTolerance(BigInt(confirmed.amount), input.quotedAmountOut)))) {
        return confirmed;
      }
    }
  }

  if (!token) return undefined;
  if (landsIn === 'margin') {
    if (!input.marginAccount) return undefined;
    return findMarginDeposit(client, input.marginAccount, input.recipient, token, input.quotedAmountOut);
  }
  return findIncomingTransfer(client, input.recipient, token, input.quotedAmountOut, {
    ...(input.marginAccount ? { excludeSender: input.marginAccount } : {}),
  });
}
