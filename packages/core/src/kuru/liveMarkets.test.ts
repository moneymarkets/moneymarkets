import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Address } from 'viem';
import {
  ACTIVE_MARKETS_RETRY_MS,
  ACTIVE_MARKETS_TTL_MS,
  activeMarketsView,
  CAP_MEASURABLE_QUOTE_ASSETS,
  capCanMeasure,
  COLD_START_MARKETS,
  configureLiveMarkets,
  DISABLED_MARKET_CANDIDATES,
  getActiveMarkets,
  getDisabledMarkets,
  getLiveMarketsStatus,
  listedByKuru,
  liveMarketsRefreshInFlight,
  lookupKuruListing,
  MARKET_CANDIDATES,
  PARKED_MARKET_CANDIDATES,
  resetLiveMarketsForTests,
  TRADING_MARKET_CANDIDATES,
  type VenueStateName,
} from './liveMarkets.js';
import {
  AUSD_USDC,
  CBBTC_USDC,
  EMO_MON,
  fakeChain,
  fakeKuru,
  listedAs,
  MON_AUSD,
  MON_USDC,
  notFoundFor,
  RECORDED_LOOKUPS,
  RECORDED_TUPLES,
  WBTC_AUSD,
  WETH_USDC,
  XAUT0_USDC,
} from './__fixtures__/liveMarketsHarness.js';
import {
  KURU_LIST_TRANSIENT_500,
  KURU_LOOKUP_MON_USDC,
  KURU_LOOKUP_NOT_FOUND_0X01,
  KURU_LOOKUP_WETH_USDC,
} from './__fixtures__/kuruMarketLookup.js';
import {
  CBBTC_USDC_PARAMS,
  EMO_MON_PARAMS,
  MON_USDC_PARAMS,
  WETH_USDC_PARAMS,
  XAUT0_USDC_PARAMS,
  XAUT0_USDC_TUPLE,
} from './__fixtures__/newMarkets.js';
import { MON_AUSD_PARAMS } from './__fixtures__/books.js';
import { AUSD_USDC_PARAMS } from './__fixtures__/ausdUsdc.js';
import { MAINNET } from '../chain/addresses.js';

const lower = (list: readonly string[]) => list.map((a) => a.toLowerCase());
const TRADING = [MON_USDC, WETH_USDC, CBBTC_USDC, XAUT0_USDC, EMO_MON];
/** The recorded listed reply for one of the recorded candidates. */
const RECORDED_OK = (address: string) => RECORDED_LOOKUPS[address]!;

/** Read before any test resets anything: what a fresh process starts with. */
const ACTIVE_AT_IMPORT = getActiveMarkets();

let now = 1_758_600_000_000;
const clock = () => now;

async function configureAndSettle(
  kuru = fakeKuru(),
  chain = fakeChain(),
): Promise<{ kuru: ReturnType<typeof fakeKuru>; chain: ReturnType<typeof fakeChain> }> {
  configureLiveMarkets({ client: chain.client, fetchImpl: kuru.fetchImpl, now: clock });
  await liveMarketsRefreshInFlight();
  return { kuru, chain };
}

beforeEach(() => {
  resetLiveMarketsForTests();
  now = 1_758_600_000_000;
});

