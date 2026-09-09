/**
 * Duel contract interaction — the EVM replacement for `lib/flicky.ts`.
 *
 * Everything here is thin on purpose: build a call, send it, surface the real
 * hash. No optimistic state, no synthesized receipts. If a transaction fails,
 * the caller finds out.
 *
 * ── Swipes are signed, not sent ─────────────────────────────────────────────
 *
 * The Sui build made every swipe a player-signed transaction because DeepBook
 * required the sender to own the minting account. Somnia has no such
 * constraint, so a swipe is an EIP-712 signature the player produces off-chain
 * — no wallet popup mid-duel, no gas — and the relayer submits it.
 *
 * The signature binds (duelId, cardIdx, direction, nonce, deadline), so the
 * relayer can neither forge a swipe nor replay one, and it has no path to move
 * escrow. See `apps/contracts-evm/src/DreamSwipeDuel.sol`.
 */
import type { Config } from "wagmi"
import { readContract, signTypedData, writeContract } from "wagmi/actions"
import { erc20Abi, type Address, type Hex } from "viem"
import { duelAbi } from "./duel-abi"
import { COLLATERAL_ADDRESS, DUEL_ADDRESS, somniaTestnet } from "./chain"

/**
 * Mirrors the contract's `Status` enum.
 *
 * A const object rather than a TS `enum`: this project sets
 * `erasableSyntaxOnly`, which forbids enums because they emit runtime code.
 */
export const DuelStatus = {
  None: 0,
  Pending: 1,
  Active: 2,
  Complete: 3,
} as const
export type DuelStatus = (typeof DuelStatus)[keyof typeof DuelStatus]

/** Mirrors the contract's `Tier` enum. */
export const DuelTier = {
  Free: 0,
  Staked: 1,
} as const
export type DuelTier = (typeof DuelTier)[keyof typeof DuelTier]

/** Mirrors the contract's `Direction` enum. UP = YES, DOWN = NO. */
export const SwipeDirection = {
  Up: 0,
  Down: 1,
} as const
export type SwipeDirection =
  (typeof SwipeDirection)[keyof typeof SwipeDirection]

export interface DuelState {
  status: DuelStatus
  tier: DuelTier
  creator: Address
  challenger: Address
  stakeToken: Address
  stake: bigint
  deckSize: number
  settledCount: number
  deckRevealed: boolean
  deckCommit: Hex
  createdAtSec: bigint
  startedAtSec: bigint
  /** Realized PnL summed across settled cards. Signed. */
  p0Score: bigint
  p1Score: bigint
}

/** Raw tuple order returned by `getDuel`. Kept adjacent to the decoder. */
type RawDuel = readonly [
  number, // status
  number, // tier
  Address, // creator
  Address, // challenger
  Address, // stakeToken
  bigint, // stake
  number, // deckSize
  number, // settledCount
  boolean, // deckRevealed
  Hex, // deckCommit
  bigint, // createdAtSec
  bigint, // startedAtSec
  bigint, // p0Score
  bigint, // p1Score
]

function decodeDuel(raw: RawDuel): DuelState {
  return {
    status: raw[0] as DuelStatus,
    tier: raw[1] as DuelTier,
    creator: raw[2],
    challenger: raw[3],
    stakeToken: raw[4],
    stake: raw[5],
    deckSize: raw[6],
    settledCount: raw[7],
    deckRevealed: raw[8],
    deckCommit: raw[9],
    createdAtSec: raw[10],
    startedAtSec: raw[11],
    p0Score: raw[12],
    p1Score: raw[13],
  }
}

/** Read one duel's on-chain state. */
export async function fetchDuel(
  config: Config,
  duelId: Hex
): Promise<DuelState> {
  const raw = (await readContract(config, {
    address: DUEL_ADDRESS,
    abi: duelAbi,
    functionName: "getDuel",
    args: [duelId],
  })) as unknown as RawDuel
  return decodeDuel(raw)
}

