/**
 * Kuru's per-address market lookup, recorded byte for byte.
 *
 * `GET https://api.kuru.io/api/v1/markets/<address>`, fetched 2026-09-23T07:40:54Z
 * with curl from this machine. Every body below is the exact response text; nothing
 * was retyped or trimmed. The HTTP status recorded with each is the one curl reported.
 *
 *   listed       HTTP 200, `{"success":true,"data":{...,"market":"<address>",...}}`
 *   not listed   HTTP 500, `{"success":false,"error":"Error retrieving specific market",
 *                "details":"Market not found: <address as requested>"}`
 *
 * The not-found body echoes whatever path segment was requested: `notanaddress` came
 * back as "Market not found: notanaddress". Attack cases in the tests are built by
 * editing these bodies, never by writing a plausible-looking one from scratch.
 */

export interface RecordedLookup {
  readonly status: number;
  readonly body: string;
}

/** HTTP 200 for `0x065c9d28e428a0db40191a54d33d5b7c71a9c394`. */
export const KURU_LOOKUP_MON_USDC: RecordedLookup = {
  status: 200,
  body: '{"success":true,"data":{"baseasset":"0x0000000000000000000000000000000000000000","quoteasset":"0x754704bc059f8c67012fed69bc8a327a5aafb603","market":"0x065c9d28e428a0db40191a54d33d5b7c71a9c394","kuruammvault":"0x838c2d3fd4db5eb2f185cbe7697fbaace52b34d7","priceprecision":"100000000","sizeprecision":"10000000000","ticksize":"100","minsize":"2000000000000","maxsize":"2000000000000000000","takerfeebps":"0","makerfeebps":"0","blocknumber":"43660999","txindex":"4","logindex":"21","transactionhash":"0x85f4b267e1b2a1c0062d5ce1142f3c721a071682dc73d3780b8cccfcd4086a72","triggertime":"2025-11-04T00:00:00.000Z","basetoken":{"address":"0x0000000000000000000000000000000000000000","decimal":"18","name":"Monad","ticker":"MON","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/0x3789a22f1ad92aff28ff5012e6e6de72e114f0d2_1765986465886.png","twitter":"https://x.com/monad","website":"https://www.monad.xyz/","is_verified":false,"contract_renounced":true,"is_erc20":false,"is_mintable":false},"quotetoken":{"address":"0x754704bc059f8c67012fed69bc8a327a5aafb603","decimal":"6","name":"USDC","ticker":"USDC","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/tokens/USDC/logo.svg","twitter":"","website":"","is_verified":true,"contract_renounced":false,"is_erc20":false,"is_mintable":true},"lastPrice":0.026364,"lastTradeTime":"2026-09-23T07:40:36.000Z","volume5m":86569.61617671482,"buyVolume5m":46623.024642742166,"sellVolume5m":39946.591533972634,"buyCount5m":108,"sellCount5m":74,"volume1h":749875.4570478649,"buyVolume1h":377498.8723369526,"sellVolume1h":372376.5847109124,"buyCount1h":753,"sellCount1h":743,"volume24h":22581053.154530026,"buyVolume24h":11323458.390582085,"sellVolume24h":11257594.76394806,"buyCount24h":22170,"sellCount24h":21734,"uniqueTraders5m":20,"uniqueTraders1h":35,"uniqueTraders24h":61,"priceChange5m":-0.48692107349111086,"priceChange1h":-1.509264793783622,"priceChange24h":5.287539936102236,"liquidity":1.3161052142e-8}}',
};

/** HTTP 200 for `0xa6afd386135b7d41a6c40c525abc4a1019b0d132`. */
export const KURU_LOOKUP_WETH_USDC: RecordedLookup = {
  status: 200,
  body: '{"success":true,"data":{"baseasset":"0xee8c0e9f1bffb4eb878d8f15f368a02a35481242","quoteasset":"0x754704bc059f8c67012fed69bc8a327a5aafb603","market":"0xa6afd386135b7d41a6c40c525abc4a1019b0d132","kuruammvault":"0xde814a43c003416b363257452a787f479a4b98a1","priceprecision":"10000","sizeprecision":"10000000000","ticksize":"100","minsize":"20000000","maxsize":"1000000000000000000","takerfeebps":"0","makerfeebps":"0","blocknumber":"69551015","txindex":"2","logindex":"9","transactionhash":"0x97536cc6bb8911ecfb213e4c7baa64752e734ba7b69846aeac8b49eed16be1f5","triggertime":"2026-04-21T10:41:54.000Z","basetoken":{"address":"0xee8c0e9f1bffb4eb878d8f15f368a02a35481242","decimal":"18","name":"Wrapped Ether","ticker":"WETH","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/tokens/WETH/logo.svg","twitter":"","website":"","is_verified":false,"contract_renounced":false,"is_erc20":false,"is_mintable":true},"quotetoken":{"address":"0x754704bc059f8c67012fed69bc8a327a5aafb603","decimal":"6","name":"USDC","ticker":"USDC","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/tokens/USDC/logo.svg","twitter":"","website":"","is_verified":true,"contract_renounced":false,"is_erc20":false,"is_mintable":true},"lastPrice":2741.17,"lastTradeTime":"2026-09-23T07:40:14.000Z","volume5m":19089.957945863523,"buyVolume5m":7075.7487599266815,"sellVolume5m":12014.209185936845,"buyCount5m":6,"sellCount5m":42,"volume1h":113839.41174797966,"buyVolume1h":55226.26176370704,"sellVolume1h":58613.14998427261,"buyCount1h":47,"sellCount1h":294,"volume24h":4968007.362321461,"buyVolume24h":2583501.6667875256,"sellVolume24h":2384505.6955339345,"buyCount24h":1839,"sellCount24h":6303,"uniqueTraders5m":10,"uniqueTraders1h":14,"uniqueTraders24h":86,"priceChange5m":-0.06052143224333991,"priceChange1h":-0.6358044158320374,"priceChange24h":0.5199872386770762,"liquidity":0}}',
};

