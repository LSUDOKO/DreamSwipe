/**
 * DreamDEX card source — deals a duel deck from live Somnia event contracts.
 *
 * ── Why this slots in rather than replacing anything ────────────────────────
 *
 * `card-source.ts` already defines the seam this plugs into. That seam exists
 * because this project lost ~12 days of playability when a third-party venue
 * was torn down, and the fix was to make "what are the cards" swappable
 * without touching "run a duel". DreamDEX becomes a third source alongside
 * `predict` and `pyth`; commit-reveal, swipe, lockup, settle and finalize stay
 * one code path.
 *
 * ── One card per market, never padded ──────────────────────────────────────
 *
 * A DreamDEX event contract already IS a binary question with its own strike
 * and expiry, so a card maps 1:1 onto a market. That is simpler than the
 * DeepBook model, where one market was sliced into several strikes.
 *
 * The consequence is that deck size is bounded by how many distinct eligible
 * markets are actually live. `specs/00_MASTER_SPEC.md` is explicit:
 *
 *   > If fewer than 3 eligible markets: do not fabricate. Show waiting/fallback.
 *
 * So this NEVER duplicates a market to reach a target size. Two cards on the
 * same market would show the player the same question twice and settle
 * identically — a fake deck. Below the floor it throws
 * `NoCardsAvailableError`, which the existing `auto` fallback already knows how
 * to handle.
 */
import {
  SomniaDreamDexAdapter,
  VenueUnavailableError,
  type EventMarket,
} from "@workspace/dreamdex"
import { NoCardsAvailableError, type BuiltDeck } from "./card-source"
import { makeLogger } from "./log"

const log = makeLogger("dreamdex-cards")

/** Deck bounds from the master spec: `clamp(eligibleMarkets.length, 3, 5)`. */
export const MIN_DECK_SIZE = 3
export const MAX_DECK_SIZE = 5

/**
 * Minimum time a card needs before its market expires.
 *
 * A card must survive the whole flow — reveal, both players swiping, then
 * lockup — before it settles. Dealing a market that expires mid-swipe would
 * hand the player a card they cannot actually act on.
 */
export const MIN_HEADROOM_MS = 90_000

/**
 * Maximum time to settlement.
 *
 * A duel that cannot resolve for four hours is not a game. Long-dated windows
 * are excluded so a match reaches a result while the players are still there.
 */
export const MAX_HORIZON_MS = 75 * 60 * 1000

/** Themed decks (`specs/00_MASTER_SPEC.md` §Themed decks). */
export type DeckTheme =
  | "crypto-turbo"
  | "somnia-ecosystem"
  | "high-liquidity"
  | "any"

export interface DreamDexDeckCard {
  /** Venue market id — the on-chain `bytes32`, used as the card's identity. */
  marketId: string
  asset: string
  question: string
  strike: bigint
  /** Unix ms when this market settles. */
  expiryMs: number
  intervalSec: number
  /** Venue pool, carried so the swipe path can route an order without a re-lookup. */
  pool: string
}

export interface DreamDexBuiltDeck extends Omit<BuiltDeck, "cards" | "source"> {
  cards: DreamDexDeckCard[]
  settleAtMs: number[]
  source: "dreamdex"
}

/**
 * Deterministic shuffle from the duel seed.
 *
 * The deck MUST be reproducible from the seed: the server commits a hash
 * before reveal, and a non-deterministic order would make that commitment
 * unverifiable. Uses the seed bytes as a keystream over Fisher-Yates.
 */
function seededShuffle<T>(items: T[], seed: Uint8Array): T[] {
  const out = [...items]
  if (seed.length === 0) return out
  for (let i = out.length - 1; i > 0; i--) {
    // Two seed bytes per step gives enough range for realistic deck sizes.
    const hi = seed[(i * 2) % seed.length] ?? 0
    const lo = seed[(i * 2 + 1) % seed.length] ?? 0
    const j = ((hi << 8) | lo) % (i + 1)
    const a = out[i]!
    const b = out[j]!
    out[i] = b
    out[j] = a
  }
  return out
}

