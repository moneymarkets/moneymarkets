import { encodeFunctionData, pad, parseAbi, type Address, type Hex, type PublicClient } from 'viem';

/**
 * AUSD across chains, over LayerZero's OFT standard.
 *
 * ## Endpoint IDs (open item 3, closed)
 *
 * Read from `@layerzerolabs/lz-definitions@3.1.10`, `dist/index.d.ts`:
 *   MainnetV2EndpointId.MONAD_V2_MAINNET   = 30390
 *   TestnetV2EndpointId.MONAD_V2_TESTNET   = 40204
 *   ETHEREUM 30101 · BSC 30102 · AVALANCHE 30106 · POLYGON 30109 ·
 *   ARBITRUM 30110 · OPTIMISM 30111 · SOLANA 30168 · KATANA 30375 · BASE 30184
 *
 * Note that Monad's LayerZero endpoint id (30390) has nothing to do with its EVM
 * chain id (143). Using one where the other belongs sends funds to a different
 * chain, which is why they are named apart here.
 */

export const LZ_EID = {
  MONAD_MAINNET: 30390,
  MONAD_TESTNET: 40204,
  ETHEREUM: 30101,
  BSC: 30102,
  AVALANCHE: 30106,
  POLYGON: 30109,
  ARBITRUM: 30110,
  OPTIMISM: 30111,
  BASE: 30184,
  SOLANA: 30168,
  KATANA: 30375,
} as const;

export const oftAbi = parseAbi([
  'struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }',
  'struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }',
  'struct MessagingReceipt { bytes32 guid; uint64 nonce; MessagingFee fee; }',
  'struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }',
  'function quoteSend(SendParam sendParam, bool payInLzToken) view returns (MessagingFee)',
  'function token() view returns (address)',
  'function approvalRequired() view returns (bool)',
  'function sharedDecimals() view returns (uint8)',
  'function send(SendParam sendParam, MessagingFee fee, address refundAddress) payable returns (MessagingReceipt, OFTReceipt)',
]);

export interface SendParam {
  readonly dstEid: number;
  readonly to: Hex;
  readonly amountLD: bigint;
  readonly minAmountLD: bigint;
  readonly extraOptions: Hex;
  readonly composeMsg: Hex;
  readonly oftCmd: Hex;
}

export interface MessagingFee {
  readonly nativeFee: bigint;
  readonly lzTokenFee: bigint;
}

/** OFT addresses are `bytes32`, left-padded. A raw 20-byte address is rejected by the endpoint. */
export function addressToBytes32(address: Address): Hex {
  return pad(address, { size: 32 });
}

export interface BuildSendParamInput {
  readonly dstEid: number;
  readonly recipient: Address;
  readonly amount: bigint;
  /** Slippage floor in the same units as `amount`. Defaults to no slippage. */
  readonly minAmount?: bigint;
  readonly extraOptions?: Hex;
}

export function buildSendParam(input: BuildSendParamInput): SendParam {
  if (input.amount <= 0n) throw new Error('OFT amount must be positive');
  const minAmountLD = input.minAmount ?? input.amount;
  if (minAmountLD > input.amount) {
    throw new Error('OFT minAmountLD cannot exceed amountLD');
  }
  if (!Number.isInteger(input.dstEid) || input.dstEid <= 0) {
    throw new Error(`OFT dstEid ${input.dstEid} is not a LayerZero endpoint id`);
  }
  if (input.dstEid === 143 || input.dstEid === 10143) {
    throw new Error(
      `dstEid ${input.dstEid} is Monad's EVM chain id, not its LayerZero endpoint id ` +
        `(mainnet ${LZ_EID.MONAD_MAINNET}, testnet ${LZ_EID.MONAD_TESTNET})`,
    );
  }
  return {
    dstEid: input.dstEid,
    to: addressToBytes32(input.recipient),
    amountLD: input.amount,
    minAmountLD,
    extraOptions: input.extraOptions ?? '0x',
    composeMsg: '0x',
    oftCmd: '0x',
  };
}

export async function quoteSend(
  client: PublicClient,
  adapter: Address,
  sendParam: SendParam,
): Promise<MessagingFee> {
  const fee = (await client.readContract({
    address: adapter,
    abi: oftAbi,
    functionName: 'quoteSend',
    args: [sendParam, false],
  })) as MessagingFee;
  return { nativeFee: fee.nativeFee, lzTokenFee: fee.lzTokenFee };
}

export function encodeSend(sendParam: SendParam, fee: MessagingFee, refundAddress: Address): Hex {
  return encodeFunctionData({
    abi: oftAbi,
    functionName: 'send',
    args: [sendParam, fee, refundAddress],
  });
}

/**
 * What the adapter itself says about how a send has to be made.
 *
 * `approvalRequired()` is the load-bearing one. A `false` means the adapter *is* the
 * token — `send()` burns from the caller directly — so there is no ERC-20 approve
 * step and a UI that draws one is inventing work. It is read rather than remembered
 * because it is a property of the deployed contract, and the contract can be
 * replaced.
 *
 * Measured on Base mainnet at block 50812266, 2026-09-03, against
 * `0x9CaB7Ede13dc56652E44D2404E969C212f22689b`:
 *   token()             0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a  (AUSD, 6dp)
 *   approvalRequired()  false
 *   sharedDecimals()    6
 *   quoteSend(dstEid 30390, 1 / 5 / 25 AUSD).nativeFee
 *                       100701869744601 wei, identical at all three sizes
 */
export interface OftConfig {
  readonly adapter: Address;
  readonly token: Address;
  readonly approvalRequired: boolean;
  readonly sharedDecimals: number;
}

export async function readOftConfig(client: PublicClient, adapter: Address): Promise<OftConfig> {
  const [token, approvalRequired, sharedDecimals] = await Promise.all([
    client.readContract({ address: adapter, abi: oftAbi, functionName: 'token' }),
    client.readContract({ address: adapter, abi: oftAbi, functionName: 'approvalRequired' }),
    client.readContract({ address: adapter, abi: oftAbi, functionName: 'sharedDecimals' }),
  ]);
  return {
    adapter,
    token: token as Address,
    approvalRequired: approvalRequired as boolean,
    sharedDecimals: Number(sharedDecimals),
  };
}

/**
 * The LayerZero fee is quoted in the **source** chain's native asset — ETH on Base,
 * not MON and not AUSD. Nothing this app sponsors covers it: the Base-side `send()`
 * is the user's own transaction from their own wallet, which is exactly why that leg
 * is a documented manual step rather than something the relayer touches.
 */
export const OFT_FEE_ASSET = { symbol: 'ETH', decimals: 18, chain: 'Base' } as const;
