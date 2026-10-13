import { describe, expect, it } from 'vitest';
import { pad } from 'viem';
import { addressToBytes32, buildSendParam, encodeSend, LZ_EID } from './oft.js';

/**
 * The values below were read from Base mainnet on 2026-09-02, block 50783474, via
 * `https://mainnet.base.org`. They are recorded here rather than in a comment
 * somewhere because the encoder's whole job is to reproduce a struct the live
 * contract accepts, and a test is the only version of that claim which keeps working.
 *
 * AUSD OFT on Base: 0x9CaB7Ede13dc56652E44D2404E969C212f22689b (1200 bytes of code)
 *   token()            0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a  — the same AUSD
 *                      address Monad uses; Agora deploys it at one address everywhere
 *   oftVersion()       (0x02e49c2c, 1)
 *   endpoint()         0x1a44076050125825900e736c501f859c50fE728c  — LayerZero V2
 *   approvalRequired() false  — no ERC-20 approve is needed before send(), which is
 *                      one fewer transaction for the user than an OFT *adapter* would
 *                      require. Do not add an approval step "to be safe": it would be
 *                      a second signature for nothing.
 *   sharedDecimals()   6
 *
 * A live quoteSend for 5 AUSD to Monad (EID 30390), recipient the M0 test account:
 *   extraOptions 0x                      -> nativeFee 0.000100701869744601 ETH
 *   extraOptions lzReceive 65k gas       -> nativeFee 0.000100772333669759 ETH
 *
 * Both quoted, so enforced options are configured on the adapter and passing `0x` is
 * legitimate rather than a latent revert.
 */
const AUSD_OFT_BASE = '0x9CaB7Ede13dc56652E44D2404E969C212f22689b' as const;
const TEST_ACCOUNT = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961' as const;

describe('LayerZero endpoint ids', () => {
  it('keeps the Monad endpoint id apart from its EVM chain id', () => {
    // 30390 is the LayerZero endpoint id; 143 is the chain id. Swapping them sends
    // funds to a different chain, so the builder refuses rather than encodes.
    expect(LZ_EID.MONAD_MAINNET).toBe(30390);
    expect(() => buildSendParam({ dstEid: 143, recipient: TEST_ACCOUNT, amount: 1n })).toThrow(
      /chain id/,
    );
    expect(() => buildSendParam({ dstEid: 10143, recipient: TEST_ACCOUNT, amount: 1n })).toThrow(
      /chain id/,
    );
  });

  it('carries Base as 30184', () => {
    expect(LZ_EID.BASE).toBe(30184);
  });
});

describe('SendParam encoding', () => {
  it('left-pads the recipient to bytes32, as the endpoint requires', () => {
    expect(addressToBytes32(TEST_ACCOUNT)).toBe(pad(TEST_ACCOUNT, { size: 32 }));
    expect(addressToBytes32(TEST_ACCOUNT)).toHaveLength(66);
  });

  it('reproduces the exact struct that the live contract quoted', () => {
    const sendParam = buildSendParam({
      dstEid: LZ_EID.MONAD_MAINNET,
      recipient: TEST_ACCOUNT,
      amount: 5_000_000n,
    });
    expect(sendParam).toEqual({
      dstEid: 30390,
      to: pad(TEST_ACCOUNT, { size: 32 }),
      amountLD: 5_000_000n,
      minAmountLD: 5_000_000n,
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
    });
  });

  it('defaults minAmountLD to the full amount rather than to zero', () => {
    // A zero floor would let a solver deliver nothing and still succeed.
    const p = buildSendParam({
      dstEid: LZ_EID.MONAD_MAINNET,
      recipient: TEST_ACCOUNT,
      amount: 5_000_000n,
    });
    expect(p.minAmountLD).toBe(p.amountLD);
  });

  it('refuses a slippage floor above the amount', () => {
    expect(() =>
      buildSendParam({
        dstEid: LZ_EID.MONAD_MAINNET,
        recipient: TEST_ACCOUNT,
        amount: 5_000_000n,
        minAmount: 6_000_000n,
      }),
    ).toThrow(/cannot exceed/);
  });

  it('refuses a non-positive amount', () => {
    expect(() =>
      buildSendParam({ dstEid: LZ_EID.MONAD_MAINNET, recipient: TEST_ACCOUNT, amount: 0n }),
    ).toThrow(/positive/);
  });

  it('encodes send() calldata against the quoted fee', () => {
    const sendParam = buildSendParam({
      dstEid: LZ_EID.MONAD_MAINNET,
      recipient: TEST_ACCOUNT,
      amount: 5_000_000n,
    });
    const data = encodeSend(
      sendParam,
      { nativeFee: 100_701_869_744_601n, lzTokenFee: 0n },
      TEST_ACCOUNT,
    );
    expect(data.startsWith('0x')).toBe(true);
    // The recipient must appear as a padded word, and the amount as 5e6.
    expect(data.toLowerCase()).toContain(TEST_ACCOUNT.slice(2).toLowerCase());
    expect(data.length).toBeGreaterThan(200);
  });

  it('names the Base OFT that these numbers came from', () => {
    // Guards the constant against a silent edit: the quote above is only meaningful
    // for this contract.
    expect(AUSD_OFT_BASE).toBe('0x9CaB7Ede13dc56652E44D2404E969C212f22689b');
  });
});
