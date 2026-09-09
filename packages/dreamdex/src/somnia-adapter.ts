/**
 * DreamDEX Event Contracts adapter for Somnia.
 *
 * This is the ONLY file in DreamSwipe that knows about `@somnia-chain/markets-sdk`,
 * ERC-6909 outcome ids, or Somnia's chain layout. Everything above it speaks the
 * venue-neutral types in `./types`.
 *
 * ── Everything here was verified against live Shannon testnet ───────────────
 *
 * Facts below are observed, not assumed (see docs/MIGRATION_AUDIT.md §2.2).
 * Three of them contradict the project spec pack, and building on the spec's
 * numbers unchecked would have silently mispriced the whole app:
 *
 *   - The installable SDK is `@somnia-chain/markets-sdk`. The spec's
 *     `@dreamdex-bot-kit/core` is an unpublished internal workspace name.
 *   - Testnet collateral is tUSDC at 6 decimals, NOT USDso at 18. We never
 *     hardcode either: `collateralDecimals` is read per-market.
 *   - Testnet gas is STT; SOMI is mainnet.
 *
 * ── Design rules this file must keep ────────────────────────────────────────
 *
 * 1. READS NEED NO PRIVATE KEY. Market discovery, books, and settlement are
 *    all public. A player browsing DreamSwipe must never be asked for a key to
 *    see real market data.
 * 2. DISCOVERY DOES NOT DEPEND ON THE INDEXER. Markets are found by scanning
 *    `MarketCreated` logs on chain. This repo has already lost ~12 days of
 *    playability to a third-party read API being torn down (see
 *    `apps/server/src/card-source.ts`); we do not repeat that dependency.
 * 3. NEVER FABRICATE. No invented tx hashes, order ids, fills, or prices. If
 *    the venue cannot answer, throw `VenueUnavailableError`.
 */
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import {
  SOMNIA_TESTNET_ADDRESSES,
  SomniaMarkets,
  probabilityToPrice,
  priceToProbability,
} from "@somnia-chain/markets-sdk"
import { createPublicClient, http, type PublicClient } from "viem"
import { somniaTestnet } from "viem/chains"
import { buildOrderBook, quoteOverBook, toUpPrice } from "./book-math"
import { DEFAULT_SWEEP_TTL_MS, SingleFlightCache } from "./market-cache"
import {
  VenueReadOnlyError,
  VenueUnavailableError,
  type BookLevel,
  type CancelOrderRequest,
  type CancelResult,
  type Direction,
  type DreamDexAdapter,
  type EventMarket,
  type Fill,
  type MarketFilters,
  type MarketStatus,
  type OrderBook,
  type OrderResult,
  type PlaceOrderRequest,
  type Position,
  type Quote,
  type QuoteRequest,
  type Settlement,
  type VenueCapabilities,
} from "./types"

/** Shannon testnet defaults. Verified live: eth_chainId → 0xc488 (50312). */
export const SHANNON_CHAIN_ID = 50312
export const DEFAULT_RPC_URL = "https://dream-rpc.somnia.network"
export const DEFAULT_WS_RPC_URL = "wss://api.infra.testnet.somnia.network/ws"
export const DEFAULT_INDEXER_URL = "https://dev.smk.somnia.host/v1/graphql"

/**
 * Somnia caps `eth_getLogs` at 1000 blocks per call, so discovery walks
 * backwards in windows rather than issuing one wide query.
 */
const LOG_WINDOW_BLOCKS = 1000n
/**
 * How many windows to walk back.
 *
 * Sized from a real constraint, not a guess: Somnia mines fast, so the 40
 * windows the official starter uses cover only a few minutes of history. That
 * was measured to MISS the 4h markets entirely — they were created before the
 * scan horizon — while still taking ~38s when issued serially.
 *
 * 240 windows (240k blocks) covers a comfortably longer horizon, and the
 * windows are fetched CONCURRENTLY (see `listMarkets`), so wall-clock time is
 * bounded by the slowest batch rather than the sum of every request.
 */
