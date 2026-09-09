/**
 * DreamSwipeDuel ABI.
 *
 * GENERATED from `apps/contracts-evm/out/DreamSwipeDuel.sol/DreamSwipeDuel.json`.
 * Do not hand-edit: recompile the contract and re-run the codegen instead, or
 * the app will encode calls against a signature the chain no longer has.
 *
 *   cd apps/contracts-evm && forge build
 *   bun run scripts/gen-abi.ts
 */
export const duelAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "keeper_",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "DUEL_TIMEOUT_SEC",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MAX_DECK_SIZE",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint8",
        internalType: "uint8",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MIN_DECK_SIZE",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint8",
        internalType: "uint8",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "REVEAL_TIMEOUT_SEC",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "admin",
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
    name: "cancelPending",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimDuelTimeout",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimRevealTimeout",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "computeDeckCommit",
    inputs: [
      {
        name: "marketIds",
        type: "bytes32[]",
        internalType: "bytes32[]",
      },
      {
        name: "strikes",
        type: "uint256[]",
        internalType: "uint256[]",
      },
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "createDuel",
    inputs: [
      {
        name: "deckCommit",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "deckSize",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "tier",
        type: "uint8",
        internalType: "enum DreamSwipeDuel.Tier",
      },
      {
        name: "stakeToken",
        type: "address",
        internalType: "address",
      },
      {
        name: "stake",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "eip712Domain",
    inputs: [],
    outputs: [
      {
        name: "fields",
        type: "bytes1",
        internalType: "bytes1",
      },
      {
        name: "name",
        type: "string",
        internalType: "string",
      },
      {
        name: "version",
        type: "string",
        internalType: "string",
      },
      {
        name: "chainId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "verifyingContract",
        type: "address",
        internalType: "address",
      },
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "extensions",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "finalize",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getDeck",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        internalType: "struct DreamSwipeDuel.Card[]",
        components: [
          {
            name: "marketId",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "strike",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getDuel",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct DreamSwipeDuel.Duel",
        components: [
          {
            name: "status",
            type: "uint8",
            internalType: "enum DreamSwipeDuel.Status",
          },
          {
            name: "tier",
            type: "uint8",
            internalType: "enum DreamSwipeDuel.Tier",
          },
          {
            name: "creator",
            type: "address",
            internalType: "address",
          },
          {
            name: "challenger",
            type: "address",
            internalType: "address",
          },
          {
            name: "stakeToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "stake",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "deckSize",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "settledCount",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "deckRevealed",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "deckCommit",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "createdAtSec",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "startedAtSec",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "p0Score",
            type: "int256",
            internalType: "int256",
          },
          {
            name: "p1Score",
            type: "int256",
            internalType: "int256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getSwipe",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "player",
        type: "address",
        internalType: "address",
      },
      {
        name: "cardIdx",
        type: "uint8",
        internalType: "uint8",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct DreamSwipeDuel.Swipe",
        components: [
          {
            name: "exists",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "direction",
            type: "uint8",
            internalType: "enum DreamSwipeDuel.Direction",
          },
          {
            name: "premium",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "filled",
            type: "uint128",
            internalType: "uint128",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isCardSettled",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "cardIdx",
        type: "uint8",
        internalType: "uint8",
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
    name: "joinDuel",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "keeper",
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
    name: "nonces",
    inputs: [
      {
        name: "",
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
    name: "recordSwipe",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "player",
        type: "address",
        internalType: "address",
      },
      {
        name: "cardIdx",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "direction",
        type: "uint8",
        internalType: "enum DreamSwipeDuel.Direction",
      },
      {
        name: "premium",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "filled",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "nonce",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "deadline",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "signature",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "revealDeck",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "marketIds",
        type: "bytes32[]",
        internalType: "bytes32[]",
      },
      {
        name: "strikes",
        type: "uint256[]",
        internalType: "uint256[]",
      },
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setKeeper",
    inputs: [
      {
        name: "newKeeper",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "settleCard",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "cardIdx",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "winner",
        type: "uint8",
        internalType: "enum DreamSwipeDuel.Direction",
      },
      {
        name: "voided",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "swipeDigest",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "cardIdx",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "direction",
        type: "uint8",
        internalType: "enum DreamSwipeDuel.Direction",
      },
      {
        name: "nonce",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "deadline",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "CardSettled",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "cardIdx",
        type: "uint8",
        indexed: true,
        internalType: "uint8",
      },
      {
        name: "marketId",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "p0Pnl",
        type: "int256",
        indexed: false,
        internalType: "int256",
      },
      {
        name: "p1Pnl",
        type: "int256",
        indexed: false,
        internalType: "int256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "DeckRevealed",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "marketIds",
        type: "bytes32[]",
        indexed: false,
        internalType: "bytes32[]",
      },
      {
        name: "strikes",
        type: "uint256[]",
        indexed: false,
        internalType: "uint256[]",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "DuelCreated",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "creator",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "tier",
        type: "uint8",
        indexed: false,
        internalType: "enum DreamSwipeDuel.Tier",
      },
      {
        name: "stakeToken",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "stake",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
      {
        name: "deckSize",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
      {
        name: "deckCommit",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "DuelFinalized",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "winner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "p0Score",
        type: "int256",
        indexed: false,
        internalType: "int256",
      },
      {
        name: "p1Score",
        type: "int256",
        indexed: false,
        internalType: "int256",
      },
      {
        name: "payout",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "DuelJoined",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "challenger",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "startedAtSec",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "DuelRefunded",
    inputs: [
      {
        name: "duelId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "reason",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "EIP712DomainChanged",
    inputs: [],
    anonymous: false,
  },
  {
    type: "event",
    name: "KeeperUpdated",
    inputs: [
      {
        name: "previousKeeper",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "newKeeper",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SwipeRecorded",
    inputs: [
      {
        name: "duelId",
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
        name: "cardIdx",
        type: "uint8",
        indexed: true,
        internalType: "uint8",
      },
      {
        name: "direction",
        type: "uint8",
        indexed: false,
        internalType: "enum DreamSwipeDuel.Direction",
      },
      {
        name: "premium",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
      {
        name: "filled",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AlreadyJoined",
    inputs: [],
  },
  {
    type: "error",
    name: "AlreadySwiped",
    inputs: [],
  },
  {
    type: "error",
    name: "CardAlreadySettled",
    inputs: [],
  },
  {
    type: "error",
    name: "CardIndexOutOfBounds",
    inputs: [],
  },
  {
    type: "error",
    name: "CardsNotAllSettled",
    inputs: [],
  },
  {
    type: "error",
    name: "CreatorCannotJoin",
    inputs: [],
  },
  {
    type: "error",
    name: "DeckAlreadyRevealed",
    inputs: [],
  },
  {
    type: "error",
    name: "DeckCommitMismatch",
    inputs: [],
  },
  {
    type: "error",
    name: "DeckNotRevealed",
    inputs: [],
  },
  {
    type: "error",
    name: "DuelNotActive",
    inputs: [],
  },
  {
    type: "error",
    name: "DuelNotComplete",
    inputs: [],
  },
  {
    type: "error",
    name: "DuelNotPending",
    inputs: [],
  },
  {
    type: "error",
    name: "ECDSAInvalidSignature",
    inputs: [],
  },
  {
    type: "error",
    name: "ECDSAInvalidSignatureLength",
    inputs: [
      {
        name: "length",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "ECDSAInvalidSignatureS",
    inputs: [
      {
        name: "s",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidDeckCommit",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidDeckSize",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidNonce",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidShortString",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidSignature",
    inputs: [],
  },
  {
    type: "error",
    name: "NotAdmin",
    inputs: [],
  },
  {
    type: "error",
    name: "NotKeeper",
    inputs: [],
  },
  {
    type: "error",
    name: "NotPlayer",
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
    name: "SignatureExpired",
    inputs: [],
  },
  {
    type: "error",
    name: "StakeMustBeZeroForFreeTier",
    inputs: [],
  },
  {
    type: "error",
    name: "StringTooLong",
    inputs: [
      {
        name: "str",
        type: "string",
        internalType: "string",
      },
    ],
  },
  {
    type: "error",
    name: "TimeoutNotReached",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroAddress",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroStake",
    inputs: [],
  },
] as const
