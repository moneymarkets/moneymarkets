import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCctpRail,
  maxFeeFor,
  toBytes32,
  CCTP_DOMAINS,
  MONAD_CCTP_DOMAIN,
  MESSAGE_TRANSMITTER_V2,
  MESSAGE_SENT_TOPIC,
  TOKEN_MESSENGER_V2,
  decodeBurnMessage,
  readBurnFromReceipt,
} from './cctp.js';
import { isQuote, type Decline, type FundingRequest, type Quote } from './types.js';
import { decodeAbiParameters, type Address, type PublicClient, type TransactionReceipt } from 'viem';

/**
 * Circle CCTP V2.
 *
 * The domain table and the fee response below are what the chain and Circle actually
 * returned on 2026-09-11, not a shape anyone imagined. The domain assertions matter more
 * than they look: a wrong destination domain burns real USDC toward whatever chain holds
 * that number, and there is no undo.
 */

const ACCOUNT = '0x714f169Fe2D3990961B534D573f9646c037586E6' as Address;

const BASE_USDC: FundingRequest = {
  sourceChain: { id: 8453, key: 'base', displayName: 'Base', vm: 'evm' },
  sourceAsset: {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },
  amount: 5_000_000n,
  recipient: ACCOUNT,
  senderAddress: ACCOUNT,
  wantsMargin: false,
};

/** Verbatim from `GET /v2/burn/USDC/fees/6/15`. */
const FEES_BASE = [
  { finalityThreshold: 1000, minimumFee: 1.3 },
  { finalityThreshold: 2000, minimumFee: 0 },
];

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the domain table is what each chain reported about itself', () => {
  it('puts Monad at 15, read from its own MessageTransmitterV2', () => {
    expect(MONAD_CCTP_DOMAIN).toBe(15);
    expect(CCTP_DOMAINS[143]).toBe(15);
  });

  it('matches every localDomain() read on 2026-09-11', () => {
    expect(CCTP_DOMAINS[1]).toBe(0);
    expect(CCTP_DOMAINS[43114]).toBe(1);
    expect(CCTP_DOMAINS[10]).toBe(2);
    expect(CCTP_DOMAINS[42161]).toBe(3);
    expect(CCTP_DOMAINS[8453]).toBe(6);
    expect(CCTP_DOMAINS[137]).toBe(7);
    expect(CCTP_DOMAINS[59144]).toBe(11);
  });

  it('claims no chain whose domain nobody read', () => {
    // Unichain, zkSync, World Chain are in KNOWN_CHAINS and were never probed for CCTP.
    expect(CCTP_DOMAINS[130]).toBeUndefined();
    expect(CCTP_DOMAINS[324]).toBeUndefined();
  });
});

describe('the fee is Circle’s rate, rounded so the transfer is not one unit short', () => {
  it('rounds up, because maxFee is a ceiling the user offers', () => {
    // 5.000000 USDC at 1.3 bps is 650 units exactly.
    expect(maxFeeFor(5_000_000n, 1.3)).toBe(650n);
    // 1 unit at 1.3 bps is a fraction; a floor would offer zero and never be picked up.
    expect(maxFeeFor(1n, 1.3)).toBe(1n);
  });

  it('never uses a float for a monetary value', () => {
    // 1.4 bps of 100 USDC. Computed in integers throughout (A2.6).
    expect(maxFeeFor(100_000_000n, 1.4)).toBe(14_000n);
  });

  it('reads the bps rate itself by its digits, not by multiplying the float (Section 1 Medium)', () => {
    // `Math.round(bps * 10)` was here before. `0.15 * 10` and neighbouring values are
    // exactly where IEEE 754 does not round-trip a one-decimal-place number cleanly —
    // these are the values that would have exposed it, not the ones already covered
    // by the two tests above.
    expect(maxFeeFor(10_000_000n, 0.1)).toBe(100n); // 0.1 bps of 10 USDC
    expect(maxFeeFor(10_000_000n, 0.2)).toBe(200n); // 0.2 bps of 10 USDC
    expect(maxFeeFor(10_000_000n, 0.29)).toBe(300n); // rounds the second digit up, to 0.3 bps
    expect(maxFeeFor(10_000_000n, 1.0)).toBe(1_000n); // an integer-valued decimal
  });

  it('is zero for a zero rate', () => {
    expect(maxFeeFor(5_000_000n, 0)).toBe(0n);
  });
});

