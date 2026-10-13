// MonadDeployer ABI.
// Copied verbatim from @kuru-labs/kuru-sdk@0.0.95 (abi/MonadDeployer.json).
// See ./SOURCE.md. The SDK itself is never imported at runtime (spec 4.2).
// Do not hand-edit: regenerate from the package if it needs to change.
export const monadDeployerAbi = [
  {
    inputs: [
      {
        internalType: 'contract IRouter',
        name: '_router',
        type: 'address',
      },
      {
        internalType: 'address',
        name: '_owner',
        type: 'address',
      },
      {
        internalType: 'address',
        name: '_marginAccount',
        type: 'address',
      },
      {
        internalType: 'address',
        name: '_kuruCollective',
        type: 'address',
      },
      {
        internalType: 'uint96',
        name: '_kuruAmmSpread',
        type: 'uint96',
      },
      {
        internalType: 'uint256',
        name: '_kuruCollectiveFee',
        type: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'constructor',
  },
  {
    inputs: [],
    name: 'AlreadyInitialized',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'expected',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'received',
        type: 'uint256',
      },
    ],
    name: 'InsufficientAssets',
    type: 'error',
  },
  {
    inputs: [],
    name: 'NewOwnerIsZeroAddress',
    type: 'error',
  },
  {
    inputs: [],
    name: 'NoHandoverRequest',
    type: 'error',
  },
  {
    inputs: [],
    name: 'Unauthorized',
    type: 'error',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'pendingOwner',
        type: 'address',
      },
    ],
    name: 'OwnershipHandoverCanceled',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'pendingOwner',
        type: 'address',
      },
    ],
    name: 'OwnershipHandoverRequested',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'oldOwner',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'newOwner',
        type: 'address',
      },
    ],
    name: 'OwnershipTransferred',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'token',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'string',
        name: 'tokenURI',
        type: 'string',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'dev',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'supplyToDev',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'bytes',
        name: 'metadata',
        type: 'bytes',
      },
    ],
    name: 'PumpingTime',
    type: 'event',
  },
  {
    inputs: [],
    name: 'cancelOwnershipHandover',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'pendingOwner',
        type: 'address',
      },
    ],
    name: 'completeOwnershipHandover',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
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
            internalType: 'string',
            name: 'tokenURI',
            type: 'string',
          },
          {
            internalType: 'uint256',
            name: 'initialSupply',
            type: 'uint256',
          },
          {
            internalType: 'address',
            name: 'dev',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'supplyToDev',
            type: 'uint256',
          },
        ],
        internalType: 'struct MonadDeployer.TokenParams',
        name: 'tokenParams',
        type: 'tuple',
      },
      {
        components: [
          {
            internalType: 'uint256',
            name: 'nativeTokenAmount',
            type: 'uint256',
          },
          {
            internalType: 'uint96',
            name: 'sizePrecision',
            type: 'uint96',
          },
          {
            internalType: 'uint32',
            name: 'pricePrecision',
            type: 'uint32',
          },
          {
            internalType: 'uint32',
            name: 'tickSize',
            type: 'uint32',
          },
          {
            internalType: 'uint96',
            name: 'minSize',
            type: 'uint96',
          },
          {
            internalType: 'uint96',
            name: 'maxSize',
            type: 'uint96',
          },
          {
            internalType: 'uint256',
            name: 'takerFeeBps',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'makerFeeBps',
            type: 'uint256',
          },
        ],
        internalType: 'struct MonadDeployer.MarketParams',
        name: 'marketParams',
        type: 'tuple',
      },
      {
        internalType: 'bytes',
        name: 'metadata',
        type: 'bytes',
      },
    ],
    name: 'deployTokenAndMarket',
    outputs: [
      {
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'kuruAmmSpread',
    outputs: [
      {
        internalType: 'uint96',
        name: '',
        type: 'uint96',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'kuruCollective',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'kuruCollectiveFee',
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
    inputs: [],
    name: 'owner',
    outputs: [
      {
        internalType: 'address',
        name: 'result',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'pendingOwner',
        type: 'address',
      },
    ],
    name: 'ownershipHandoverExpiresAt',
    outputs: [
      {
        internalType: 'uint256',
        name: 'result',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'renounceOwnership',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'requestOwnershipHandover',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint96',
        name: '_kuruAmmSpread',
        type: 'uint96',
      },
    ],
    name: 'setKuruAmmSpread',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: '_kuruCollective',
        type: 'address',
      },
    ],
    name: 'setKuruCollective',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: '_kuruCollectiveFee',
        type: 'uint256',
      },
    ],
    name: 'setKuruCollectiveFee',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'newOwner',
        type: 'address',
      },
    ],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;
