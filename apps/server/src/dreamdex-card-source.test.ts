/**
 * DreamDEX card-source tests.
 *
 * The rule under protection is the one the master spec states outright:
 *
 *   > If fewer than 3 eligible markets: do not fabricate.
 *
 * So the important cases here are the refusals — too few markets, a market
 * that would expire mid-duel, a market not accepting orders — plus the
 * determinism the commit-reveal scheme depends on.
 */
import { describe, expect, it } from "bun:test"
import type { EventMarket } from "@workspace/dreamdex"
import { NoCardsAvailableError } from "./card-source"
import {
  MAX_DECK_SIZE,
  MIN_DECK_SIZE,
  buildDreamDexDeck,
  selectEligibleMarkets,
} from "./dreamdex-card-source"

const NOW = 1_800_000_000_000 // fixed clock

function market(overrides: Partial<EventMarket> & { id: string }): EventMarket {
  return {
    asset: "BTC",
    question: "BTC closes at or above its opening price",
    strike: 0n,
    intervalSec: 900,
    tradingStartSec: Math.floor(NOW / 1000),
    // Default: 15 minutes out — comfortably inside the playable band.
    expirySec: Math.floor(NOW / 1000) + 15 * 60,
    status: "TRADING",
    finalized: false,
    collateralDecimals: 6,
    handle: { pool: `0xpool${overrides.id}` },
    ...overrides,
  }
}

/** A fake adapter exposing only what the card source actually calls. */
function fakeAdapter(markets: EventMarket[] | Error) {
  return {
    listMarkets: async () => {
      if (markets instanceof Error) throw markets
      return markets
    },
  } as never
}

function manyMarkets(count: number): EventMarket[] {
  return Array.from({ length: count }, (_, i) =>
    market({
      id: `0x${i}`,
      // Stagger expiries so ordering is observable.
      expirySec: Math.floor(NOW / 1000) + (10 + i) * 60,
    })
  )
}

describe("selectEligibleMarkets", () => {
  it("keeps markets inside the playable window", () => {
    const eligible = selectEligibleMarkets(manyMarkets(4), NOW)
    expect(eligible).toHaveLength(4)
  })

  it("drops markets that would expire mid-duel", () => {
    // A card must survive reveal + both players swiping + lockup. One expiring
    // in 30s would be dealt and then immediately become unplayable.
    const tooSoon = market({
      id: "0xsoon",
      expirySec: Math.floor(NOW / 1000) + 30,
    })
    expect(selectEligibleMarkets([tooSoon], NOW)).toHaveLength(0)
  })

  it("drops markets too far out to resolve during a session", () => {
    const tooFar = market({
      id: "0xfar",
      expirySec: Math.floor(NOW / 1000) + 4 * 60 * 60,
      intervalSec: 14400,
    })
    expect(selectEligibleMarkets([tooFar], NOW)).toHaveLength(0)
  })

  it("drops markets that are not accepting orders", () => {
    // A future expiry does NOT imply the market is open.
    const locked = market({ id: "0xlocked", status: "LOCKED" })
    const resolved = market({ id: "0xresolved", status: "RESOLVED" })
    const finalized = market({ id: "0xfin", finalized: true })
    expect(
      selectEligibleMarkets([locked, resolved, finalized], NOW)
    ).toHaveLength(0)
  })

  it("deduplicates a market seen twice in discovery", () => {
    // Overlapping log windows can surface the same MarketCreated twice; two
    // cards on one market would show the same question and settle identically.
    const dupe = market({ id: "0xsame" })
    expect(selectEligibleMarkets([dupe, { ...dupe }], NOW)).toHaveLength(1)
  })

  it("orders soonest-settling first", () => {
    const out = selectEligibleMarkets(manyMarkets(4), NOW)
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.expirySec).toBeGreaterThanOrEqual(out[i - 1]!.expirySec)
    }
  })

  describe("themes", () => {
    it("crypto-turbo keeps only fast windows", () => {
      const fast = market({ id: "0xfast", intervalSec: 300 })
      const slow = market({
        id: "0xslow",
        intervalSec: 3600,
        expirySec: Math.floor(NOW / 1000) + 50 * 60,
      })
      const out = selectEligibleMarkets([fast, slow], NOW, "crypto-turbo")
      expect(out.map((m) => m.id)).toEqual(["0xfast"])
    })

    it("somnia-ecosystem matches nothing rather than quietly serving a crypto deck", () => {
      // The venue lists only BTC/ETH today. Serving those under an
      // "ecosystem" label would misrepresent the deck to the player.
      expect(
        selectEligibleMarkets(manyMarkets(4), NOW, "somnia-ecosystem")
      ).toHaveLength(0)
    })
  })
})

