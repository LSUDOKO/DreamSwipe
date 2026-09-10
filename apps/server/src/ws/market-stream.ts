/**
 * Live market-price stream over the WebSocket.
 *
 * Pushes each subscribed market's current mid to the sockets watching it, so
 * the lockup view can show a position moving without every client polling the
 * venue itself.
 *
 * ── What replaced what ──────────────────────────────────────────────────────
 *
 * The Sui build streamed a Pyth BTC spot feed, because a DeepBook card was a
 * strike placed against spot and "is it above the strike yet" was the live
 * question. A DreamDEX card is a market with its own book, so the live
 * question is instead "what does the market think right now" — the mid IS the
 * probability, quoted in millionths.
 *
 * ── Honest empty state ──────────────────────────────────────────────────────
 *
 * A market with no resting orders has NO price. It is reported as `mid: null`
 * rather than a last-known value or a zero, because a stale price on a lockup
 * screen is indistinguishable from a live one and would misrepresent a
 * position's value.
 */
import { SomniaDreamDexAdapter } from "@workspace/dreamdex/adapter"
import { makeLogger } from "../log"
import type { ServerWebSocket } from "bun"
import type { SocketState } from "./matchmaking"

const log = makeLogger("market-stream")

/**
 * Poll cadence.
 *
 * Slower than the old 2s oracle tick on purpose: each tick costs one book read
 * per subscribed market against a public RPC, and a probability that moves on
 * a 5s cadence still reads as live.
 */
const TICK_INTERVAL_MS = 5_000

/** marketId → sockets watching it. */
const subscribers = new Map<string, Set<ServerWebSocket<SocketState>>>()

let timer: ReturnType<typeof setInterval> | null = null
let adapter: SomniaDreamDexAdapter | null = null

function getAdapter(): SomniaDreamDexAdapter {
  adapter ??= new SomniaDreamDexAdapter({
    rpcUrl: process.env.SOMNIA_RPC_URL,
    wsRpcUrl: process.env.SOMNIA_WS_RPC_URL,
    indexerUrl: process.env.DREAMDEX_INDEXER_URL,
  })
  return adapter
}

export function subscribeMarkets(
  ws: ServerWebSocket<SocketState>,
  marketIds: string[]
): void {
  for (const id of marketIds) {
    let set = subscribers.get(id)
    if (!set) {
      set = new Set()
      subscribers.set(id, set)
    }
    set.add(ws)
  }
}

export function unsubscribeMarkets(
  ws: ServerWebSocket<SocketState>,
  marketIds: string[]
): void {
  for (const id of marketIds) {
    const set = subscribers.get(id)
    if (!set) continue
    set.delete(ws)
    // Drop the entry entirely so the tick loop stops reading a book nobody
    // is watching.
    if (set.size === 0) subscribers.delete(id)
  }
}

/** Clean up every subscription for a closing socket. */
export function onSocketCloseMarketStream(
  ws: ServerWebSocket<SocketState>
): void {
  for (const [id, set] of subscribers) {
    set.delete(ws)
    if (set.size === 0) subscribers.delete(id)
  }
}

async function tick(): Promise<void> {
  if (subscribers.size === 0) return
  const ex = getAdapter()

  // Read every watched market concurrently — serially, N markets would make
  // the tick interval meaningless.
  await Promise.all(
    [...subscribers.entries()].map(async ([marketId, sockets]) => {
      if (sockets.size === 0) return
      let mid: string | null = null
      let bestBid: string | null = null
      let bestAsk: string | null = null
      // The client needs expiry to render a per-card settle countdown AND to
      // fire the auto-swipe deadline; without it a stalled player silently
      // forfeits every remaining card.
      let expirySec: number | null = null
      try {
        const [book, market] = await Promise.all([
          ex.getOrderBook(marketId),
          ex.getMarket(marketId).catch(() => null),
        ])
        mid = book.mid === null ? null : book.mid.toString()
        bestBid = book.bestBid === null ? null : book.bestBid.toString()
        bestAsk = book.bestAsk === null ? null : book.bestAsk.toString()
        expirySec = market?.expirySec ?? null
      } catch {
        // One unreadable market must not stall the others. It reports as
        // "no price", which is the truth from the client's perspective.
      }

      // Emitted as `oracle_tick` — the message the client already consumes in
      // active-duel, duel-view and my-match-tile. Renaming it here (rather
      // than migrating three client call sites) keeps one wire contract and
      // avoids a silent drift where the server broadcasts a message nobody
      // listens for. That drift is exactly what happened when this stream was
      // first ported: live prices, per-card PnL, settle countdowns and the
      // auto-swipe deadline all went dead at once, with nothing failing loudly.
      //
      // `spot` carries the market's mid in PROBABILITY millionths, not a USD
      // price — on DreamDEX the live quantity is "what does the market think",
      // and each card has its own book. Null when the book is empty, so the UI
      // renders its honest "no quotes" state instead of a stale number.
      const payload = JSON.stringify({
        type: "oracle_tick",
        expiryMarketId: marketId,
        spot: mid,
        bestBid,
        bestAsk,
        expiry: expirySec === null ? null : String(expirySec),
        settlementPrice: null,
        timestampMs: Date.now(),
      })
      for (const ws of sockets) {
        try {
          ws.send(payload)
        } catch {
          // Socket closed between the read and the send; the close handler
          // will clear it.
        }
      }
    })
  )
}

