import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type PublicClient } from 'viem';
import {
  confirmDestinationTx,
  detectDestination,
  extractVendorDestinationCandidate,
  findIncomingTransfer,
  findMarginDeposit,
} from './destination.js';

/**
 * Step 4's independent proof — the tracker rebuild's central fix, and the surface a
 * full security review (this session) found real gaps in. Every case here checks that
 * a claim is never trusted on its own: a candidate hash from the vendor is only
 * evidence once this app's own `eth_getTransactionReceipt` confirms it actually paid
 * this recipient this token, and a log-scan match is only evidence once its amount
 * sits within tolerance of what this deposit was quoted to deliver — not merely any
 * transfer to the same address in the same token.
 */

const RECIPIENT = '0x0000000000000000000000000000000000000001' as const;
const OTHER_USER = '0x0000000000000000000000000000000000009999' as const;
const TOKEN = '0x0000000000000000000000000000000000000002' as const;
const OTHER_TOKEN = '0x0000000000000000000000000000000000000004' as const;
const MARGIN_ACCOUNT = '0x0000000000000000000000000000000000000003' as const;

const TRANSFER_ABI = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const DEPOSIT_ABI = parseAbiItem('event Deposit(address owner, address token, uint256 amount)');

function transferLog(params: { from: Address; to: Address; value: bigint; address?: Address }) {
  return {
    address: params.address ?? TOKEN,
    topics: encodeEventTopics({ abi: [TRANSFER_ABI], eventName: 'Transfer', args: { from: params.from, to: params.to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [params.value]),
  };
}

function depositLog(params: { owner: Address; token: Address; amount: bigint; address?: Address }) {
  return {
    address: params.address ?? MARGIN_ACCOUNT,
    topics: encodeEventTopics({ abi: [DEPOSIT_ABI], eventName: 'Deposit' }),
    data: encodeAbiParameters(
      [
        { name: 'owner', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      [params.owner, params.token, params.amount],
    ),
  };
}

function mockClient(overrides: Partial<PublicClient>): PublicClient {
  return overrides as PublicClient;
}

describe('extractVendorDestinationCandidate', () => {
  it('reads 1Click-shaped payloads', () => {
    const raw = { swapDetails: { destinationChainTxHashes: [{ hash: '0xabc' }] } };
    expect(extractVendorDestinationCandidate(raw)).toBe('0xabc');
  });

  it('reads Relay-shaped payloads', () => {
    expect(extractVendorDestinationCandidate({ txHashes: ['0xdef'] })).toBe('0xdef');
  });

  it('is undefined for an unrecognised shape — not an error, not a guess', () => {
    expect(extractVendorDestinationCandidate({ something: 'else' })).toBeUndefined();
    expect(extractVendorDestinationCandidate(null)).toBeUndefined();
    expect(extractVendorDestinationCandidate(undefined)).toBeUndefined();
  });
});

describe('confirmDestinationTx', () => {
  it('confirms a mined, successful receipt whose own log pays this recipient this token', async () => {
    const client = mockClient({
      getTransactionReceipt: vi.fn(async () => ({
        status: 'success',
        blockNumber: 12345n,
        logs: [transferLog({ from: OTHER_USER, to: RECIPIENT, value: 5_000_000n })],
      })) as unknown as PublicClient['getTransactionReceipt'],
    });
    const evidence = await confirmDestinationTx(client, '0xhash', {
      recipient: RECIPIENT,
      token: TOKEN,
      landsIn: 'wallet',
    });
    expect(evidence?.block).toBe('12345');
    expect(evidence?.amount).toBe('5000000');
    expect(evidence?.source).toBe('eth_getTransactionReceipt');
  });

  it('does not confirm a successful receipt whose log pays someone else (security review M2)', async () => {
    const client = mockClient({
      getTransactionReceipt: vi.fn(async () => ({
        status: 'success',
        blockNumber: 12345n,
        logs: [transferLog({ from: OTHER_USER, to: OTHER_USER, value: 5_000_000n })],
      })) as unknown as PublicClient['getTransactionReceipt'],
    });
    const evidence = await confirmDestinationTx(client, '0xhash', {
      recipient: RECIPIENT,
      token: TOKEN,
      landsIn: 'wallet',
    });
    expect(evidence).toBeUndefined();
  });

  it('does not confirm a receipt with no log on the expected token at all', async () => {
    const client = mockClient({
      getTransactionReceipt: vi.fn(async () => ({
        status: 'success',
        blockNumber: 12345n,
        logs: [transferLog({ from: OTHER_USER, to: RECIPIENT, value: 5_000_000n, address: OTHER_TOKEN })],
      })) as unknown as PublicClient['getTransactionReceipt'],
    });
    const evidence = await confirmDestinationTx(client, '0xhash', {
      recipient: RECIPIENT,
      token: TOKEN,
      landsIn: 'wallet',
    });
    expect(evidence).toBeUndefined();
  });

  it('for a margin-landing deposit, requires a MarginAccount Deposit log naming this recipient and token', async () => {
    const client = mockClient({
      getTransactionReceipt: vi.fn(async () => ({
        status: 'success',
        blockNumber: 500n,
        logs: [depositLog({ owner: RECIPIENT, token: TOKEN, amount: 5_000_000n })],
      })) as unknown as PublicClient['getTransactionReceipt'],
    });
    const evidence = await confirmDestinationTx(client, '0xhash', {
      recipient: RECIPIENT,
      token: TOKEN,
      landsIn: 'margin',
      marginAccount: MARGIN_ACCOUNT,
    });
    expect(evidence?.amount).toBe('5000000');
  });

  it('for a margin-landing deposit, a wallet Transfer log is not accepted as proof', async () => {
    const client = mockClient({
      getTransactionReceipt: vi.fn(async () => ({
        status: 'success',
        blockNumber: 500n,
        logs: [transferLog({ from: OTHER_USER, to: RECIPIENT, value: 5_000_000n })],
      })) as unknown as PublicClient['getTransactionReceipt'],
    });
    const evidence = await confirmDestinationTx(client, '0xhash', {
      recipient: RECIPIENT,
      token: TOKEN,
      landsIn: 'margin',
      marginAccount: MARGIN_ACCOUNT,
    });
    expect(evidence).toBeUndefined();
  });

  it('is undefined for a reverted transaction — a candidate is not proof of delivery', async () => {
    const client = mockClient({
      getTransactionReceipt: vi.fn(async () => ({
        status: 'reverted',
        blockNumber: 1n,
        logs: [transferLog({ from: OTHER_USER, to: RECIPIENT, value: 5_000_000n })],
      })) as unknown as PublicClient['getTransactionReceipt'],
    });
    expect(
      await confirmDestinationTx(client, '0xhash', { recipient: RECIPIENT, token: TOKEN, landsIn: 'wallet' }),
    ).toBeUndefined();
  });

  it('is undefined, not an error, for a hash the RPC does not know yet', async () => {
    const client = mockClient({
      getTransactionReceipt: vi.fn(async () => {
        throw new Error('not found');
      }),
    });
    await expect(
      confirmDestinationTx(client, '0xhash', { recipient: RECIPIENT, token: TOKEN, landsIn: 'wallet' }),
    ).resolves.toBeUndefined();
  });
});

describe('findIncomingTransfer', () => {
  it('matches a Transfer within tolerance of the quoted amount', async () => {
    const client = mockClient({
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => [
        { transactionHash: '0xlog1', blockNumber: 990n, args: { from: OTHER_USER, value: 5_000_000n } },
      ]) as unknown as PublicClient['getLogs'],
    });
    const evidence = await findIncomingTransfer(client, RECIPIENT, TOKEN, 5_000_000n);
    expect(evidence?.hash).toBe('0xlog1');
    expect(evidence?.amount).toBe('5000000');
    expect(evidence?.source).toBe('balance-poll');
  });

  it('security review H1: ignores a transfer whose amount is nowhere near the quote', async () => {
    const client = mockClient({
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => [
        // A spoofed or unrelated transfer of a wildly different size — the exact
        // false-positive class the review found: any incoming transfer used to match.
        { transactionHash: '0xunrelated', blockNumber: 990n, args: { from: OTHER_USER, value: 1n } },
      ]) as unknown as PublicClient['getLogs'],
    });
    const evidence = await findIncomingTransfer(client, RECIPIENT, TOKEN, 5_000_000n, { windows: 1 });
    expect(evidence).toBeUndefined();
  });

  it('security review H1: a zero-value spoofed transfer never matches', async () => {
    const client = mockClient({
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => [
        { transactionHash: '0xspoof', blockNumber: 990n, args: { from: OTHER_USER, value: 0n } },
      ]) as unknown as PublicClient['getLogs'],
    });
    const evidence = await findIncomingTransfer(client, RECIPIENT, TOKEN, 5_000_000n, { windows: 1 });
    expect(evidence).toBeUndefined();
  });

  it('security review H1: excludes a transfer from the margin account (a withdrawal, not a deposit arrival)', async () => {
    const client = mockClient({
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => [
        { transactionHash: '0xwithdrawal', blockNumber: 990n, args: { from: MARGIN_ACCOUNT, value: 5_000_000n } },
      ]) as unknown as PublicClient['getLogs'],
    });
    const evidence = await findIncomingTransfer(client, RECIPIENT, TOKEN, 5_000_000n, {
      windows: 1,
      excludeSender: MARGIN_ACCOUNT,
    });
    expect(evidence).toBeUndefined();
  });

  it('is undefined with no quoted amount to check against, rather than matching anything', async () => {
    const client = mockClient({
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => [
        { transactionHash: '0xlog1', blockNumber: 990n, args: { from: OTHER_USER, value: 5_000_000n } },
      ]) as unknown as PublicClient['getLogs'],
    });
    const evidence = await findIncomingTransfer(client, RECIPIENT, TOKEN, undefined);
    expect(evidence).toBeUndefined();
  });

  it('is undefined when nothing was found in the window — not an error', async () => {
    const client = mockClient({
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => []) as unknown as PublicClient['getLogs'],
    });
    const evidence = await findIncomingTransfer(client, RECIPIENT, TOKEN, 5_000_000n, { windows: 1 });
    expect(evidence).toBeUndefined();
  });
});

