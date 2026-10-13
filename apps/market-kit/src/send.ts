import {
  createWalletClient,
  encodeAbiParameters,
  encodePacked,
  http,
  keccak256,
  toHex,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { deployerKeystoreExists, loadDeployerAccount } from './keystore.js';
import { assertMainnetAllowed, chainFor, mainnetAllowed } from '@tradepro/core';
import { describeError, EXTRA_REVERT_SELECTORS } from './market.js';
import { decodeKuruError } from '@tradepro/core';
import type { KitConfig } from './config.js';
import type { PlannedCall } from './plan.js';

/**
 * The one door between a built plan and the chain.
 *
 * Rule A2.4 as amended: submitting needs `CHAIN=mainnet`, `MODE=live` **and**
 * `I_UNDERSTAND_THIS_USES_REAL_FUNDS=true`. Nothing in this repo sets them. Every
 * command builds its `PlannedCall`s unconditionally and then calls `submitPlan`,
 * which throws in a dry run — so the dry-run and live paths are the same code path,
 * and "the dry run showed something different" cannot happen.
 */

export interface SimulationResult {
  readonly call: PlannedCall;
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * `eth_call` each planned call, in order, from the operator address.
 *
 * A simulation is not a promise that the sequence succeeds: each call is simulated
 * against **current** state, so a `batchProvisionLiquidity` that depends on a deposit
 * earlier in the same plan will fail here until that deposit is real. That is reported
 * as-is rather than papered over, because a state override that fixed it would be
 * telling the operator what they want to hear.
 *
 * The one override is the operator's **native MON balance**, raised to cover the
 * `msg.value` the plan attaches. Without it a call that sends MON fails inside the
 * node before it reaches the contract — `"An internal error was received"` — which
 * hides the contract's real answer behind a funding problem the operator already
 * knows about. Every command that uses this says so in its output.
 */
export async function simulatePlan(
  client: PublicClient,
  from: `0x${string}`,
  calls: readonly PlannedCall[],
): Promise<SimulationResult[]> {
  const totalValue = calls.reduce((a, c) => a + c.value, 0n);
  // 10 MON of headroom over msg.value, not 1: the node still charges the call's gas
  // against the overridden balance, and at 11 MON against a 10 MON `value` the RPC
  // answers -32603 "internal error" instead of the contract's own revert. Measured
  // 2026-09-02 against the MON/AUSD vault: 11 MON -> -32603, 20 MON -> 0xad251c27.
  const stateOverride =
    totalValue > 0n ? [{ address: from, balance: totalValue + 10n * 10n ** 18n }] : undefined;
  const out: SimulationResult[] = [];
  for (const call of calls) {
    try {
      await client.call({
        account: from,
        to: call.to,
        data: call.data,
        value: call.value,
        ...(stateOverride ? { stateOverride } : {}),
      });
      out.push({ call, ok: true });
    } catch (error) {
      out.push({ call, ok: false, reason: describeError(error) });
    }
  }
  return out;
}

export class DryRunStop extends Error {
  constructor(readonly calls: readonly PlannedCall[]) {
    super(
      `dry run: ${calls.length} transaction(s) built and printed, none sent. ` +
        'Submitting needs CHAIN=mainnet, MODE=live and I_UNDERSTAND_THIS_USES_REAL_FUNDS=true.',
    );
    this.name = 'DryRunStop';
  }
}

/**
 * The signer, resolved from the encrypted keystore first and the environment second.
 *
 * `.secrets/deployer-keystore.json` is the intended source: a key at rest is encrypted,
 * and a keystore that is copied, committed or backed up on its own is useless without
 * the passphrase. `DEPLOYER_PRIVATE_KEY` stays supported for a machine that has no
 * keystore, and is checked last so its presence cannot quietly shadow the keystore.
 *
 * Either way the signer must be the address the plan was built for. Signing as somebody
 * else would produce a transaction the dry run never described.
 */
export function walletFor(config: KitConfig): WalletClient {
  const account = resolveSigner(config);
  if (account.address.toLowerCase() !== config.from.toLowerCase()) {
    throw new Error(
      `the deployer key belongs to ${account.address} but this plan was built for ` +
        `${config.from}. Refusing to sign as someone other than the address the plan ` +
        'names. Set DEPLOYER_ADDRESS to the keystore address, or pass --from.',
    );
  }
  return createWalletClient({
    account,
    chain: chainFor(config.mode),
    transport: http(config.rpcUrl),
  });
}

function resolveSigner(config: KitConfig): PrivateKeyAccount {
  void config;
  if (deployerKeystoreExists()) return loadDeployerAccount();
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      'no deployer key. Run `pnpm generate-deployer` to create an encrypted keystore at ' +
        '.secrets/deployer-keystore.json, or set DEPLOYER_PRIVATE_KEY. Neither is set by ' +
        'anything in this repo.',
    );
  }
  return privateKeyToAccount(key as `0x${string}`);
}

