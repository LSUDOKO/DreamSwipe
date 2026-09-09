/**
 * Order-book math: pure functions over book levels.
 *
 * Kept deliberately free of any SDK or network dependency so the CLOB
 * intelligence the game shows — spread, depth, imbalance, execution price,
 * slippage — is unit-testable against known books rather than only observable
 * against a live venue.
 *
 * The honesty rule from `specs/06_FRONTEND.md` ("No fake live values") is
 * enforced here in the type signatures: anything that cannot be derived from
 * the given book returns `null`, never `0`. A zero spread and an unknown
 * spread must not be indistinguishable downstream.
 */
import {
  ONE_PROBABILITY,
  type BookLevel,
  type Direction,
  type OrderBook,
  type Quote,
} from "./types"

/** Sum of resting size across levels. */
export function totalDepth(levels: BookLevel[]): bigint {
  let sum = 0n
  for (const l of levels) sum += l.quantity
  return sum
}

/**
 * Normalized book imbalance in [-1, 1].
 *
 *   imbalance = (bidDepth - askDepth) / (bidDepth + askDepth)
 *
 * Positive means buy-side pressure. Returns `null` for a completely empty
 * book, so "balanced at 0" is distinguishable from "no orders at all" — the
 * CLOB Imbalance bot requires a real reading and must not trade on an absence.
 */
export function computeImbalance(
  bidDepth: bigint,
  askDepth: bigint
): number | null {
  const total = bidDepth + askDepth
  if (total === 0n) return null
  // Scale to a float via a fixed denominator to avoid bigint division loss.
  const numerator = bidDepth - askDepth
  return Number((numerator * 1_000_000n) / total) / 1_000_000
}

/**
 * Assemble an `OrderBook` (with derived metrics) from raw levels.
 *
 * Sorts defensively: bids descending, asks ascending. Levels with zero size
 * are dropped — some venues report emptied levels rather than removing them,
 * and a zero-size "best bid" would poison every derived metric.
 */
export function buildOrderBook(input: {
  marketId: string
  bids: BookLevel[]
  asks: BookLevel[]
  observedAtMs?: number
}): OrderBook {
  const bids = input.bids
    .filter((l) => l.quantity > 0n)
    .sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : 0))
  const asks = input.asks
    .filter((l) => l.quantity > 0n)
    .sort((a, b) => (a.price > b.price ? 1 : a.price < b.price ? -1 : 0))

  const bestBid = bids.length > 0 ? bids[0]!.price : null
  const bestAsk = asks.length > 0 ? asks[0]!.price : null
  const bidDepth = totalDepth(bids)
  const askDepth = totalDepth(asks)

  return {
    marketId: input.marketId,
    bids,
    asks,
    bestBid,
    bestAsk,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
    mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2n : null,
    bidDepth,
    askDepth,
    imbalance: computeImbalance(bidDepth, askDepth),
    observedAtMs: input.observedAtMs ?? Date.now(),
  }
}

/**
 * Convert a DOWN-side view to the book's UP terms.
 *
 * The venue quotes ONE book, in UP/YES terms. Backing DOWN at probability p is
 * the same trade as buying UP at (1 - p). Every price crossing the adapter
 * boundary is in UP terms; this is the single conversion point.
 */
export function toUpPrice(price: bigint, direction: Direction): bigint {
  return direction === "UP" ? price : ONE_PROBABILITY - price
}

/**
 * Walk the book to price a market order of `quantity`.
 *
 * Returns what the book can ACTUALLY fill. If depth runs out the quote is
 * marked `insufficientLiquidity` with a partial `fillableQuantity` — the UI
 * shows that honestly instead of quoting a size the venue cannot execute.
 *
 * `levels` must already be in execution order (best price first).
 */
export function walkBook(
  levels: BookLevel[],
  quantity: bigint
): { filled: bigint; cost: bigint; avgPrice: bigint | null } {
  let remaining = quantity
  let filled = 0n
  let cost = 0n

  for (const level of levels) {
    if (remaining <= 0n) break
    const take = level.quantity < remaining ? level.quantity : remaining
    // cost is in collateral base units: size * probability / ONE.
    cost += (take * level.price) / ONE_PROBABILITY
    filled += take
    remaining -= take
  }

  const avgPrice = filled > 0n ? (cost * ONE_PROBABILITY) / filled : null
  return { filled, cost, avgPrice }
}