/** HTTP 200 for `0x40c49f171202f91ff5d2fae34c22dd2bfdd22af0`. */
export const KURU_LOOKUP_CBBTC_USDC: RecordedLookup = {
  status: 200,
  body: '{"success":true,"data":{"baseasset":"0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b","quoteasset":"0x754704bc059f8c67012fed69bc8a327a5aafb603","market":"0x40c49f171202f91ff5d2fae34c22dd2bfdd22af0","kuruammvault":"0x0f1bf866456d3559e3851847d720d0fd2a5d278b","priceprecision":"10000","sizeprecision":"100000000","ticksize":"100","minsize":"12500","maxsize":"10000000000","takerfeebps":"0","makerfeebps":"0","blocknumber":"73880642","txindex":"3","logindex":"28","transactionhash":"0x6340da17f4046ac2ff6dac202ba0e9a92463cb943b19c15de20f4af74a728114","triggertime":"2026-05-11T11:40:42.000Z","basetoken":{"address":"0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b","decimal":"8","name":"Coinbase Wrapped BTC","ticker":"cbBTC","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/0x2eb297d39ea50963421066953c2dab7bdd3e90d6_1772565029823.png","twitter":"","website":"","is_verified":true,"contract_renounced":false,"is_erc20":false,"is_mintable":true},"quotetoken":{"address":"0x754704bc059f8c67012fed69bc8a327a5aafb603","decimal":"6","name":"USDC","ticker":"USDC","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/tokens/USDC/logo.svg","twitter":"","website":"","is_verified":true,"contract_renounced":false,"is_erc20":false,"is_mintable":true},"lastPrice":86142.65,"lastTradeTime":"2026-09-23T07:40:00.000Z","volume5m":20691.143452499702,"buyVolume5m":7347.6249381975,"sellVolume5m":13343.518514302203,"buyCount5m":4,"sellCount5m":26,"volume1h":61352.11670177,"buyVolume1h":21367.058846085303,"sellVolume1h":39985.057855684696,"buyCount1h":38,"sellCount1h":61,"volume24h":4312179.0137690175,"buyVolume24h":2090547.0280752245,"sellVolume24h":2221631.9856937933,"buyCount24h":2375,"sellCount24h":4222,"uniqueTraders5m":11,"uniqueTraders1h":18,"uniqueTraders24h":99,"priceChange5m":-0.07552684352313527,"priceChange1h":-0.4491323312064341,"priceChange24h":1.069776713531142,"liquidity":0}}',
};

