/**
 * Collateral + swipe-window helpers.
 *
 * ── Why this file still exists, and why the name is temporary ───────────────
 *
 * On Sui this module wrapped DeepBook Predict: deriving a per-player
 * `AccountWrapper`, building deposit/withdraw PTBs, converting strikes to
 * ticks. **None of that survives on Somnia** — DreamDEX event contracts have
 * no funding account to derive, and collateral is a plain ERC-20 the player
 * already holds.
 *
 * What is kept is the small set of pure helpers the UI genuinely still needs
 * (formatting, swipe-window timing), re-implemented for EVM. The module keeps
 * its old path so the migration is one commit rather than a rename touching
 * eight components; it should be folded into `lib/chain.ts` afterwards.
 *
 * Everything venue-specific now lives behind `@workspace/dreamdex`.
 */
import { COLLATERAL_DECIMALS, COLLATERAL_SYMBOL } from "./chain"

/**
 * Collateral descriptor.
 *
 * On Shannon testnet this is tUSDC at 6 decimals — NOT USDso at 18, which is
 * mainnet-only. The two differ by 10^12 and nothing reverts to tell you, so
 * `decimals` is carried explicitly everywhere it is used.
 */
export const DUSDC = {
  symbol: COLLATERAL_SYMBOL,
  decimals: COLLATERAL_DECIMALS,
} as const

/** Native gas token. STT on testnet; SOMI is mainnet. */
export const SUI = {
  symbol: "STT",
  decimals: 18,
} as const

/**
 * Per-swipe sizing.
 *
 * `QUANTITY` is one whole prediction contract in collateral base units. A
 * winning contract redeems 1:1, so this is also the maximum payout per card.
 */
export const SWIPE = {
  QUANTITY: 1_000_000n,
  /** How long a player has to decide a card, ms. */
  WINDOW_MS: 15_000,
} as const

/**
 * Time left in the current card's swipe window.
 *
 * Returns 0 once elapsed rather than a negative number, so callers can render
 * a countdown without clamping at every call site.
 */
export function swipeWindowRemainingMs(
  startedAtMs: number,
  nowMs: number = Date.now()
): number {
  if (startedAtMs <= 0) return SWIPE.WINDOW_MS
  return Math.max(0, startedAtMs + SWIPE.WINDOW_MS - nowMs)
}

/**
 * Time left on a specific card, given the duel start and the card's index.
 *
 * Cards are swiped in order, so card `i` opens `i` windows after the duel
 * started.
 */
export function cardSwipeRemainingMs(
  startedAtMs: number,
  cardIdx: number,
  nowMs: number = Date.now()
): number {
  if (startedAtMs <= 0) return SWIPE.WINDOW_MS
  const opensAt = startedAtMs + cardIdx * SWIPE.WINDOW_MS
  return Math.max(0, opensAt + SWIPE.WINDOW_MS - nowMs)
}

/**
 * Format a collateral amount.
 *
 * Takes `decimals` so a caller holding a live market's own scale can pass it
 * rather than inheriting the testnet default.
 */
export function fmtDusdc(
  base: bigint,
  decimals: number = COLLATERAL_DECIMALS,
  fractionDigits = 2
): string {
  const negative = base < 0n
  const abs = negative ? -base : base
  const scale = 10n ** BigInt(decimals)
  const whole = abs / scale
  const frac = (abs % scale).toString().padStart(decimals, "0")
  const shown = fractionDigits > 0 ? `.${frac.slice(0, fractionDigits)}` : ""
  return `${negative ? "-" : ""}${whole}${shown}`
}

/** Signed variant, with an explicit + so a gain reads as a gain. */
export function fmtDusdcSigned(
  base: bigint,
  decimals: number = COLLATERAL_DECIMALS
): string {
  const s = fmtDusdc(base, decimals)
  return base > 0n ? `+${s}` : s
}

/**
 * Venue/contract addresses, under the old `DEEPBOOK` name so existing call
 * sites keep resolving during the migration.
 *
 * On Somnia there is no protocol config, pool vault or account registry to
 * reference — a market carries its own pool, and the adapter routes to it. Only
 * the collateral address is still meaningful here.
 */
export { COLLATERAL_ADDRESS as DEEPBOOK_COLLATERAL } from "./chain"

export const DEEPBOOK = {
  /** Retained for display; there is no separate venue package on EVM. */
  packageId: "",
} as const

/**
 * There is no funding account to resolve on EVM — the wallet IS the account.
 * Returns the address unchanged so legacy call sites keep working.
 */
export async function resolveWrapper(address: string): Promise<string> {
  return address
}

/** No separate account state exists; the wallet's own balance is authoritative. */
export async function fetchAccountState(
  address: string
): Promise<{ wrapperId: string; balance: bigint }> {
  return { wrapperId: address, balance: 0n }
}