describe('findMarginDeposit', () => {
  it('finds this recipient\'s own Deposit event, within tolerance, among other users\' in the same window', async () => {
    const client = mockClient({
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => [
        { transactionHash: '0xsomeoneelse', blockNumber: 980n, args: { owner: OTHER_USER, token: TOKEN, amount: 999_000_000n } },
        { transactionHash: '0xours', blockNumber: 990n, args: { owner: RECIPIENT, token: TOKEN, amount: 5_000_000n } },
      ]) as unknown as PublicClient['getLogs'],
    });
    const evidence = await findMarginDeposit(client, MARGIN_ACCOUNT, RECIPIENT, TOKEN, 5_000_000n);
    expect(evidence?.hash).toBe('0xours');
    expect(evidence?.amount).toBe('5000000');
  });

  it('does not match a Deposit for a different token', async () => {
    const client = mockClient({
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => [
        { transactionHash: '0xwrongtoken', blockNumber: 990n, args: { owner: RECIPIENT, token: OTHER_TOKEN, amount: 5_000_000n } },
      ]) as unknown as PublicClient['getLogs'],
    });
    const evidence = await findMarginDeposit(client, MARGIN_ACCOUNT, RECIPIENT, TOKEN, 5_000_000n, 1);
    expect(evidence).toBeUndefined();
  });

  it('security review H1: does not match this recipient\'s own Deposit of a very different amount', async () => {
    const client = mockClient({
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => [
        { transactionHash: '0xdifferentdeposit', blockNumber: 990n, args: { owner: RECIPIENT, token: TOKEN, amount: 1n } },
      ]) as unknown as PublicClient['getLogs'],
    });
    const evidence = await findMarginDeposit(client, MARGIN_ACCOUNT, RECIPIENT, TOKEN, 5_000_000n, 1);
    expect(evidence).toBeUndefined();
  });

  it('is undefined with no quoted amount to check against', async () => {
    const client = mockClient({
      getBlockNumber: vi.fn(async () => 1000n),
      getLogs: vi.fn(async () => [
        { transactionHash: '0xours', blockNumber: 990n, args: { owner: RECIPIENT, token: TOKEN, amount: 5_000_000n } },
      ]) as unknown as PublicClient['getLogs'],
    });
    const evidence = await findMarginDeposit(client, MARGIN_ACCOUNT, RECIPIENT, TOKEN, undefined);
    expect(evidence).toBeUndefined();
  });
});