export interface DeckCard {
  marketId: Hex
  strike: bigint
}

/** Read the revealed deck. Empty until reveal — never inferred. */
export async function fetchDeck(
  config: Config,
  duelId: Hex
): Promise<DeckCard[]> {
  const raw = (await readContract(config, {
    address: DUEL_ADDRESS,
    abi: duelAbi,
    functionName: "getDeck",
    args: [duelId],
  })) as unknown as readonly { marketId: Hex; strike: bigint }[]
  return raw.map((c) => ({ marketId: c.marketId, strike: c.strike }))
}

/** Read a player's recorded swipe for one card. */
export async function fetchSwipe(
  config: Config,
  duelId: Hex,
  player: Address,
  cardIdx: number
): Promise<{
  exists: boolean
  direction: SwipeDirection
  premium: bigint
  filled: bigint
}> {
  const raw = (await readContract(config, {
    address: DUEL_ADDRESS,
    abi: duelAbi,
    functionName: "getSwipe",
    args: [duelId, player, cardIdx],
  })) as unknown as {
    exists: boolean
    direction: number
    premium: bigint
    filled: bigint
  }
  return {
    exists: raw.exists,
    direction: raw.direction as SwipeDirection,
    premium: raw.premium,
    filled: raw.filled,
  }
}

/** The player's current EIP-712 nonce. Strictly increasing; blocks replay. */
export async function fetchNonce(
  config: Config,
  player: Address
): Promise<bigint> {
  return (await readContract(config, {
    address: DUEL_ADDRESS,
    abi: duelAbi,
    functionName: "nonces",
    args: [player],
  })) as bigint
}

