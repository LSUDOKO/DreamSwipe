/**
 * Application-level types for DreamSwipe's prediction venue.
 *
 * These are DELIBERATELY venue-neutral. Nothing here names DreamDEX, Somnia,
 * ERC-6909, or the markets SDK — that is the whole point of the adapter
 * boundary in `specs/04_DREAMDEX_INTEGRATION.md`:
 *
 *   > Do not expose raw DreamDEX contracts throughout the application.
 *
 * The game engine, deck selection, bots and UI all speak these types. Only
 * `somnia-adapter.ts` knows how to turn them into venue calls. If DreamDEX
 * changes its ABI — and the DeepBook pin in this repo's own history moved
 * three times — the blast radius is one file.
 *
 * ── Units, stated once ──────────────────────────────────────────────────────
 *
 * Two different scales appear here and mixing them silently misprices
 * everything, so both are named explicitly in field docs:
 *
 *   PROBABILITY (price)  — millionths. 900_000n = 0.90 = "90% likely".
 *                          Always quoted in UP/YES terms; a DOWN price is
 *                          (ONE - upPrice). Verified against the live venue.
 *   COLLATERAL (size)    — base units of the settlement token. On Shannon
 *                          testnet that is tUSDC with 6 decimals, so
 *                          1_000_000n = 1 whole contract. NEVER hardcode the
 *                          exponent: read `decimals` off the market and derive
 *                          the scale, because mainnet collateral (USDso) is
 *                          18 decimals. A constant that is right on testnet is
 *                          wrong by 10^12 on mainnet and nothing reverts to
 *                          tell you.
 */

/** Probability price scale: 1_000_000 == 1.00 == certainty. */
export const ONE_PROBABILITY = 1_000_000n

/** The two sides of a binary market. UP is "YES", DOWN is "NO". */
export type Direction = "UP" | "DOWN"

/**
 * Lifecycle of a market, normalized away from any venue's raw enum.
 *
 * Only `TRADING` accepts orders. `RESOLVED` pays the winning side 1:1;
 * `VOIDED` refunds both sides at 0.5.
 */
export type MarketStatus =
  | "LISTED"
  | "TRADING"
  | "LOCKED"
  | "SETTLING"
  | "RESOLVED"
  | "VOIDED"
  | "UNKNOWN"

/**
 * One binary prediction market — a single question over a single time window.
 *
 * `id` is opaque to the game. Do not parse it, do not sort by it, and do not
 * persist anything derived from its internal structure: the venue's own docs
 * warn that pools are recycled across windows, so identity must come from the
 * id itself, never from an address.
 */
export interface EventMarket {
  /** Opaque, venue-assigned market identifier. Stable for this window. */
  id: string
  /** Underlying asset symbol as the venue reports it, e.g. "BTC", "ETH". */
  asset: string
  /** Human-readable question shown on the card. */
  question: string
  /**
   * Strike, in the venue's price-feed units. `0n` means the venue expressed
   * the question relative to the window's own opening price rather than an
   * absolute level ("closes at or above its opening price"), which is the
   * common case for short windows.
   */
  strike: bigint
  /** Window length in seconds (300 = 5m, 900 = 15m, ...). */
  intervalSec: number
  /** Unix seconds when trading opened. */
  tradingStartSec: number
  /** Unix seconds when the window closes. After this the market can resolve. */
  expirySec: number
  /** Current lifecycle state. Only `TRADING` accepts orders. */
  status: MarketStatus
  /** True once the venue has finalized the outcome. */
  finalized: boolean
  /**
   * Decimals of the collateral token backing this market. Derive every size
   * scale from THIS, never from a literal — see the units note above.
   */
  collateralDecimals: number
  /**
   * Venue-specific handles the adapter needs to act on this market. Opaque
   * to the game: pass it back, never interpret it.
   */
  readonly handle: MarketHandle
}

/**
 * Opaque venue routing data. The game stores and returns this; only the
 * adapter reads its fields.
 */