const LOG_WINDOW_COUNT = 240

/**
 * Concurrent `getLogs` requests in flight.
 *
 * Discovery is on the critical path for starting a duel, so it must not be
 * serial. Capped to stay well clear of public-RPC rate limits — a throttled
 * window is skipped silently, and skipping too many would quietly shrink the
 * deck.
 */
const LOG_SCAN_CONCURRENCY = 12

/** Venue order-type encoding. Verified in the official starter + SKILL.md. */
const ORDER_TYPE_CODE = {
  LIMIT: 0,
  FILL_OR_KILL: 1,
  MARKET: 2, // IOC — taker, must cross
  POST_ONLY: 3, // maker, must rest; reverts if it would cross
} as const

/** Raw shape of a `MarketCreated` log's args, as emitted by the venue. */
interface MarketCreatedArgs {
  marketId: string
  market: string
  pool: string
  yesId: bigint
  noId: bigint
  collateral: string
  asset: string
  strike: bigint
  tradingStart: bigint
  expiry: bigint
  oracleQuestionId: bigint
  question: string
  intervalSec: bigint
}

/**
 * The venue's numeric status enum, normalized.
 *
 * Observed values: 0 Listed, 1 Trading, 2 Locked, 3 Settling, 4 Resolved,
 * 5 Voided. Only 1 accepts orders. `Settling` is documented as effectively
 * never observable, but it is mapped rather than dropped so an unexpected
 * value surfaces as UNKNOWN instead of being silently treated as tradable.
 */
function normalizeStatus(
  status: number,
  finalized: boolean,
  isVoided: boolean
): MarketStatus {
  if (isVoided) return "VOIDED"
  switch (status) {
    case 0:
      return "LISTED"
    case 1:
      return "TRADING"
    case 2:
      return "LOCKED"
    case 3:
      return "SETTLING"
    case 4:
      return "RESOLVED"
    case 5:
      return "VOIDED"
    default:
      return finalized ? "RESOLVED" : "UNKNOWN"
  }
}

export interface SomniaAdapterConfig {
  rpcUrl?: string
  wsRpcUrl?: string
  indexerUrl?: string
  /**
   * Signer key for WRITES only (mint / order / redeem). Omit for a read-only
   * adapter — reads never need it. Never commit a key; supply via env.
   */
  privateKey?: string
  /** Collateral token to scope discovery to. Defaults to testnet tUSDC. */
  collateral?: string
  /**
   * How long a discovery sweep is reused, in ms.
   *
   * Discovery is a multi-hundred-request log scan (measured ~26s against the
   * public RPC), so it is cached and single-flighted. Set to 0 to disable —
   * only sensible in tests.
   */
  sweepTtlMs?: number
}

/**
 * Load `marketCreatorEventsAbi`.
 *
 * The SDK does NOT re-export this from its main entry, and as of 0.29.0 the
 * `exports` map blocks the deep path the official starter uses
 * (`.../dist/eventsAbi.js` now throws ERR_PACKAGE_PATH_NOT_EXPORTED). So we
 * resolve the package root and import the file by absolute URL. This is
 * deliberately isolated in one function: when the SDK re-exports the ABI
 * properly, only this needs to change.
 */
let cachedMarketCreatedEvent: unknown | null = null
async function loadMarketCreatedEvent(): Promise<unknown> {
  if (cachedMarketCreatedEvent) return cachedMarketCreatedEvent
  try {
    const require = createRequire(import.meta.url)
    const pkgJson = require.resolve("@somnia-chain/markets-sdk/package.json")
    const root = pkgJson.slice(0, pkgJson.lastIndexOf("/"))
    const mod = (await import(
      pathToFileURL(`${root}/dist/eventsAbi.js`).href
    )) as { marketCreatorEventsAbi?: Array<{ name?: string }> }
    const abi = mod.marketCreatorEventsAbi
    const event = abi?.find((e) => e.name === "MarketCreated")
    if (!event) {
      throw new Error("MarketCreated not present in marketCreatorEventsAbi")
    }
    cachedMarketCreatedEvent = event
    return event
  } catch (cause) {
    throw new VenueUnavailableError(
      "Could not load the venue's MarketCreated ABI from @somnia-chain/markets-sdk",
      cause
    )
  }
}

