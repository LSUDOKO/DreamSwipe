/**
 * Market-cache tests.
 *
 * The behaviours here are the ones that keep discovery both fast and honest:
 * de-duplicating concurrent callers (the reason a 17s scan does not become
 * five 17s scans), and holding the last good value through a transient RPC
 * failure rather than blanking the market list mid-session.
 *
 * Time is injected so these run instantly and deterministically.
 */
import { describe, expect, it } from "bun:test"
import { MarketIdentityCache, SingleFlightCache } from "./market-cache"
import type { EventMarket } from "./types"

function makeClock(startMs = 1_000_000) {
  let now = startMs
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

function market(id: string): EventMarket {
  return {
    id,
    asset: "BTC",
    question: "BTC closes at or above its opening price",
    strike: 0n,
    intervalSec: 300,
    tradingStartSec: 1_700_000_000,
    expirySec: 1_700_000_300,
    status: "TRADING",
    finalized: false,
    collateralDecimals: 6,
    handle: { pool: "0xpool" },
  }
}

describe("SingleFlightCache", () => {
  it("produces once and serves the cached value within the TTL", async () => {
    const clock = makeClock()
    let calls = 0
    const cache = new SingleFlightCache(
      async () => {
        calls++
        return calls
      },
      1000,
      clock.now
    )

    expect(await cache.get()).toBe(1)
    expect(await cache.get()).toBe(1)
    expect(calls).toBe(1)
  })

  it("re-produces after the TTL expires", async () => {
    const clock = makeClock()
    let calls = 0
    const cache = new SingleFlightCache(async () => ++calls, 1000, clock.now)

    expect(await cache.get()).toBe(1)
    clock.advance(1001)
    expect(await cache.get()).toBe(2)
    expect(calls).toBe(2)
  })

  it("de-duplicates concurrent callers into ONE production", async () => {
    // This is the property that stops a matchmaking burst from firing N
    // simultaneous multi-second log scans at the same RPC.
    const clock = makeClock()
    let calls = 0
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      release = r
    })

    const cache = new SingleFlightCache(
      async () => {
        calls++
        await gate
        return "value"
      },
      1000,
      clock.now
    )

    const all = Promise.all([
      cache.get(),
      cache.get(),
      cache.get(),
      cache.get(),
      cache.get(),
    ])
    release!()
    const results = await all

    expect(calls).toBe(1)
    expect(results).toEqual(["value", "value", "value", "value", "value"])
  })

  it("keeps serving the last good value when a refresh fails", async () => {
    // A transient RPC hiccup should degrade to slightly stale identity data,
    // never to an empty market list.
    const clock = makeClock()
    let attempt = 0
    const cache = new SingleFlightCache(
      async () => {
        attempt++
        if (attempt === 1) return "good"
        throw new Error("rpc down")
      },
      1000,
      clock.now
    )

    expect(await cache.get()).toBe("good")
    clock.advance(2000)
    expect(await cache.get()).toBe("good") // survived the failure
  })

  it("propagates the error when there is nothing cached to fall back on", async () => {
    // With no prior value the caller MUST see the failure so it can render an
    // honest unavailable state instead of an empty lobby.
    const cache = new SingleFlightCache(async () => {
      throw new Error("rpc down")
    }, 1000)

    await expect(cache.get()).rejects.toThrow("rpc down")
  })

  it("recovers on a later attempt after a failure", async () => {
    const clock = makeClock()
    let attempt = 0
    const cache = new SingleFlightCache(
      async () => {
        attempt++
        if (attempt === 1) throw new Error("transient")
        return "recovered"
      },
      1000,
      clock.now
    )

    await expect(cache.get()).rejects.toThrow("transient")
    expect(await cache.get()).toBe("recovered")
  })

  it("peek does not trigger work and respects the TTL", async () => {
    const clock = makeClock()
    let calls = 0
    const cache = new SingleFlightCache(async () => ++calls, 1000, clock.now)

    expect(cache.peek()).toBeNull()
    expect(calls).toBe(0)

    await cache.get()
    expect(cache.peek()).toBe(1)
    expect(cache.isFresh()).toBe(true)

    clock.advance(1001)
    expect(cache.peek()).toBeNull()
    expect(cache.isFresh()).toBe(false)
    expect(calls).toBe(1) // peek never produced
  })

  it("clear forces the next get to re-produce", async () => {
    let calls = 0
    const cache = new SingleFlightCache(async () => ++calls, 100_000)
    await cache.get()
    cache.clear()
    await cache.get()
    expect(calls).toBe(2)
  })
})

describe("MarketIdentityCache", () => {
  it("stores and returns markets within the TTL", () => {
    const clock = makeClock()
    const cache = new MarketIdentityCache(1000, clock.now)
    cache.set(market("0xa"))
    expect(cache.get("0xa")?.id).toBe("0xa")
    expect(cache.has("0xa")).toBe(true)
  })

  it("expires entries past the TTL", () => {
    const clock = makeClock()
    const cache = new MarketIdentityCache(1000, clock.now)
    cache.set(market("0xa"))
    clock.advance(1001)
    expect(cache.get("0xa")).toBeNull()
    expect(cache.has("0xa")).toBe(false)
  })

  it("returns null for an unknown id", () => {
    expect(new MarketIdentityCache().get("0xmissing")).toBeNull()
  })

  it("setAll ingests a whole sweep", () => {
    const cache = new MarketIdentityCache()
    cache.setAll([market("0xa"), market("0xb")])
    expect(cache.size).toBe(2)
  })

  it("prune drops only expired entries", () => {
    const clock = makeClock()
    const cache = new MarketIdentityCache(1000, clock.now)
    cache.set(market("0xold"))
    clock.advance(1001)
    cache.set(market("0xnew"))

    expect(cache.prune()).toBe(1)
    expect(cache.get("0xnew")?.id).toBe("0xnew")
    expect(cache.get("0xold")).toBeNull()
  })
})
