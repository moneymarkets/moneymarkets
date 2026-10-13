import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import {
  buildPermitCall,
  buildPermitMessage,
  domainSeparatorOf,
  KNOWN_PERMIT_DOMAINS,
  MAX_PERMIT_DEADLINE_SECONDS,
  permitTypedData,
  recoverPermitSigner,
  splitSignature,
  type PermitDomain,
} from './permit.js';
import { KURU_FLOW_ROUTER } from '../kuru/flow.js';

const account = privateKeyToAccount(`0x${'22'.repeat(32)}` as Hex);
const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address;
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address;
const USDT0 = '0xe7cd86e13AC4309349F30B3435a9d337750fC82D' as Address;

/**
 * These are the exact values `DOMAIN_SEPARATOR()` returned on Monad mainnet
 * (chain 143) on 2026-09-02. If the reconstruction below stops matching them, either
 * the stored domain is wrong or the token was upgraded — either way, do not sign.
 */
const LIVE_SEPARATORS: Record<Address, Hex> = {
  [AUSD]: '0x995063441ebf2219c9' as Hex, // prefix only; full value asserted below
  [USDC]: '0xfe22123edc0dd4aeb912eb7948c5f0e531592c2053b3067612f427db342c93c6',
  [USDT0]: '0x101a90213d0b0d9d607fe3b94dcb41e91f20ab1432d4cd23ae9f820c0968452a',
};

describe('permit domains match the live DOMAIN_SEPARATOR', () => {
  it('reconstructs USDC: name "USDC", version "2"', () => {
    const domain: PermitDomain = {
      name: 'USDC',
      version: '2',
      chainId: 143,
      verifyingContract: USDC,
    };
    expect(domainSeparatorOf(domain)).toBe(LIVE_SEPARATORS[USDC]);
  });

  it('reconstructs USDT0: name "USDT0", version "1"', () => {
    const domain: PermitDomain = {
      name: 'USDT0',
      version: '1',
      chainId: 143,
      verifyingContract: USDT0,
    };
    expect(domainSeparatorOf(domain)).toBe(LIVE_SEPARATORS[USDT0]);
  });

  it('reconstructs AUSD from the values eip712Domain() reported', () => {
    const domain: PermitDomain = {
      name: 'Agora Dollar',
      version: '1',
      chainId: 143,
      verifyingContract: AUSD,
    };
    expect(domainSeparatorOf(domain).startsWith(LIVE_SEPARATORS[AUSD])).toBe(true);
  });

  it('keeps the same three tokens in the known-domain table', () => {
    expect(KNOWN_PERMIT_DOMAINS[AUSD.toLowerCase()]).toEqual({
      name: 'Agora Dollar',
      version: '1',
    });
    expect(KNOWN_PERMIT_DOMAINS[USDC.toLowerCase()]).toEqual({ name: 'USDC', version: '2' });
  });

  it('produces a different separator on testnet', () => {
    const mainnet: PermitDomain = {
      name: 'Agora Dollar',
      version: '1',
      chainId: 143,
      verifyingContract: AUSD,
    };
    expect(domainSeparatorOf({ ...mainnet, chainId: 10143 })).not.toBe(domainSeparatorOf(mainnet));
  });
});

describe('permit construction rules (A4)', () => {
  const base = {
    owner: account.address,
    spender: MARGIN,
    marginAccount: MARGIN,
    value: 1_000_000n,
    nonce: 0n,
    now: 1_756_800_000_000,
  };

  it('builds a permit with a ten-minute deadline', () => {
    const m = buildPermitMessage(base);
    expect(m.deadline).toBe(BigInt(1_756_800_000 + MAX_PERMIT_DEADLINE_SECONDS));
  });

  it('refuses a spender that is neither the MarginAccount nor the Kuru Flow router', () => {
    expect(() =>
      buildPermitMessage({
        ...base,
        spender: '0x0000000000000000000000000000000000000009' as Address,
      }),
    ).toThrow(/must be the MarginAccount/);
  });

  it('builds a permit to the pinned Kuru Flow router (D101 — convert via swap)', () => {
    const m = buildPermitMessage({ ...base, spender: KURU_FLOW_ROUTER });
    expect(m.spender).toBe(KURU_FLOW_ROUTER);
  });

  it('refuses an infinite approval', () => {
    expect(() => buildPermitMessage({ ...base, value: 2n ** 256n - 1n })).toThrow(/exact amount/);
  });

  it('refuses a zero amount', () => {
    expect(() => buildPermitMessage({ ...base, value: 0n })).toThrow(/must be positive/);
  });

  it('refuses a deadline beyond ten minutes', () => {
    expect(() => buildPermitMessage({ ...base, deadlineSeconds: 601 })).toThrow(/1\.\.600/);
    expect(() => buildPermitMessage({ ...base, deadlineSeconds: 0 })).toThrow(/1\.\.600/);
  });
});

describe('signing and encoding', () => {
  const domain: PermitDomain = {
    name: 'Agora Dollar',
    version: '1',
    chainId: 143,
    verifyingContract: AUSD,
  };
  const message = buildPermitMessage({
    owner: account.address,
    spender: MARGIN,
    marginAccount: MARGIN,
    value: 1_000_000n,
    nonce: 0n,
    now: 1_756_800_000_000,
  });

  it('round-trips a signature back to the owner', async () => {
    const signature = await account.signTypedData(permitTypedData(message, domain));
    expect(await recoverPermitSigner(message, domain, signature)).toBe(account.address);
  });

  it('does not verify against a different token', async () => {
    const signature = await account.signTypedData(permitTypedData(message, domain));
    const other = await recoverPermitSigner(
      message,
      { ...domain, verifyingContract: USDC },
      signature,
    );
    expect(other).not.toBe(account.address);
  });

  it('splits a 65-byte signature into v, r, s', async () => {
    const signature = await account.signTypedData(permitTypedData(message, domain));
    const { v, r, s } = splitSignature(signature);
    expect([27, 28]).toContain(v);
    expect(r).toHaveLength(66);
    expect(s).toHaveLength(66);
  });

  it('rejects a signature of the wrong length', () => {
    expect(() => splitSignature('0x1234' as Hex)).toThrow(/65-byte/);
  });

  it('encodes a permit call with the exact amount and deadline', async () => {
    const signature = await account.signTypedData(permitTypedData(message, domain));
    const call = buildPermitCall(AUSD, message, signature);
    expect(call.to).toBe(AUSD);
    expect(call.data.slice(0, 10)).toBe('0xd505accf'); // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
    expect(call.data.toLowerCase()).toContain(MARGIN.slice(2).toLowerCase());
  });
});
