import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, type Address, type Hex } from 'viem';
import {
  buildForwardRequest,
  DEFAULT_DEADLINE_SECONDS,
  gasWithHeadroom,
  hashForwardRequest,
  hashForwardRequestWith,
  isSignedBySender,
  MAX_RELAYABLE_GAS,
  recoverForwardRequestSigner,
  type ForwarderDomain,
} from './build.js';
import {
  FORWARD_REQUEST_SCHEMA_VERIFIED,
  FORWARD_REQUEST_TYPES,
  ForwarderSchemaUnverifiedError,
  KURU_FORWARDER_DOMAIN,
} from './types.js';

/**
 * A throwaway key that exists only inside this file. It signs nothing on any chain,
 * holds nothing, and is here so the signature path is exercised offline.
 */
const TEST_KEY = `0x${'11'.repeat(32)}` as Hex;
const account = privateKeyToAccount(TEST_KEY);

const MARGIN = '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address;

const domain: ForwarderDomain = KURU_FORWARDER_DOMAIN;

const request = buildForwardRequest({
  from: account.address,
  to: MARGIN,
  data: '0x8340f549' as Hex,
  nonce: 0n,
  gas: 200_000n,
  now: 1_756_800_000_000,
});

describe('the domain is the one the chain reports', () => {
  it('uses the values eip712Domain() returned', () => {
    // Decoded from the raw eip712Domain() return on 2026-09-02.
    expect(KURU_FORWARDER_DOMAIN.name).toBe('KuruForwarder');
    expect(KURU_FORWARDER_DOMAIN.version).toBe('1.0.0');
    expect(KURU_FORWARDER_DOMAIN.chainId).toBe(143);
    expect(KURU_FORWARDER_DOMAIN.verifyingContract).toBe(
      '0x974E61BBa9C4704E8Bcc1923fdC3527B41323FAA',
    );
  });
});

describe('request construction', () => {
  it('sets a deadline two minutes out', () => {
    expect(request.deadline).toBe(BigInt(1_756_800_000 + DEFAULT_DEADLINE_SECONDS));
  });

  it('refuses to forward native value', () => {
    expect(() =>
      buildForwardRequest({
        from: account.address,
        to: MARGIN,
        data: '0x' as Hex,
        nonce: 0n,
        gas: 100_000n,
        value: 1n,
      }),
    ).toThrow(/never forwards MON/);
  });

  it('refuses gas outside the relayable range', () => {
    const base = { from: account.address, to: MARGIN, data: '0x' as Hex, nonce: 0n };
    expect(() => buildForwardRequest({ ...base, gas: 0n })).toThrow(/outside/);
    expect(() => buildForwardRequest({ ...base, gas: MAX_RELAYABLE_GAS + 1n })).toThrow(/outside/);
  });

  it('refuses a negative nonce', () => {
    expect(() =>
      buildForwardRequest({
        from: account.address,
        to: MARGIN,
        data: '0x' as Hex,
        nonce: -1n,
        gas: 100_000n,
      }),
    ).toThrow(/negative/);
  });

  it('pads a gas estimate by 20% and caps it', () => {
    expect(gasWithHeadroom(100_000n)).toBe(120_000n);
    expect(gasWithHeadroom(MAX_RELAYABLE_GAS)).toBe(MAX_RELAYABLE_GAS);
  });
});

describe('typed-data hashing', () => {
  it('produces the EIP-712 digest viem would produce for the same struct', () => {
    // This pins the hashing code, not the struct: if the struct is wrong, both sides
    // are wrong together. The struct itself is open item 1.
    const expected = hashTypedData({
      domain,
      types: FORWARD_REQUEST_TYPES,
      primaryType: 'ForwardRequest',
      message: { ...request },
    });
    expect(hashForwardRequestWith(request, domain, FORWARD_REQUEST_TYPES)).toBe(expected);
  });

  it('changes when any field changes', () => {
    const a = hashForwardRequestWith(request, domain, FORWARD_REQUEST_TYPES);
    const b = hashForwardRequestWith(
      { ...request, nonce: request.nonce + 1n },
      domain,
      FORWARD_REQUEST_TYPES,
    );
    expect(a).not.toBe(b);
  });

  it('changes when the verifying contract changes, so a signature cannot be replayed onto another forwarder', () => {
    const other: ForwarderDomain = {
      ...domain,
      verifyingContract: '0x0000000000000000000000000000000000000001' as Address,
    };
    expect(hashForwardRequestWith(request, domain, FORWARD_REQUEST_TYPES)).not.toBe(
      hashForwardRequestWith(request, other, FORWARD_REQUEST_TYPES),
    );
  });

  it('changes when the chain id changes, so a mainnet signature cannot be replayed on testnet', () => {
    const testnet: ForwarderDomain = { ...domain, chainId: 10143 };
    expect(hashForwardRequestWith(request, domain, FORWARD_REQUEST_TYPES)).not.toBe(
      hashForwardRequestWith(request, testnet, FORWARD_REQUEST_TYPES),
    );
  });
});

describe('signature recovery', () => {
  it('recovers the signer', async () => {
    const signature = await account.signTypedData({
      domain,
      types: FORWARD_REQUEST_TYPES,
      primaryType: 'ForwardRequest',
      message: { ...request },
    });
    expect(await recoverForwardRequestSigner(request, signature, domain)).toBe(account.address);
    expect(await isSignedBySender(request, signature, domain)).toBe(true);
  });

  it('rejects a signature over a different request', async () => {
    const signature = await account.signTypedData({
      domain,
      types: FORWARD_REQUEST_TYPES,
      primaryType: 'ForwardRequest',
      message: { ...request },
    });
    const tampered = { ...request, to: '0x0000000000000000000000000000000000000002' as Address };
    expect(await isSignedBySender(tampered, signature, domain)).toBe(false);
  });

  it('rejects a signature whose `from` is not the signer', async () => {
    const signature = await account.signTypedData({
      domain,
      types: FORWARD_REQUEST_TYPES,
      primaryType: 'ForwardRequest',
      message: { ...request },
    });
    const impersonated = {
      ...request,
      from: '0x0000000000000000000000000000000000000003' as Address,
    };
    expect(await isSignedBySender(impersonated, signature, domain)).toBe(false);
  });

  it('rejects malformed signature bytes without throwing', async () => {
    expect(await isSignedBySender(request, '0xdeadbeef' as Hex, domain)).toBe(false);
  });
});

describe('the unverified-schema gate', () => {
  it('is still closed', () => {
    expect(FORWARD_REQUEST_SCHEMA_VERIFIED).toBe(false);
  });

  it('blocks hashing against the live forwarder until open item 1 is closed', () => {
    expect(() => hashForwardRequest(request)).toThrow(ForwarderSchemaUnverifiedError);
    expect(() => hashForwardRequest(request)).toThrow(/open item 1/);
  });
});