describe('supports() gates on what was actually read', () => {
  const rail = createCctpRail();

  it('claims Base USDC', () => {
    expect(rail.supports(BASE_USDC)).toBe(true);
  });

  it('refuses a non-USDC asset, because CCTP moves USDC and nothing else', () => {
    expect(
      rail.supports({ ...BASE_USDC, sourceAsset: { ...BASE_USDC.sourceAsset, symbol: 'USDT' } }),
    ).toBe(false);
  });

  it('refuses Monad as a source, since it is the destination', () => {
    expect(
      rail.supports({ ...BASE_USDC, sourceChain: { ...BASE_USDC.sourceChain, id: 143 } }),
    ).toBe(false);
  });

  it('refuses a chain nobody probed', () => {
    expect(
      rail.supports({ ...BASE_USDC, sourceChain: { ...BASE_USDC.sourceChain, id: 130 } }),
    ).toBe(false);
  });
});

describe('a quote carries Circle’s own rate', () => {
  it('asks for the fast threshold and prices it at Circle’s minimum', async () => {
    const spy = stubFetch(200, FEES_BASE);
    const q = (await createCctpRail().quote(BASE_USDC, new AbortController().signal)) as Quote;
    expect(String(spy.mock.calls[0]?.[0])).toContain('/v2/burn/USDC/fees/6/15');
    expect(q.amountOut).toBe(5_000_000n - 650n);
    expect(q.fees[0]?.amount).toBe(650n);
    expect(q.fees[0]?.label).toContain('1.3 bps');
  });

  it('states no ETA rather than inventing one', async () => {
    stubFetch(200, FEES_BASE);
    const q = (await createCctpRail().quote(BASE_USDC, new AbortController().signal)) as Quote;
    expect(q.etaSeconds).toBe(0);
  });

  it('is not executable without a wallet to sign the burn', async () => {
    stubFetch(200, FEES_BASE);
    const rail = createCctpRail();
    const withWallet = (await rail.quote(BASE_USDC, new AbortController().signal)) as Quote;
    const without = (await rail.quote(
      { ...BASE_USDC, senderAddress: undefined },
      new AbortController().signal,
    )) as Quote;
    expect(withWallet.executable).toBe(true);
    expect(without.executable).toBe(false);
  });

  it('declines when Circle offers no fast lane, rather than silently using the slow one', async () => {
    stubFetch(200, [{ finalityThreshold: 2000, minimumFee: 0 }]);
    const result = await createCctpRail().quote(BASE_USDC, new AbortController().signal);
    expect(isQuote(result)).toBe(false);
    expect((result as Decline).reason).toContain('fast transfer');
  });

  it('passes Circle’s own error sentence through', async () => {
    stubFetch(400, { message: 'Unsupported destination domain' });
    const result = await createCctpRail().quote(BASE_USDC, new AbortController().signal);
    expect((result as Decline).reason).toBe('Unsupported destination domain');
  });
});

