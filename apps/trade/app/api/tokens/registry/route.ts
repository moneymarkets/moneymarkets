import { NextResponse } from 'next/server';
import { z } from 'zod';
import { tokenRegistry } from '../../../../lib/server/tokens/tokenRegistryLive';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const entrySchema = z.object({
  address: z.string(),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int(),
  logoUrl: z.string().optional(),
  sources: z.array(z.enum(['kuru-market', 'kuru-flow', 'base'])),
  verified: z.boolean(),
});

const responseSchema = z.object({
  tokens: z.array(entrySchema),
  logoHosts: z.array(z.string()),
  asOf: z.number(),
});

export type TokenRegistryResponse = z.infer<typeof responseSchema>;

/** The token registry (spec A1): every token this app knows, contract-verified, cached ten minutes. */
export async function GET() {
  try {
    const snapshot = await tokenRegistry();
    const body = responseSchema.parse({
      tokens: snapshot.tokens,
      logoHosts: snapshot.logoHosts,
      asOf: snapshot.asOf,
    });
    return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('token registry build failed', error);
    return NextResponse.json(
      { error: 'REGISTRY_UNAVAILABLE', upstream: { message: error instanceof Error ? error.message : String(error) } },
      { status: 502 },
    );
  }
}