describe('the candidate list is the verified one, and nothing else', () => {
  it('holds exactly the five trading markets, MON/USDC first', () => {
    expect(lower(TRADING_MARKET_CANDIDATES.map((c) => c.address))).toEqual(TRADING);
    expect(TRADING_MARKET_CANDIDATES.map((c) => c.symbol)).toEqual([
      'MON/USDC',
      'WETH/USDC',
      'cbBTC/USDC',
      'XAUt0/USDC',
      'emo/MON',
    ]);
    expect(TRADING_MARKET_CANDIDATES.every((c) => c.role === 'trading')).toBe(true);
  });

  it('trades emo/MON now that the order cap values MON, and parks nothing', () => {
    expect(lower(TRADING_MARKET_CANDIDATES.map((c) => c.address))).toContain(EMO_MON);
    expect(PARKED_MARKET_CANDIDATES).toEqual([]);
    // Still a known order book, so still on the sponsored-transfer deny list.
    expect(lower(MARKET_CANDIDATES.map((c) => c.address))).toContain(EMO_MON);
    expect(MARKET_CANDIDATES).toHaveLength(7);
  });

  it('holds MON/AUSD and AUSD/USDC as shown-but-not-traded', () => {
    expect(lower(DISABLED_MARKET_CANDIDATES.map((c) => c.address))).toEqual([MON_AUSD, AUSD_USDC]);
    expect(DISABLED_MARKET_CANDIDATES.every((c) => c.role === 'disabled')).toBe(true);
  });

  it('never names WBTC/AUSD', () => {
    expect(lower(MARKET_CANDIDATES.map((c) => c.address))).not.toContain(WBTC_AUSD);
    expect(MARKET_CANDIDATES.map((c) => c.symbol)).not.toContain('WBTC/AUSD');
  });

  it('checksums every address', () => {
    for (const c of MARKET_CANDIDATES) expect(c.address).toBe(getAddress(c.address));
  });

  it('agrees field for field with the independently transcribed fixtures', () => {
    // Two transcriptions of the same chain reads: this file's and the test-writer's
    // (__fixtures__/newMarkets.ts, books.ts, ausdUsdc.ts). A typo in either shows here.
    const byAddress = new Map(MARKET_CANDIDATES.map((c) => [c.address.toLowerCase(), c.params]));
    const expected = {
      [MON_USDC]: MON_USDC_PARAMS,
      [WETH_USDC]: WETH_USDC_PARAMS,
      [CBBTC_USDC]: CBBTC_USDC_PARAMS,
      [XAUT0_USDC]: XAUT0_USDC_PARAMS,
      [EMO_MON]: EMO_MON_PARAMS,
      [MON_AUSD]: MON_AUSD_PARAMS,
      [AUSD_USDC]: AUSD_USDC_PARAMS,
    };
    for (const [address, params] of Object.entries(expected)) {
      const pinned = byAddress.get(address);
      expect(pinned, address).toBeDefined();
      expect({
        ...pinned!,
        baseAsset: pinned!.baseAsset.toLowerCase(),
        quoteAsset: pinned!.quoteAsset.toLowerCase(),
      }).toEqual({
        ...params,
        baseAsset: params.baseAsset.toLowerCase(),
        quoteAsset: params.quoteAsset.toLowerCase(),
      });
    }
  });

  it('only trades markets the order cap can value', () => {
    // MAX_ORDER_NOTIONAL_AUSD is 6,000,000 base units of a six-decimal dollar token. Both
    // the ticket and the relayer value an order's quote amount in that unit first
    // (chain/quoteValuation.ts), so every trading candidate must be quoted in an asset
    // with a valuation: AUSD and USDC one-for-one, native MON at the MON/USDC mid.
    for (const c of TRADING_MARKET_CANDIDATES) expect(capCanMeasure(c.params), c.symbol).toBe(true);
    expect(lower(CAP_MEASURABLE_QUOTE_ASSETS)).toEqual(
      lower([MAINNET.tokens.AUSD.address, MAINNET.tokens.USDC.address, MAINNET.tokens.MON.address]),
    );
  });

  it('values native MON at 18 decimals, and nothing at the wrong decimals or with no rule', () => {
    // emo/MON's real params: quoted in native MON, 18 decimals.
    expect(capCanMeasure(EMO_MON_PARAMS)).toBe(true);
    // The same address at the wrong decimals is not the asset the table describes.
    expect(capCanMeasure({ ...EMO_MON_PARAMS, quoteDecimals: 6 })).toBe(false);
    // MON/USDC's real params with only the decimals edited: the address alone is not enough.
    expect(capCanMeasure({ ...MON_USDC_PARAMS, quoteDecimals: 18 })).toBe(false);
    expect(capCanMeasure(MON_USDC_PARAMS)).toBe(true);
    // USDT0 has no valuation rule (the owner's rule names AUSD and USDC), and no market
    // this app lists is quoted in it.
    expect(capCanMeasure({ ...MON_USDC_PARAMS, quoteAsset: MAINNET.tokens.USDT0.address })).toBe(
      false,
    );
    // WETH is a real 18-decimal token with a verified book, and still has no rule.
    expect(capCanMeasure({ ...EMO_MON_PARAMS, quoteAsset: WETH_USDC_PARAMS.baseAsset })).toBe(
      false,
    );
  });

  it('uses the address book for USDC and AUSD rather than retyping them', () => {
    const quotes = new Set(MARKET_CANDIDATES.map((c) => c.params.quoteAsset));
    expect(quotes.has(MAINNET.tokens.USDC.address)).toBe(true);
    expect(quotes.has(MAINNET.tokens.AUSD.address)).toBe(true);
  });
});

