import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type * as Viem from 'viem';
import type { PublicClient } from 'viem';
import { submitPlan } from './send.js';
import type { KitConfig } from './config.js';
import type { PlannedCall } from './plan.js';

/**
 * B4 (C7): a reverted, **mined** transaction used to report only its label and hash —
 * exactly nothing about why, on the live-money path and the message that decides
 * whether a half-seeded ladder needs `kit teardown`. `submitPlan` now replays the same
 * call at the block it was actually mined in and decodes the revert the same way
 * `simulatePlan`'s pre-flight check already does, through the same `describeError`.
 *
 * `wallet.sendTransaction` is mocked (via viem's own `createWalletClient`, which vitest
 * hoists this `vi.mock` above regardless of where it sits in the file) because it would
 * otherwise open a real network connection; `config.client` is a bare stub carrying
 * only the two methods `submitPlan` actually calls on it, so nothing here depends on a
 * live RPC. The revert selector, `0x004b65ba` for `MarketStateError`, is Kuru's own,
 * verified in `packages/core/src/kuru/errors.test.ts` — not invented.
 */

const sendTransaction = vi.fn(
  async () => '0xaaaa000000000000000000000000000000000000000000000000000000000000' as const,
);

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof Viem>('viem');
  return {
    ...actual,
    createWalletClient: (args: { account: unknown }) => ({ account: args.account, sendTransaction }),
  };
});

// This dev machine has a real, encrypted deployer keystore on disk (`.secrets/`), which
// `resolveSigner` would otherwise prefer over `DEPLOYER_PRIVATE_KEY` — a unit test must
// not depend on a real secret file's presence, its passphrase, or the address inside it.
vi.mock('./keystore.js', () => ({ deployerKeystoreExists: () => false }));

const DEPLOYER_KEY = generatePrivateKey();
const FROM = privateKeyToAccount(DEPLOYER_KEY).address;

const CALL: PlannedCall = {
  label: 'batchProvisionLiquidity',
  to: '0x131A2e703e93FD1508920FEe9daD48Cd47ac0Da9',
  data: '0x12345678',
  value: 0n,
};

function configWith(client: Partial<PublicClient>): KitConfig {
  return {
    mode: 'mainnet',
    gate: { mode: 'mainnet', runMode: 'live', realFundsAcknowledged: true },
    dryRun: false,
    rpcUrl: 'https://rpc.monad.xyz',
    client: client as PublicClient,
    addresses: {} as KitConfig['addresses'],
    from: FROM,
  };
}

const REAL_MARKET_STATE_ERROR_SELECTOR = '0x004b65ba';

describe('a mined revert is replayed and decoded, not just reported by hash', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.DEPLOYER_PRIVATE_KEY;
  });

  it('includes the decoded Kuru error name in the thrown message', async () => {
    process.env.DEPLOYER_PRIVATE_KEY = DEPLOYER_KEY;
    // The pre-send simulation (no `blockNumber`) passes — state has since moved on,
    // which is exactly the race this fix exists for. Only the replay, pinned to the
    // receipt's own block, sees the revert.
    const call = vi.fn(async (args: { blockNumber?: bigint }) => {
      if (args.blockNumber === undefined) return '0x' as const;
      const err = new Error('execution reverted') as Error & { data?: string };
      err.data = REAL_MARKET_STATE_ERROR_SELECTOR;
      throw err;
    });
    const waitForTransactionReceipt = vi.fn(async () => ({
      status: 'reverted' as const,
      blockNumber: 12345n,
    }));
    const config = configWith({
      call: call as unknown as PublicClient['call'],
      waitForTransactionReceipt: waitForTransactionReceipt as unknown as PublicClient['waitForTransactionReceipt'],
    });

    await expect(submitPlan(config, [CALL])).rejects.toThrow(/MarketStateError/);
    // Replayed at the receipt's own block, not "latest" — state may have moved on.
    const replay = call.mock.calls.find((c) => (c[0] as { blockNumber?: bigint }).blockNumber !== undefined);
    expect(replay?.[0]).toMatchObject({ blockNumber: 12345n, to: CALL.to, data: CALL.data });
  });

  it('still names the transaction and reports plainly when the replay carries no selector', async () => {
    process.env.DEPLOYER_PRIVATE_KEY = DEPLOYER_KEY;
    const call = vi.fn(async (args: { blockNumber?: bigint }) => {
      if (args.blockNumber === undefined) return '0x' as const;
      throw new Error('execution reverted: Insufficient balance');
    });
    const waitForTransactionReceipt = vi.fn(async () => ({
      status: 'reverted' as const,
      blockNumber: 999n,
    }));
    const config = configWith({
      call: call as unknown as PublicClient['call'],
      waitForTransactionReceipt: waitForTransactionReceipt as unknown as PublicClient['waitForTransactionReceipt'],
    });

    await expect(submitPlan(config, [CALL])).rejects.toThrow(/Insufficient balance/);
    await expect(submitPlan(config, [CALL])).rejects.toThrow(/batchProvisionLiquidity reverted on chain/);
  });
});
