/**
 * SeasonPrizePool ABI.
 *
 * GENERATED from the Foundry artifact — do not hand-edit.
 * See apps/web/scripts/gen-abi.ts
 */
export const seasonPoolAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "operator_",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allocationOf",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "player",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "claim",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimable",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "player",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "createSeason",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "finalize",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "fund",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getSeason",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct SeasonPrizePool.Season",
        components: [
          {
            name: "state",
            type: "uint8",
            internalType: "enum SeasonPrizePool.SeasonState",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "funded",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "allocated",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "claimed",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "createdAtSec",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "finalizedAtSec",
            type: "uint64",
            internalType: "uint64",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "hasClaimed",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "player",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "operator",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "outstanding",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "setAllocations",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "players",
        type: "address[]",
        internalType: "address[]",
      },
      {
        name: "amounts",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setOperator",
    inputs: [
      {
        name: "next",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdrawSurplus",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "AllocationSet",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "player",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OperatorUpdated",
    inputs: [
      {
        name: "previous",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "next",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PrizeClaimed",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "player",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SeasonCreated",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "token",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SeasonFinalized",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "allocated",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "funded",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SeasonFunded",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "from",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SurplusWithdrawn",
    inputs: [
      {
        name: "seasonId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AllocationsExceedFunding",
    inputs: [
      {
        name: "allocated",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "funded",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "AlreadyClaimed",
    inputs: [],
  },
  {
    type: "error",
    name: "ArrayLengthMismatch",
    inputs: [],
  },
  {
    type: "error",
    name: "InsufficientSurplus",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOperator",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOwner",
    inputs: [],
  },
  {
    type: "error",
    name: "NothingAllocated",
    inputs: [],
  },
  {
    type: "error",
    name: "ReentrancyGuardReentrantCall",
    inputs: [],
  },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "SeasonExists",
    inputs: [],
  },
  {
    type: "error",
    name: "SeasonNotFinalized",
    inputs: [],
  },
  {
    type: "error",
    name: "SeasonNotOpen",
    inputs: [],
  },
  {
    type: "error",
    name: "SeasonUnknown",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroAddress",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroAmount",
    inputs: [],
  },
] as const