describe('lookupKuruListing reads Kuru’s per-address reply, and only a clear reply', () => {
  it('reads a recorded 200 as listed', async () => {
    const { fetchImpl, requests } = fakeKuru();
    expect(await lookupKuruListing(WETH_USDC, fetchImpl)).toBe('listed');
    expect(requests).toEqual([WETH_USDC]);
  });

  it('lowercases a checksummed address before asking', async () => {
    const { fetchImpl, requests } = fakeKuru();
    expect(await lookupKuruListing(getAddress(MON_USDC), fetchImpl)).toBe('listed');
    expect(requests).toEqual([MON_USDC]);
  });

  it('reads the recorded "Market not found" 500 as not listed, for that exact address', async () => {
    const recorded = '0x0000000000000000000000000000000000000001';
    const { fetchImpl } = fakeKuru({ [recorded]: KURU_LOOKUP_NOT_FOUND_0X01 });
    expect(await lookupKuruListing(recorded, fetchImpl)).toBe('not-listed');
  });

  it('does not read a "Market not found" naming some other address as an answer', async () => {
    const { fetchImpl } = fakeKuru({ [WETH_USDC]: KURU_LOOKUP_NOT_FOUND_0X01 });
    expect(await lookupKuruListing(WETH_USDC, fetchImpl)).toBe('unknown');
  });

  it('does not read a 500 that is not "Market not found" as not listed', async () => {
    // The transient failure the registry walk actually hit, and an edit of the real
    // not-found reply whose details carry a different message.
    const generic = {
      status: 500,
      body: notFoundFor(WETH_USDC).body.replace(
        `Market not found: ${WETH_USDC}`,
        'Connection terminated',
      ),
    };
    for (const answer of [KURU_LIST_TRANSIENT_500, generic]) {
      const { fetchImpl } = fakeKuru({ [WETH_USDC]: answer });
      expect(await lookupKuruListing(WETH_USDC, fetchImpl)).toBe('unknown');
    }
  });

  it('does not read a "Market not found" body on a non-500 status as not listed', async () => {
    const { fetchImpl } = fakeKuru({ [WETH_USDC]: { ...notFoundFor(WETH_USDC), status: 404 } });
    expect(await lookupKuruListing(WETH_USDC, fetchImpl)).toBe('unknown');
  });

  it('does not read a 200 whose row names a different market as listed', async () => {
    // A cache or proxy that returned the wrong row must not list the address asked about.
    const { fetchImpl } = fakeKuru({ [CBBTC_USDC]: KURU_LOOKUP_WETH_USDC });
    expect(await lookupKuruListing(CBBTC_USDC, fetchImpl)).toBe('unknown');
  });

  it('does not read a 200 with success false, or an unparsable body, as listed', async () => {
    const successFalse = {
      status: 200,
      body: KURU_LOOKUP_MON_USDC.body.replace('"success":true', '"success":false'),
    };
    const truncated = { status: 200, body: KURU_LOOKUP_MON_USDC.body.slice(0, 500) };
    for (const answer of [successFalse, truncated]) {
      const { fetchImpl } = fakeKuru({ [MON_USDC]: answer });
      expect(await lookupKuruListing(MON_USDC, fetchImpl)).toBe('unknown');
    }
  });

  it('reads a network failure, a 503 and a 404 as unknown', async () => {
    for (const answer of [
      'network-error' as const,
      { status: 503, body: KURU_LOOKUP_MON_USDC.body },
      { status: 404, body: '{}' },
    ]) {
      const { fetchImpl } = fakeKuru({ [MON_USDC]: answer });
      expect(await lookupKuruListing(MON_USDC, fetchImpl)).toBe('unknown');
    }
  });

  it('never puts anything but an address into the URL', async () => {
    const { fetchImpl, requests } = fakeKuru();
    expect(await lookupKuruListing('notanaddress', fetchImpl)).toBe('unknown');
    expect(await lookupKuruListing(`../markets?limit=1`, fetchImpl)).toBe('unknown');
    expect(requests).toEqual([]);
  });
});

