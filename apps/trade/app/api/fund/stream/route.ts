import { depositDb } from '../../../../lib/server/deposits/db';
import { onDepositTransition, type DepositTransition } from '../../../../lib/server/deposits/bus';

/**
 * Server-sent events for one deposit address, or `?all=1` for every address the
 * watcher has ever touched — what `RecentDeposits` and the funding-screen footer
 * subscribe to for the "no manual refresh" requirement.
 *
 * `GET /api/fund/status` (unchanged, still polled as a fallback) answers "where is
 * it right now"; this answers "tell me the moment that changes". The first message
 * sent is always the attempt's current row from `deposit_attempts`, so a client that
 * connects after the transition it cares about is not left blind until the next one.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const depositAddress = url.searchParams.get('depositAddress')?.trim();
  /**
   * `?all=1` is gone.
   *
   * It subscribed an anonymous caller to every transition on the server and pushed the
   * whole `deposit_attempts` row each time — recipient, deposit address, amounts, refund
   * address, transaction hashes. A live feed correlating accounts to amounts to chains,
   * for the entire user base, from one unauthenticated GET.
   *
   * `/api/rails-status` goes to deliberate lengths to publish counts and never an
   * address; this handed out exactly what that withholds. `RecentDeposits` used it to
   * refresh without naming addresses, and now re-reads `/api/fund/recent` for its own
   * account instead — one poll per client rather than one firehose for everyone.
   */
  if (!depositAddress || depositAddress.length > 128) {
    return new Response(JSON.stringify({ error: 'BAD_REQUEST' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(sseLine(event, data)));
        } catch {
          // The connection is already gone; unsubscribe on `request.signal` below
          // handles cleanup, this just avoids throwing into an emitter callback.
        }
      };

      const current = depositDb().attempt(depositAddress);
      if (current) send('snapshot', current);

      const handler = (transition: DepositTransition) => {
        send('transition', transition);
        // A fresh snapshot on every transition, not only terminal ones — security
        // review finding M3: `DESTINATION_DETECTED` and `SOURCE_LANDED` both carry
        // `terminal: false`, and the open card only ever redraws from a `snapshot`
        // event, never a bare `transition`. Sending one only on terminal transitions
        // meant the exact case this rebuild targets — a vendor stuck on PROCESSING
        // while this app's own chain read already proved delivery — never reached an
        // already-open card until it was reloaded.
        const row = depositDb().attempt(transition.depositAddress);
        if (row) send('snapshot', row);
      };
      unsubscribe = onDepositTransition(depositAddress, handler);

      // A comment line every 20s keeps the connection alive through proxies that
      // time out an idle stream, without being mistaken for a real event.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          /* connection already closed */
        }
      }, 20_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  request.signal.addEventListener('abort', () => {
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
