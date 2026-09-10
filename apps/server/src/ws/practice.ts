/**
 * Practice Mode handler — solo vs. bot, no chain commit, no queue.
 *
 * PRD §Game modes: "Practice is a single-player on-ramp — it shares the
 * swipe UI but does not enter matchmaking or touch the chain."
 *
 * Server returns a SYNTHETIC 5-card deck — no DeepBook markets, no
 * commit-reveal. Strikes are placed around the live Pyth BTC spot with the
 * same digital-BS model as real deck-gen (`buildPracticeDeck`), but at
 * 15–45s horizons so the price genuinely crosses them during the client's
 * 45s lockup. Plus 5 pre-decided bot swipes (random 50/50).
 *
 * Once the deck is sent, the client owns the rest: swiping, the bot
 * reveal, the lockup clock, per-card settlement against the `spot_tick`
 * stream, and the result. Nothing touches the chain or the DB.
 */
import type { ServerWebSocket } from "bun"
import { buildPracticeDeck, deriveSeed, hashToHex } from "../deckmaster"
import { makeLogger, shortId } from "../log"
import type { SocketState } from "./matchmaking"
import { currentPracticeSpot } from "./market-stream"
import { _sendInternal } from "./matchmaking"

const log = makeLogger("practice")

export async function handlePracticeStart(
  ws: ServerWebSocket<SocketState>
): Promise<void> {
  // Practice is FULLY SIMULATED — no stake, no chain write, no wallet needed.
  // It used to require an address, which meant the one mode built for people
  // who have not connected yet was the one mode they could not open. Anonymous
  // sockets get a session seeded from their socket identity instead.
  const sender =
    ws.data.address ?? `anon-${Math.random().toString(36).slice(2, 10)}`
  try {
    // Same source the practice tick stream uses, so the deck and the ticks it
    // settles against are one series. `readBtcSpot()` is NOT used: it throws
    // SPOT_UNAVAILABLE by design (live DreamDEX decks carry their own strike
    // and need no spot), which crashed practice with a developer-facing error.
    const spot = await currentPracticeSpot()
    const nonceHex = hashToHex(crypto.getRandomValues(new Uint8Array(16)))
    const seed = deriveSeed({
      sender,
      asset: "BTC",
      timestampMs: Date.now(),
      nonceHex,
    })
    const cards = buildPracticeDeck(spot, seed)
    const botSwipes = cards.map(() => Math.random() > 0.5)
    log.info(
      `practice for ${shortId(sender)} — ${cards.length} synthetic cards @ spot ${spot}`
    )
    _sendInternal(ws, {
      type: "practice_session",
      cards: cards.map((c) => ({
        strike: c.strike.toString(),
        expiryOffsetMs: c.expiryOffsetMs,
        pUp: c.pUp,
      })),
      botSwipes,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.warn(`practice failed for ${shortId(sender)}: ${msg}`)
    _sendInternal(ws, {
      type: "error",
      code: "practice_failed",
      message: msg,
    })
  }
}
