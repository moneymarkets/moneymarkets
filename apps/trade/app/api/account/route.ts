import { NextResponse } from 'next/server';
import { getAddress, isAddress, erc20Abi, zeroAddress, type Address } from 'viem';
import { marginAccountAbi } from '@tradepro/core';
import { addresses, readClient } from '../../../lib/server/chain';

/**
 * The user's trading balance.
 *
 * "Available to trade" is the AUSD sitting in Kuru's MarginAccount, not a wallet
 * balance — that is what an order can actually spend (spec §4.2). The wallet balance
 * is returned alongside so `/fund` can tell the two apart later.
 *
 * `?token=` asks for a different asset in the same margin account — the trade screen
 * uses it for the market's base asset, so a sell shows what it can actually sell
 * rather than an AUSD figure that has nothing to do with it. Native MON is
 * `0x0000…0000` in MarginAccount, which has no `balanceOf`, so the wallet figure is
 * the account's MON balance in that case.
 *
 * Read-only, and it takes the address as a query parameter: there is no session on
 * the server, and there is nothing here worth authenticating because every one of
 * these values is public on chain.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const owner = url.searchParams.get('address') ?? '';
  if (!isAddress(owner)) {
    return NextResponse.json({ error: 'NOT_AN_ADDRESS' }, { status: 400 });
  }

  const chain = addresses();
  const marginAccount = chain.kuru.marginAccount as Address | undefined;
  const requested = url.searchParams.get('token');
  const token: Address =
    requested && isAddress(requested)
      ? getAddress(requested)
      : (chain.tokens.AUSD.address as Address);

  if (!marginAccount) {
    // Testnet has no Kuru deployment worth reading (DECISIONS.md open item 7).
    return NextResponse.json({ error: 'NO_MARGIN_ACCOUNT_ON_THIS_CHAIN' }, { status: 503 });
  }

  const account = getAddress(owner);
  const known = Object.values(chain.tokens).find(
    (t) => (t.address as string).toLowerCase() === token.toLowerCase(),
  );

  try {
    const [margin, wallet, blockNumber] = await Promise.all([
      readClient().readContract({
        address: marginAccount,
        abi: marginAccountAbi,
        functionName: 'getBalance',
        args: [account, token],
      }) as Promise<bigint>,
      token === zeroAddress
        ? readClient().getBalance({ address: account })
        : (readClient()
            .readContract({
              address: token,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [account],
            })
            // Never `0n`: an unread balance is not an empty one, and `:87` in this same
            // file already says so for the other read. R1 — no claim without evidence.
            .catch(() => null) as Promise<bigint | null>),
      readClient().getBlockNumber(),
    ]);

    // Everything the account holds in its own wallet, not just the one token the
    // caller asked about.
    //
    // This exists because the app showed "0.00" on Home while 1.002926 USDC sat in the
    // user's wallet: the hero reads the AUSD margin balance, correctly, and nothing
    // read anything else — so money the user demonstrably owned was invisible in the
    // app that had just helped them acquire it. A balance the user holds is never
    // allowed to be absent from the screen; if it cannot be spent yet, that is a label,
    // not a reason to hide it.
    const holdable = [chain.tokens.AUSD, chain.tokens.USDC].filter(Boolean);
    const walletHoldings = await Promise.all(
      holdable.map(async (t) => {
        const address = t.address as Address;
        const balance = (await readClient()
          .readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [account] })
          .catch(() => null)) as bigint | null;
        return {
          address,
          symbol: t.symbol,
          decimals: t.decimals,
          // `null` is "we could not read it", which is not the same as zero and must
          // not be rendered as zero.
          balance: balance === null ? null : balance.toString(),
        };
      }),
    );

    return NextResponse.json(
      {
        address: account,
        token: {
          address: token,
          symbol: known?.symbol ?? 'token',
          decimals: known?.decimals ?? 18,
        },
        marginBalance: margin.toString(),
        // `null` where the read failed, so the client can say "unavailable" rather than
        // draw a zero balance the chain never reported.
        walletBalance: wallet === null ? null : wallet.toString(),
        wallet: walletHoldings,
        // The deposit tracker's step-5 evidence wants "the margin read with block
        // numbers before and after" — this is the "after" half of that pair.
        blockNumber: blockNumber.toString(),
        readAt: Date.now(),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('balance read failed', account, error);
    return NextResponse.json(
      {
        error: 'BALANCE_READ_FAILED',
        upstream: { message: error instanceof Error ? error.message : String(error), source: 'Monad RPC' },
      },
      { status: 502 },
    );
  }
}