/**
 * Live DreamDEX Event Contracts adapter.
 *
 * Construct without a `privateKey` for a read-only instance: discovery,
 * books, quotes and settlement all work. Writes throw `VenueReadOnlyError`
 * so a missing key fails loudly at the call site rather than degrading into
 * a fake success.
 */
export class SomniaDreamDexAdapter implements DreamDexAdapter {
  private readonly pub: PublicClient
  private readonly ex: InstanceType<typeof SomniaMarkets>
  private readonly collateral: string
  private readonly signerConfigured: boolean
  /** marketId → handle, learned from discovery so later calls can route. */
  private readonly handles = new Map<string, MarketCreatedArgs>()
  /**
   * Cached raw discovery sweep, single-flighted.
   *
   * Caches only the immutable `MarketCreated` args. Live status is re-read on
   * every hydrate, so a cached sweep can never make a stale tradability claim.
   */
  private readonly sweep: SingleFlightCache<MarketCreatedArgs[]>

  constructor(config: SomniaAdapterConfig = {}) {
    const rpcUrl = config.rpcUrl || DEFAULT_RPC_URL
    this.collateral = String(
      config.collateral || SOMNIA_TESTNET_ADDRESSES.testUsdc
    ).toLowerCase()
    this.signerConfigured = Boolean(config.privateKey)

    this.pub = createPublicClient({
      chain: somniaTestnet,
      transport: http(rpcUrl),
    }) as PublicClient

    this.ex = new SomniaMarkets({
      chain: somniaTestnet,
      addresses: SOMNIA_TESTNET_ADDRESSES,
      // The SDK requires a ws url — loadMarkets() throws without one.
      wsRpcUrl: config.wsRpcUrl || DEFAULT_WS_RPC_URL,
      indexerUrl: config.indexerUrl || DEFAULT_INDEXER_URL,
      rpcUrl,
      ...(config.privateKey ? { privateKey: config.privateKey } : {}),
    } as ConstructorParameters<typeof SomniaMarkets>[0])

    this.sweep = new SingleFlightCache(
      () => this.scanMarketCreated(),
      config.sweepTtlMs ?? DEFAULT_SWEEP_TTL_MS
    )
  }

  /**
   * Probe what the venue can actually do right now.
   *
   * `readable` is determined by really reaching the chain, not by assuming.
   * The UI gates CLOB panels and cash-out on these flags so an outage renders
   * as an honest disabled state (Absolute Rule #11).
   */
  async capabilities(): Promise<VenueCapabilities> {
    let readable = false
    let reason: string | undefined
    try {
      await this.pub.getBlockNumber()
      readable = true
    } catch (err) {
      reason = `Somnia RPC unreachable: ${(err as Error).message}`
    }
    return {
      readable,
      writable: readable && this.signerConfigured,
      orderBook: readable,
      // Early exit is supported by the venue, but only sellable against real
      // inventory and only while the window is open.
      cashOut: readable,
      venueLink: true,
      reason:
        reason ??
        (this.signerConfigured
          ? undefined
          : "Read-only: no signer configured, so trading is disabled"),
    }
  }

  /**
   * Discover markets by scanning `MarketCreated` logs directly from chain.
   *
   * Scoped by COLLATERAL rather than venue: `MarketCreated` carries no venue
   * id, so there is nothing to filter venues on. Filtering by the collateral
   * we can actually fund is both meaningful and sufficient on testnet.
   */
  async listMarkets(filters: MarketFilters = {}): Promise<EventMarket[]> {
    const found = await this.sweep.get()
    return this.selectFrom(found, filters)
  }

