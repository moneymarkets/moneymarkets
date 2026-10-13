import type { Address, PublicClient } from 'viem';
import {
  KURU_LOOKUP_AUSD_USDC,
  KURU_LOOKUP_CBBTC_USDC,
  KURU_LOOKUP_EMO_MON,
  KURU_LOOKUP_MON_AUSD,
  KURU_LOOKUP_MON_USDC,
  KURU_LOOKUP_NOT_FOUND_0X01,
  KURU_LOOKUP_WETH_USDC,
  KURU_LOOKUP_XAUT0_USDC,
  type RecordedLookup,
} from './kuruMarketLookup.js';
import {
  CBBTC_USDC_TUPLE,
  EMO_MON_TUPLE,
  MON_USDC_TUPLE,
  WETH_USDC_TUPLE,
  XAUT0_USDC_TUPLE,
} from './newMarkets.js';

/**
 * A fake Kuru API and a fake chain for `liveMarkets.ts`, built only from recorded
 * answers: the per-address replies in `kuruMarketLookup.ts` and the `getMarketParams()`
 * tuples in `newMarkets.ts`. Anything a test needs beyond those is an edit of one of
 * them, made in the test where it can be seen.
 */

export const MON_USDC = '0x065c9d28e428a0db40191a54d33d5b7c71a9c394';
export const WETH_USDC = '0xa6afd386135b7d41a6c40c525abc4a1019b0d132';
export const CBBTC_USDC = '0x40c49f171202f91ff5d2fae34c22dd2bfdd22af0';
export const XAUT0_USDC = '0x851145eaefdc37956b08da829fa31722199f3f07';
export const EMO_MON = '0xe7a4f90369b48d8f5b61f2fd519ec563c11e4b2d';
export const MON_AUSD = '0x131a2e70a5b31a517a74b8c567149bc294470da9';
export const AUSD_USDC = '0x699abc15308156e9a3ab89ec7387e9cfe1c86a3b';
export const WBTC_AUSD = '0xbdc776284bf593981b1f0237f053a7ad11eb596f';

export const RECORDED_LOOKUPS: Readonly<Record<string, RecordedLookup>> = {
  [MON_USDC]: KURU_LOOKUP_MON_USDC,
  [WETH_USDC]: KURU_LOOKUP_WETH_USDC,
  [CBBTC_USDC]: KURU_LOOKUP_CBBTC_USDC,
  [XAUT0_USDC]: KURU_LOOKUP_XAUT0_USDC,
  [EMO_MON]: KURU_LOOKUP_EMO_MON,
  [MON_AUSD]: KURU_LOOKUP_MON_AUSD,
  [AUSD_USDC]: KURU_LOOKUP_AUSD_USDC,
};

export const RECORDED_TUPLES: Readonly<Record<string, readonly unknown[]>> = {
  [MON_USDC]: MON_USDC_TUPLE,
  [WETH_USDC]: WETH_USDC_TUPLE,
  [CBBTC_USDC]: CBBTC_USDC_TUPLE,
  [XAUT0_USDC]: XAUT0_USDC_TUPLE,
  [EMO_MON]: EMO_MON_TUPLE,
};

const RECORDED_NOT_FOUND_ADDRESS = '0x0000000000000000000000000000000000000001';

/** The recorded "Market not found" reply, with the address it names edited to `address`. */
export function notFoundFor(address: string): RecordedLookup {
  return {
    status: KURU_LOOKUP_NOT_FOUND_0X01.status,
    body: KURU_LOOKUP_NOT_FOUND_0X01.body.replace(RECORDED_NOT_FOUND_ADDRESS, address),
  };
}

/** A recorded listed reply, with the row's `market` edited to `address`. */
export function listedAs(recorded: RecordedLookup, from: string, address: string): RecordedLookup {
  return {
    status: recorded.status,
    body: recorded.body.replace(`"market":"${from}"`, `"market":"${address}"`),
  };
}

export type KuruAnswer = RecordedLookup | 'network-error';

/**
 * Serves the recorded reply for each address, `notFoundFor` for anything unrecorded, and
 * whatever `answers` overrides. Records every address asked about.
 */
export function fakeKuru(answers: Record<string, KuruAnswer | ((n: number) => KuruAnswer)> = {}): {
  fetchImpl: typeof fetch;
  requests: string[];
} {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const address = url.slice(url.lastIndexOf('/') + 1);
    requests.push(address);
    const override = answers[address];
    const n = requests.filter((a) => a === address).length;
    const answer =
      typeof override === 'function'
        ? override(n)
        : (override ?? RECORDED_LOOKUPS[address] ?? notFoundFor(address));
    if (answer === 'network-error') throw new TypeError('fetch failed');
    return new Response(answer.body, {
      status: answer.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

export type ChainAnswer = readonly unknown[] | 'revert';

/**
 * A client whose `getMarketParams()` answers with the recorded tuple for each candidate
 * and reverts for anything else, unless `answers` overrides it.
 */
export function fakeChain(answers: Record<string, ChainAnswer> = {}): {
  client: PublicClient;
  reads: string[];
} {
  const reads: string[] = [];
  const client = {
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      const key = address.toLowerCase();
      reads.push(`${key}.${functionName}`);
      if (functionName !== 'getMarketParams') throw new Error(`unexpected read ${functionName}`);
      const answer = answers[key] ?? RECORDED_TUPLES[key] ?? 'revert';
      if (answer === 'revert') throw new Error('execution reverted');
      return answer;
    },
  } as unknown as PublicClient;
  return { client, reads };
}