describe('detectDestination', () => {
  it('prefers a confirmed vendor candidate over scanning', async () => {
    const getTransactionReceipt = vi.fn(async () => ({
      status: 'success',
      blockNumber: 500n,
      logs: [transferLog({ from: OTHER_USER, to: RECIPIENT, value: 5_000_000n })],
    })) as unknown as PublicClient['getTransactionReceipt'];
    const getLogs = vi.fn(async () => []) as unknown as PublicClient['getLogs'];
    const client = mockClient({ getTransactionReceipt, getLogs, getBlockNumber: vi.fn(async () => 1000n) });

    const evidence = await detectDestination(client, {
      recipient: RECIPIENT,
      outTokenAddress: TOKEN,
      vendorRaw: { txHashes: ['0xvendorhash'] },
    });
    expect(evidence?.hash).toBe('0xvendorhash');
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('security review H3/M2: a vendor candidate that pays the wrong recipient is not trusted, and falls back to a quote-checked scan', async () => {
    const getTransactionReceipt = vi.fn(async () => ({
      status: 'success',
      blockNumber: 500n,
      logs: [transferLog({ from: OTHER_USER, to: OTHER_USER, value: 5_000_000n })],
    })) as unknown as PublicClient['getTransactionReceipt'];
    const getLogs = vi.fn(async () => [
      { transactionHash: '0xscanned', blockNumber: 999n, args: { from: OTHER_USER, value: 5_000_000n } },
    ]) as unknown as PublicClient['getLogs'];
    const client = mockClient({ getTransactionReceipt, getLogs, getBlockNumber: vi.fn(async () => 1000n) });

    const evidence = await detectDestination(client, {
      recipient: RECIPIENT,
      outTokenAddress: TOKEN,
      vendorRaw: { txHashes: ['0xvendorhash'] },
      quotedAmountOut: 5_000_000n,
    });
    expect(evidence?.hash).toBe('0xscanned');
    expect(evidence?.source).toBe('balance-poll');
  });

  it('falls back to scanning when the vendor candidate is not confirmed yet', async () => {
    const getTransactionReceipt = vi.fn(async () => {
      throw new Error('not mined yet');
    });
    const getLogs = vi.fn(async () => [
      { transactionHash: '0xscanned', blockNumber: 999n, args: { from: OTHER_USER, value: 1_000_000n } },
    ]) as unknown as PublicClient['getLogs'];
    const client = mockClient({ getTransactionReceipt, getLogs, getBlockNumber: vi.fn(async () => 1000n) });

    const evidence = await detectDestination(client, {
      recipient: RECIPIENT,
      outTokenAddress: TOKEN,
      vendorRaw: { txHashes: ['0xvendorhash'] },
      quotedAmountOut: 1_000_000n,
    });
    expect(evidence?.hash).toBe('0xscanned');
    expect(evidence?.source).toBe('balance-poll');
  });

  it('is undefined with no vendor candidate and no known output token', async () => {
    const client = mockClient({ getBlockNumber: vi.fn(async () => 1000n) });
    const evidence = await detectDestination(client, {
      recipient: RECIPIENT,
      outTokenAddress: undefined,
      vendorRaw: undefined,
    });
    expect(evidence).toBeUndefined();
  });

  it('is undefined for a log-scan path with no quoted amount, even with a known token', async () => {
    const getLogs = vi.fn(async () => [
      { transactionHash: '0xscanned', blockNumber: 999n, args: { from: OTHER_USER, value: 1_000_000n } },
    ]) as unknown as PublicClient['getLogs'];
    const client = mockClient({ getLogs, getBlockNumber: vi.fn(async () => 1000n) });
    const evidence = await detectDestination(client, {
      recipient: RECIPIENT,
      outTokenAddress: TOKEN,
      vendorRaw: undefined,
    });
    expect(evidence).toBeUndefined();
  });

  it('scans MarginAccount Deposit events, not wallet Transfers, when landsIn is margin', async () => {
    const getLogs = vi.fn(async (args: { address?: string }) => {
      // The margin-landing money never reaches the recipient's wallet — a Transfer
      // scan on the token contract must never be the one that answers this.
      if (args.address === TOKEN) return [];
      return [{ transactionHash: '0xmargindeposit', blockNumber: 990n, args: { owner: RECIPIENT, token: TOKEN, amount: 5_000_000n } }];
    }) as unknown as PublicClient['getLogs'];
    const client = mockClient({ getLogs, getBlockNumber: vi.fn(async () => 1000n) });

    const evidence = await detectDestination(client, {
      recipient: RECIPIENT,
      outTokenAddress: TOKEN,
      vendorRaw: undefined,
      landsIn: 'margin',
      marginAccount: MARGIN_ACCOUNT,
      quotedAmountOut: 5_000_000n,
    });
    expect(evidence?.hash).toBe('0xmargindeposit');
  });

  it('is undefined for a margin-landing row with no MarginAccount address known', async () => {
    const client = mockClient({ getBlockNumber: vi.fn(async () => 1000n) });
    const evidence = await detectDestination(client, {
      recipient: RECIPIENT,
      outTokenAddress: TOKEN,
      vendorRaw: undefined,
      landsIn: 'margin',
      quotedAmountOut: 5_000_000n,
    });
    expect(evidence).toBeUndefined();
  });
});
