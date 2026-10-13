import type { Address } from 'viem';

/**
 * A real Kuru Flow quote, recorded verbatim on 2026-09-02.
 *
 *   POST https://ws.kuru.io/api/quote
 *   { userAddress: 0x43a275…A961, tokenIn: USDC, tokenOut: AUSD, amount: "1000000",
 *     autoSlippage: true, referrerAddress: 0x43a275…A961, referrerFeeBps: 30 }
 *
 * Nothing below is edited. The calldata is the API's own, still without its `0x`
 * prefix, because that missing prefix is one of the two things this module exists to
 * correct.
 */
export const FLOW_USDC_AUSD_RESPONSE = {
  type: 'calculate_swap_result',
  status: 'success',
  output: '996851',
  minOut: '996452',
  transaction: {
    calldata:
      'ce1e703000000000000000000000000000000000efe302beaa2b3e6e1b18d08d69a9012a00000000000000000000000000000000000000000000000000000000000f3464000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb60300000000000000000000000000000000000000000000000000000000000f424000000000000000000000000062ee1b8d1efdf8f73c78db87b888406b194e266a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000043a275c3eb0be7313f847ffa4fb6bd366606a961000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000005302754704bc059f8c67012fed69bc8a327a5aafb60301ffff03699abc15308156e9a3ab89ec7387e9cfe1c86a3b0105f5e10000000000000000000000000000000000000000000000000000000000000f42400600000000000000000000000000',
    value: '0',
    to: '0xb3e6778480b2E488385E8205eA05E20060B813cb',
  },
  gasPrices: {
    slow: '106.00',
    standard: '110.00',
    fast: '110.00',
    rapid: '113.64',
    extreme: '180.00',
  },
} as const;

export const FLOW_QUOTE_USER: Address = '0x43a275C3Eb0BE7313f847FFA4fb6Bd366606A961';
export const FLOW_QUOTE_TOKEN_IN: Address = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
export const FLOW_QUOTE_TOKEN_OUT: Address = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';
export const FLOW_QUOTE_AMOUNT_IN = 1_000_000n;
export const FLOW_QUOTE_REFERRER_FEE_BPS = 30;

/**
 * The last 83 bytes of that calldata are a length-prefixed packed blob, and it is the
 * only place in the response where a venue is named at all:
 *
 *   …0053                                       length 0x53 = 83
 *   02 754704bc…b603                            USDC
 *   01 ffff 03
 *   699abc15308156e9a3ab89ec7387e9cfe1c86a3b    the AUSD/USDC OrderBook
 *   01 05f5e100                                 100000000 = 1e8, this book's pricePrecision
 *
 * So Flow's USDC->AUSD route is **the same order book `kuru/convert.ts` calls
 * directly** — which is why the in-app conversion goes to the book rather than through
 * Flow: the venue is identical and only the book path can be sponsored.
 *
 * That reading is a substring observation, not a decode. The framing bytes (`02`,
 * `01ffff03`, `01`, `06`) are not documented anywhere this repo has read, and no code
 * depends on them. See the UNVERIFIED note on `KURU_FLOW_SELECTOR`.
 */
export const FLOW_ROUTE_VENUE: Address = '0x699AbC15308156E9a3AB89Ec7387e9CfE1c86A3b';