  /**
   * Scan `MarketCreated` logs across the block horizon.
   *
   * Split out from `listMarkets` so it can sit behind the single-flight cache:
   * this is the expensive half (hundreds of RPC calls, measured ~26s), while
   * filtering and live-state hydration stay cheap and always run fresh against
   * the chain.
   */
  private async scanMarketCreated(): Promise<MarketCreatedArgs[]> {
    const event = await loadMarketCreatedEvent()
    let head: bigint
    try {
      head = await this.pub.getBlockNumber()
    } catch (cause) {
      throw new VenueUnavailableError("Could not reach Somnia RPC", cause)
    }

    // Build the window list up front, then fetch in bounded-concurrency
    // batches. Serial scanning was measured at ~38s, which is far too slow to
    // sit in front of matchmaking.
    const windows: Array<{ fromBlock: bigint; toBlock: bigint }> = []
    for (let i = 0; i < LOG_WINDOW_COUNT; i++) {
      const toBlock = head - BigInt(i) * LOG_WINDOW_BLOCKS
      const fromBlock = toBlock - (LOG_WINDOW_BLOCKS - 1n)
      if (fromBlock < 0n) break
      windows.push({ fromBlock, toBlock })
    }

    const found: MarketCreatedArgs[] = []
    for (let i = 0; i < windows.length; i += LOG_SCAN_CONCURRENCY) {
      const batch = windows.slice(i, i + LOG_SCAN_CONCURRENCY)
      const results = await Promise.all(
        batch.map(async ({ fromBlock, toBlock }) => {
          try {
            return await this.pub.getLogs({
              // The ABI item is loaded dynamically; viem's generic inference
              // cannot see its shape, so this cast is confined to the call.
              event: event as never,
              fromBlock,
              toBlock,
            })
          } catch {
            // A single window can fail (rate limit, reorg). Discovery is
            // best-effort across windows rather than all-or-nothing.
            return []
          }
        })
      )
      for (const logs of results) {
        for (const log of logs) {
          const args = (log as { args?: MarketCreatedArgs }).args
          if (args?.marketId) found.push(args)
        }
      }
    }

    if (found.length === 0) {
      throw new VenueUnavailableError(
        "No MarketCreated events found on Somnia — venue may be unavailable"
      )
    }

    return found
  }

  /**
   * Filter a discovery sweep and hydrate live on-chain state.
   *
   * Always runs against fresh chain reads even when the sweep came from cache,
   * so tradability is never served stale.
   */
  private async selectFrom(
    found: MarketCreatedArgs[],
    filters: MarketFilters
  ): Promise<EventMarket[]> {
    const nowMs = Date.now()
    const nowSec = Math.floor(nowMs / 1000)

    // Deduplicate: the same market can appear in overlapping windows.
    const byId = new Map<string, MarketCreatedArgs>()
    for (const m of found) {
      if (m.collateral?.toLowerCase() !== this.collateral) continue
      byId.set(String(m.marketId), m)
    }
    for (const [id, raw] of byId) this.handles.set(id, raw)

    const candidates = [...byId.values()].filter((m) => {
      const expirySec = Number(m.expiry)
      if (expirySec <= nowSec) return false

      const msToExpiry = (expirySec - nowSec) * 1000
      if (
        filters.minTimeToExpiryMs !== undefined &&
        msToExpiry < filters.minTimeToExpiryMs
      ) {
        return false
      }
      if (
        filters.maxTimeToExpiryMs !== undefined &&
        msToExpiry > filters.maxTimeToExpiryMs
      ) {
        return false
      }
      if (filters.assets && !filters.assets.includes(String(m.asset))) {
        return false
      }
      if (
        filters.intervalSec &&
        !filters.intervalSec.includes(Number(m.intervalSec))
      ) {
        return false
      }
      return true
    })

    candidates.sort((a, b) => Number(a.expiry) - Number(b.expiry))

    // Confirm real on-chain state before calling anything tradable: a future
    // expiry does NOT imply the market is open. Hydrated concurrently — one
    // round-trip per market, serialized, is the other half of the latency
    // problem the batched log scan above solves.
    const tradingOnly = filters.tradingOnly !== false
    const limit = filters.limit ?? candidates.length

    const hydrated = await Promise.all(
      candidates.map((raw) => this.hydrate(raw))
    )

    const out: EventMarket[] = []
    for (const market of hydrated) {
      if (out.length >= limit) break
      if (!market) continue
      if (tradingOnly && market.status !== "TRADING") continue
      out.push(market)
    }
    return out
  }

