/**
 * Season prize pool — on-chain escrow reads and the claim call.
 *
 * Companion to `./season.ts`, which fetches the server's DISPLAY config
 * (name, end date, prize split). This module is the authoritative half: what
 * is actually escrowed, and what a given wallet can actually claim. When the
 * two disagree, the contract is right.
 *
 * The escrow is what makes a season prize real rather than a promise: once the
 * operator finalizes, allocations are frozen on chain and each winner claims
 * their own. Nobody — not the operator, not the owner — can redirect a prize
 * after that point, and the surplus sweep is bounded so an unclaimed prize can
 * never be swept out from under a late claimer.
 */
import type { Config } from "wagmi"
import { readContract, writeContract } from "wagmi/actions"
import { keccak256, toHex, type Address, type Hex } from "viem"
import { seasonPoolAbi } from "./season-abi"

/** Deployed on Shannon; see `deployments/somnia-testnet.json`. */
export const SEASON_POOL_ADDRESS = (import.meta.env.VITE_SEASON_POOL_ADDRESS ||
  "0xB380814066dcb5d0b4d4968742bFdC005D1FB4a7") as Address

/** Mirrors the contract's `SeasonState`. */
export const SeasonState = {
  None: 0,
  Open: 1,
  Finalized: 2,
} as const
export type SeasonState = (typeof SeasonState)[keyof typeof SeasonState]

export interface SeasonInfo {
  state: SeasonState
  token: Address
  funded: bigint
  allocated: bigint
  claimed: bigint
  createdAtSec: bigint
  finalizedAtSec: bigint
}

/**
 * Season ids are `keccak256(label)`, so a human-readable name like "season-1"
 * maps to a stable bytes32 without a registry lookup.
 */
export function seasonIdOf(label: string): Hex {
  return keccak256(toHex(label))
}

export async function fetchSeason(
  config: Config,
  seasonId: Hex
): Promise<SeasonInfo> {
  const raw = (await readContract(config, {
    address: SEASON_POOL_ADDRESS,
    abi: seasonPoolAbi,
    functionName: "getSeason",
    args: [seasonId],
  })) as unknown as {
    state: number
    token: Address
    funded: bigint
    allocated: bigint
    claimed: bigint
    createdAtSec: bigint
    finalizedAtSec: bigint
  }
  return { ...raw, state: raw.state as SeasonState }
}

/**
 * What this player can claim right now.
 *
 * Returns 0 both before finalization and after claiming, so the UI renders one
 * number without duplicating the contract's state machine — and never offers a
 * claim button that would revert.
 */
export async function fetchClaimable(
  config: Config,
  seasonId: Hex,
  player: Address
): Promise<bigint> {
  return (await readContract(config, {
    address: SEASON_POOL_ADDRESS,
    abi: seasonPoolAbi,
    functionName: "claimable",
    args: [seasonId, player],
  })) as bigint
}

/** This player's allocation, regardless of season state or claim status. */
export async function fetchAllocation(
  config: Config,
  seasonId: Hex,
  player: Address
): Promise<bigint> {
  return (await readContract(config, {
    address: SEASON_POOL_ADDRESS,
    abi: seasonPoolAbi,
    functionName: "allocationOf",
    args: [seasonId, player],
  })) as bigint
}

export async function fetchHasClaimed(
  config: Config,
  seasonId: Hex,
  player: Address
): Promise<boolean> {
  return (await readContract(config, {
    address: SEASON_POOL_ADDRESS,
    abi: seasonPoolAbi,
    functionName: "hasClaimed",
    args: [seasonId, player],
  })) as boolean
}

/** Claim this season's prize. The contract enforces one claim per player. */
export async function claimPrize(config: Config, seasonId: Hex): Promise<Hex> {
  return writeContract(config, {
    address: SEASON_POOL_ADDRESS,
    abi: seasonPoolAbi,
    functionName: "claim",
    args: [seasonId],
  })
}