/** HTTP 200 for `0x851145eaefdc37956b08da829fa31722199f3f07`. */
export const KURU_LOOKUP_XAUT0_USDC: RecordedLookup = {
  status: 200,
  body: '{"success":true,"data":{"baseasset":"0x01bff41798a0bcf287b996046ca68b395dbc1071","quoteasset":"0x754704bc059f8c67012fed69bc8a327a5aafb603","market":"0x851145eaefdc37956b08da829fa31722199f3f07","kuruammvault":"0x17ef8f953cc10861dc1bef9322322586a9fa08b8","priceprecision":"10000","sizeprecision":"1000000","ticksize":"100","minsize":"2000","maxsize":"100000000","takerfeebps":"0","makerfeebps":"0","blocknumber":"76297570","txindex":"6","logindex":"54","transactionhash":"0x0f67857bcd25ee810b97e35b00003355c0fd10b3b96832150e3ba17ae42aa592","triggertime":"2026-05-22T16:31:56.000Z","basetoken":{"address":"0x01bff41798a0bcf287b996046ca68b395dbc1071","decimal":"6","name":"XAUt0","ticker":"XAUt0","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/tokens/XAUt0/logo.svg","twitter":null,"website":null,"is_verified":false,"contract_renounced":false,"is_erc20":false,"is_mintable":true},"quotetoken":{"address":"0x754704bc059f8c67012fed69bc8a327a5aafb603","decimal":"6","name":"USDC","ticker":"USDC","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/tokens/USDC/logo.svg","twitter":"","website":"","is_verified":true,"contract_renounced":false,"is_erc20":false,"is_mintable":true},"lastPrice":4323.9800000000005,"lastTradeTime":"2026-09-23T07:37:01.000Z","volume5m":247.2381695,"buyVolume5m":247.2381695,"sellVolume5m":0,"buyCount5m":2,"sellCount5m":0,"volume1h":18161.430123699996,"buyVolume1h":7988.978500839999,"sellVolume1h":10172.451622859999,"buyCount1h":12,"sellCount1h":9,"volume24h":45096967.20846776,"buyVolume24h":22579117.6521457,"sellVolume24h":22517849.556322124,"buyCount24h":6199,"sellCount24h":6270,"uniqueTraders5m":2,"uniqueTraders1h":5,"uniqueTraders24h":29,"priceChange5m":-0.05408753860093567,"priceChange1h":-0.24753674409591414,"priceChange24h":0.22715788400113116,"liquidity":0}}',
};

/** HTTP 200 for `0xe7a4f90369b48d8f5b61f2fd519ec563c11e4b2d`. */
export const KURU_LOOKUP_EMO_MON: RecordedLookup = {
  status: 200,
  body: '{"success":true,"data":{"baseasset":"0x81a224f8a62f52bde942dbf23a56df77a10b7777","quoteasset":"0x0000000000000000000000000000000000000000","market":"0xe7a4f90369b48d8f5b61f2fd519ec563c11e4b2d","kuruammvault":"0xc9d4adafa87935a440d32ae1a0526098170fad3f","priceprecision":"100000","sizeprecision":"100000000000","ticksize":"10","minsize":"20000000000000","maxsize":"1553255926290448384","takerfeebps":"2","makerfeebps":"2","blocknumber":"38374330","txindex":"3","logindex":"23","transactionhash":"0xf4d155c83cfc33cb4d8bf8a039962f1c6e3543cba783d586d6524c39d164f665","triggertime":"2025-11-27T17:13:47.000Z","basetoken":{"address":"0x81a224f8a62f52bde942dbf23a56df77a10b7777","decimal":"18","name":"emonad","ticker":"emo","imageurl":"https://crypto-token-logos-production.s3.us-west-2.amazonaws.com/143_0x81a224f8a62f52bde942dbf23a56df77a10b7777_small.png","twitter":"","website":"","is_verified":true,"contract_renounced":false,"is_erc20":false,"is_mintable":true},"quotetoken":{"address":"0x0000000000000000000000000000000000000000","decimal":"18","name":"Monad","ticker":"MON","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/0x3789a22f1ad92aff28ff5012e6e6de72e114f0d2_1765986465886.png","twitter":"https://x.com/monad","website":"https://www.monad.xyz/","is_verified":false,"contract_renounced":true,"is_erc20":false,"is_mintable":false},"lastPrice":0.031,"lastTradeTime":"2026-09-23T04:41:11.000Z","volume5m":0,"buyVolume5m":0,"sellVolume5m":0,"buyCount5m":0,"sellCount5m":0,"volume1h":0,"buyVolume1h":0,"sellVolume1h":0,"buyCount1h":0,"sellCount1h":0,"volume24h":1.87198827307685,"buyVolume24h":0,"sellVolume24h":1.87198827307685,"buyCount24h":0,"sellCount24h":1,"uniqueTraders5m":0,"uniqueTraders1h":0,"uniqueTraders24h":1,"priceChange5m":0,"priceChange1h":0,"priceChange24h":0,"liquidity":0}}',
};