export interface MarketHandle {
  /** The order book / escrow contract for this window. */
  pool: string
  /** Outcome-token contract (a shared multi-token singleton). */
  outcomeToken?: string
  /** Outcome-token id for the UP side. */
  upId?: string
  /** Outcome-token id for the DOWN side. */
  downId?: string
  /** Collateral token address. */
  collateral?: string
  /** Oracle question id, for auditing how a market settled. */
  oracleQuestionId?: string
}

/** One price level in the book. */
export interface BookLevel {
  /** Probability price in millionths, in UP terms. */
  price: bigint
  /** Resting size at this level, in collateral base units. */
  quantity: bigint
}

/**
 * A snapshot of the order book, plus the derived CLOB metrics the spec's
 * "CLOB intelligence" panel renders.
 *
 * Every derived field is computed from real resting orders. When the book is
 * empty or one-sided the corresponding field is `null` — the UI must render an
 * honest empty state rather than a zero, because "spread = 0" reads as a
 * perfectly tight market when it actually means "no data".
 */
export interface OrderBook {
  marketId: string
  /** Descending by price. */
  bids: BookLevel[]
  /** Ascending by price. */
  asks: BookLevel[]
  /** Best bid price (millionths), or null if there are no bids. */
  bestBid: bigint | null
  /** Best ask price (millionths), or null if there are no asks. */
  bestAsk: bigint | null
  /** bestAsk - bestBid, or null unless both sides exist. */
  spread: bigint | null
  /** Midpoint of best bid/ask, or null unless both sides exist. */
  mid: bigint | null
  /** Total resting bid size, collateral base units. */
  bidDepth: bigint
  /** Total resting ask size, collateral base units. */
  askDepth: bigint
  /**
   * (bidDepth - askDepth) / (bidDepth + askDepth), in [-1, 1].
   * Positive = buy-side pressure. `null` when the book is completely empty,
   * so callers can distinguish "balanced" from "nothing there".
   */
  imbalance: number | null
  /** When this snapshot was taken (ms). */
  observedAtMs: number
}

/** What a prospective trade would actually cost, quoted over the live book. */
export interface Quote {
  marketId: string
  direction: Direction
  /** Size requested, collateral base units. */
  quantity: bigint
  /**
   * Size the book can actually fill. Less than `quantity` when the book is
   * too thin — the UI must surface this rather than implying a full fill.
   */
  fillableQuantity: bigint
  /** Volume-weighted execution price in millionths, or null if unfillable. */
  avgPrice: bigint | null
  /** Total collateral cost to acquire `fillableQuantity`. */
  cost: bigint
  /**
   * Slippage vs the touch, as a fraction (0.01 = 1%). Null when there is no
   * reference price to measure against.
   */
  slippage: number | null
  /** True when the book cannot fill the requested size at all. */
  insufficientLiquidity: boolean
}

export interface QuoteRequest {
  marketId: string
  direction: Direction
  quantity: bigint
}

/** Order kinds, normalized. */
export type OrderType = "LIMIT" | "MARKET" | "FILL_OR_KILL" | "POST_ONLY"

export interface PlaceOrderRequest {
  marketId: string
  direction: Direction
  /** BUY acquires the outcome token; SELL exits an existing position. */
  side: "BUY" | "SELL"
  /** Limit price in millionths, UP terms. */
  price: bigint
  /** Size in collateral base units. */
  quantity: bigint
  orderType: OrderType
}

/** A single execution against an order. */
export interface Fill {
  orderId: string
  marketId: string
  direction: Direction
  /** Executed price, millionths. */
  price: bigint
  /** Executed size, collateral base units. */
  quantity: bigint
  /** Transaction hash carrying this fill — the canonical evidence. */
  txHash: string
  timestampMs: number
}

/**
 * Result of submitting an order.
 *
 * `txHash` is REAL or the call failed. Per Absolute Rule #7 the adapter never
 * fabricates a hash, an order id, or a fill.
 */
export interface OrderResult {
  orderId: string | null
  marketId: string
  txHash: string
  /** Fills that executed immediately (taker orders). Empty for resting makers. */
  fills: Fill[]
  /** True when the order rested on the book rather than executing. */
  resting: boolean
}

export interface CancelOrderRequest {
  marketId: string
  orderId: string
}

export interface CancelResult {
  orderId: string
  txHash: string
  cancelled: boolean
}

