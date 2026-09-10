/**
 * Bot Arena HTTP API.
 *
 * Serves a live deck plus the market context a bot is allowed to see.
 *
 * ── Why the browser does not do this itself ─────────────────────────────────
 *
 * Market discovery is a multi-hundred-request `getLogs` scan (Somnia caps
 * `getLogs` at 1000 blocks and publishes no event-contract REST endpoint).
 * Running that per player would hammer the public RPC and take ~17s on a cold
 * cache. The server already holds a single-flight cache, so it answers from
 * warm state in ~1.5s and every player shares the work.
 *
 * ── The fairness boundary is here, not in the client ────────────────────────
 *
 * This endpoint returns ONLY what a human sees on the swipe card: the
 * question, the live book summary, recent mid history, and time to expiry.
 * It deliberately does not return settlement, outcome, or anything derived
 * from the future — see `specs/07_BOT_ARENA.md`. A client-side bot therefore
 * cannot cheat even if it wanted to, because the data never leaves the server.
 */
import { SomniaDreamDexAdapter } from "@workspace/dreamdex/adapter"
import { VenueUnavailableError } from "@workspace/dreamdex"
import { buildDreamDexDeck } from "./dreamdex-card-source"
import { makeLogger } from "./log"

const log = makeLogger("bot-arena")

/** Shared adapter: reuses the single-flight market cache across requests. */
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
 * Rolling mid history per market, sampled as decks are served.
 *
 * Momentum needs a price series, and the venue exposes no historical endpoint
 * for event contracts. Rather than fabricate one, the server remembers the
 * mids it has genuinely observed. Early in a market's life this is short or
 * empty — and the Momentum agent correctly reports "no usable signal" instead
 * of inventing a trend.
 */
const MID_HISTORY_LIMIT = 12
const midHistory = new Map<string, bigint[]>()

function recordMid(marketId: string, mid: bigint | null): bigint[] {
  if (mid === null) return midHistory.get(marketId) ?? []
  const series = midHistory.get(marketId) ?? []
  series.push(mid)
  if (series.length > MID_HISTORY_LIMIT) series.shift()
  midHistory.set(marketId, series)
  return series
}

function json(body: unknown, status = 200): Response {
  return new Response(
    // bigint is not JSON-serializable; every numeric field crossing the wire
    // becomes a decimal string and the client re-widens it.
    JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    {
      status,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      },
    }
  )
}

/**
 * `GET /bot-arena/deck` — a live deck with per-card market context.
 *
 * Returns 503 when the venue genuinely has too few live windows, so the client
 * can show an honest "try again shortly" rather than an empty board.
 */
export async function handleBotArenaRequest(
  req: Request
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== "/bot-arena/deck") return null
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405)

  const ex = getAdapter()

  try {
    const deck = await buildDreamDexDeck({
      adapter: ex,
      seed: crypto.getRandomValues(new Uint8Array(32)),
      nowMs: Date.now(),
    })

    const nowMs = Date.now()
    const cards = await Promise.all(
      deck.cards.map(async (card) => {
        // A book read can fail per-market; one bad market must not fail the
        // whole deck, so the card degrades to "no quotes" instead.
        let mid: bigint | null = null
        let bidDepth = 0n
        let askDepth = 0n
        try {
          const book = await ex.getOrderBook(card.marketId)
          mid = book.mid
          bidDepth = book.bidDepth
          askDepth = book.askDepth
        } catch {
          // leave the honest empty state
        }

        return {
          marketId: card.marketId,
          asset: card.asset,
          question: card.question,
          intervalSec: card.intervalSec,
          msToExpiry: card.expiryMs - nowMs,
          mid,
          midHistory: recordMid(card.marketId, mid),
          bidDepth,
          askDepth,
        }
      })
    )

    return json({ cards })
  } catch (err) {
    if (
      err instanceof VenueUnavailableError ||
      (err as Error).name === "NoCardsAvailableError"
    ) {
      log.info(`deck unavailable: ${(err as Error).message}`)
      return json(
        {
          error: "no_live_markets",
          detail: (err as Error).message,
        },
        503
      )
    }
    log.error(`bot-arena deck failed: ${(err as Error).message}`)
    return json({ error: "internal" }, 500)
  }
}

/**
 * `GET /bot-arena/settlement?marketIds=0x..,0x..` — how those markets resolved.
 *
 * ── Why this is a SEPARATE endpoint from the deck ───────────────────────────
 *
 * The deck endpoint deliberately returns no outcome data, because a bot reads
 * the same payload a human does and must not be able to see the future
 * (`specs/07_BOT_ARENA.md`). Settlement lives here instead, so the fairness
 * boundary stays a property of the deck payload rather than a promise about
 * how the client uses it: a card can only be scored AFTER it was swiped, and
 * the agent never receives this data at all.
 *
 * Returns `resolved: false` for a market still open. That is the honest answer
 * — a duel is scored when the venue settles, not when the player finishes.
 */
export async function handleBotArenaSettlement(
  req: Request
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== "/bot-arena/settlement") return null
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405)

  const raw = url.searchParams.get("marketIds") ?? ""
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10)
  if (ids.length === 0) return json({ error: "marketIds required" }, 400)

  const ex = getAdapter()
  const results = await Promise.all(
    ids.map(async (marketId) => {
      try {
        const s = await ex.getSettlement(marketId)
        if (!s) return { marketId, resolved: false }
        return {
          marketId,
          resolved: true,
          // null winner + voided:true means the venue voided the market and
          // BOTH sides redeem at half — never coerced to a side.
          winner: s.winner,
          voided: s.voided,
        }
      } catch {
        // An unreadable market is reported as unresolved rather than guessed.
        return { marketId, resolved: false }
      }
    })
  )
  return json({ markets: results })
}
