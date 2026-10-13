#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';
import { parseArgs, ArgError } from './args.js';

/**
 * The environment lives at the repo root, and the kit is usually run from inside its
 * own package (`pnpm --filter @tradepro/market-kit kit …`), where `dotenv/config`
 * finds nothing. A kit that silently falls back to the testnet defaults reads an
 * address that has no code there and reports "bestBidAsk returned no data", which
 * looks like a broken market rather than a missing CHAIN. So both files are loaded,
 * nearest first, and neither overrides a variable already in the environment.
 */
loadDotenv({ path: new URL('../.env', import.meta.url) });
loadDotenv({ path: new URL('../../../.env', import.meta.url) });
import { deployCommand } from './commands/deploy.js';
import { seedCommand } from './commands/seed.js';
import { statusCommand } from './commands/status.js';
import { swapCommand } from './commands/swap.js';
import { teardownCommand } from './commands/teardown.js';
import { vaultCommand } from './commands/vault.js';
import { ConfigError } from './config.js';
import { LadderError } from './ladder.js';
import { DryRunStop } from './send.js';

export const USAGE = `
kit — Kuru market tooling (spec §8). Reads the chain; never guesses.

  kit deploy   --base <addr> --quote <addr> --min-size <human> --max-size <human>
               [--preset-from <market>] [--price-precision 1e8] [--size-precision 1e10]
               [--tick 100] [--taker-fee-bps 0] [--maker-fee-bps 0] [--amm-spread 30]
               [--symbol NAME] [--markets-dir DIR]

  kit seed     --market <addr> --fee-bps <n> --size-per-level <quote amount>
               [--band 0.98..1.02] [--levels 6] [--side buy|sell|both] [--ref <price>]
               [--no-deposit] [--dry-run]

  kit vault    --market <addr> --deposit-base <amt> --deposit-quote <amt>
               [--min-quote-consumed <amt>] [--receiver <addr>]

  kit status   --market <addr> [--scan 2000]

  kit teardown --market <addr> [--order-ids 1,2,3] [--scan 2000] [--batch-size 50]
               [--no-withdraw]

  kit swap     --token-in <addr> --token-out <addr> --amount <human>
               [--slippage <pct>] [--referrer <addr>] [--referrer-bps <n>]

Common flags: --from <operator address>  --chain mainnet|testnet  --rpc <url>
              --simulate (eth_call every planned call)  --out <file>  --dry-run

Notes
  --levels is per side, so --levels 6 --side both builds 12 orders.
  --fee-bps is the flip spread in BASIS POINTS; the kit multiplies by 100 because
    Kuru's minFeesPps is parts-per-million. --fee-bps 30 -> 3000 pps -> 0.30%.
  The ladder is anchored on bestBidAsk() read from the chain. --ref is required, and
    only used, when the book has no two-sided price to anchor to; --ref-source is
    then required too, so the dry run records where that price came from.
  kit swap buys a market's base asset through Kuru Flow. That router is not
    ERC-2771 aware, so the swap is never relayed: the operator signs and pays gas.
  MODE=dryrun is the default. Submitting needs CHAIN=mainnet, MODE=live and
    I_UNDERSTAND_THIS_USES_REAL_FUNDS=true, none of which this repo sets.
`.trim();

const COMMANDS: Record<string, (args: ReturnType<typeof parseArgs>) => Promise<number>> = {
  deploy: deployCommand,
  seed: seedCommand,
  vault: vaultCommand,
  status: statusCommand,
  teardown: teardownCommand,
  swap: swapCommand,
};

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    return 0;
  }
  const args = parseArgs(argv);
  const command = COMMANDS[args.command];
  if (!command) {
    console.error(`unknown command "${args.command}".\n\n${USAGE}`);
    return 2;
  }
  return command(args);
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isEntrypoint || process.env.KIT_FORCE_MAIN === 'true') {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (
        error instanceof ArgError ||
        error instanceof ConfigError ||
        error instanceof LadderError ||
        error instanceof DryRunStop
      ) {
        console.error(`\n${error.name}: ${error.message}`);
        process.exitCode = 2;
        return;
      }
      console.error(error);
      process.exitCode = 1;
    });
}