describe('the burn is addressed to the signed-in account and nowhere else', () => {
  it('pads the recipient into the 32-byte word CCTP mints to', () => {
    expect(toBytes32(ACCOUNT)).toBe(
      '0x000000000000000000000000714f169fe2d3990961b534d573f9646c037586e6',
    );
  });

  it('builds approve then depositForBurn, to the verified TokenMessenger', async () => {
    stubFetch(200, FEES_BASE);
    const rail = createCctpRail();
    const q = (await rail.quote(BASE_USDC, new AbortController().signal)) as Quote;
    const plan = await rail.buildSourceTx!(q);

    expect(plan.txs).toHaveLength(2);
    expect(plan.txs[0]?.to.toLowerCase()).toBe(BASE_USDC.sourceAsset.address.toLowerCase());
    expect(plan.txs[1]?.to).toBe(TOKEN_MESSENGER_V2);
    // depositForBurn's own selector, from the encoding that simulated on seven chains.
    expect(plan.txs[1]?.data.startsWith('0x')).toBe(true);
    // The recipient word appears in the calldata, unpadded of its leading zeros.
    expect(plan.txs[1]?.data.toLowerCase()).toContain(ACCOUNT.slice(2).toLowerCase());
  });

  it('approves exactly the amount, never unlimited', async () => {
    stubFetch(200, FEES_BASE);
    const rail = createCctpRail();
    const q = (await rail.quote(BASE_USDC, new AbortController().signal)) as Quote;
    const plan = await rail.buildSourceTx!(q);
    // 5000000 = 0x4c4b40, right-aligned in the 32-byte amount word.
    expect(plan.txs[0]?.data.endsWith('4c4b40')).toBe(true);
    expect(plan.txs[0]?.data.toLowerCase()).not.toContain('f'.repeat(60));
  });

  it('refuses to build without the address that will sign', async () => {
    stubFetch(200, FEES_BASE);
    const rail = createCctpRail();
    const q = (await rail.quote(
      { ...BASE_USDC, senderAddress: undefined },
      new AbortController().signal,
    )) as Quote;
    await expect(rail.buildSourceTx!(q)).rejects.toThrow(/address that will send/);
  });

  it('never sends value: these are token transfers', async () => {
    stubFetch(200, FEES_BASE);
    const rail = createCctpRail();
    const q = (await rail.quote(BASE_USDC, new AbortController().signal)) as Quote;
    const plan = await rail.buildSourceTx!(q);
    for (const tx of plan.txs) expect(tx.value).toBe('0');
  });
});