/**
 * Submit a plan, or refuse. Returns the hashes in plan order.
 *
 * Every call is simulated immediately before it is sent, and a failing simulation
 * aborts the remaining calls: a half-seeded ladder is recoverable with `kit
 * teardown`, a blind retry is not.
 */
export async function submitPlan(
  config: KitConfig,
  calls: readonly PlannedCall[],
): Promise<Hash[]> {
  if (!mainnetAllowed(config.gate)) throw new DryRunStop(calls);
  assertMainnetAllowed('market-kit submitting a transaction', config.gate);

  const wallet = walletFor(config);
  const hashes: Hash[] = [];
  for (const call of calls) {
    await config.client.call({
      account: config.from,
      to: call.to,
      data: call.data,
      value: call.value,
    });
    const hash = await wallet.sendTransaction({
      account: wallet.account!,
      chain: chainFor(config.mode),
      to: call.to,
      data: call.data,
      value: call.value,
    });
    const receipt = await config.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      // A mined revert has no return data of its own — the receipt says only that it
      // failed, never why. Replaying the exact same call at the block it was actually
      // mined in (not "latest", which may have moved on since) reproduces the same
      // revert as an `eth_call`, which does carry the reason, decoded through the same
      // `describeError` the pre-flight simulation above already uses.
      const reason = await config.client
        .call({
          account: config.from,
          to: call.to,
          data: call.data,
          value: call.value,
          blockNumber: receipt.blockNumber,
        })
        .then(() => 'no reason data (the replay itself did not revert)')
        .catch((error: unknown) => describeError(error));
      throw new Error(`${call.label} reverted on chain: ${hash} — ${reason}`);
    }
    console.log(`  sent ${call.label}: ${hash} (block ${receipt.blockNumber})`);
    hashes.push(hash);
  }
  return hashes;
}

/* ────────────────── funded simulation of the provision call ───────────────── */

/**
 * `MarginAccount.balances` is `mapping(bytes32 => uint256)` at **storage slot 1**,
 * keyed by `keccak256(abi.encodePacked(user, token))`.
 *
 * The declaration order is from the verified MarginAccount implementation
 * `0x57cf97fe1fac7d78b07e7e0761410cb2e91f0ca7` (Etherscan V2, chainid 143):
 * `trustedForwarder` and `protocolPaused` pack into slot 0, `balances` is slot 1.
 * `ERC2771Context` declares no storage and solady's `Ownable`/`Initializable` use
 * fixed slots, so nothing shifts it.
 *
 * Confirmed by reading it rather than trusting the layout: on 2026-09-02
 * `getBalance(0x43a275C3…, AUSD)` returned `4986600`, and
 * `eth_getStorageAt(MarginAccount, keccak256(abi.encode(accountKey, 1)))` returned
 * the same value.
 */
export const MARGIN_ACCOUNT_BALANCES_SLOT = 1n;

export function marginAccountBalanceSlot(user: `0x${string}`, token: `0x${string}`): `0x${string}` {
  const accountKey = keccak256(encodePacked(['address', 'address'], [user, token]));
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }],
      [accountKey, MARGIN_ACCOUNT_BALANCES_SLOT],
    ),
  );
}

export interface FundedSimulation {
  readonly ok: boolean;
  readonly reason?: string;
  readonly gasUsed?: bigint;
}

/**
 * Answer the one question a dry run cannot otherwise answer: **would the OrderBook
 * accept this ladder?**
 *
 * The deposits in a seed plan cannot be simulated against current state — the
 * operator has not moved the money yet — so a plain `eth_call` of
 * `batchProvisionLiquidity` always reverts for want of collateral, which tells the
 * owner nothing about the prices and sizes. This overrides the operator's
 * MarginAccount balances to exactly what the ladder needs and calls the real
 * contract, so `PriceError`, `TickSizeError`, `SizeError`, `PostOnlyError` and
 * `ProvisionError` all still fire for real. Nothing is sent; `eth_call` cannot send.
 */
