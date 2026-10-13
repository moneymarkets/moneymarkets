// KuruUtils ABI.
// Copied verbatim from @kuru-labs/kuru-sdk@0.0.95 (abi/KuruUtils.json).
// See ./SOURCE.md. The SDK itself is never imported at runtime (spec 4.2).
// Do not hand-edit: regenerate from the package if it needs to change.
export const kuruUtilsAbi = [
  {
    inputs: [
      {
        internalType: 'address[]',
        name: 'route',
        type: 'address[]',
      },
      {
        internalType: 'bool[]',
        name: 'isBuy',
        type: 'bool[]',
      },
    ],
    name: 'calculatePriceOverRoute',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address[]',
        name: 'tokens',
        type: 'address[]',
      },
      {
        internalType: 'address',
        name: 'holder',
        type: 'address',
      },
    ],
    name: 'getTokensInfo',
    outputs: [
      {
        components: [
          {
            internalType: 'string',
            name: 'name',
            type: 'string',
          },
          {
            internalType: 'string',
            name: 'symbol',
            type: 'string',
          },
          {
            internalType: 'uint256',
            name: 'balance',
            type: 'uint256',
          },
          {
            internalType: 'uint8',
            name: 'decimals',
            type: 'uint8',
          },
          {
            internalType: 'uint256',
            name: 'totalSupply',
            type: 'uint256',
          },
        ],
        internalType: 'struct KuruUtils.TokenInfo[]',
        name: '',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;