/**
 * Filter live markets down to ones a duel can actually be played on.
 *
 * Every rule here exists to avoid dealing a card that would fail later:
 * expired mid-duel, unresolvable within the session, or not accepting orders.
 */
export function selectEligibleMarkets(
  markets: EventMarket[],
  nowMs: number,
  theme: DeckTheme = "any"
): EventMarket[] {
  const eligible = markets.filter((m) => {
    if (m.status !== "TRADING") return false
    if (m.finalized) return false

    const msToExpiry = m.expirySec * 1000 - nowMs
    if (msToExpiry < MIN_HEADROOM_MS) return false
    if (msToExpiry > MAX_HORIZON_MS) return false

    if (theme === "crypto-turbo") {
      // Fast windows only — the arcade-paced deck.
      return m.intervalSec <= 900
    }
    if (theme === "somnia-ecosystem") {
      // Reserved for Somnia-native assets. The venue currently lists only
      // BTC/ETH, so this deliberately matches nothing rather than quietly
      // serving a crypto deck under a different name.
      return false
    }
    return true
  })

  // One card per market: dedupe defensively in case discovery returned the
  // same market twice across overlapping log windows.
  const seen = new Set<string>()
  const unique: EventMarket[] = []
  for (const m of eligible) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    unique.push(m)
  }

  // Soonest-settling first, so a duel resolves as promptly as possible.
  unique.sort((a, b) => a.expirySec - b.expirySec)
  return unique
}

/**
 * Build a deck from live DreamDEX markets.
 *
 * Throws `NoCardsAvailableError` when fewer than `MIN_DECK_SIZE` eligible
 * markets exist, so callers can degrade honestly instead of dealing a padded
 * deck.
 */
export async function buildDreamDexDeck(input: {
  adapter: SomniaDreamDexAdapter
  seed: Uint8Array
  nowMs: number
  theme?: DeckTheme
}): Promise<DreamDexBuiltDeck> {
  const { adapter, seed, nowMs, theme = "any" } = input

  let markets: EventMarket[]
  try {
    markets = await adapter.listMarkets({ tradingOnly: true })
  } catch (err) {
    if (err instanceof VenueUnavailableError) {
      // Distinct and greppable on purpose — a generic "market list failed" is
      // part of how a 12-day upstream outage went unnoticed last time.
      throw new NoCardsAvailableError(
        "predict",
        `DREAMDEX_VENUE_UNAVAILABLE: ${err.message}`
      )
    }
    throw err
  }

  const eligible = selectEligibleMarkets(markets, nowMs, theme)

  if (eligible.length < MIN_DECK_SIZE) {
    throw new NoCardsAvailableError(
      "predict",
      `DREAMDEX_NO_LIVE_MARKETS: only ${eligible.length} eligible market(s) ` +
        `(need ${MIN_DECK_SIZE}) for theme "${theme}" — the venue may have no ` +
        `live windows in the ${MIN_HEADROOM_MS / 1000}s–${MAX_HORIZON_MS / 60000}m band right now.`
    )
  }

  // clamp(eligible, 3, 5), never padded above what really exists.
  const deckSize = Math.min(eligible.length, MAX_DECK_SIZE)

  // Shuffle the eligible pool before slicing so two duels dealt in the same
  // minute do not always get an identical deck, then re-sort the chosen cards
  // by settle time so the player swipes toward the soonest resolution.
  const chosen = seededShuffle(eligible, seed).slice(0, deckSize)
  chosen.sort((a, b) => a.expirySec - b.expirySec)

  const cards: DreamDexDeckCard[] = chosen.map((m) => ({
    marketId: m.id,
    asset: m.asset,
    question: m.question,
    strike: m.strike,
    expiryMs: m.expirySec * 1000,
    intervalSec: m.intervalSec,
    pool: m.handle.pool,
  }))

  log.info(
    `dealt ${cards.length} card(s) from ${eligible.length} eligible market(s) ` +
      `(theme=${theme}): ${cards.map((c) => `${c.asset}/${c.intervalSec / 60}m`).join(", ")}`
  )

  return {
    cards,
    settleAtMs: cards.map((c) => c.expiryMs),
    source: "dreamdex",
  }
}
