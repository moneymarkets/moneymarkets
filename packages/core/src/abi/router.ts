// Router ABI.
// Copied verbatim from @kuru-labs/kuru-sdk@0.0.95 (abi/Router.json).
// See ./SOURCE.md. The SDK itself is never imported at runtime (spec 4.2).
// Do not hand-edit: regenerate from the package if it needs to change.
export const routerAbi = [
  {
    inputs: [],
    stateMutability: 'nonpayable',
    type: 'constructor',
  },
  {
    inputs: [],
    name: 'AlreadyInitialized',
    type: 'error',
  },
  {
    inputs: [],
    name: 'BaseAndQuoteAssetSame',
    type: 'error',
  },
  {
    inputs: [],
    name: 'Create2EmptyBytecode',
    type: 'error',
  },
  {
    inputs: [],
    name: 'FailedDeployment',
    type: 'error',
  },
  {
    inputs: [],
    name: 'ImplementationNotChanged',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'balance',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'needed',
        type: 'uint256',
      },
    ],
    name: 'InsufficientBalance',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidInitialization',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidMarket',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidPricePrecision',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidSizePrecision',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidTickSize',
    type: 'error',
  },
  {
    inputs: [],
    name: 'LengthMismatch',
    type: 'error',
  },
  {
    inputs: [],
    name: 'MarketTypeMismatch',
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
    name: 'NoMarketsPassed',
    type: 'error',
  },
  {
    inputs: [],
    name: 'NotInitializing',
    type: 'error',
  },
  {
    inputs: [],
    name: 'SlippageExceeded',
    type: 'error',
  },
  {
    inputs: [],
    name: 'Uint96Overflow',
    type: 'error',
  },
  {
    inputs: [],
    name: 'Unauthorized',
    type: 'error',
  },
  {
    inputs: [],
    name: 'UnauthorizedCallContext',
    type: 'error',
  },
  {
    inputs: [],
    name: 'UpgradeFailed',
    type: 'error',
  },
  {
    inputs: [],
    name: 'ZeroAddressNotAllowed',
    type: 'error',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'uint64',
        name: 'version',
        type: 'uint64',
      },
    ],
    name: 'Initialized',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'address',
        name: 'msgSender',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'debitToken',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'creditToken',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'amountIn',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'amountOut',
        type: 'uint256',
      },
    ],
    name: 'KuruRouterSwap',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'address',
        name: 'baseAsset',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'quoteAsset',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'market',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'vaultAddress',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint32',
        name: 'pricePrecision',
        type: 'uint32',
      },
      {
        indexed: false,
        internalType: 'uint96',
        name: 'sizePrecision',
        type: 'uint96',
      },
      {
        indexed: false,
        internalType: 'uint32',
        name: 'tickSize',
        type: 'uint32',
      },
      {
        indexed: false,
        internalType: 'uint96',
        name: 'minSize',
        type: 'uint96',
      },
      {
        indexed: false,
        internalType: 'uint96',
        name: 'maxSize',
        type: 'uint96',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'takerFeeBps',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'makerFeeBps',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint96',
        name: 'kuruAmmSpread',
        type: 'uint96',
      },
    ],
    name: 'MarketRegistered',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'address',
        name: 'previousImplementation',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'newImplementation',
        type: 'address',
      },
    ],
    name: 'OBImplementationUpdated',
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
        name: 'implementation',
        type: 'address',
      },
    ],
    name: 'Upgraded',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'address',
        name: 'previousImplementation',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'newImplementation',
        type: 'address',
      },
    ],
    name: 'VaultImplementationUpdated',
    type: 'event',
  },
  {
    inputs: [],
    name: 'TRUSTED_FORWARDER',
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
    inputs: [
      {
        internalType: 'address[]',
        name: '_marketAddresses',
        type: 'address[]',
      },
      {
        internalType: 'bool[]',
        name: '_isBuy',
        type: 'bool[]',
      },
      {
        internalType: 'bool[]',
        name: '_nativeSend',
        type: 'bool[]',
      },
      {
        internalType: 'address',
        name: '_debitToken',
        type: 'address',
      },
      {
        internalType: 'address',
        name: '_creditToken',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: '_amount',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: '_minAmountOut',
        type: 'uint256',
      },
    ],
    name: 'anyToAnySwap',
    outputs: [
      {
        internalType: 'uint256',
        name: '_amountOut',
        type: 'uint256',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
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
        internalType: 'address',
        name: '_baseAssetAddress',
        type: 'address',
      },
      {
        internalType: 'address',
        name: '_quoteAssetAddress',
        type: 'address',
      },
      {
        internalType: 'uint96',
        name: '_sizePrecision',
        type: 'uint96',
      },
      {
        internalType: 'uint32',
        name: '_pricePrecision',
        type: 'uint32',
      },
      {
        internalType: 'uint32',
        name: '_tickSize',
        type: 'uint32',
      },
      {
        internalType: 'uint96',
        name: '_minSize',
        type: 'uint96',
      },
      {
        internalType: 'uint96',
        name: '_maxSize',
        type: 'uint96',
      },
      {
        internalType: 'uint256',
        name: '_takerFeeBps',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: '_makerFeeBps',
        type: 'uint256',
      },
      {
        internalType: 'uint96',
        name: '_kuruAmmSpread',
        type: 'uint96',
      },
      {
        internalType: 'address',
        name: 'oldImplementation',
        type: 'address',
      },
      {
        internalType: 'bool',
        name: 'old',
        type: 'bool',
      },
    ],
    name: 'computeAddress',
    outputs: [
      {
        internalType: 'address',
        name: 'proxy',
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
        name: '_marketAddress',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'oldImplementation',
        type: 'address',
      },
      {
        internalType: 'bool',
        name: 'old',
        type: 'bool',
      },
    ],
    name: 'computeVaultAddress',
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
    inputs: [
      {
        internalType: 'enum IOrderBook.OrderBookType',
        name: '_type',
        type: 'uint8',
      },
      {
        internalType: 'address',
        name: '_baseAssetAddress',
        type: 'address',
      },
      {
        internalType: 'address',
        name: '_quoteAssetAddress',
        type: 'address',
      },
      {
        internalType: 'uint96',
        name: '_sizePrecision',
        type: 'uint96',
      },
      {
        internalType: 'uint32',
        name: '_pricePrecision',
        type: 'uint32',
      },
      {
        internalType: 'uint32',
        name: '_tickSize',
        type: 'uint32',
      },
      {
        internalType: 'uint96',
        name: '_minSize',
        type: 'uint96',
      },
      {
        internalType: 'uint96',
        name: '_maxSize',
        type: 'uint96',
      },
      {
        internalType: 'uint256',
        name: '_takerFeeBps',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: '_makerFeeBps',
        type: 'uint256',
      },
      {
        internalType: 'uint96',
        name: '_kuruAmmSpread',
        type: 'uint96',
      },
    ],
    name: 'deployProxy',
    outputs: [
      {
        internalType: 'address',
        name: 'proxy',
        type: 'address',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
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
        name: '_orderbookImplementation',
        type: 'address',
      },
      {
        internalType: 'address',
        name: '_kuruAmmVaultImplementation',
        type: 'address',
      },
      {
        internalType: 'address',
        name: '_trustedForwarder',
        type: 'address',
      },
    ],
    name: 'initialize',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'kuruAmmVaultImplementation',
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
    name: 'marginAccountAddress',
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
    name: 'orderBookImplementation',
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
    name: 'proxiableUUID',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32',
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
        internalType: 'address[]',
        name: 'markets',
        type: 'address[]',
      },
      {
        internalType: 'enum IOrderBook.MarketState',
        name: 'state',
        type: 'uint8',
      },
    ],
    name: 'toggleMarkets',
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
  {
    inputs: [
      {
        internalType: 'address[]',
        name: 'contracts',
        type: 'address[]',
      },
      {
        internalType: 'address',
        name: '_newOwner',
        type: 'address',
      },
    ],
    name: 'transferOwnershipForContracts',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address[]',
        name: 'proxies',
        type: 'address[]',
      },
      {
        internalType: 'bytes[]',
        name: 'data',
        type: 'bytes[]',
      },
    ],
    name: 'upgradeMultipleOrderBookProxies',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address[]',
        name: 'proxies',
        type: 'address[]',
      },
      {
        internalType: 'bytes[]',
        name: 'data',
        type: 'bytes[]',
      },
    ],
    name: 'upgradeMultipleVaultProxies',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'newImplementation',
        type: 'address',
      },
    ],
    name: 'upgradeOrderBookImplementation',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'newImplementation',
        type: 'address',
      },
      {
        internalType: 'bytes',
        name: 'data',
        type: 'bytes',
      },
    ],
    name: 'upgradeToAndCall',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'newImplementation',
        type: 'address',
      },
    ],
    name: 'upgradeVaultImplementation',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address',
      },
    ],
    name: 'verifiedMarket',
    outputs: [
      {
        internalType: 'uint32',
        name: 'pricePrecision',
        type: 'uint32',
      },
      {
        internalType: 'uint96',
        name: 'sizePrecision',
        type: 'uint96',
      },
      {
        internalType: 'address',
        name: 'baseAssetAddress',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: 'baseAssetDecimals',
        type: 'uint256',
      },
      {
        internalType: 'address',
        name: 'quoteAssetAddress',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: 'quoteAssetDecimals',
        type: 'uint256',
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
    stateMutability: 'view',
    type: 'function',
  },
  {
    stateMutability: 'payable',
    type: 'receive',
  },
] as const;
