import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertKnownFlags, flagInt, flagString, requireAddress, type ParsedArgs } from '../args.js';
import { loadConfig, marginAccountAddress } from '../config.js';
import {
  formatBase,
  formatPrice,
  formatQuote,
  formatSize,
  formatWire,
  gapBps,
  heading,
  renderTable,
  type TableColumn,
} from '../format.js';
import {
  previewVaultDeposit,
  readMarginBalance,
  readMarket,
  readVault,
  scanRestingOrders,
  type RestingOrder,
} from '../market.js';
import { readChain } from './seed.js';

export const STATUS_FLAGS = ['market', 'scan', 'from', 'chain', 'rpc', 'out'] as const;

/** `kit status` — params, best bid/ask, vault TVL, our resting orders. Reads only. */
export async function statusCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, STATUS_FLAGS);
  const config = loadConfig({
    mode: readChain(args),
    from: flagString(args, 'from'),
    rpcUrl: flagString(args, 'rpc'),
  });
  const market = requireAddress(args, 'market');
  const window = flagInt(args, 'scan') ?? 2000;

  const view = await readMarket(config.client, market);
  const marginAccount = marginAccountAddress(config);
  const [vault, baseHeld, quoteHeld, scan] = await Promise.all([
    readVault(config.client, view.vault.vault, config.from),
    readMarginBalance(config.client, marginAccount, config.from, view.base.address),
    readMarginBalance(config.client, marginAccount, config.from, view.quote.address),
    scanRestingOrders(config.client, market, config.from, window),
  ]);
  const preview = await previewVaultDeposit(
    config.client,
    view.vault.vault,
    10n ** BigInt(view.base.decimals),
    10n ** BigInt(view.quote.decimals),
  );

  const spread =
    view.bestBidWire > 0n && view.bestAskWire > 0n
      ? `${gapBps(view.bestAskWire - view.bestBidWire, view.bestBidWire)} bps`
      : 'n/a (book is not two-sided)';

  const lines = [
    heading(`kit status — ${view.symbol}  ${view.address}`),
    [
      `chain             ${config.mode} (${config.client.chain?.id})  block ${view.blockNumber}`,
      `operator          ${config.from}`,
      '',
      'PARAMS (getMarketParams, 11-tuple)',
      `  base            ${view.base.symbol}  ${view.base.address}  ${view.base.decimals} dp` +
        `${view.base.native ? '  (native MON)' : ''}`,
      `  quote           ${view.quote.symbol}  ${view.quote.address}  ${view.quote.decimals} dp` +
        `${view.quote.native ? '  (native MON)' : ''}`,
      `  pricePrecision  ${view.params.pricePrecision}`,
      `  sizePrecision   ${view.params.sizePrecision}`,
      `  tickSize        ${view.params.tickSize}  (${formatPrice(view.params.tickSize, view.params)})`,
      `  minSize         ${view.params.minSize}  (${formatSize(view.params.minSize, view.params)} ${view.base.symbol})`,
      `  maxSize         ${view.params.maxSize}  (${formatSize(view.params.maxSize, view.params)} ${view.base.symbol})`,
      `  fees            taker ${view.params.takerFeeBps} bps / maker ${view.params.makerFeeBps} bps`,
      '',
      'BOOK (bestBidAsk, the ground truth — never the SDK asks array)',
      `  best bid        ${view.bestBidWire === 0n ? '— none —' : formatWire(view.bestBidWire)}`,
      `  best ask        ${view.bestAskWire === 0n ? '— none —' : formatWire(view.bestAskWire)}`,
      `  spread          ${spread}`,
      '',
      'VAULT (KuruAMMVault — dual asset, not ERC-4626)',
      `  address         ${vault.address}`,
      `  totalSupply     ${vault.totalSupply} shares`,
      `  TVL base        ${formatBase(vault.reserve1, view.params)} ${view.base.symbol}`,
      `  TVL quote       ${formatQuote(vault.reserve2, view.params)} ${view.quote.symbol}`,
      `  spread const    ${vault.spreadConstant}`,
      `  your shares     ${vault.shares}`,
      `  previewDeposit  ${'shares' in preview ? `${preview.shares} shares for 1 base + 1 quote` : `REVERTS — ${preview.revert}`}`,
      `  vault bid/ask   ${formatWire(view.vault.vaultBestBid)} / ${formatWire(view.vault.vaultBestAsk)}`,
      `  vault sizes     bid ${view.vault.vaultBidOrderSize} / ask ${view.vault.vaultAskOrderSize}`,
      '',
      'YOUR MARGIN BALANCES',
      `  ${view.base.symbol.padEnd(8)}        ${formatBase(baseHeld, view.params)}`,
      `  ${view.quote.symbol.padEnd(8)}        ${formatQuote(quoteHeld, view.params)}`,
    ].join('\n'),
    heading(
      `YOUR RESTING ORDERS — ${scan.orders.length} found in order ids ${scan.fromId}..${scan.toId}`,
    ),
    scan.orders.length === 0
      ? `  none. Scanned the last ${window} of ${scan.counter} order ids; widen with --scan N.\n` +
        '  This is a bounded scan because the public RPC caps eth_getLogs at 100 blocks and\n' +
        '  the Envio indexer (spec §9) is Phase 3.'
      : renderOrderTable(scan.orders, view),
  ];

  const text = lines.join('\n');
  console.log(text);

  const out = flagString(args, 'out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${text}\n`, 'utf8');
    console.log(`\nwritten to ${out}`);
  }
  return 0;
}

function renderOrderTable(
  orders: readonly RestingOrder[],
  view: Awaited<ReturnType<typeof readMarket>>,
): string {
  const columns: TableColumn<RestingOrder>[] = [
    { header: 'orderId', align: 'right', value: (o) => o.orderId.toString() },
    { header: 'side', align: 'left', value: (o) => (o.isBuy ? 'buy' : 'sell') },
    { header: 'kind', align: 'left', value: (o) => (o.isFlip ? 'flip' : 'plain') },
    { header: 'price', align: 'right', value: (o) => formatPrice(o.price, view.params) },
    {
      header: 'flip',
      align: 'right',
      value: (o) => (o.isFlip ? formatPrice(o.flippedPrice, view.params) : '—'),
    },
    { header: 'size', align: 'right', value: (o) => formatSize(o.size, view.params) },
    { header: 'flippedId', align: 'right', value: (o) => o.flippedId.toString() },
  ];
  return renderTable(
    [...orders].sort((a, b) => Number(b.orderId - a.orderId)),
    columns,
  );
}
