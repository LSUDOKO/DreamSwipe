/**
 * Where a deck's cards come from.
 *
 * ── Why this seam exists ────────────────────────────────────────────────────
 *
 * Historically the deck was welded to DeepBook Predict: discovery hit that
 * indexer, and each card was a bet on one live `ExpiryMarket`. That made a
 * third-party service a single point of failure for the whole game — and on
 * 2026-08-17 it failed totally. The venue stopped creating markets, its read
 * API was torn down, and both tiers were unplayable for ~12 days.
 *
 * This module keeps a seam between "what are the cards" and "run a duel", so
 * the engine is never welded to one venue again. It is deliberately NOT a
 * second game: every source emits the same `DeckCardOut[]`, and everything
 * downstream (commit-reveal, swipe, lockup, settle, finalize) is one code
 * path — the "two tiers share one engine" invariant in CLAUDE.md.
 *
 * ── After the Somnia migration ──────────────────────────────────────────────
 *
 * The `predict` (DeepBook) and `pyth` sources are gone with the Sui chain
 * layer. `dreamdex` replaces them: one card per live DreamDEX event contract,
 * which is a simpler mapping than before because a market already IS a binary
 * question with its own strike and expiry.
 *
 * The seam is kept rather than collapsed. It costs almost nothing, and the
 * outage it was built for is exactly the kind of thing that happens twice.
 */
import type { DeckCardOut } from "./deckmaster"
import { buildDreamDexDeck } from "./dreamdex-card-source"
import { SomniaDreamDexAdapter } from "@workspace/dreamdex/adapter"
import { makeLogger } from "./log"

const log = makeLogger("cards")

export type DeckSourceName = "dreamdex"

/**
 * A built deck, plus the per-card settle times the keeper needs.
 *
 * `settleAtMs[i]` pairs with `cards[i]`. It is carried separately because a
 * card's settle time is not stored on chain — the contract's `Card` is
 * `(marketId, strike)` only — so the server is the only place that knows when
 * to expect settlement. Persisted alongside the deck plaintext (`rememberDeck`).
 */
export interface BuiltDeck {
  cards: DeckCardOut[]
  settleAtMs: number[]
  source: DeckSourceName
}

export interface BuildDeckInput {
  seed: Uint8Array
  /** Duel tier. Free and staked deal from the same source. */
  tier: string
  nowMs: number
}

export interface CardSource {
  readonly name: DeckSourceName
  build(input: BuildDeckInput): Promise<BuiltDeck>
}

/**
 * Thrown when a source genuinely has nothing to build from.
 *
 * Distinct and greppable on purpose: a generic "market list failed" is part of
 * how a 12-day upstream outage went unnoticed. Callers surface this as an
 * honest "no live markets" state rather than dealing a fabricated deck.
 */
export class NoCardsAvailableError extends Error {
  constructor(
    readonly source: DeckSourceName,
    message: string
  ) {
    super(message)
    this.name = "NoCardsAvailableError"
  }
}

/** Shared adapter, so every deck reuses the single-flight market cache. */
let adapter: SomniaDreamDexAdapter | null = null
function getAdapter(): SomniaDreamDexAdapter {
  adapter ??= new SomniaDreamDexAdapter({
    rpcUrl: process.env.SOMNIA_RPC_URL,
    wsRpcUrl: process.env.SOMNIA_WS_RPC_URL,
    indexerUrl: process.env.DREAMDEX_INDEXER_URL,
  })
  return adapter
}

/**
 * Live DreamDEX event contracts — one card per market.
 *
 * Refuses rather than pads when fewer than three eligible markets are live;
 * see `dreamdex-card-source.ts` for the selection rules.
 */
export const dreamdexCardSource: CardSource = {
  name: "dreamdex",

  async build({ seed, nowMs }: BuildDeckInput): Promise<BuiltDeck> {
    const deck = await buildDreamDexDeck({
      adapter: getAdapter(),
      seed,
      nowMs,
    })

    // Map the venue's card shape onto the deck vocabulary the engine speaks.
    // `lowerTick`/`higherTick` were a DeepBook artifact (a strike had to be
    // expressed as a tick range); DreamDEX markets carry their own strike, so
    // they are zeroed rather than invented.
    const cards: DeckCardOut[] = deck.cards.map((c) => ({
      expiryMarketId: c.marketId,
      strike: c.strike,
      lowerTick: 0n,
      higherTick: 0n,
      // The venue asks "closes at or above its opening price", so neither side
      // is structurally favoured — unlike the old strike-vs-spot placement.
      isUpFavored: false,
    }))

    log.info(
      `built ${cards.length}-card deck from dreamdex ` +
        `(${deck.cards.map((c) => `${c.asset}/${c.intervalSec / 60}m`).join(", ")})`
    )

    return { cards, settleAtMs: deck.settleAtMs, source: "dreamdex" }
  },
}

/**
 * Build a deck from the configured source.
 *
 * Only one source exists today, but the indirection is kept so adding a second
 * (or a fallback) does not mean touching matchmaking again.
 */
export async function buildDeckFromSource(
  input: BuildDeckInput
): Promise<BuiltDeck> {
  return dreamdexCardSource.build(input)
}
