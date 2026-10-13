import { describe, expect, it } from 'vitest';
import { keccak256, stringToHex } from 'viem';
import {
  FORWARD_REQUEST_SCHEMA_VERIFIED,
  FORWARD_REQUEST_TYPES,
  KURU_FORWARDER_DOMAIN,
} from './types.js';
import {
  DEPLOYED_PUSH32_CONSTANTS,
  IDENTIFIED_PUSH32,
  UNIDENTIFIED_PUSH32,
  UNIDENTIFIED_SELECTORS,
} from './__fixtures__/bytecode.js';

/**
 * The gate on `FORWARD_REQUEST_SCHEMA_VERIFIED`.
 *
 * A Solidity `keccak256("SomeStruct(...)")` constant is folded at compile time, so
 * the type *string* is not in the deployed bytecode but its *hash* is, sitting in a
 * PUSH32. That gives an exact test: whatever type string this repo believes in must
 * hash to one of the constants the implementation actually carries.
 *
 * While the schema is unverified this suite records that the current guess does not
 * match — which is the honest state, and the reason the flag is false. The moment a
 * real type string is recovered (`pnpm close-item-1`), the first test below turns
 * into the proof that it is right, and only then may the flag be flipped.
 */

function typeStringOf(types: typeof FORWARD_REQUEST_TYPES): string {
  const fields = types.ForwardRequest.map((f) => `${f.type} ${f.name}`).join(',');
  return `ForwardRequest(${fields})`;
}

const currentTypeString = typeStringOf(FORWARD_REQUEST_TYPES);
const currentTypeHash = keccak256(stringToHex(currentTypeString));

describe('the ForwardRequest type hash must be one the contract carries', () => {
  it('is the gate on FORWARD_REQUEST_SCHEMA_VERIFIED', () => {
    const matches = UNIDENTIFIED_PUSH32.includes(currentTypeHash as never);

    if (FORWARD_REQUEST_SCHEMA_VERIFIED) {
      // The flag is on, so the claim must hold against the deployed bytecode.
      expect(
        matches,
        `FORWARD_REQUEST_SCHEMA_VERIFIED is true but ${currentTypeString} hashes to ` +
          `${currentTypeHash}, which is not among the PUSH32 constants in the deployed ` +
          'implementation. Either the type string is wrong or the flag was flipped early.',
      ).toBe(true);
    } else {
      // The flag is off. Record why: the guess does not match.
      expect(matches).toBe(false);
    }
  });

  it('keeps the extracted constants as recorded evidence', () => {
    // From eth_getCode on 0xbf6Cc109c6eBcA4B28e3e51FD8798294599CFe2A, 2026-09-02.
    expect(DEPLOYED_PUSH32_CONSTANTS.length).toBe(43);
    expect(UNIDENTIFIED_PUSH32.length).toBe(4);
    for (const c of UNIDENTIFIED_PUSH32) {
      expect(DEPLOYED_PUSH32_CONSTANTS).toContain(c);
      expect(c).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('has already accounted for every other 32-byte constant', () => {
    // If this drifts, an assumption about the contract changed and the search space
    // for the type hash changed with it.
    for (const [hash, meaning] of Object.entries(IDENTIFIED_PUSH32)) {
      expect(DEPLOYED_PUSH32_CONSTANTS, `${meaning} missing`).toContain(hash);
      expect(UNIDENTIFIED_PUSH32).not.toContain(hash as never);
    }
  });

  it('confirms the EIP712Domain typehash in the bytecode is the 4-field one', () => {
    // Which is why the domain has no salt, matching what eip712Domain() reported.
    const fourField = keccak256(
      stringToHex(
        'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
      ),
    );
    expect(DEPLOYED_PUSH32_CONSTANTS).toContain(fourField);
    expect(KURU_FORWARDER_DOMAIN).not.toHaveProperty('salt');
  });

  it('records the dispatcher selectors that no known signature explains', () => {
    expect(UNIDENTIFIED_SELECTORS.length).toBe(13);
    for (const s of UNIDENTIFIED_SELECTORS) expect(s).toMatch(/^0x[0-9a-f]{8}$/);
    // execute() is one of these. Recovering its signature is open item 1(b).
  });
});

describe('the working guess, for the record', () => {
  it('is the OpenZeppelin-derived shape', () => {
    expect(currentTypeString).toBe(
      'ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint256 deadline,bytes data)',
    );
  });

  it('is documented as unverified', () => {
    expect(FORWARD_REQUEST_SCHEMA_VERIFIED).toBe(false);
  });
});
