/**
 * Book-math tests.
 *
 * These cover the rules the spec calls out as load-bearing: honest empty
 * states (null, never a misleading zero), execution pricing over a real book,
 * and `netResult = realizedValue - actualEntryCost`.
 *
 * One fixture is the ACTUAL book observed on Shannon testnet during the
 * migration audit, so the math is exercised against shape-real data rather
 * than only tidy invented numbers.
 */
import { describe, expect, it } from "bun:test"
import {
  buildOrderBook,
  cardPnl,
  computeImbalance,
  contrarianEdge,
  quoteOverBook,
  totalDepth,
  toUpPrice,
  walkBook,
} from "./book-math"
import { ONE_PROBABILITY, type BookLevel } from "./types"

const M = 1_000_000n // one whole contract, 6-decimal collateral

describe("computeImbalance", () => {
  it("is null for a completely empty book, not zero", () => {
    // The distinction matters: the CLOB Imbalance bot must not read "no
    // orders" as "perfectly balanced" and trade on it.
    expect(computeImbalance(0n, 0n)).toBeNull()
  })

  it("is 0 for a genuinely balanced book", () => {
    expect(computeImbalance(10n * M, 10n * M)).toBe(0)
  })

  it("is +1 when only bids rest, -1 when only asks rest", () => {
    expect(computeImbalance(5n * M, 0n)).toBe(1)
    expect(computeImbalance(0n, 5n * M)).toBe(-1)
  })

  it("reports buy-side pressure as positive", () => {
    // 75 bid vs 25 ask → (75-25)/100 = 0.5
    expect(computeImbalance(75n * M, 25n * M)).toBeCloseTo(0.5, 6)
  })
})

describe("buildOrderBook", () => {
  it("derives the touch, spread and mid from real levels", () => {
    // Shape taken from a live Shannon testnet BTC market observed during the
    // audit: best bid 0.756, best ask 0.782.
    const book = buildOrderBook({
      marketId: "0x1",
      bids: [
        { price: 747_000n, quantity: 2n * M },
        { price: 756_000n, quantity: 1n * M },
        { price: 686_000n, quantity: 3n * M },
      ],
      asks: [
        { price: 792_000n, quantity: 2n * M },
        { price: 782_000n, quantity: 1n * M },
      ],
    })

    expect(book.bestBid).toBe(756_000n) // sorted descending
    expect(book.bestAsk).toBe(782_000n) // sorted ascending
    expect(book.spread).toBe(26_000n)
    expect(book.mid).toBe(769_000n)
    expect(book.bidDepth).toBe(6n * M)
    expect(book.askDepth).toBe(3n * M)
  })

  it("returns null spread/mid when one side is empty", () => {
    // A one-sided book has no meaningful spread. Reporting 0 would render as
    // an infinitely tight market in the UI.
    const book = buildOrderBook({
      marketId: "0x1",
      bids: [{ price: 500_000n, quantity: M }],
      asks: [],
    })
    expect(book.bestAsk).toBeNull()
    expect(book.spread).toBeNull()
    expect(book.mid).toBeNull()
    expect(book.imbalance).toBe(1)
  })

  it("drops zero-size levels so they cannot become a phantom touch", () => {
    const book = buildOrderBook({
      marketId: "0x1",
      bids: [
        { price: 900_000n, quantity: 0n },
        { price: 500_000n, quantity: M },
      ],
      asks: [],
    })
    expect(book.bestBid).toBe(500_000n)
    expect(book.bids).toHaveLength(1)
  })

  it("is fully empty-safe", () => {
    const book = buildOrderBook({ marketId: "0x1", bids: [], asks: [] })
    expect(book.bestBid).toBeNull()
    expect(book.spread).toBeNull()
    expect(book.imbalance).toBeNull()
    expect(book.bidDepth).toBe(0n)
  })
})

describe("toUpPrice", () => {
  it("mirrors DOWN into UP terms", () => {
    // Backing DOWN at 0.30 is buying UP at 0.70 — one book, one convention.
    expect(toUpPrice(300_000n, "DOWN")).toBe(700_000n)
    expect(toUpPrice(300_000n, "UP")).toBe(300_000n)
  })
})

describe("walkBook", () => {
  const levels: BookLevel[] = [
    { price: 500_000n, quantity: 2n * M },
    { price: 600_000n, quantity: 2n * M },
  ]

  it("fills at the touch when depth suffices", () => {
    const r = walkBook(levels, M)
    expect(r.filled).toBe(M)
    expect(r.cost).toBe(500_000n) // 1.0 contract at 0.50
    expect(r.avgPrice).toBe(500_000n)
  })

  it("blends prices across levels", () => {
    // 2 @ 0.50 + 2 @ 0.60 = cost 2.2 for 4 → avg 0.55
    const r = walkBook(levels, 4n * M)
    expect(r.filled).toBe(4n * M)
    expect(r.cost).toBe(2_200_000n)
    expect(r.avgPrice).toBe(550_000n)
  })

  it("fills only what exists when the book is too thin", () => {
    const r = walkBook(levels, 10n * M)
    expect(r.filled).toBe(4n * M) // not 10
    expect(r.avgPrice).toBe(550_000n)
  })

  it("returns a null average price against an empty book", () => {
    const r = walkBook([], M)
    expect(r.filled).toBe(0n)
    expect(r.avgPrice).toBeNull()
  })
})