/** HTTP 200 for `0x131a2e70a5b31a517a74b8c567149bc294470da9`. */
export const KURU_LOOKUP_MON_AUSD: RecordedLookup = {
  status: 200,
  body: '{"success":true,"data":{"baseasset":"0x0000000000000000000000000000000000000000","quoteasset":"0x00000000efe302beaa2b3e6e1b18d08d69a9012a","market":"0x131a2e70a5b31a517a74b8c567149bc294470da9","kuruammvault":"0xf7fbe88e3a15463a66e7ce9946e56a9878eeba30","priceprecision":"100000000","sizeprecision":"10000000000","ticksize":"100","minsize":"2000000000000","maxsize":"20000000000000000000","takerfeebps":"0","makerfeebps":"0","blocknumber":"45440066","txindex":"1","logindex":"7","transactionhash":"0x8642018193e395f73e79d0f5bc357de4c735ae37baa28194565816f39ba6d57e","triggertime":"2025-11-18T00:00:00.000Z","basetoken":{"address":"0x0000000000000000000000000000000000000000","decimal":"18","name":"Monad","ticker":"MON","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/0x3789a22f1ad92aff28ff5012e6e6de72e114f0d2_1765986465886.png","twitter":"https://x.com/monad","website":"https://www.monad.xyz/","is_verified":false,"contract_renounced":true,"is_erc20":false,"is_mintable":false},"quotetoken":{"address":"0x00000000efe302beaa2b3e6e1b18d08d69a9012a","decimal":"6","name":"AUSD","ticker":"AUSD","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/tokens/AUSD/logo.svg","twitter":"https://x.com/withAUSD","website":"https://www.agora.finance/","is_verified":false,"contract_renounced":false,"is_erc20":false,"is_mintable":true},"lastPrice":0.025442,"lastTradeTime":"2026-09-02T23:59:23.000Z","volume5m":0,"buyVolume5m":0,"sellVolume5m":0,"buyCount5m":0,"sellCount5m":0,"volume1h":0,"buyVolume1h":0,"sellVolume1h":0,"buyCount1h":0,"sellCount1h":0,"volume24h":0,"buyVolume24h":0,"sellVolume24h":0,"buyCount24h":0,"sellCount24h":0,"uniqueTraders5m":0,"uniqueTraders1h":0,"uniqueTraders24h":0,"priceChange5m":0,"priceChange1h":0,"priceChange24h":0,"liquidity":1.1770462194e-8}}',
};

/** HTTP 200 for `0x699abc15308156e9a3ab89ec7387e9cfe1c86a3b`. */
export const KURU_LOOKUP_AUSD_USDC: RecordedLookup = {
  status: 200,
  body: '{"success":true,"data":{"baseasset":"0x00000000efe302beaa2b3e6e1b18d08d69a9012a","quoteasset":"0x754704bc059f8c67012fed69bc8a327a5aafb603","market":"0x699abc15308156e9a3ab89ec7387e9cfe1c86a3b","kuruammvault":"0x790c4ec26462171be752ce61e1b195c5ed1aedf9","priceprecision":"100000000","sizeprecision":"1000000","ticksize":"100","minsize":"10000000","maxsize":"10000000000000","takerfeebps":"0","makerfeebps":"0","blocknumber":"43913811","txindex":"4","logindex":"19","transactionhash":"0x2630ba6a69d120c14fc6c2f0125e5f4499bd5125ab8f62a499cbe36a628934f7","triggertime":"2025-12-23T11:52:43.000Z","basetoken":{"address":"0x00000000efe302beaa2b3e6e1b18d08d69a9012a","decimal":"6","name":"AUSD","ticker":"AUSD","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/tokens/AUSD/logo.svg","twitter":"https://x.com/withAUSD","website":"https://www.agora.finance/","is_verified":false,"contract_renounced":false,"is_erc20":false,"is_mintable":true},"quotetoken":{"address":"0x754704bc059f8c67012fed69bc8a327a5aafb603","decimal":"6","name":"USDC","ticker":"USDC","imageurl":"https://dsvxs4ecepqgj.cloudfront.net/tokens/USDC/logo.svg","twitter":"","website":"","is_verified":true,"contract_renounced":false,"is_erc20":false,"is_mintable":true},"lastPrice":1.000123,"lastTradeTime":"2026-09-03T02:40:47.000Z","volume5m":0,"buyVolume5m":0,"sellVolume5m":0,"buyCount5m":0,"sellCount5m":0,"volume1h":0,"buyVolume1h":0,"sellVolume1h":0,"buyCount1h":0,"sellCount1h":0,"volume24h":0,"buyVolume24h":0,"sellVolume24h":0,"buyCount24h":0,"sellCount24h":0,"uniqueTraders5m":0,"uniqueTraders1h":0,"uniqueTraders24h":0,"priceChange5m":0,"priceChange1h":0,"priceChange24h":0,"liquidity":0}}',
};

/** HTTP 500 for `0x0000000000000000000000000000000000000001`, an address Kuru does not list. */
export const KURU_LOOKUP_NOT_FOUND_0X01: RecordedLookup = {
  status: 500,
  body: '{"success":false,"error":"Error retrieving specific market","details":"Market not found: 0x0000000000000000000000000000000000000001"}',
};

/**
 * HTTP 500 from the paged list endpoint (`GET /api/v1/markets?limit=200&offset=3200`),
 * quoted verbatim in `reports/MARKETS-VERIFIED.md` section 4. A transient server
 * failure, not an answer about any market: the retry of the same page succeeded.
 */
export const KURU_LIST_TRANSIENT_500: RecordedLookup = {
  status: 500,
  body: '{"success":false,"error":"Error retrieving markets"}',
};
