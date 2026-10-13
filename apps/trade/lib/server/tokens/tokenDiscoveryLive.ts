import { parseAbiItem, type Address } from 'viem';
import { readClient } from '../chain';
import { tokenDb } from './tokenDb';
import { scanTick, type ScanPage, type ScanTickResult, type TransferLogReader } from './tokenDiscovery';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/**
 * One page of `Transfer(*, account, *)` across every contract: a topic-only filter,
 * no `address`, which is what makes an airdrop from a contract no list has ever named
 * visible. Distinct emitting contracts are the discovered tokens.
 */
export const readTransferLogsLive: TransferLogReader = async (account: Address, page: ScanPage) => {
  const logs = await readClient().getLogs({
    event: TRANSFER,
    args: { to: account },
    fromBlock: page.fromBlock,
    toBlock: page.toBlock,
  });
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const log of logs) {
    const key = log.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(log.address);
  }
  return out;
};

/** One bounded tick of discovery for `account`, against the live chain head. */
export async function runDiscoveryTick(account: Address): Promise<ScanTickResult> {
  const head = await readClient().getBlockNumber();
  return scanTick({ account, head, db: tokenDb(), readLogs: readTransferLogsLive });
}
