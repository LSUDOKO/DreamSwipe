/**
 * Bot Arena tests.
 *
 * Two things are being protected here:
 *
 *  1. Each strategy actually implements its stated thesis — Momentum follows,
 *     Mean Reversion fades, CLOB Imbalance reads depth. A bot whose rationale
 *     does not match its behaviour is worse than no bot, because the player is
 *     shown a lie about how it decided.
 *  2. Agents degrade HONESTLY. With no book or no history they must report
 *     zero confidence and say they are guessing, never manufacture a signal.
 */
import { describe, expect, it } from "bun:test"
import {
  ClobImbalanceAgent,
  ContrarianAgent,
  MeanReversionAgent,
  MomentumAgent,
  STRATEGIES,
  createAgent,
  type PredictionContext,
} from "./agents"
import { buildOrderBook } from "./book-math"
import type { OrderBook } from "./types"

const M = 1_000_000n

function ctx(overrides: Partial<PredictionContext> = {}): PredictionContext {
  return {
    marketId: "0x1",
    asset: "BTC",
    question: "BTC closes at or above its opening price",
    book: null,
    midHistory: [],
    msToExpiry: 5 * 60 * 1000,
    intervalSec: 300,
    ...overrides,
  }
}

function bookAt(
  upProbability: number,
  bidDepth = 5n * M,
  askDepth = 5n * M
): OrderBook {
  const mid = BigInt(Math.round(upProbability * 1_000_000))
  return buildOrderBook({
    marketId: "0x1",
    bids: [{ price: mid - 10_000n, quantity: bidDepth }],
    asks: [{ price: mid + 10_000n, quantity: askDepth }],
  })
}

describe("MomentumAgent", () => {
  // "hard" difficulty acts on any signal, so these assert the raw thesis
  // rather than the difficulty gate.
  const agent = new MomentumAgent("hard")

  it("backs UP when the mid has been drifting up", async () => {
    const d = await agent.decide(
      ctx({ midHistory: [400_000n, 420_000n, 460_000n, 500_000n] })
    )
    expect(d.direction).toBe("UP")
    expect(d.confidence).toBeGreaterThan(0)
  })

  it("backs DOWN when the mid has been drifting down", async () => {
    const d = await agent.decide(
      ctx({ midHistory: [600_000n, 560_000n, 520_000n, 480_000n] })
    )
    expect(d.direction).toBe("DOWN")
  })

  it("reports no signal with too little history instead of guessing loudly", async () => {
    const d = await agent.decide(ctx({ midHistory: [500_000n] }))
    expect(d.confidence).toBe(0)
    expect(d.rationale).toContain("No usable signal")
  })

  it("scales confidence with the size of the move", async () => {
    const small = await agent.decide(
      ctx({ midHistory: [500_000n, 500_000n, 502_000n, 503_000n] })
    )
    const large = await agent.decide(
      ctx({ midHistory: [300_000n, 300_000n, 700_000n, 800_000n] })
    )
    expect(large.confidence).toBeGreaterThan(small.confidence)
  })
})

describe("MeanReversionAgent", () => {
  const agent = new MeanReversionAgent("hard")

  it("fades a market stretched toward UP", async () => {
    // Market says 85% UP — mean reversion takes the other side.
    const d = await agent.decide(ctx({ book: bookAt(0.85) }))
    expect(d.direction).toBe("DOWN")
    expect(d.rationale).toContain("stretched")
  })

  it("fades a market stretched toward DOWN", async () => {
    const d = await agent.decide(ctx({ book: bookAt(0.15) }))
    expect(d.direction).toBe("UP")
  })

  it("has low conviction near an even market", async () => {
    const d = await agent.decide(ctx({ book: bookAt(0.51) }))
    expect(d.confidence).toBeLessThan(0.2)
  })

  it("reports no signal without a two-sided book", async () => {
    const d = await agent.decide(ctx({ book: null }))
    expect(d.confidence).toBe(0)
  })

  it("takes the OPPOSITE side to momentum on the same stretched market", async () => {
    // The two theses must genuinely disagree, otherwise the arena offers no
    // real variety of opponent.
    const stretched = ctx({
      book: bookAt(0.9),
      midHistory: [500_000n, 700_000n, 850_000n, 900_000n],
    })
    const mr = await new MeanReversionAgent("hard").decide(stretched)
    const mom = await new MomentumAgent("hard").decide(stretched)
    expect(mr.direction).not.toBe(mom.direction)
  })
})

