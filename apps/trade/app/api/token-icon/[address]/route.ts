import { handleTokenIcon } from '../../../../lib/server/tokens/tokenIconRoute';
import { knownTokenSymbol, tokenIconLive } from '../../../../lib/server/tokens/tokenIconsLive';

export const dynamic = 'force-dynamic';

/** A token's icon from our own origin (Kuru, then KyberSwap, DexScreener, GeckoTerminal), 64 px. */
export async function GET(_request: Request, context: { params: Promise<{ address: string }> }) {
  const { address } = await context.params;
  return handleTokenIcon(address, { symbolOf: knownTokenSymbol, icon: tokenIconLive });
}