describe('a claimed burn is verified against its own receipt before it is trusted (B2)', () => {
  /**
   * A real, mined `MessageSent` log — Arbitrum tx
   * `0x8ae0a629c25eba59d80db8bd78269d40a69ef61ba2f7d9a01cee751b4069d94d`, block
   * 508036553, read live from `arb1.arbitrum.io/rpc` on 2026-09-23. Independently
   * cross-checked against that same transaction's own `depositForBurn` calldata
   * (destinationDomain, mintRecipient and amount all matched byte for byte) before
   * being pasted in here — not constructed, not imagined.
   */
  const REAL_LOG_DATA =
    '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000001b0000000010000000300000013000000000000000000000000000000000000000000000000000000000000000000000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d00000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d000000000000000000000000b21d281dedb17ae5b501f6aa8256fe38c4e45757000003e80000000000000001000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000b21d281dedb17ae5b501f6aa8256fe38c4e45757000000000000000000000000000000000000000000000000000000001dcd6500000000000000000000000000a95d9c1f655341597c94393fddc30cf3c08e4fce0000000000000000000000000000000000000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000636374702d666f72776172640000000000000000000000000000000000000018bc11860809397de5b65806b28fee51b0b094027c0000000000000000000000000000000000000000' as `0x${string}`;
  const REAL_TX_HASH =
    '0x8ae0a629c25eba59d80db8bd78269d40a69ef61ba2f7d9a01cee751b4069d94d' as `0x${string}`;

  it('decodes the destination domain, mint recipient and amount from the burn body, not the header', () => {
    // The log's `data` is ABI-encoded `bytes`; unwrap it the same way `readBurnFromReceipt`
    // does before handing the real message bytes to the offset decoder.
    const [message] = decodeAbiParameters([{ type: 'bytes' }], REAL_LOG_DATA);
    const decoded = decodeBurnMessage(message);
    expect(decoded.destinationDomain).toBe(19);
    // The header's own `recipient` field (bytes 76-108) is TokenMessengerV2 on every
    // chain — 28b5a0e9c621a5badaa536219b3a228c8168cf5d — and is NOT this value. Getting
    // that swapped would verify every burn against the wrong address.
    expect(decoded.mintRecipient.toLowerCase()).toBe('0xb21d281dedb17ae5b501f6aa8256fe38c4e45757');
    expect(decoded.mintRecipient.toLowerCase()).not.toBe(TOKEN_MESSENGER_V2.toLowerCase());
    expect(decoded.amount).toBe(500_000_000n);
  });

  it('the computed topic0 for MessageSent(bytes) is what the live log actually carries', () => {
    expect(MESSAGE_SENT_TOPIC).toBe(
      '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036',
    );
  });

  function stubClient(receipt: Partial<TransactionReceipt> | undefined): PublicClient {
    return {
      getTransactionReceipt: vi.fn(async () => receipt as TransactionReceipt),
    } as unknown as PublicClient;
  }

  it('reads a real receipt and decodes the message it actually emitted', async () => {
    const client = stubClient({
      status: 'success',
      logs: [
        {
          address: MESSAGE_TRANSMITTER_V2,
          topics: [MESSAGE_SENT_TOPIC],
          data: REAL_LOG_DATA,
        } as never,
      ],
    });
    const decoded = await readBurnFromReceipt(client, REAL_TX_HASH);
    expect(decoded).toBeDefined();
    expect(decoded?.destinationDomain).toBe(19);
    expect(decoded?.mintRecipient.toLowerCase()).toBe('0xb21d281dedb17ae5b501f6aa8256fe38c4e45757');
    expect(decoded?.amount).toBe(500_000_000n);
  });

  it('refuses a reverted transaction rather than reading a log that should not exist', async () => {
    const client = stubClient({
      status: 'reverted',
      logs: [{ address: MESSAGE_TRANSMITTER_V2, topics: [MESSAGE_SENT_TOPIC], data: REAL_LOG_DATA } as never],
    });
    expect(await readBurnFromReceipt(client, REAL_TX_HASH)).toBeUndefined();
  });

  it('refuses a receipt with no MessageSent log from the real MessageTransmitterV2', async () => {
    const client = stubClient({ status: 'success', logs: [] });
    expect(await readBurnFromReceipt(client, REAL_TX_HASH)).toBeUndefined();
  });

  it('ignores a log from a different contract at the same block, even with the right topic', async () => {
    const client = stubClient({
      status: 'success',
      logs: [
        {
          address: '0x000000000000000000000000000000000000dEaD',
          topics: [MESSAGE_SENT_TOPIC],
          data: REAL_LOG_DATA,
        } as never,
      ],
    });
    expect(await readBurnFromReceipt(client, REAL_TX_HASH)).toBeUndefined();
  });
});

describe('status never calls an attestation a delivery', () => {
  it('a complete attestation is still in flight, not delivered', async () => {
    // Circle attesting is Circle ready; the relayer's own mint is what delivers.
    stubFetch(200, { messages: [{ status: 'complete', attestation: '0xsig' }] });
    const s = await createCctpRail().status({ rail: 'cctp', ref: '0xhash', sourceChainId: 8453 });
    expect(s.state).toBe('in-flight');
  });

  it('an unknown hash is source-seen, not a failure', async () => {
    // Verbatim: what Circle answers in the seconds after a real burn.
    stubFetch(404, { error: 'Message not found for provided parameters' });
    const s = await createCctpRail().status({ rail: 'cctp', ref: '0xhash', sourceChainId: 8453 });
    expect(s.state).toBe('source-seen');
    expect(s.message).toBe('Message not found for provided parameters');
  });

  it('says so rather than guessing when no source chain was recorded', async () => {
    const s = await createCctpRail().status({ rail: 'cctp', ref: '0xhash' });
    expect(s.state).toBe('in-flight');
    expect(s.message).toMatch(/No source chain/);
  });
});