  /** Read live on-chain state for one discovered market. */
  private async hydrate(raw: MarketCreatedArgs): Promise<EventMarket | null> {
    const id = String(raw.marketId)
    try {
      const mo = (await this.ex.client.getMarketOnchain(
        asHex(id, "marketId")
      )) as {
        status: number
        finalized: boolean
        isVoided: boolean
        decimals: number
        outcomeToken: string
        yesId: string | bigint
        noId: string | bigint
        pool: string
      }
      return {
        id,
        asset: String(raw.asset),
        question: String(raw.question),
        strike: BigInt(raw.strike),
        intervalSec: Number(raw.intervalSec),
        tradingStartSec: Number(raw.tradingStart),
        expirySec: Number(raw.expiry),
        status: normalizeStatus(mo.status, mo.finalized, mo.isVoided),
        finalized: mo.finalized,
        collateralDecimals: Number(mo.decimals),
        handle: {
          pool: mo.pool ?? String(raw.pool),
          outcomeToken: mo.outcomeToken,
          upId: String(mo.yesId ?? raw.yesId),
          downId: String(mo.noId ?? raw.noId),
          collateral: String(raw.collateral),
          oracleQuestionId: String(raw.oracleQuestionId),
        },
      }
    } catch {
      // One unreadable market must not fail the whole deck.
      return null
    }
  }

  async getMarket(marketId: string): Promise<EventMarket | null> {
    const raw = this.handles.get(marketId)
    if (raw) return this.hydrate(raw)
    // Not seen in this process yet — rediscover, ignoring tradability so a
    // settled market can still be looked up for results.
    const all = await this.listMarkets({ tradingOnly: false })
    return all.find((m) => m.id === marketId) ?? null
  }

  /** Read the live book and derive CLOB metrics from real resting orders. */
  async getOrderBook(marketId: string): Promise<OrderBook> {
    const market = await this.getMarket(marketId)
    if (!market) {
      throw new VenueUnavailableError(`Unknown market ${marketId}`)
    }
    const pool = market.handle.pool
    try {
      const [bidsRes, asksRes] = await Promise.all([
        this.ex.client.getAllOpenOrdersOnchain(asHex(pool, "pool"), {
          isBid: true,
        }),
        this.ex.client.getAllOpenOrdersOnchain(asHex(pool, "pool"), {
          isBid: false,
        }),
      ])
      return buildOrderBook({
        marketId,
        bids: toLevels(bidsRes),
        asks: toLevels(asksRes),
      })
    } catch (cause) {
      throw new VenueUnavailableError(
        `Could not read the order book for ${marketId}`,
        cause
      )
    }
  }

  /** Quote a trade over the real book. Never invents a fillable size. */
  async getQuote(request: QuoteRequest): Promise<Quote> {
    const book = await this.getOrderBook(request.marketId)
    return quoteOverBook(book, request.direction, request.quantity)
  }