export async function simulateProvisionFunded(
  client: PublicClient,
  from: `0x${string}`,
  provision: PlannedCall,
  marginAccount: `0x${string}`,
  funding: readonly { token: `0x${string}`; amount: bigint }[],
): Promise<FundedSimulation> {
  const stateDiff = funding.map(({ token, amount }) => ({
    slot: marginAccountBalanceSlot(from, token),
    value: toHex(amount, { size: 32 }),
  }));
  try {
    await client.call({
      account: from,
      to: provision.to,
      data: provision.data,
      value: provision.value,
      stateOverride: [
        { address: marginAccount, stateDiff },
        { address: from, balance: 10n ** 21n },
      ],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
}

/* ─────────────── simulating a market that does not exist yet ──────────────── */

export interface BundleCall {
  readonly label: string;
  readonly to: `0x${string}`;
  readonly data: `0x${string}`;
  readonly value: bigint;
}

export interface BundleOverride {
  readonly address: `0x${string}`;
  readonly balance?: bigint;
  readonly stateDiff?: Readonly<Record<`0x${string}`, `0x${string}`>>;
}

export interface BundleResult {
  readonly label: string;
  readonly ok: boolean;
  readonly reason?: string;
  readonly returnData: `0x${string}`;
}

/**
 * `eth_simulateV1` — several calls in one simulated block, each seeing the state the
 * previous one left.
 *
 * This is the only honest way to answer "would this ladder be accepted?" for a market
 * that does not exist yet. A plain `eth_call` to the predicted CREATE2 address returns
 * empty **success**, because there is no code there — so it would print "ok" for a
 * ladder the venue has never seen. Deploying the market inside the simulation and then
 * provisioning on the contract that deploy actually created runs every real check:
 * `MarketTypeMismatch`, `InvalidPricePrecision`, `TickSizeError`, `SizeError`,
 * `PriceError`, `ProvisionError`.
 *
 * Monad's RPC rejects `"validation": false` outright — measured 2026-09-02:
 * `{"code":-32603,"message":"\`\"validation\": false\` is not supported yet"}` — so the
 * caller's native balance has to be overridden to cover gas, exactly as `simulatePlan`
 * already does for `msg.value`.
 *
 * Nothing is sent. `eth_simulateV1` cannot send.
 */
export async function simulateBundle(
  client: PublicClient,
  from: `0x${string}`,
  calls: readonly BundleCall[],
  overrides: readonly BundleOverride[],
): Promise<BundleResult[]> {
  const stateOverrides: Record<string, unknown> = {};
  for (const override of overrides) {
    const entry: Record<string, unknown> = {};
    if (override.balance !== undefined) entry.balance = toHex(override.balance);
    if (override.stateDiff !== undefined) entry.stateDiff = override.stateDiff;
    stateOverrides[override.address] = entry;
  }

  const response = (await client.request({
    method: 'eth_simulateV1' as never,
    params: [
      {
        blockStateCalls: [
          {
            stateOverrides,
            calls: calls.map((call) => ({
              from,
              to: call.to,
              data: call.data,
              value: toHex(call.value),
            })),
          },
        ],
        validation: true,
        traceTransfers: false,
        returnFullTransactions: false,
      },
      'latest',
    ] as never,
  })) as readonly { calls: readonly { status: string; returnData?: string }[] }[];

  const results = response[0]?.calls ?? [];
  return calls.map((call, i) => {
    const result = results[i];
    const returnData = (result?.returnData ?? '0x') as `0x${string}`;
    if (result === undefined) {
      return { label: call.label, ok: false, reason: 'the node returned no result', returnData };
    }
    const ok = BigInt(result.status) === 1n;
    return ok
      ? { label: call.label, ok, returnData }
      : { label: call.label, ok, reason: describeReturnData(returnData), returnData };
  });
}

/** Name a revert from its raw return data, the way `describeError` names a thrown one. */
export function describeReturnData(returnData: string): string {
  if (!/^0x[0-9a-fA-F]{8}/.test(returnData)) return 'reverted with no reason data';
  const selector = returnData.slice(0, 10).toLowerCase() as `0x${string}`;
  const named = decodeKuruError(selector)?.name ?? EXTRA_REVERT_SELECTORS[selector];
  return named ? `${named}  [${selector}]` : `reverted  [unrecognised selector ${selector}]`;
}
