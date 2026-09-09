/**
 * Duel state for the UI — the EVM rewrite of the old Sui `flicky.ts`.
 *
 * ── Why the shape is preserved ──────────────────────────────────────────────
 *
 * The `DuelState` interface below deliberately keeps the field names the game
 * routes already render (`p0Payout`, `cardsSettled`, `deckHashHex`, …). The
 * chain underneath changed completely; the UI's vocabulary did not need to,
 * and rewriting a dozen working views during a chain migration is how subtle
 * rendering bugs get introduced.
 *
 * Where the new contract genuinely differs, the difference is honoured rather
 * than faked:
 *
 *   - Sui tracked `payout` and `premium` separately per player. The Solidity
 *     contract accumulates a single signed `p0Score`/`p1Score` (realized PnL),
 *     because that is the only quantity settlement actually produces. The
 *     legacy split is derived for display — see `splitScore` — and never
 *     invented beyond what the score really says.
 *   - `startedAtMs` comes from a block timestamp (seconds), scaled here once.
 *   - `stakeCoinType` is now an ERC-20 address, not a Move type string.
 */
import type { Config } from "wagmi"
import { keccak256, encodeAbiParameters, type Address, type Hex } from "viem"
import {
  DuelStatus as ChainStatus,
  DuelTier,
  SwipeDirection,
  fetchDeck as fetchChainDeck,
  fetchDuel as fetchChainDuel,
  fetchSwipe,
} from "./duel"

export type DuelStatus = "PENDING" | "ACTIVE" | "COMPLETE"

export interface DuelCard {
  /** Venue market id this card is bet on (bytes32 hex). */
  expiryMarketId: string
  strike: bigint
}

export interface DuelSwipe {
  isUp: boolean
  /** Size acquired, collateral base units. */
  quantity: bigint
  /** What was actually paid to enter. */
  premium: bigint
}

export interface DuelState {
  id: string
  /** ERC-20 collateral address for a staked duel; zero address when Free. */
  stakeCoinType: string
  status: DuelStatus
  /** 1 = STAKED, 2 = FREE — kept in the legacy encoding the UI switches on. */
  tier: number
  creator: string
  challenger: string
  /** keccak256 deck commitment, "0x"-prefixed hex. */
  deckHashHex: string
  deckSize: bigint
  cards: DuelCard[]
  p0Stake: bigint
  p1Stake: bigint
  p0Payout: bigint
  p0Premium: bigint
  p1Payout: bigint
  p1Premium: bigint
  p0NextCardIdx: bigint
  p1NextCardIdx: bigint
  settledCount: bigint
  startedAtMs: bigint
  p0Swipes: (DuelSwipe | null)[]
  p1Swipes: (DuelSwipe | null)[]
  cardsSettled: boolean[]
  cardSettlementPrices: bigint[]
}

export interface DeckCard {
  /** Venue market id (bytes32 hex). */
  expiryMarketId: string
  strike: bigint
}

export const DEFAULT_DECK_SIZE = 5

/**
 * Deck commitment.
 *
 * MUST match `DreamSwipeDuel.computeDeckCommit`, which is
 * `keccak256(abi.encode(bytes32[] marketIds, uint256[] strikes, bytes32 salt))`.
 * A mismatch here does not fail loudly at commit time — it fails at REVEAL,
 * after both players have staked, so the encoding is kept adjacent to the
 * Solidity signature it mirrors.
 */
export function computeDeckCommit(cards: DeckCard[], salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32[]" }, { type: "uint256[]" }, { type: "bytes32" }],
      [
        cards.map((c) => c.expiryMarketId as Hex),
        cards.map((c) => c.strike),
        salt,
      ]
    )
  )
}

/** Random 32-byte salt. Stops the commitment being brute-forced from a small
 *  space of plausible decks. */