/** A holding in one market. */
export interface Position {
  marketId: string
  owner: string
  /** UP tokens held, collateral base units. */
  upQuantity: bigint
  /** DOWN tokens held, collateral base units. */
  downQuantity: bigint
}

/** How a market finally resolved. */
export interface Settlement {
  marketId: string
  /**
   * The side that won. `null` when the market was VOIDED, in which case both
   * sides redeem at 0.5 rather than one side taking everything.
   */
  winner: Direction | null
  voided: boolean
  /** Settlement/reference price in the venue's feed units, when exposed. */
  settlementPrice: bigint | null
  resolvedAtMs: number | null
}

/** Filters for market discovery. */
export interface MarketFilters {
  /** Restrict to these assets, e.g. ["BTC"]. */
  assets?: string[]
  /** Only markets with at least this long left, in ms. Excludes near-expiry. */
  minTimeToExpiryMs?: number
  /** Only markets expiring within this horizon, in ms. */
  maxTimeToExpiryMs?: number
  /** Only these window lengths, in seconds. */
  intervalSec?: number[]
  /** Only markets currently accepting orders. Defaults to true. */
  tradingOnly?: boolean
  /** Cap on results. */
  limit?: number
}

/**
 * What this venue can actually do, right now.
 *
 * This is the mechanism behind Absolute Rule #11 — "if an advanced capability
 * is not supported by the live venue, implement an honest disabled/unavailable
 * state rather than a fake path". The UI reads these flags and disables the
 * corresponding surface instead of rendering a plausible-looking number.
 */
export interface VenueCapabilities {
  /** Reads (markets, books, settlement) are reachable. */
  readable: boolean
  /** Writes (mint, order, redeem) are possible — requires a funded signer. */
  writable: boolean
  /** A real order book can be read, so CLOB metrics are genuine. */
  orderBook: boolean
  /** Positions can be exited before expiry, so cash-out may be offered. */
  cashOut: boolean
  /** A per-market deep link into the venue UI is available. */
  venueLink: boolean
  /** Human-readable reason when something above is false. */
  reason?: string
}

/**
 * The venue adapter. This is the ONLY interface the rest of DreamSwipe may
 * use to reach a prediction venue.
 *
 * Contract for implementors:
 *   - Never invent data. If the venue cannot answer, throw
 *     `VenueUnavailableError` or return null — never a placeholder.
 *   - Never fabricate tx hashes, order ids, fills, prices or PnL.
 *   - Reads must not require a private key.
 *   - Writes must fail loudly when no signer is configured.
 */
export interface DreamDexAdapter {
  /** What this adapter can currently do. Drives UI gating. */
  capabilities(): Promise<VenueCapabilities>
  listMarkets(filters?: MarketFilters): Promise<EventMarket[]>
  getMarket(marketId: string): Promise<EventMarket | null>
  getOrderBook(marketId: string): Promise<OrderBook>
  getQuote(request: QuoteRequest): Promise<Quote>
  placeOrder(request: PlaceOrderRequest): Promise<OrderResult>
  cancelOrder(request: CancelOrderRequest): Promise<CancelResult>
  getFills(marketId: string, owner?: string): Promise<Fill[]>
  getPosition(marketId: string, owner: string): Promise<Position>
  getSettlement(marketId: string): Promise<Settlement | null>
  /** Deep link into the venue for this market, or null if none is known. */
  getVenueLink(marketId: string): string | null
}

/**
 * Thrown when the venue genuinely cannot serve a request.
 *
 * Callers are expected to surface this as an honest "unavailable" state. It
 * exists so that a venue outage degrades the product visibly instead of
 * silently producing wrong numbers — the failure mode this repo already lived
 * through once (see `apps/server/src/card-source.ts`).
 */
export class VenueUnavailableError extends Error {
  override readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "VenueUnavailableError"
    this.cause = cause
  }
}

/** Thrown when a write is attempted without a configured signer. */
export class VenueReadOnlyError extends Error {
  constructor(message = "Venue adapter is read-only: no signer configured") {
    super(message)
    this.name = "VenueReadOnlyError"
  }
}