/** Collateral balance, in base units. */
export async function fetchCollateralBalance(
  config: Config,
  owner: Address
): Promise<bigint> {
  return (await readContract(config, {
    address: COLLATERAL_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint
}

/**
 * Collateral decimals, read from the token itself.
 *
 * Deliberately not a constant at the call site: testnet tUSDC is 6 and mainnet
 * USDso is 18, and a wrong literal misprices everything without reverting.
 */
export async function fetchCollateralDecimals(config: Config): Promise<number> {
  return (await readContract(config, {
    address: COLLATERAL_ADDRESS,
    abi: erc20Abi,
    functionName: "decimals",
  })) as number
}

/** How much the duel contract may pull from this owner. */
export async function fetchAllowance(
  config: Config,
  owner: Address
): Promise<bigint> {
  return (await readContract(config, {
    address: COLLATERAL_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, DUEL_ADDRESS],
  })) as bigint
}

/**
 * Approve the duel contract to escrow collateral.
 *
 * Approves the exact amount rather than an unlimited allowance: a staked duel
 * needs a known stake, and an infinite approval on a testnet game is a
 * gratuitous standing risk to the player's balance.
 */
export async function approveCollateral(
  config: Config,
  amount: bigint
): Promise<Hex> {
  return writeContract(config, {
    address: COLLATERAL_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [DUEL_ADDRESS, amount],
  })
}

/**
 * Open a duel.
 *
 * `deckCommit` binds the deck BEFORE either player can see it, which is what
 * makes the deck provably un-reshuffled at reveal time.
 */
export async function createDuel(
  config: Config,
  params: {
    deckCommit: Hex
    deckSize: number
    tier: DuelTier
    stake: bigint
  }
): Promise<Hex> {
  return writeContract(config, {
    address: DUEL_ADDRESS,
    abi: duelAbi,
    functionName: "createDuel",
    args: [
      params.deckCommit,
      params.deckSize,
      params.tier,
      // A Free duel must carry the zero address; the contract rejects a
      // non-zero stake on that tier outright.
      params.tier === DuelTier.Staked
        ? COLLATERAL_ADDRESS
        : "0x0000000000000000000000000000000000000000",
      params.stake,
    ],
  })
}

/** Join a pending duel, matching the creator's stake. */
export async function joinDuel(config: Config, duelId: Hex): Promise<Hex> {
  return writeContract(config, {
    address: DUEL_ADDRESS,
    abi: duelAbi,
    functionName: "joinDuel",
    args: [duelId],
  })
}

/** Finalize a duel whose cards have all settled, paying the winner. */
export async function finalizeDuel(config: Config, duelId: Hex): Promise<Hex> {
  return writeContract(config, {
    address: DUEL_ADDRESS,
    abi: duelAbi,
    functionName: "finalize",
    args: [duelId],
  })
}

/** Cancel a duel nobody joined and reclaim the stake. */
export async function cancelPendingDuel(
  config: Config,
  duelId: Hex
): Promise<Hex> {
  return writeContract(config, {
    address: DUEL_ADDRESS,
    abi: duelAbi,
    functionName: "cancelPending",
    args: [duelId],
  })
}

/**
 * Reclaim both stakes when the deck was never revealed in time.
 *
 * Permissionless by design — a challenger must not need the creator's
 * cooperation to get their money back.
 */
export async function claimRevealTimeout(
  config: Config,
  duelId: Hex
): Promise<Hex> {
  return writeContract(config, {
    address: DUEL_ADDRESS,
    abi: duelAbi,
    functionName: "claimRevealTimeout",
    args: [duelId],
  })
}

/** Reclaim both stakes when a started duel never completed. */
export async function claimDuelTimeout(
  config: Config,
  duelId: Hex
): Promise<Hex> {
  return writeContract(config, {
    address: DUEL_ADDRESS,
    abi: duelAbi,
    functionName: "claimDuelTimeout",
    args: [duelId],
  })
}

/** EIP-712 domain. Must match the contract's `EIP712("DreamSwipeDuel", "1")`. */
export const SWIPE_DOMAIN = {
  name: "DreamSwipeDuel",
  version: "1",
  chainId: somniaTestnet.id,
  verifyingContract: DUEL_ADDRESS,
} as const

export const SWIPE_TYPES = {
  Swipe: [
    { name: "duelId", type: "bytes32" },
    { name: "cardIdx", type: "uint8" },
    { name: "direction", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

export interface SignedSwipe {
  duelId: Hex
  cardIdx: number
  direction: SwipeDirection
  nonce: bigint
  deadline: bigint
  signature: Hex
}

/** How long a signed swipe stays valid. Short: it should be relayed at once. */
export const SWIPE_DEADLINE_SEC = 5 * 60

/**
 * Sign a swipe for the relayer to submit.
 *
 * This is what removes the wallet popup from the middle of a duel: the player
 * signs typed data (no gas, no transaction) and the relayer pays to record it.
 *
 * The nonce is read fresh from chain each time. Signing two swipes against the
 * same nonce would make the second unusable, since the contract requires
 * strictly sequential nonces.
 */
export async function signSwipe(
  config: Config,
  params: {
    duelId: Hex
    cardIdx: number
    direction: SwipeDirection
    player: Address
  }
): Promise<SignedSwipe> {
  const nonce = await fetchNonce(config, params.player)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + SWIPE_DEADLINE_SEC)

  const signature = await signTypedData(config, {
    domain: SWIPE_DOMAIN,
    types: SWIPE_TYPES,
    primaryType: "Swipe",
    message: {
      duelId: params.duelId,
      cardIdx: params.cardIdx,
      direction: params.direction,
      nonce,
      deadline,
    },
  })

  return {
    duelId: params.duelId,
    cardIdx: params.cardIdx,
    direction: params.direction,
    nonce,
    deadline,
    signature,
  }
}

/**
 * Which player won, by realized PnL.
 *
 * Returns null for an exact tie — the contract refunds each stake rather than
 * picking a winner, so the UI must be able to say "draw".
 */
export function duelWinner(duel: DuelState): Address | null {
  if (duel.p0Score > duel.p1Score) return duel.creator
  if (duel.p1Score > duel.p0Score) return duel.challenger
  return null
}