describe("buildDreamDexDeck", () => {
  const seed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

  it("deals one card per market, capped at the max deck size", async () => {
    const deck = await buildDreamDexDeck({
      adapter: fakeAdapter(manyMarkets(8)),
      seed,
      nowMs: NOW,
    })
    expect(deck.cards).toHaveLength(MAX_DECK_SIZE)
    expect(deck.source).toBe("dreamdex")

    const ids = deck.cards.map((c) => c.marketId)
    expect(new Set(ids).size).toBe(ids.length) // never the same market twice
  })

  it("deals exactly what exists when between the floor and the cap", async () => {
    const deck = await buildDreamDexDeck({
      adapter: fakeAdapter(manyMarkets(4)),
      seed,
      nowMs: NOW,
    })
    expect(deck.cards).toHaveLength(4)
  })

  it("REFUSES rather than padding when below the floor", async () => {
    // The spec's "do not fabricate" rule. Duplicating a market to reach 3
    // would be a fake deck.
    const promise = buildDreamDexDeck({
      adapter: fakeAdapter(manyMarkets(MIN_DECK_SIZE - 1)),
      seed,
      nowMs: NOW,
    })
    await expect(promise).rejects.toThrow(NoCardsAvailableError)
    await expect(promise).rejects.toThrow("DREAMDEX_NO_LIVE_MARKETS")
  })

  it("refuses when the venue itself is unreachable", async () => {
    const { VenueUnavailableError } = await import("@workspace/dreamdex")
    const promise = buildDreamDexDeck({
      adapter: fakeAdapter(new VenueUnavailableError("rpc down")),
      seed,
      nowMs: NOW,
    })
    await expect(promise).rejects.toThrow(NoCardsAvailableError)
    await expect(promise).rejects.toThrow("DREAMDEX_VENUE_UNAVAILABLE")
  })

  it("is deterministic for a given seed", async () => {
    // Commit-reveal depends on this: the server hashes the deck before reveal,
    // so the same seed must always produce the same deck or the commitment is
    // unverifiable.
    const markets = manyMarkets(8)
    const a = await buildDreamDexDeck({
      adapter: fakeAdapter(markets),
      seed,
      nowMs: NOW,
    })
    const b = await buildDreamDexDeck({
      adapter: fakeAdapter(markets),
      seed,
      nowMs: NOW,
    })
    expect(a.cards.map((c) => c.marketId)).toEqual(
      b.cards.map((c) => c.marketId)
    )
  })

  it("produces different decks for different seeds", async () => {
    // Otherwise every duel in the same minute is the identical deck.
    const markets = manyMarkets(10)
    const a = await buildDreamDexDeck({
      adapter: fakeAdapter(markets),
      seed,
      nowMs: NOW,
    })
    const b = await buildDreamDexDeck({
      adapter: fakeAdapter(markets),
      seed: new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]),
      nowMs: NOW,
    })
    expect(a.cards.map((c) => c.marketId)).not.toEqual(
      b.cards.map((c) => c.marketId)
    )
  })

  it("pairs each settle time with its card", async () => {
    // The keeper needs settleAtMs[i] to line up with cards[i]; a mismatch
    // would settle a card against the wrong market's clock.
    const deck = await buildDreamDexDeck({
      adapter: fakeAdapter(manyMarkets(5)),
      seed,
      nowMs: NOW,
    })
    expect(deck.settleAtMs).toHaveLength(deck.cards.length)
    deck.cards.forEach((card, i) => {
      expect(deck.settleAtMs[i]).toBe(card.expiryMs)
    })
  })

  it("orders the dealt cards soonest-settling first", async () => {
    const deck = await buildDreamDexDeck({
      adapter: fakeAdapter(manyMarkets(8)),
      seed,
      nowMs: NOW,
    })
    for (let i = 1; i < deck.cards.length; i++) {
      expect(deck.cards[i]!.expiryMs).toBeGreaterThanOrEqual(
        deck.cards[i - 1]!.expiryMs
      )
    }
  })

  it("carries the venue pool so the swipe path needs no re-lookup", async () => {
    const deck = await buildDreamDexDeck({
      adapter: fakeAdapter(manyMarkets(4)),
      seed,
      nowMs: NOW,
    })
    for (const card of deck.cards) {
      expect(card.pool).toMatch(/^0xpool/)
      expect(card.question.length).toBeGreaterThan(0)
    }
  })
})