describe("quoteOverBook", () => {
  const book = buildOrderBook({
    marketId: "0x1",
    bids: [{ price: 400_000n, quantity: 5n * M }],
    asks: [
      { price: 600_000n, quantity: 1n * M },
      { price: 700_000n, quantity: 5n * M },
    ],
  })

  it("prices an UP buy against the asks and reports slippage vs the touch", () => {
    const q = quoteOverBook(book, "UP", 2n * M)
    expect(q.fillableQuantity).toBe(2n * M)
    // 1 @ 0.60 + 1 @ 0.70 = 1.30 for 2 → avg 0.65
    expect(q.avgPrice).toBe(650_000n)
    expect(q.cost).toBe(1_300_000n)
    // touch is 0.60; 0.65 is ~8.33% worse
    expect(q.slippage).toBeCloseTo(0.0833, 3)
    expect(q.insufficientLiquidity).toBe(false)
  })

  it("prices a DOWN buy against the mirrored bid side", () => {
    // Bids at UP 0.40 mean DOWN is available at 0.60.
    const q = quoteOverBook(book, "DOWN", M)
    expect(q.avgPrice).toBe(600_000n)
    expect(q.cost).toBe(600_000n)
  })

  it("flags insufficient liquidity instead of quoting a fill it cannot do", () => {
    const q = quoteOverBook(book, "UP", 100n * M)
    expect(q.insufficientLiquidity).toBe(true)
    expect(q.fillableQuantity).toBe(6n * M)
    expect(q.fillableQuantity).toBeLessThan(100n * M)
  })

  it("returns an unfillable quote against an empty book", () => {
    const empty = buildOrderBook({ marketId: "0x1", bids: [], asks: [] })
    const q = quoteOverBook(empty, "UP", M)
    expect(q.fillableQuantity).toBe(0n)
    expect(q.avgPrice).toBeNull()
    expect(q.slippage).toBeNull()
    expect(q.insufficientLiquidity).toBe(true)
  })
})

describe("contrarianEdge", () => {
  it("names the crowded side and prices the other from real book data", () => {
    // Mid 0.80 → market favours UP; DOWN costs 0.20 and returns 5x if right.
    const book = buildOrderBook({
      marketId: "0x1",
      bids: [{ price: 790_000n, quantity: M }],
      asks: [{ price: 810_000n, quantity: M }],
    })
    const edge = contrarianEdge(book)!
    expect(edge.crowdedSide).toBe("UP")
    expect(edge.contrarianSide).toBe("DOWN")
    expect(edge.upProbability).toBeCloseTo(0.8, 6)
    expect(edge.contrarianReturn).toBeCloseTo(5, 6)
  })

  it("flips when the market favours DOWN", () => {
    const book = buildOrderBook({
      marketId: "0x1",
      bids: [{ price: 190_000n, quantity: M }],
      asks: [{ price: 210_000n, quantity: M }],
    })
    const edge = contrarianEdge(book)!
    expect(edge.crowdedSide).toBe("DOWN")
    expect(edge.contrarianSide).toBe("UP")
    expect(edge.contrarianReturn).toBeCloseTo(5, 6)
  })

  it("is null without a mid — no market view means no crowd", () => {
    const oneSided = buildOrderBook({
      marketId: "0x1",
      bids: [{ price: 500_000n, quantity: M }],
      asks: [],
    })
    expect(contrarianEdge(oneSided)).toBeNull()
  })

  it("never claims an edge at the degenerate bounds", () => {
    // A mid pinned at certainty implies a division that would report an
    // infinite return. Refuse rather than render Infinity.
    const certain = buildOrderBook({
      marketId: "0x1",
      bids: [{ price: ONE_PROBABILITY, quantity: M }],
      asks: [{ price: ONE_PROBABILITY, quantity: M }],
    })
    expect(contrarianEdge(certain)).toBeNull()
  })
})

describe("cardPnl", () => {
  it("pays 1:1 on a win, netting out entry cost", () => {
    // Bought 1 contract at 0.40 and won → redeem 1.00, net +0.60.
    expect(
      cardPnl({
        direction: "UP",
        quantity: M,
        entryCost: 400_000n,
        winner: "UP",
        voided: false,
      })
    ).toBe(600_000n)
  })

  it("loses exactly the entry cost on a loss", () => {
    expect(
      cardPnl({
        direction: "UP",
        quantity: M,
        entryCost: 400_000n,
        winner: "DOWN",
        voided: false,
      })
    ).toBe(-400_000n)
  })

  it("refunds both sides at 0.5 when the market voids", () => {
    // Paid 0.40, refunded 0.50 → +0.10 regardless of the side taken.
    expect(
      cardPnl({
        direction: "UP",
        quantity: M,
        entryCost: 400_000n,
        winner: null,
        voided: true,
      })
    ).toBe(100_000n)
  })

  it("is symmetric: a duel is zero-sum only through real economics", () => {
    // Same market, opposite sides, both paying the mid. The winner's gain and
    // the loser's loss are set purely by price, with no score multiplier.
    const up = cardPnl({
      direction: "UP",
      quantity: M,
      entryCost: 500_000n,
      winner: "UP",
      voided: false,
    })
    const down = cardPnl({
      direction: "DOWN",
      quantity: M,
      entryCost: 500_000n,
      winner: "UP",
      voided: false,
    })
    expect(up).toBe(500_000n)
    expect(down).toBe(-500_000n)
    expect(up + down).toBe(0n)
  })
})

describe("totalDepth", () => {
  it("sums resting size", () => {
    expect(
      totalDepth([
        { price: 1n, quantity: 2n * M },
        { price: 2n, quantity: 3n * M },
      ])
    ).toBe(5n * M)
  })

  it("is 0 for an empty side", () => {
    expect(totalDepth([])).toBe(0n)
  })
})
