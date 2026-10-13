import { NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { addresses } from '../../../../lib/server/chain';
import { awaitFlowUsdPerWhole } from '../../../../lib/server/tokens/flowPrice';
import { tokenDb } from '../../../../lib/server/tokens/tokenDb';
import { readContractMetaLive, registryEntry, tokenRegistry } from '../../../../lib/server/tokens/tokenRegistryLive';
import { USD_DECIMALS } from '../../../../lib/server/walletTokens';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The lazy per-row price (spec A4): a Kuru Flow quote of one whole unit to USDC, by
 * address, whether or not any list names the token, cached 30 seconds. Asked only when
 * a row without an on-chain book price is on screen. Answers `priceSource: 'none'`
 * honestly when Flow cannot route the token; the row shows its quantity and "No price".
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenRaw = url.searchParams.get('address') ?? '';
  const accountRaw = url.searchParams.get('account') ?? '';
  if (!isAddress(tokenRaw) || !isAddress(accountRaw)) {
    return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  }
  const token = getAddress(tokenRaw);
  const account = getAddress(accountRaw);
  const chain = addresses();
  const usdc = chain.tokens.USDC.address;
  try {
    const registry = await tokenRegistry();
    let decimals = registryEntry(registry, token)?.decimals;
    if (decimals === undefined) {
      const stored = tokenDb().getMeta([token]).get(token.toLowerCase());
      decimals = stored?.decimals;
    }
    if (decimals === undefined) {
      const meta = (await readContractMetaLive([token])).get(token.toLowerCase());
      if (!meta) return NextResponse.json({ error: 'NOT_ERC20' }, { status: 422 });
      tokenDb().putMeta([{ address: token, ...meta }]);
      decimals = meta.decimals;
    }
    const usdPerWhole = await awaitFlowUsdPerWhole(token, decimals, account, usdc);
    return NextResponse.json(
      {
        address: token,
        decimals,
        priceSource: usdPerWhole === undefined ? 'none' : 'flow-quote',
        price: usdPerWhole === undefined ? null : { value: usdPerWhole.toString(), decimals: USD_DECIMALS },
        asOf: Date.now(),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('token price read failed', token, error);
    return NextResponse.json(
      { error: 'PRICE_READ_FAILED', upstream: { message: error instanceof Error ? error.message : String(error) } },
      { status: 502 },
    );
  }
}