  async placeOrder(request: PlaceOrderRequest): Promise<OrderResult> {
    this.assertWritable()
    const market = await this.getMarket(request.marketId)
    if (!market) {
      throw new VenueUnavailableError(`Unknown market ${request.marketId}`)
    }
    if (market.status !== "TRADING") {
      throw new VenueUnavailableError(
        `Market ${request.marketId} is ${market.status}, not accepting orders`
      )
    }

    // The venue exposes one book in UP terms with four sides.
    const side =
      request.side === "BUY"
        ? request.direction === "UP"
          ? "BUY_YES"
          : "BUY_NO"
        : request.direction === "UP"
          ? "SELL_YES"
          : "SELL_NO"

    try {
      const res = (await this.ex.trader.placeOrder({
        pool: asHex(market.handle.pool, "pool"),
        side,
        price: toUpPrice(request.price, request.direction),
        quantity: request.quantity,
        orderType: ORDER_TYPE_CODE[request.orderType],
      })) as {
        hash?: string
        orderId?: string | bigint
        fills?: Array<{
          fillPrice?: bigint
          quantityFilled?: bigint
          orderId?: string | bigint
        }>
      }

      // A real hash or nothing — never synthesize one.
      const txHash = res.hash ?? ""
      const fills: Fill[] = (res.fills ?? []).map((f) => ({
        orderId: String(f.orderId ?? res.orderId ?? ""),
        marketId: request.marketId,
        direction: request.direction,
        price: BigInt(f.fillPrice ?? 0n),
        quantity: BigInt(f.quantityFilled ?? 0n),
        txHash,
        timestampMs: Date.now(),
      }))

      return {
        orderId: res.orderId != null ? String(res.orderId) : null,
        marketId: request.marketId,
        txHash,
        fills,
        resting: fills.length === 0 && res.orderId != null,
      }
    } catch (cause) {
      // A PostOnly that would cross reverts by design; surface it as-is rather
      // than pretending the order rested.
      throw new VenueUnavailableError(
        `placeOrder failed for ${request.marketId}: ${(cause as Error).message}`,
        cause
      )
    }
  }

  async cancelOrder(request: CancelOrderRequest): Promise<CancelResult> {
    this.assertWritable()
    const market = await this.getMarket(request.marketId)
    if (!market) {
      throw new VenueUnavailableError(`Unknown market ${request.marketId}`)
    }
    try {
      const res = (await this.ex.trader.cancelOrder({
        pool: asHex(market.handle.pool, "pool"),
        orderId: BigInt(request.orderId),
      })) as { hash?: string }
      return {
        orderId: request.orderId,
        txHash: res.hash ?? "",
        cancelled: Boolean(res.hash),
      }
    } catch (cause) {
      throw new VenueUnavailableError(
        `cancelOrder failed for order ${request.orderId}`,
        cause
      )
    }
  }

  /**
   * Fills for a market.
   *
   * Not yet wired to a canonical on-chain fill source. Returning `[]` here
   * would be a lie by omission — callers cannot distinguish "no fills" from
   * "not implemented" — so this refuses instead. PnL is computed from
   * settlement plus recorded entry cost, which does not depend on this.
   */
  async getFills(_marketId: string, _owner?: string): Promise<Fill[]> {
    throw new VenueUnavailableError(
      "Fill history is not exposed by this adapter; use order results and settlement for PnL"
    )
  }

  /** Real ERC-6909 outcome-token balances for an owner. */
  async getPosition(marketId: string, owner: string): Promise<Position> {
    const market = await this.getMarket(marketId)
    if (!market) {
      throw new VenueUnavailableError(`Unknown market ${marketId}`)
    }
    const { outcomeToken, upId, downId } = market.handle
    if (!outcomeToken || !upId || !downId) {
      throw new VenueUnavailableError(
        `Market ${marketId} is missing outcome token routing data`
      )
    }
    try {
      const [up, down] = await Promise.all([
        this.ex.client.getOutcomeBalance({
          outcomeToken: asHex(outcomeToken, "outcomeToken"),
          account: asHex(owner, "owner address"),
          id: BigInt(upId),
        }),
        this.ex.client.getOutcomeBalance({
          outcomeToken: asHex(outcomeToken, "outcomeToken"),
          account: asHex(owner, "owner address"),
          id: BigInt(downId),
        }),
      ])
      return {
        marketId,
        owner,
        upQuantity: BigInt(up ?? 0n),
        downQuantity: BigInt(down ?? 0n),
      }
    } catch (cause) {
      throw new VenueUnavailableError(
        `Could not read position for ${owner} in ${marketId}`,
        cause
      )
    }
  }

