/**
 * Market discovery cache.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Discovery scans `MarketCreated` logs across hundreds of 1000-block windows,
 * because Somnia caps `eth_getLogs` and the venue publishes no event-contract
 * REST endpoint. Even fully parallelized that was MEASURED at ~26s against the
 * public RPC. Matchmaking cannot wait 26s to deal a deck.
 *
 * The key insight is that the two halves of a market have completely different
 * volatility:
 *
 *   - Its IDENTITY (id, pool, asset, question, strike, expiry, interval) is
 *     written once at creation and never changes.
 *   - Its STATE (status, finalized) changes constantly and decides whether an
 *     order can even be placed.
 *
 * So identity is cached for a long TTL and state is re-read every time. That
 * makes the steady-state cost one cheap state read per market instead of a
 * multi-hundred-request log scan, without ever serving a stale tradability
 * decision — which would be the dangerous kind of staleness.
 *
 * This mirrors the conflict rule in the master spec: canonical chain evidence
 * outranks server cache. We cache only the part of the record that is
 * immutable by construction.
 */
import type { EventMarket } from "./types"

/**
 * How long a discovered market's IDENTITY stays trusted.
 *
 * Long is safe: creation data is immutable. The bound exists so a market that
 * disappears from the venue eventually leaves the cache too.
 */
export const DEFAULT_IDENTITY_TTL_MS = 10 * 60 * 1000

/**
 * How long a full discovery sweep is reused before another is scheduled.
 *
 * Shorter than the identity TTL so newly created windows appear promptly —
 * short-dated markets are created every few minutes and a duel dealt from a
 * stale list would miss them.
 */
export const DEFAULT_SWEEP_TTL_MS = 60 * 1000

export interface CachedSweep<T> {
  value: T
  fetchedAtMs: number
}

/**
 * A single-flight, TTL'd cache around an expensive async producer.
 *
 * Single-flight matters more than the TTL here: when a match is made, several
 * callers ask for markets in the same instant. Without de-duplication that is
 * N concurrent 26-second log scans hammering the same RPC. With it, the first
 * caller pays and the rest await the same promise.
 */
export class SingleFlightCache<T> {
  private cached: CachedSweep<T> | null = null
  private inFlight: Promise<T> | null = null

  constructor(
    private readonly produce: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Cached value if fresh, otherwise produce one (de-duplicating callers). */
  async get(): Promise<T> {
    const cached = this.cached
    if (cached && this.now() - cached.fetchedAtMs < this.ttlMs) {
      return cached.value
    }
    return this.refresh()
  }

  /**
   * Force a refresh, still de-duplicated.
   *
   * On failure the previous value is KEPT and returned if we have one: a
   * transient RPC hiccup should degrade to slightly stale identity data, not
   * blank the market list mid-session. With nothing cached, the error
   * propagates so the caller can show an honest unavailable state.
   */
  async refresh(): Promise<T> {
    if (this.inFlight) return this.inFlight

    const flight = (async () => {
      try {
        const value = await this.produce()
        this.cached = { value, fetchedAtMs: this.now() }
        return value
      } catch (err) {
        if (this.cached) return this.cached.value
        throw err
      } finally {
        this.inFlight = null
      }
    })()

    this.inFlight = flight
    return flight
  }

  /** Cached value without triggering work, or null if absent/expired. */
  peek(): T | null {
    const cached = this.cached
    if (!cached) return null
    if (this.now() - cached.fetchedAtMs >= this.ttlMs) return null
    return cached.value
  }

  /** True when a value is cached and still fresh. */
  isFresh(): boolean {
    return this.peek() !== null
  }

  clear(): void {
    this.cached = null
  }
}

/**
 * Age of a market's identity record, for staleness decisions.
 */
export interface IdentityEntry {
  market: EventMarket
  fetchedAtMs: number
}

/**
 * Identity store for discovered markets.
 *
 * Holds only immutable creation data. Callers re-read live state before
 * acting on anything — see `SomniaDreamDexAdapter.getMarket`.
 */
export class MarketIdentityCache {
  private readonly entries = new Map<string, IdentityEntry>()

  constructor(
    private readonly ttlMs: number = DEFAULT_IDENTITY_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  set(market: EventMarket): void {
    this.entries.set(market.id, { market, fetchedAtMs: this.now() })
  }

  setAll(markets: readonly EventMarket[]): void {
    for (const m of markets) this.set(m)
  }

  get(id: string): EventMarket | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    if (this.now() - entry.fetchedAtMs >= this.ttlMs) {
      this.entries.delete(id)
      return null
    }
    return entry.market
  }

  has(id: string): boolean {
    return this.get(id) !== null
  }

  /** Drop expired entries. Safe to call periodically. */
  prune(): number {
    const cutoff = this.now() - this.ttlMs
    let removed = 0
    for (const [id, entry] of this.entries) {
      if (entry.fetchedAtMs <= cutoff) {
        this.entries.delete(id)
        removed++
      }
    }
    return removed
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