export function startMarketStream(): void {
  if (timer) return
  log.info(`tick every ${TICK_INTERVAL_MS}ms`)
  timer = setInterval(() => {
    void tick().catch((e) => log.warn(`tick failed: ${(e as Error).message}`))
  }, TICK_INTERVAL_MS)
  timer.unref?.()
}

export function stopMarketStream(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function marketStreamStats(): {
  markets: number
  subscribers: number
} {
  let total = 0
  for (const set of subscribers.values()) total += set.size
  return { markets: subscribers.size, subscribers: total }
}

// ─── Global spot feed (practice mode) ───────────────────────────────────────
//
// Practice is fully simulated, but its settlement loop still needs ONE live
// number ticking so cards resolve on a real clock rather than a fake one. The
// Sui build fed it a Pyth BTC spot price; DreamDEX publishes no such feed, so
// this derives a global tick from the shortest-dated live BTC market's mid.
//
// That keeps practice honest: the number moves because a real market moved. It
// is a probability in millionths, not a USD price — practice compares each
// card against the same series, so the unit only has to be consistent.
//
// This exists because deleting `spot_subscribe` during the migration silently
// killed practice mode entirely: the deck dealt, the player swiped, and the
// session then timed out with "price feed stalled" every single time, with no
// error anywhere to explain why.

const spotSubscribers = new Set<ServerWebSocket<SocketState>>()
let spotTimer: ReturnType<typeof setInterval> | null = null

export function subscribeSpot(ws: ServerWebSocket<SocketState>): void {
  spotSubscribers.add(ws)
}

export function unsubscribeSpot(ws: ServerWebSocket<SocketState>): void {
  spotSubscribers.delete(ws)
}

export function onSocketCloseSpot(ws: ServerWebSocket<SocketState>): void {
  spotSubscribers.delete(ws)
}

/**
 * Last observed mid, and a deterministic walk when the venue has no book.
 *
 * Practice is FULLY SIMULATED — it must not stop working because DreamDEX
 * happens to have no resting orders, which is the common case on testnet
 * (every live book was empty when this was written). Gating practice on venue
 * liquidity is what left it dead: the deck dealt, the player swiped, and the
 * session timed out with "price feed stalled" every single time.
 *
 * So: use the real mid when one exists, and otherwise advance a synthetic
 * series. The synthetic path is clearly labelled `synthetic: true` on the wire
 * so nothing downstream can mistake it for a market price — and it is used
 * ONLY by practice, never by a duel that settles real money.
 */
let lastSpot = 500_000n // 0.50 in probability millionths
let spotSeed = 0

function nextSyntheticSpot(): bigint {
  // A small bounded random walk inside [0.05, 0.95]. Deterministic step size
  // so the series looks like a market rather than noise.
  spotSeed++
  const drift = BigInt(((spotSeed * 7919) % 2001) - 1000) * 8n
  let next = lastSpot + drift
  if (next < 50_000n) next = 50_000n
  if (next > 950_000n) next = 950_000n
  lastSpot = next
  return next
}

async function spotTick(): Promise<void> {
  if (spotSubscribers.size === 0) return

  let spot: bigint | null = null
  let synthetic = false
  try {
    const markets = await getAdapter().listMarkets({ limit: 6 })
    const target = markets.find((m) => m.asset === "BTC") ?? markets[0]
    if (target) {
      const book = await getAdapter().getOrderBook(target.id)
      if (book.mid !== null && book.mid > 0n) {
        spot = book.mid
        lastSpot = book.mid
      }
    }
  } catch (e) {
    log.warn(`spot source read failed: ${(e as Error).message}`)
  }

  if (spot === null) {
    spot = nextSyntheticSpot()
    synthetic = true
  }

  const payload = JSON.stringify({
    type: "spot_tick",
    spot: spot.toString(),
    // Explicit, so a consumer can never silently treat this as a real quote.
    synthetic,
    timestampMs: Date.now(),
  })
  for (const ws of spotSubscribers) {
    try {
      ws.send(payload)
    } catch {
      // Closed mid-send; the close handler clears it.
    }
  }
}

/**
 * The current practice spot, in probability millionths.
 *
 * Shared with `spotTick` so the practice DECK and the practice TICK STREAM are
 * built from the same series — otherwise a deck could be dealt at one price
 * and then settled against a completely unrelated one.
 *
 * Reads the venue when a book exists and falls back to the synthetic walk when
 * it does not. Practice is fully simulated, so it must not fail because
 * DreamDEX happens to have no resting orders — which is the common case on
 * testnet and is exactly what made `readBtcSpot()` throw SPOT_UNAVAILABLE and
 * take the whole practice mode down.
 */
export async function currentPracticeSpot(): Promise<bigint> {
  try {
    const markets = await getAdapter().listMarkets({ limit: 6 })
    const target = markets.find((m) => m.asset === "BTC") ?? markets[0]
    if (target) {
      const book = await getAdapter().getOrderBook(target.id)
      if (book.mid !== null && book.mid > 0n) {
        lastSpot = book.mid
        return book.mid
      }
    }
  } catch {
    // Fall through to the synthetic series.
  }
  return nextSyntheticSpot()
}

export function startSpotStream(): void {
  if (spotTimer) return
  spotTimer = setInterval(() => {
    void spotTick()
  }, TICK_INTERVAL_MS)
  spotTimer.unref?.()
}

export function stopSpotStream(): void {
  if (spotTimer) clearInterval(spotTimer)
  spotTimer = null
}