describe('the active set, cold', () => {
  it('is MON/USDC alone, and never empty', () => {
    expect(lower(ACTIVE_AT_IMPORT)).toEqual([MON_USDC]);
    expect(lower(COLD_START_MARKETS)).toEqual([MON_USDC]);
    expect(getActiveMarkets()).toEqual([getAddress(MON_USDC)]);
    expect([...activeMarketsView]).toEqual([getAddress(MON_USDC)]);
    expect(getLiveMarketsStatus().source).toBe('cold-start');
  });

  it('makes no network call at all until configured', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    getActiveMarkets();
    void activeMarketsView.length;
    expect(listedByKuru(getAddress(MON_AUSD))).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('answers without waiting while the first refresh is still running', () => {
    const { client } = fakeChain();
    const { fetchImpl } = fakeKuru();
    configureLiveMarkets({ client, fetchImpl, now: clock });
    expect(liveMarketsRefreshInFlight()).toBeDefined();
    expect(lower(getActiveMarkets())).toEqual([MON_USDC]);
  });
});

describe('the active set, after a refresh', () => {
  it('holds all five when Kuru lists them and the chain agrees', async () => {
    await configureAndSettle();
    expect(lower(getActiveMarkets())).toEqual(TRADING);
    expect(lower([...activeMarketsView])).toEqual(TRADING);
    const status = getLiveMarketsStatus();
    expect(status.source).toBe('confirmed');
    expect(status.checks.map((c) => c.why)).toEqual(Array(5).fill('listed-and-verified'));
  });

  it('only ever asks about the trading and shown candidates', async () => {
    const { kuru, chain } = await configureAndSettle();
    expect(new Set(kuru.requests)).toEqual(new Set([...TRADING, MON_AUSD, AUSD_USDC]));
    // The chain half runs for the five trading candidates only.
    expect(new Set(chain.reads)).toEqual(new Set(TRADING.map((a) => `${a}.getMarketParams`)));
  });

  it('makes emo/MON active on its recorded reply and its recorded tuple', async () => {
    const kuru = fakeKuru({ [EMO_MON]: RECORDED_OK(EMO_MON) });
    await configureAndSettle(kuru);
    expect(lower([...activeMarketsView])).toContain(EMO_MON);
  });

  it('drops emo/MON with MON/USDC, the book that prices MON, when Kuru refuses MON/USDC', async () => {
    // emo/MON itself is listed and verified. Its orders are valued at the MON/USDC mid,
    // and a book Kuru says it does not list is not one this app stands behind.
    await configureAndSettle(fakeKuru({ [MON_USDC]: notFoundFor(MON_USDC) }));
    expect(lower(getActiveMarkets())).toEqual([WETH_USDC, CBBTC_USDC, XAUT0_USDC]);
    const emo = getLiveMarketsStatus().checks.find((c) => c.address.toLowerCase() === EMO_MON);
    expect(emo?.outcome).toBe('excluded');
    expect(emo?.why).toBe('pricing-book-inactive');
  });

  it('drops emo/MON when MON/USDC’s params no longer price MON in dollars', async () => {
    // MON/USDC's real tuple with its quote asset edited to AUSD: the address is no longer
    // the market pinned here, so it is excluded, and emo/MON goes with it.
    const quoteChanged: unknown[] = [...RECORDED_TUPLES[MON_USDC]!];
    quoteChanged[4] = MAINNET.tokens.AUSD.address;
    await configureAndSettle(fakeKuru(), fakeChain({ [MON_USDC]: quoteChanged }));
    expect(lower(getActiveMarkets())).not.toContain(EMO_MON);
    expect(lower(getActiveMarkets())).not.toContain(MON_USDC);
  });

  it('holds emo/MON back, as unverified, while MON/USDC cannot be read', async () => {
    await configureAndSettle(fakeKuru({ [MON_USDC]: 'network-error' }));
    expect(lower(getActiveMarkets())).toEqual([WETH_USDC, CBBTC_USDC, XAUT0_USDC]);
    const emo = getLiveMarketsStatus().checks.find((c) => c.address.toLowerCase() === EMO_MON);
    expect(emo?.outcome).toBe('unverified');
    expect(emo?.why).toBe('pricing-book-inactive');
  });

  it('does not tie a dollar-quoted market to MON/USDC', async () => {
    await configureAndSettle(fakeKuru({ [MON_USDC]: notFoundFor(MON_USDC) }));
    for (const dollarQuoted of [WETH_USDC, CBBTC_USDC, XAUT0_USDC]) {
      expect(lower(getActiveMarkets())).toContain(dollarQuoted);
    }
  });

  it('never lets in a market that is not a trading candidate, whatever Kuru and the chain say', async () => {
    // Kuru "lists" every address, and the chain answers every address with a real tuple.
    const kuru = fakeKuru(
      Object.fromEntries(
        [MON_AUSD, AUSD_USDC, WBTC_AUSD].map((a) => [
          a,
          listedAs(KURU_LOOKUP_MON_USDC, MON_USDC, a),
        ]),
      ),
    );
    const chain = fakeChain({
      [MON_AUSD]: RECORDED_TUPLES[MON_USDC]!,
      [AUSD_USDC]: RECORDED_TUPLES[MON_USDC]!,
      [WBTC_AUSD]: RECORDED_TUPLES[MON_USDC]!,
    });
    await configureAndSettle(kuru, chain);
    const active = lower(getActiveMarkets());
    expect(active).toEqual(TRADING);
    for (const outsider of [MON_AUSD, AUSD_USDC, WBTC_AUSD]) expect(active).not.toContain(outsider);
  });

  it('excludes a market Kuru says it does not list', async () => {
    await configureAndSettle(fakeKuru({ [WETH_USDC]: notFoundFor(WETH_USDC) }));
    expect(lower(getActiveMarkets())).toEqual(TRADING.filter((a) => a !== WETH_USDC));
    expect(
      getLiveMarketsStatus().checks.find((c) => c.address.toLowerCase() === WETH_USDC)?.why,
    ).toBe('not-listed-by-kuru');
  });

  it('excludes a market whose Kuru reply could not be read, rather than allowing it', async () => {
    const kuru = fakeKuru({
      [XAUT0_USDC]: 'network-error',
      [CBBTC_USDC]: KURU_LIST_TRANSIENT_500,
    });
    await configureAndSettle(kuru);
    expect(lower(getActiveMarkets())).toEqual([MON_USDC, WETH_USDC, EMO_MON]);
    // One retry each, then excluded.
    expect(kuru.requests.filter((a) => a === XAUT0_USDC)).toHaveLength(2);
    expect(kuru.requests.filter((a) => a === CBBTC_USDC)).toHaveLength(2);
  });

  it('keeps a market whose first reply was unreadable when the retry answers', async () => {
    const kuru = fakeKuru({
      [WETH_USDC]: (n) => (n === 1 ? KURU_LIST_TRANSIENT_500 : KURU_LOOKUP_WETH_USDC),
    });
    await configureAndSettle(kuru);
    expect(lower(getActiveMarkets())).toEqual(TRADING);
  });

  it('excludes a market whose getMarketParams() reverts', async () => {
    await configureAndSettle(fakeKuru(), fakeChain({ [CBBTC_USDC]: 'revert' }));
    expect(lower(getActiveMarkets())).not.toContain(CBBTC_USDC);
    expect(lower(getActiveMarkets())).toHaveLength(4);
  });

  it('excludes a market whose assets or scales no longer match the pinned ones', async () => {
    // XAUt0/USDC's real tuple with its quote asset edited to AUSD, and again with its
    // sizePrecision edited: either means the address is no longer the market pinned here.
    const quoteChanged: unknown[] = [...XAUT0_USDC_TUPLE];
    quoteChanged[4] = MAINNET.tokens.AUSD.address;
    await configureAndSettle(fakeKuru(), fakeChain({ [XAUT0_USDC]: quoteChanged }));
    expect(lower(getActiveMarkets())).not.toContain(XAUT0_USDC);
    expect(
      getLiveMarketsStatus().checks.find((c) => c.address.toLowerCase() === XAUT0_USDC)?.why,
    ).toBe('params-changed');

    resetLiveMarketsForTests();
    const scaleChanged: unknown[] = [...XAUT0_USDC_TUPLE];
    scaleChanged[1] = 10_000_000n;
    await configureAndSettle(fakeKuru(), fakeChain({ [XAUT0_USDC]: scaleChanged }));
    expect(lower(getActiveMarkets())).not.toContain(XAUT0_USDC);
  });

  it('does not exclude a market for a fee change alone', async () => {
    const feeChanged: unknown[] = [...XAUT0_USDC_TUPLE];
    feeChanged[9] = 5n;
    await configureAndSettle(fakeKuru(), fakeChain({ [XAUT0_USDC]: feeChanged }));
    expect(lower(getActiveMarkets())).toContain(XAUT0_USDC);
  });
});

describe('an outage never empties the set, and a real refusal does', () => {
  it('stays at MON/USDC when Kuru cannot be reached at all from cold', async () => {
    const kuru = fakeKuru(Object.fromEntries(TRADING.map((a) => [a, 'network-error' as const])));
    await configureAndSettle(kuru);
    expect(lower(getActiveMarkets())).toEqual([MON_USDC]);
    expect(getLiveMarketsStatus().source).toBe('cold-start');
  });

  it('stays at MON/USDC when the RPC cannot be reached at all from cold', async () => {
    const chain = fakeChain(Object.fromEntries(TRADING.map((a) => [a, 'revert' as const])));
    await configureAndSettle(fakeKuru(), chain);
    expect(lower(getActiveMarkets())).toEqual([MON_USDC]);
  });

  it('keeps the last confirmed set through an outage, and retries on the retry interval', async () => {
    const down = { value: false };
    const kuru = fakeKuru(
      Object.fromEntries(
        TRADING.map((a) => [a, () => (down.value ? ('network-error' as const) : RECORDED_OK(a))]),
      ),
    );
    await configureAndSettle(kuru);
    expect(lower(getActiveMarkets())).toEqual(TRADING);

    down.value = true;
    now += ACTIVE_MARKETS_TTL_MS + 1;
    getActiveMarkets();
    await liveMarketsRefreshInFlight();
    expect(lower(getActiveMarkets())).toEqual(TRADING);

    // Not retried on every read.
    const asked = kuru.requests.length;
    now += ACTIVE_MARKETS_RETRY_MS - 1;
    getActiveMarkets();
    expect(liveMarketsRefreshInFlight()).toBeUndefined();
    expect(kuru.requests.length).toBe(asked);

    // Retried once the interval has passed, and the recovery is picked up.
    down.value = false;
    now += 2;
    getActiveMarkets();
    await liveMarketsRefreshInFlight();
    expect(lower(getActiveMarkets())).toEqual(TRADING);
    expect(getLiveMarketsStatus().confirmedAt).toBe(now);
  });

  it('still drops a market Kuru definitively refuses in the middle of an outage', async () => {
    const down = { value: false };
    const kuru = fakeKuru(
      Object.fromEntries(
        TRADING.map((a) => [
          a,
          () =>
            !down.value
              ? RECORDED_OK(a)
              : a === WETH_USDC
                ? notFoundFor(WETH_USDC)
                : ('network-error' as const),
        ]),
      ),
    );
    await configureAndSettle(kuru);
    const confirmedAt = getLiveMarketsStatus().confirmedAt;

    down.value = true;
    now += ACTIVE_MARKETS_TTL_MS + 1;
    getActiveMarkets();
    await liveMarketsRefreshInFlight();
    // Nothing confirmed, so the set is kept, minus the one definitive refusal.
    expect(lower(getActiveMarkets())).toEqual(TRADING.filter((a) => a !== WETH_USDC));
    expect(getLiveMarketsStatus().confirmedAt).toBe(confirmedAt);
  });

  it('empties the cold set only on a definitive refusal of MON/USDC itself', async () => {
    const kuru = fakeKuru({
      ...Object.fromEntries(TRADING.map((a) => [a, 'network-error' as const])),
      [MON_USDC]: notFoundFor(MON_USDC),
    });
    await configureAndSettle(kuru);
    expect(getActiveMarkets()).toEqual([]);
    expect(getLiveMarketsStatus().source).toBe('cold-start');
  });

  it('empties the set when Kuru definitively refuses all five', async () => {
    const kuru = fakeKuru(Object.fromEntries(TRADING.map((a) => [a, notFoundFor(a)])));
    await configureAndSettle(kuru);
    expect(getActiveMarkets()).toEqual([]);
    expect(getLiveMarketsStatus().source).toBe('confirmed');
  });
});

describe('refresh cadence', () => {
  it('runs one refresh at a time, however many reads arrive', async () => {
    const { client } = fakeChain();
    const kuru = fakeKuru();
    configureLiveMarkets({ client, fetchImpl: kuru.fetchImpl, now: clock });
    for (let i = 0; i < 50; i += 1) {
      getActiveMarkets();
      void activeMarketsView[0];
    }
    await liveMarketsRefreshInFlight();
    // Five trading candidates and two shown ones, once each.
    expect(kuru.requests).toHaveLength(7);
  });

  it('does not refresh again inside ten minutes, and does after', async () => {
    const { kuru } = await configureAndSettle();
    now += ACTIVE_MARKETS_TTL_MS - 1;
    getActiveMarkets();
    expect(liveMarketsRefreshInFlight()).toBeUndefined();
    now += 2;
    getActiveMarkets();
    expect(liveMarketsRefreshInFlight()).toBeDefined();
    await liveMarketsRefreshInFlight();
    expect(kuru.requests).toHaveLength(14);
  });

  it('refreshes when the view alone is read, so callers that only read the array stay current', async () => {
    await configureAndSettle();
    now += ACTIVE_MARKETS_TTL_MS + 1;
    void activeMarketsView.length;
    expect(liveMarketsRefreshInFlight()).toBeDefined();
  });

  it('keeps the first configuration', async () => {
    const first = await configureAndSettle();
    const second = fakeKuru(Object.fromEntries(TRADING.map((a) => [a, notFoundFor(a)])));
    configureLiveMarkets({ client: fakeChain().client, fetchImpl: second.fetchImpl, now: clock });
    now += ACTIVE_MARKETS_TTL_MS + 1;
    getActiveMarkets();
    await liveMarketsRefreshInFlight();
    expect(second.requests).toEqual([]);
    expect(first.kuru.requests).toHaveLength(14);
  });
});

describe('the live view cannot be written to', () => {
  it('refuses push, index assignment, truncation and freezing', () => {
    const view = activeMarketsView as Address[];
    expect(() => view.push('0xbdc776284bf593981b1f0237f053a7ad11eb596f')).toThrow(TypeError);
    expect(() => {
      view[0] = getAddress(WBTC_AUSD);
    }).toThrow(TypeError);
    expect(() => {
      view.length = 0;
    }).toThrow(TypeError);
    expect(() => Object.freeze(view)).toThrow(TypeError);
    expect(() => view.splice(0, 1)).toThrow(TypeError);
    expect(lower(getActiveMarkets())).toEqual([MON_USDC]);
  });

  it('hands out copies, so a caller editing its copy changes nothing', () => {
    const copy = getActiveMarkets();
    copy.push(getAddress(WBTC_AUSD));
    expect(lower(getActiveMarkets())).toEqual([MON_USDC]);
  });

  it('is the same object before and after a refresh, and shows the new set', async () => {
    const reference = activeMarketsView;
    await configureAndSettle();
    expect(reference).toBe(activeMarketsView);
    expect(lower([...reference])).toEqual(TRADING);
    expect(JSON.parse(JSON.stringify(reference))).toEqual(TRADING.map((a) => getAddress(a)));
  });
});

describe('listedByKuru, for venueState', () => {
  it('answers from what the refresh learned', async () => {
    await configureAndSettle();
    expect(listedByKuru(getAddress(MON_AUSD))).toBe(true);
    expect(listedByKuru(getAddress(AUSD_USDC))).toBe(true);
    expect(listedByKuru(getAddress(WETH_USDC))).toBe(true);
  });

  it('says undefined, not false, for an address it has not heard about yet', async () => {
    const { kuru } = await configureAndSettle();
    expect(listedByKuru(getAddress(WBTC_AUSD))).toBeUndefined();
    await vi.waitFor(() => expect(kuru.requests).toContain(WBTC_AUSD));
    // The harness answers "Market not found" for anything unrecorded.
    await vi.waitFor(() => expect(listedByKuru(getAddress(WBTC_AUSD))).toBe(false));
  });

  it('never turns a known answer into "not listed" because Kuru could not be read', async () => {
    const down = { value: false };
    const kuru = fakeKuru({
      [MON_AUSD]: () => (down.value ? 'network-error' : RECORDED_OK(MON_AUSD)),
    });
    await configureAndSettle(kuru);
    expect(listedByKuru(getAddress(MON_AUSD))).toBe(true);

    down.value = true;
    now += ACTIVE_MARKETS_TTL_MS + 1;
    const before = kuru.requests.filter((a) => a === MON_AUSD).length;
    expect(listedByKuru(getAddress(MON_AUSD))).toBe(true);
    await vi.waitFor(() =>
      expect(kuru.requests.filter((a) => a === MON_AUSD).length).toBe(before + 2),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listedByKuru(getAddress(MON_AUSD))).toBe(true);
  });

  it('asks nothing when unconfigured, so a testnet or browser process never labels anything', () => {
    const { requests } = fakeKuru();
    expect(listedByKuru(getAddress(MON_AUSD))).toBeUndefined();
    expect(requests).toEqual([]);
  });
});

describe('getDisabledMarkets', () => {
  const reader =
    (states: Record<string, VenueStateName | undefined>) => async (market: Address) => {
      const state = states[market.toLowerCase()];
      return state ? { state } : undefined;
    };

  it('returns MON/AUSD and AUSD/USDC with the venue’s own reading', async () => {
    await configureAndSettle();
    const disabled = await getDisabledMarkets(
      reader({ [MON_AUSD]: 'empty', [AUSD_USDC]: 'paused' }),
    );
    expect(disabled).toEqual([
      {
        address: getAddress(MON_AUSD),
        symbol: 'MON/AUSD',
        base: 'MON',
        quote: 'AUSD',
        stillListedByKuru: true,
        reason: 'empty',
        venueState: 'empty',
      },
      {
        address: getAddress(AUSD_USDC),
        symbol: 'AUSD/USDC',
        base: 'AUSD',
        quote: 'USDC',
        stillListedByKuru: true,
        reason: 'paused',
        venueState: 'paused',
      },
    ]);
  });

  it('says unknown, and carries the reading, for anything that is neither paused nor empty', async () => {
    const disabled = await getDisabledMarkets(
      reader({ [MON_AUSD]: 'tradable', [AUSD_USDC]: undefined }),
    );
    expect(disabled.map((d) => [d.reason, d.venueState])).toEqual([
      ['unknown', 'tradable'],
      ['unknown', undefined],
    ]);
  });

  it('does not claim a listing it does not know, and survives a reader that throws', async () => {
    const disabled = await getDisabledMarkets(async () => {
      throw new Error('rpc down');
    });
    expect(disabled.map((d) => d.stillListedByKuru)).toEqual([undefined, undefined]);
    expect(disabled.map((d) => d.reason)).toEqual(['unknown', 'unknown']);
  });

  it('reports Kuru’s "not listed" when Kuru gives it', async () => {
    await configureAndSettle(fakeKuru({ [MON_AUSD]: notFoundFor(MON_AUSD) }));
    const disabled = await getDisabledMarkets();
    expect(disabled.map((d) => d.stillListedByKuru)).toEqual([false, true]);
  });
});
