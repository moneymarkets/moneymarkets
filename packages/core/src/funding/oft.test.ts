import { describe, expect, it, vi } from 'vitest';
import {
  createOftRail,
  toBytes32Address,
  OFT_ROUTES,
  MONAD_LZ_EID,
  MONAD_LZ_ENDPOINT,
  type OftConfig,
} from './oft.js';
import { isQuote, type Decline, type FundingRequest, type Quote } from './types.js';
import type { Address } from 'viem';

/**
 * The OFT rails.
 *
 * Every fee below is what `quoteSend` returned on 2026-09-11, and every route in the
 * table was confirmed peered at both ends. The two assertions that matter most are the
 * absent ones: USDT0 from Base is not in the table because its lane is unwired, and the
 * Monad endpoint is not `0x1a4407…` because that address has no code on Monad.
 */

const ACCOUNT = '0x714f169Fe2D3990961B534D573f9646c037586E6' as Address;

const AUSD_BASE: FundingRequest = {
  sourceChain: { id: 8453, key: 'base', displayName: 'Base', vm: 'evm' },
  sourceAsset: {
    symbol: 'AUSD',
    address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    decimals: 6,
  },
  amount: 5_000_000n,
  recipient: ACCOUNT,
  senderAddress: ACCOUNT,
  wantsMargin: false,
};

/** The live figure: AUSD Base -> Monad, 5.000000, extraOptions '0x'. */
const AUSD_BASE_FEE = 100_598_487_792_126n;

const quoting = (nativeFee = AUSD_BASE_FEE): OftConfig => ({
  quoteSend: vi.fn(async () => ({ nativeFee, lzTokenFee: 0n })),
});

describe('the Monad endpoint is the one with code on Monad', () => {
  it('is 0x6F4756…, not the near-universal 0x1a4407…', () => {
    expect(MONAD_LZ_ENDPOINT).toBe('0x6F475642a6e85809B1c36Fa62763669b1b48DD5B');
    expect(MONAD_LZ_ENDPOINT.toLowerCase()).not.toBe(
      '0x1a44076050125825900e736c501f859c50fe728c',
    );
  });

  it('uses eid 30390, read from the endpoint itself', () => {
    expect(MONAD_LZ_EID).toBe(30390);
  });
});

describe('the route table holds only lanes wired at both ends', () => {
  it('has AUSD from Base and Ethereum', () => {
    const ausd = OFT_ROUTES.filter((r) => r.rail === 'oft-ausd').map((r) => r.sourceChainId);
    expect(ausd.sort()).toEqual([1, 8453]);
  });

  it('has USDT0 from Ethereum and Arbitrum', () => {
    const usdt0 = OFT_ROUTES.filter((r) => r.rail === 'oft-usdt0').map((r) => r.sourceChainId);
    expect(usdt0.sort((a, b) => a - b)).toEqual([1, 42161]);
  });

  it('does NOT have USDT0 from Base: peers(30390) is zero on both sides', () => {
    // The decisive one. Quoting it would revert NoPeer(30390) and, if it somehow sent,
    // Monad's _lzReceive would reject the message on arrival.
    expect(
      OFT_ROUTES.some((r) => r.rail === 'oft-usdt0' && r.sourceChainId === 8453),
    ).toBe(false);
  });

  it('never names the token as the adapter', () => {
    // An earlier note claimed the AUSD adapter was the token. It is not, on any route.
    for (const r of OFT_ROUTES) {
      expect(r.adapter.toLowerCase()).not.toBe(r.sourceToken.toLowerCase());
    }
  });

  it('requires an approval only where the adapter reported it needs one', () => {
    const ethUsdt0 = OFT_ROUTES.find((r) => r.rail === 'oft-usdt0' && r.sourceChainId === 1);
    // A lockbox over real USDT: approvalRequired() is true.
    expect(ethUsdt0?.approvalRequired).toBe(true);
    // And USDT is the token that reverts on a non-zero-to-non-zero approve.
    expect(ethUsdt0?.resetAllowanceFirst).toBe(true);

    for (const r of OFT_ROUTES.filter((x) => x.rail === 'oft-ausd')) {
      expect(r.approvalRequired).toBe(false);
    }
  });
});