/**
 * Quote a buy of `quantity` on `direction` against a live book.
 *
 * Slippage is measured against the touch (the best price available), so it
 * answers "how much worse than the top of book did walking it make me?".
 * Null when there is no touch to compare against.
 */
export function quoteOverBook(
  book: OrderBook,
  direction: Direction,
  quantity: bigint
): Quote {
  // Buying UP consumes asks. Buying DOWN is buying the complement, which
  // consumes the bid side of the UP book at the mirrored price.
  const levels: BookLevel[] =
    direction === "UP"
      ? book.asks
      : book.bids.map((l) => ({
          price: ONE_PROBABILITY - l.price,
          quantity: l.quantity,
        }))

  const touch = levels.length > 0 ? levels[0]!.price : null
  const { filled, cost, avgPrice } = walkBook(levels, quantity)

  let slippage: number | null = null
  if (avgPrice !== null && touch !== null && touch > 0n) {
    slippage = Number(((avgPrice - touch) * 1_000_000n) / touch) / 1_000_000
  }

  return {
    marketId: book.marketId,
    direction,
    quantity,
    fillableQuantity: filled,
    avgPrice,
    cost,
    slippage,
    insufficientLiquidity: filled < quantity,
  }
}

/**
 * The "Contrarian Edge" indicator from the master spec.
 *
 * The spec is explicit that this is educational and market-derived, never a
 * promised multiplier:
 *
 *   > Present a market-derived educational indicator, never a guaranteed
 *   > multiplier.
 *
 * So this returns only facts already true of the book: what each side costs
 * right now, and what a winning contract pays back per unit of collateral
 * (winners redeem 1:1, so backing at probability p returns 1/p). The crowded
 * side is simply the one the market prices above even. No prediction is made
 * about which side will win, and none should be shown.
 *
 * Returns null when there is no mid price — with no market view there is no
 * "crowd" to be contrarian to.
 */
export function contrarianEdge(book: OrderBook): {
  /** The side the market currently favours. */
  crowdedSide: Direction
  /** The less-crowded side. */
  contrarianSide: Direction
  /** Market-implied probability of UP, as a fraction. */
  upProbability: number
  /**
   * Gross return per unit of collateral if the contrarian side wins, from
   * actual pricing (1 / price). 2.5 means 1 tUSDC returns 2.5 if correct.
   */
  contrarianReturn: number
} | null {
  if (book.mid === null || book.mid <= 0n || book.mid >= ONE_PROBABILITY) {
    return null
  }
  const upProbability = Number(book.mid) / Number(ONE_PROBABILITY)
  const crowdedSide: Direction = upProbability >= 0.5 ? "UP" : "DOWN"
  const contrarianSide: Direction = crowdedSide === "UP" ? "DOWN" : "UP"
  const contrarianPrice =
    contrarianSide === "UP" ? upProbability : 1 - upProbability

  return {
    crowdedSide,
    contrarianSide,
    upProbability,
    contrarianReturn: 1 / contrarianPrice,
  }
}

/**
 * Realized PnL for one settled card.
 *
 * Per `specs/01_PRODUCT_AND_GAMEPLAY.md`:
 *
 *   netResult = realizedValue - actualEntryCost
 *
 * A winning contract redeems 1:1 for collateral, so realized value is the
 * quantity held on the winning side. A voided market refunds both sides at
 * 0.5. Losing contracts are worth exactly zero — there is no consolation
 * term, and no score multiplier is applied anywhere: economic outcome IS the
 * score.
 */
export function cardPnl(input: {
  direction: Direction
  /** Size held, collateral base units. */
  quantity: bigint
  /** What was actually paid to enter, collateral base units. */
  entryCost: bigint
  /** Winning side, or null if the market voided. */
  winner: Direction | null
  voided: boolean
}): bigint {
  if (input.voided) {
    // Both sides refund at 0.5.
    return input.quantity / 2n - input.entryCost
  }
  const won = input.winner !== null && input.winner === input.direction
  const realized = won ? input.quantity : 0n
  return realized - input.entryCost
}
