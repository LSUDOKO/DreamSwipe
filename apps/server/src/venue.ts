/**
 * The process-wide DreamDEX adapter.
 *
 * Every caller shares ONE instance so they share its single-flight market
 * cache. Constructing an adapter per call site would mean each one paying the
 * full cold discovery scan — a multi-hundred-request `getLogs` walk measured at
 * ~17s — instead of ~1.5s from warm cache.
 *
 * Previously `bot-arena-api`, `relay-api` and `card-source` each built their
 * own, so a player hitting matchmaking and the Bot Arena in the same minute
 * triggered several independent scans against the same public RPC.
 */
import { SomniaDreamDexAdapter } from "@workspace/dreamdex/adapter"

let adapter: SomniaDreamDexAdapter | null = null

export function getVenueAdapter(): SomniaDreamDexAdapter {
  adapter ??= new SomniaDreamDexAdapter({
    rpcUrl: process.env.SOMNIA_RPC_URL,
    wsRpcUrl: process.env.SOMNIA_WS_RPC_URL,
    indexerUrl: process.env.DREAMDEX_INDEXER_URL,
  })
  return adapter
}