describe("ClobImbalanceAgent", () => {
  const agent = new ClobImbalanceAgent("hard")

  it("backs UP when bid depth dominates", async () => {
    const d = await agent.decide(ctx({ book: bookAt(0.5, 20n * M, 2n * M) }))
    expect(d.direction).toBe("UP")
    expect(d.confidence).toBeGreaterThan(0.5)
  })

  it("backs DOWN when ask depth dominates", async () => {
    const d = await agent.decide(ctx({ book: bookAt(0.5, 2n * M, 20n * M) }))
    expect(d.direction).toBe("DOWN")
  })

  it("refuses to read imbalance off a too-thin book", async () => {
    // Two tiny orders can read as ±1.0 and mean nothing — the spec asks for a
    // depth threshold precisely to stop that.
    const thin = buildOrderBook({
      marketId: "0x1",
      bids: [{ price: 490_000n, quantity: 100n }],
      asks: [],
    })
    const d = await agent.decide(ctx({ book: thin }))
    expect(d.confidence).toBe(0)
    expect(d.rationale).toContain("too thin")
  })

  it("reports no signal without a book", async () => {
    const d = await agent.decide(ctx({ book: null }))
    expect(d.confidence).toBe(0)
  })
})

describe("ContrarianAgent", () => {
  const agent = new ContrarianAgent("hard")

  it("always takes the less crowded side", async () => {
    expect((await agent.decide(ctx({ book: bookAt(0.8) }))).direction).toBe(
      "DOWN"
    )
    expect((await agent.decide(ctx({ book: bookAt(0.2) }))).direction).toBe(
      "UP"
    )
  })

  it("quotes the real payout multiple from live pricing", async () => {
    const d = await agent.decide(ctx({ book: bookAt(0.8) }))
    // Backing the 0.20 side returns ~5x. This comes from the book, not a
    // promised bonus.
    expect(d.rationale).toMatch(/5\.\d+x/)
  })
})

describe("difficulty", () => {
  it("makes an easy bot sit out weak signals", async () => {
    // Same information, weaker action — difficulty must never change what the
    // bot can SEE, only how decisively it acts.
    const weak = ctx({ midHistory: [500_000n, 500_000n, 501_000n, 501_500n] })
    const easy = await new MomentumAgent("easy").decide(weak)
    const hard = await new MomentumAgent("hard").decide(weak)

    expect(easy.confidence).toBe(0)
    expect(hard.confidence).toBeGreaterThan(0)
  })

  it("lets a hard bot act on a signal an easy bot would skip", async () => {
    const moderate = ctx({
      midHistory: [500_000n, 510_000n, 520_000n, 530_000n],
    })
    const hard = await new MomentumAgent("hard").decide(moderate)
    expect(hard.confidence).toBeGreaterThan(0)
  })
})

describe("fairness", () => {
  it("PredictionContext cannot carry outcome information", () => {
    // The structural guarantee behind specs/07: an agent cannot see the future
    // because the context has nowhere to put it. If someone later adds a
    // `winner` or `settlementPrice` field, this test is the tripwire.
    const context = ctx()
    const keys = Object.keys(context).sort()
    expect(keys).toEqual([
      "asset",
      "book",
      "intervalSec",
      "marketId",
      "midHistory",
      "msToExpiry",
      "question",
    ])
    expect(keys).not.toContain("winner")
    expect(keys).not.toContain("settlementPrice")
    expect(keys).not.toContain("resolved")
  })

  it("every strategy decides from context alone and always returns a side", async () => {
    // Even with nothing to go on, an agent must return a playable decision —
    // a duel cannot stall because a bot declined to answer.
    for (const name of STRATEGIES) {
      const agent = createAgent(name)
      const d = await agent.decide(ctx())
      expect(["UP", "DOWN"]).toContain(d.direction)
      expect(d.confidence).toBeGreaterThanOrEqual(0)
      expect(d.confidence).toBeLessThanOrEqual(1)
      expect(d.rationale.length).toBeGreaterThan(0)
    }
  })

  it("exposes a name and description for every strategy", async () => {
    for (const name of STRATEGIES) {
      const agent = createAgent(name)
      expect(agent.name.length).toBeGreaterThan(0)
      expect(agent.description.length).toBeGreaterThan(0)
    }
  })
})