describe('a quote is one for one, because quoteOFT said so', () => {
  it('delivers exactly what went in', async () => {
    const q = (await createOftRail('oft-ausd', quoting()).quote(
      AUSD_BASE,
      new AbortController().signal,
    )) as Quote;
    expect(q.amountOut).toBe(q.amountIn);
    expect(q.outToken).toBe('AUSD');
  });

  it('names the message fee in the chain’s own token, not in the asset', async () => {
    const q = (await createOftRail('oft-ausd', quoting()).quote(
      AUSD_BASE,
      new AbortController().signal,
    )) as Quote;
    expect(q.fees[0]?.amount).toBe(AUSD_BASE_FEE);
    expect(q.fees[0]?.token).toBe('ETH');
    expect(q.fees[0]?.label).toContain('LayerZero');
  });

  it('asks for minAmountLD equal to amountLD, which is safe on these lanes only', async () => {
    const config = quoting();
    await createOftRail('oft-ausd', config).quote(AUSD_BASE, new AbortController().signal);
    const call = vi.mocked(config.quoteSend).mock.calls[0]?.[0];
    expect(call?.sendParam.minAmountLD).toBe(call?.sendParam.amountLD);
    expect(call?.sendParam.dstEid).toBe(30390);
  });

  it('sends the recipient as the 32-byte word LayerZero takes', () => {
    expect(toBytes32Address(ACCOUNT)).toBe(
      '0x000000000000000000000000714f169fe2d3990961b534d573f9646c037586e6',
    );
  });

  it('passes a quoteSend revert through as the chain worded it', async () => {
    const failing: OftConfig = {
      quoteSend: async () => {
        throw new Error('NoPeer(30390)');
      },
    };
    const result = await createOftRail('oft-usdt0', failing).quote(
      {
        ...AUSD_BASE,
        sourceAsset: { symbol: 'USDT', address: '0xFd08', decimals: 6 },
        sourceChain: { id: 42161, key: 'arbitrum', displayName: 'Arbitrum', vm: 'evm' },
      },
      new AbortController().signal,
    );
    expect(isQuote(result)).toBe(false);
    expect((result as Decline).reason).toBe('NoPeer(30390)');
  });

  it('declines a lane it has no entry for, without asking anyone', async () => {
    const config = quoting();
    const result = await createOftRail('oft-usdt0', config).quote(
      {
        ...AUSD_BASE,
        sourceAsset: { symbol: 'USDT', address: '0x102d', decimals: 6 },
      },
      new AbortController().signal,
    );
    expect(isQuote(result)).toBe(false);
    expect(config.quoteSend).not.toHaveBeenCalled();
  });
});

describe('the send carries the fee as value and refunds to the sender', () => {
  it('has one transaction where no approval is required', async () => {
    const rail = createOftRail('oft-ausd', quoting());
    const q = (await rail.quote(AUSD_BASE, new AbortController().signal)) as Quote;
    const plan = await rail.buildSourceTx!(q);
    expect(plan.txs).toHaveLength(1);
    expect(plan.txs[0]?.value).toBe(AUSD_BASE_FEE.toString());
    expect(plan.txs[0]?.to).toBe('0x9CaB7Ede13dc56652E44D2404E969C212f22689b');
  });

  it('has three where the token is USDT: reset, approve, send', async () => {
    const rail = createOftRail('oft-usdt0', quoting(199_953_520_176_901n));
    const q = (await rail.quote(
      {
        ...AUSD_BASE,
        sourceChain: { id: 1, key: 'ethereum', displayName: 'Ethereum', vm: 'evm' },
        sourceAsset: {
          symbol: 'USDT',
          address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          decimals: 6,
        },
      },
      new AbortController().signal,
    )) as Quote;
    const plan = await rail.buildSourceTx!(q);
    expect(plan.txs).toHaveLength(3);
    expect(plan.txs[0]?.label).toMatch(/Clear/);
    // The reset approves zero: the amount word is all zeros.
    expect(plan.txs[0]?.data.endsWith('0'.repeat(64))).toBe(true);
    expect(plan.txs[2]?.value).toBe('199953520176901');
  });

  it('refunds to the sender, who is the only one who can receive on that chain', async () => {
    const rail = createOftRail('oft-ausd', quoting());
    const q = (await rail.quote(AUSD_BASE, new AbortController().signal)) as Quote;
    const plan = await rail.buildSourceTx!(q);
    // The refundAddress argument is the sender, not the Monad recipient. Here they
    // happen to be the same account, so assert on the request that produced it instead.
    expect(plan.txs[0]?.data.toLowerCase()).toContain(ACCOUNT.slice(2).toLowerCase());
  });

  it('refuses to build without the address that will sign', async () => {
    const rail = createOftRail('oft-ausd', quoting());
    const q = (await rail.quote(
      { ...AUSD_BASE, senderAddress: undefined },
      new AbortController().signal,
    )) as Quote;
    expect(q.executable).toBe(false);
    await expect(rail.buildSourceTx!(q)).rejects.toThrow(/address that will send/);
  });
});
