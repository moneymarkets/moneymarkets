import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem';

/**
 * KyberSwap's MetaAggregationRouterV2 on Monad, pinned (rule 1.9). Verified 2026-09-29 at
 * block 109,001,479 by chain-reader (DECISIONS.md, pinned-router entry):
 *
 *   - 13,724 bytes, runtime keccak256 0x73055c10f463ef7d44c444ccae0b71ab4cacaf67aedbad2cd8af639d53cc6316;
 *     not a proxy (ERC-1967/1822/OZ slots zero, no DELEGATECALL, no SELFDESTRUCT);
 *   - MonadScan exact-match verified `MetaAggregationRouterV2`, solc 0.8.17, metadata hash
 *     in the deployed code matches the verified source; constructor WETH = WMON;
 *   - every token pull is `safeTransferFrom(srcToken, msg.sender, ...)`, total capped at
 *     `desc.amount`, so an exact approve to this address is the right allowance target;
 *   - the swap reverts unless `dstToken.balanceOf(dstReceiver)` rises by at least
 *     `minReturnAmount` (and `minReturnAmount > 0`);
 *   - owner 0x1874028262f1f4b2dd1f2700a72ee8b9b7c69090 (an EOA) can only `rescueFunds`
 *     the router's own balance; nothing can spend another account's allowance.
 *
 * Not verified: the executor (`callTarget` / `srcReceivers`) each build names is chosen
 * by Kyber's API and its source is not on MonadScan. The router's own dstReceiver /
 * minReturnAmount check is what bounds it, and both are decoded and checked here and in
 * the relayer policy.
 */
export const KYBER_ROUTER: Address = getAddress('0x6131B5fae19EA4f9D964eAc0408E4408b66337b5');
export const KYBER_SWAP_SELECTOR: Hex = '0xe21fd0e9';

/** Kyber's native-token sentinel. This app never sends native value to an aggregator. */
export const KYBER_NATIVE_TOKEN: Address = getAddress('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');

/** `desc.flags` bit that makes the router demand `msg.value == amount` (verified source). */
const FLAG_REQUIRES_NATIVE_VALUE = 0x02n;

/** The `swap` entry, verbatim from the verified ABI. */
export const KYBER_SWAP_ABI = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'execution',
        type: 'tuple',
        internalType: 'struct IMetaAggregationRouterV2.SwapExecutionParams',
        components: [
          { name: 'callTarget', type: 'address', internalType: 'address' },
          { name: 'approveTarget', type: 'address', internalType: 'address' },
          { name: 'targetData', type: 'bytes', internalType: 'bytes' },
          {
            name: 'desc',
            type: 'tuple',
            internalType: 'struct IMetaAggregationRouterV2.SwapDescriptionV2',
            components: [
              { name: 'srcToken', type: 'address', internalType: 'contract IERC20' },
              { name: 'dstToken', type: 'address', internalType: 'contract IERC20' },
              { name: 'srcReceivers', type: 'address[]', internalType: 'address[]' },
              { name: 'srcAmounts', type: 'uint256[]', internalType: 'uint256[]' },
              { name: 'feeReceivers', type: 'address[]', internalType: 'address[]' },
              { name: 'feeAmounts', type: 'uint256[]', internalType: 'uint256[]' },
              { name: 'dstReceiver', type: 'address', internalType: 'address' },
              { name: 'amount', type: 'uint256', internalType: 'uint256' },
              { name: 'minReturnAmount', type: 'uint256', internalType: 'uint256' },
              { name: 'flags', type: 'uint256', internalType: 'uint256' },
              { name: 'permit', type: 'bytes', internalType: 'bytes' },
            ],
          },
          { name: 'clientData', type: 'bytes', internalType: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'returnAmount', type: 'uint256', internalType: 'uint256' },
      { name: 'gasUsed', type: 'uint256', internalType: 'uint256' },
    ],
  },
] as const;

export interface DecodedKyberSwap {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  /** `dstReceiver`, or the zero address meaning "the caller". */
  readonly recipient: Address;
  readonly minOut: bigint;
  readonly flags: bigint;
  readonly feeReceiverCount: number;
  readonly permitLength: number;
}

/**
 * Decode a KyberSwap router swap with the verified ABI, and refuse the shapes this app
 * never sponsors or signs: a native-token input, the native-value flag, a fee skim, or an
 * embedded permit. Throws on anything else malformed; a caller treats a throw as "not a
 * swap this app recognises".
 */
export function decodeKyberSwap(data: Hex): DecodedKyberSwap {
  if (data.slice(0, 10).toLowerCase() !== KYBER_SWAP_SELECTOR) {
    throw new Error(`not a KyberSwap swap call: ${data.slice(0, 10)}`);
  }
  const { args } = decodeFunctionData({ abi: KYBER_SWAP_ABI, data });
  const desc = args[0].desc;
  const tokenIn = getAddress(desc.srcToken);
  if (tokenIn === KYBER_NATIVE_TOKEN) throw new Error('a KyberSwap swap spending native MON is not accepted');
  if ((desc.flags & FLAG_REQUIRES_NATIVE_VALUE) !== 0n) {
    throw new Error('a KyberSwap swap flagged to take native value is not accepted');
  }
  if (desc.feeReceivers.length !== 0 || desc.feeAmounts.length !== 0) {
    throw new Error('a KyberSwap swap carrying a fee is not accepted');
  }
  if (desc.permit !== '0x') throw new Error('a KyberSwap swap carrying its own permit is not accepted');
  if (desc.amount === 0n || desc.minReturnAmount === 0n) {
    throw new Error('a KyberSwap swap must spend and return a positive amount');
  }
  return {
    tokenIn,
    tokenOut: getAddress(desc.dstToken),
    amountIn: desc.amount,
    recipient: getAddress(desc.dstReceiver),
    minOut: desc.minReturnAmount,
    flags: desc.flags,
    feeReceiverCount: desc.feeReceivers.length,
    permitLength: (desc.permit.length - 2) / 2,
  };
}
