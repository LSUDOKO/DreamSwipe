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
      try {
        const book = await ex.getOrderBook(marketId)
        mid = book.mid === null ? null : book.mid.toString()
        bestBid = book.bestBid === null ? null : book.bestBid.toString()
        bestAsk = book.bestAsk === null ? null : book.bestAsk.toString()
      } catch {
        // One unreadable market must not stall the others. It reports as
        // "no price", which is the truth from the client's perspective.
      }

      const payload = JSON.stringify({
        type: "market_tick",
        marketId,
        mid,
        bestBid,
        bestAsk,
        observedAtMs: Date.now(),
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