  /**
   * How a market resolved, or null while it is still open.
   *
   * A voided market has no winner and refunds both sides at 0.5 — that is
   * reported as `winner: null, voided: true`, never coerced to a side.
   */
  async getSettlement(marketId: string): Promise<Settlement | null> {
    try {
      const mo = (await this.ex.client.getMarketOnchain(
        asHex(marketId, "marketId")
      )) as {
        finalized: boolean
        isResolved: boolean
        isVoided: boolean
        winningOutcome: number | bigint
      }
      if (!mo.finalized && !mo.isResolved && !mo.isVoided) return null
      if (mo.isVoided) {
        return {
          marketId,
          winner: null,
          voided: true,
          settlementPrice: null,
          resolvedAtMs: Date.now(),
        }
      }
      return {
        marketId,
        // 0 = Up/YES, 1 = Down/NO.
        winner: Number(mo.winningOutcome) === 0 ? "UP" : "DOWN",
        voided: false,
        settlementPrice: null,
        resolvedAtMs: Date.now(),
      }
    } catch (cause) {
      throw new VenueUnavailableError(
        `Could not read settlement for ${marketId}`,
        cause
      )
    }
  }

  /**
   * Deep link into the DreamDEX UI.
   *
   * IMPORTANT: no documented per-market permalink exists. The observed
   * `/{PAIR}/{INTERVAL}` form addresses a market *series*, not one window, so
   * a link built from it may land on the successor window rather than this
   * exact market. It is returned as a best-effort handoff and must be
   * labelled as "trade this market on DreamDEX", never as a receipt for a
   * specific settled window.
   */
  getVenueLink(marketId: string): string | null {
    const raw = this.handles.get(marketId)
    if (!raw) return "https://app.dreamdex.io/event-contracts"
    const pair = `W${String(raw.asset).toUpperCase()}:USDso`
    const interval = intervalLabel(Number(raw.intervalSec))
    if (!interval) return "https://app.dreamdex.io/event-contracts"
    return `https://app.dreamdex.io/event-contracts/${pair}/${interval}`
  }

  private assertWritable(): void {
    if (!this.signerConfigured) throw new VenueReadOnlyError()
  }
}

/** Map seconds to the venue UI's interval slug. */
function intervalLabel(sec: number): string | null {
  if (sec === 300) return "5m"
  if (sec === 900) return "15m"
  if (sec === 3600) return "1h"
  if (sec === 14400) return "4h"
  return null
}

/**
 * Normalize the SDK's open-orders response into book levels.
 *
 * Defensive on purpose: the SDK returns `{ orders: [...] }`, individual
 * fields have been observed as undefined, and a malformed level must be
 * dropped rather than become a `NaN` that silently poisons every derived
 * metric downstream.
 */
function toLevels(res: unknown): BookLevel[] {
  const orders = (res as { orders?: unknown[] })?.orders
  if (!Array.isArray(orders)) return []
  const out: BookLevel[] = []
  for (const o of orders) {
    const raw = o as { price?: unknown; quantity?: unknown; size?: unknown }
    const price = safeBigInt(raw.price)
    const quantity = safeBigInt(raw.quantity ?? raw.size)
    if (price === null || quantity === null || quantity <= 0n) continue
    out.push({ price, quantity })
  }
  return out
}

/**
 * Assert a string is 0x-prefixed hex, and narrow it to viem's `Hex` type.
 *
 * The SDK and viem both demand `0x${string}`, while chain logs and our own
 * venue-neutral types carry plain `string`. Rather than casting blindly at a
 * dozen call sites, every crossing goes through this one check — so a
 * malformed address or id fails immediately with a useful message instead of
 * being handed to an RPC that would reject it opaquely.
 */
function asHex(value: string, label: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new VenueUnavailableError(
      `Expected ${label} to be 0x-prefixed hex, got ${JSON.stringify(value)}`
    )
  }
  return value as `0x${string}`
}

function safeBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v))
  if (typeof v === "string" && v.trim() !== "") {
    try {
      return BigInt(v)
    } catch {
      return null
    }
  }
  return null
}

export { probabilityToPrice, priceToProbability }