export function randomSalt(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

function mapStatus(status: ChainStatus): DuelStatus {
  switch (status) {
    case ChainStatus.Pending:
      return "PENDING"
    case ChainStatus.Active:
      return "ACTIVE"
    case ChainStatus.Complete:
      return "COMPLETE"
    default:
      // A duel id that was never created reads as status 0. Treating that as
      // PENDING would render a phantom lobby entry, so surface it as complete
      // — callers check `creator` for existence.
      return "COMPLETE"
  }
}

/**
 * Split a signed realized score into the legacy payout/premium pair the UI
 * renders.
 *
 * The contract stores ONE number per player (`score = payout - premium`),
 * because that is what settlement produces. Rather than invent a fake split,
 * this maps a positive score to payout and a negative score to premium, which
 * renders identically in every place the UI does `payout - premium`.
 */
function splitScore(score: bigint): { payout: bigint; premium: bigint } {
  return score >= 0n
    ? { payout: score, premium: 0n }
    : { payout: 0n, premium: -score }
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/**
 * Read a duel's full state, including deck and both players' swipes.
 *
 * Swipes are fetched per (player, card) because the contract stores them in a
 * nested mapping rather than an array — mappings cannot be returned wholesale.
 * They are read concurrently so a 5-card duel costs one round-trip, not ten.
 */
export async function fetchDuel(
  config: Config,
  duelId: string
): Promise<DuelState> {
  const id = duelId as Hex
  const [chain, deck] = await Promise.all([
    fetchChainDuel(config, id),
    fetchChainDeck(config, id),
  ])

  const deckSize = chain.deckSize
  const hasChallenger = chain.challenger !== ZERO_ADDRESS

  // Only read swipes once the deck is revealed — before that there are none,
  // and querying would be `deckSize * 2` wasted calls on every poll.
  let p0Swipes: (DuelSwipe | null)[] = new Array(deckSize).fill(null)
  let p1Swipes: (DuelSwipe | null)[] = new Array(deckSize).fill(null)

  if (chain.deckRevealed && deckSize > 0) {
    const indices = Array.from({ length: deckSize }, (_, i) => i)
    const [p0, p1] = await Promise.all([
      Promise.all(indices.map((i) => fetchSwipe(config, id, chain.creator, i))),
      hasChallenger
        ? Promise.all(
            indices.map((i) => fetchSwipe(config, id, chain.challenger, i))
          )
        : Promise.resolve(indices.map(() => null)),
    ])
    const toSwipe = (
      s: {
        exists: boolean
        direction: SwipeDirection
        premium: bigint
        filled: bigint
      } | null
    ): DuelSwipe | null =>
      s && s.exists
        ? {
            isUp: s.direction === SwipeDirection.Up,
            quantity: s.filled,
            premium: s.premium,
          }
        : null
    p0Swipes = p0.map(toSwipe)
    p1Swipes = p1.map(toSwipe)
  }

  const p0 = splitScore(chain.p0Score)
  const p1 = splitScore(chain.p1Score)

  // The contract exposes a settled COUNT, not per-index flags. Cards settle in
  // order, so the first `settledCount` entries are the settled ones.
  const cardsSettled = Array.from(
    { length: deckSize },
    (_, i) => i < chain.settledCount
  )

  return {
    id: duelId,
    stakeCoinType: chain.stakeToken,
    status: mapStatus(chain.status),
    // Legacy encoding: 1 = STAKED, 2 = FREE.
    tier: chain.tier === DuelTier.Staked ? 1 : 2,
    creator: chain.creator,
    challenger: chain.challenger,
    deckHashHex: chain.deckCommit,
    deckSize: BigInt(deckSize),
    cards: deck.map((c) => ({
      expiryMarketId: c.marketId,
      strike: c.strike,
    })),
    p0Stake: chain.stake,
    p1Stake: hasChallenger ? chain.stake : 0n,
    p0Payout: p0.payout,
    p0Premium: p0.premium,
    p1Payout: p1.payout,
    p1Premium: p1.premium,
    // Swipes are relayed and can land in any order, so "next card" is derived
    // from how many the player has actually recorded.
    p0NextCardIdx: BigInt(p0Swipes.filter(Boolean).length),
    p1NextCardIdx: BigInt(p1Swipes.filter(Boolean).length),
    settledCount: BigInt(chain.settledCount),
    startedAtMs: chain.startedAtSec * 1000n,
    p0Swipes,
    p1Swipes,
    cardsSettled,
    // The venue settles to an outcome, not a price. There is no per-card
    // settlement price to report, and inventing one would be a fabricated
    // value — so this stays zeroed and the UI reads outcomes instead.
    cardSettlementPrices: new Array(deckSize).fill(0n),
  }
}

/** True when this address is one of the duel's two players. */
export function isPlayer(
  duel: Pick<RefundCandidate, "creator" | "challenger">,
  address: string | undefined
): boolean {
  if (!address) return false
  const a = address.toLowerCase()
  return duel.creator.toLowerCase() === a || duel.challenger.toLowerCase() === a
}

/** Realized score for a player, as the UI's payout/premium pair implies. */
export function playerScore(duel: DuelState, address: string): bigint {
  const isCreator = duel.creator.toLowerCase() === address.toLowerCase()
  return isCreator
    ? duel.p0Payout - duel.p0Premium
    : duel.p1Payout - duel.p1Premium
}

export type { Address }

// ─── Refunds and timeouts ───────────────────────────────────────────────────

/**
 * Reveal-timeout window, mirroring `DreamSwipeDuel.REVEAL_TIMEOUT_SEC` (5 min).
 *
 * Kept in sync with the contract by name. If the constant there changes, the
 * UI would offer a refund the chain still rejects — annoying but safe, since
 * the contract is the authority and simply reverts.
 */
export const REFUND_TIMEOUT_MS = 5 * 60 * 1000

/** Duel-timeout window, mirroring `DreamSwipeDuel.DUEL_TIMEOUT_SEC` (2 h). */
export const DUEL_TIMEOUT_MS = 2 * 60 * 60 * 1000

export type RefundKind = "cancel_pending" | "reveal_timeout" | "duel_timeout"

/**
 * Which refund, if any, this player can claim right now.
 *
 * Returns null when nothing is claimable, so the UI can hide the button rather
 * than offer an action that would revert.
 *
 * The timeout branches are permissionless on chain — a challenger must not
 * need the creator's cooperation to recover a stake — but the UI only offers
 * them to participants, since nobody else has a reason to care.
 */
/**
 * The minimum a caller must know for an eligibility decision.
 *
 * Deliberately narrower than `DuelState`: the history list renders lightweight
 * rows from the server, not full on-chain reads, and forcing them to
 * materialize a whole `DuelState` just to grey out a button would mean N extra
 * chain round-trips on a screen that is only listing.
 */
export interface RefundCandidate {
  status: DuelStatus
  creator: string
  challenger: string
  startedAtMs: bigint | number
  /** Empty/absent means the deck was never revealed. */
  cards?: readonly unknown[]
}

export function refundEligibility(
  duel: RefundCandidate,
  address: string | undefined,
  nowMs: number = Date.now()
): RefundKind | null {
  if (!address || !isPlayer(duel, address)) return null

  // Nobody joined: the creator can simply cancel and take their stake back.
  if (duel.status === "PENDING") {
    return duel.creator.toLowerCase() === address.toLowerCase()
      ? "cancel_pending"
      : null
  }

  if (duel.status !== "ACTIVE") return null

  const startedMs = Number(duel.startedAtMs)
  if (startedMs === 0) return null
  const elapsed = nowMs - startedMs

  // Deck never revealed — the griefing case the contract guards against.
  if ((duel.cards?.length ?? 0) === 0 && elapsed >= REFUND_TIMEOUT_MS) {
    return "reveal_timeout"
  }
  // Started but never finished (venue outage, abandoned opponent).
  if (elapsed >= DUEL_TIMEOUT_MS) return "duel_timeout"

  return null
}

/** Human-readable reason for a refund, shown next to the claim button. */
export function refundReason(kind: RefundKind): string {
  switch (kind) {
    case "cancel_pending":
      return "no opponent joined"
    case "reveal_timeout":
      return "deck was never revealed"
    case "duel_timeout":
      return "duel never completed"
  }
}

/**
 * Pick the contract call that claims this refund.
 *
 * Returns a sender the tx hook can run. Each branch maps to a distinct
 * contract entrypoint because they guard different conditions — collapsing
 * them into one call would mean the contract could not tell a cancel from a
 * timeout.
 */
export function buildRefundDuelTx(duelId: string, kind: RefundKind) {
  const id = duelId as Hex
  return async (config: Config): Promise<Hex> => {
    const { cancelPendingDuel, claimDuelTimeout, claimRevealTimeout } =
      await import("./duel")
    switch (kind) {
      case "cancel_pending":
        return cancelPendingDuel(config, id)
      case "reveal_timeout":
        return claimRevealTimeout(config, id)
      case "duel_timeout":
        return claimDuelTimeout(config, id)
    }
  }
}
