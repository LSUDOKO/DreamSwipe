/**
 * Relayer HTTP endpoint.
 *
 * `POST /relay/swipe` — accept a player's EIP-712-signed swipe and submit it.
 *
 * ── Where the execution numbers come from ───────────────────────────────────
 *
 * `premium` (what the swipe cost) and `filled` (what was acquired) decide the
 * card's score, so they are derived HERE from the live venue book and never
 * taken from the request body. A client-supplied premium would let a player
 * understate their own entry cost and inflate their PnL, which is the one
 * cheat this design has to actively prevent.
 *
 * The current build records the market's live executable price for one
 * contract. When the staked path places real orders, this is the seam where
 * the actual fill replaces the quote — the contract already stores whatever it
 * is told, so nothing downstream changes.
 */
import { SomniaDreamDexAdapter } from "@workspace/dreamdex/adapter"
import { ONE_PROBABILITY } from "@workspace/dreamdex"
import { relaySwipe, validateSwipeRequest } from "./relayer"
import { makeLogger } from "./log"

const log = makeLogger("relay-api")

/** One whole prediction contract, 6-decimal collateral. */
const SWIPE_QUANTITY = 1_000_000n

let adapter: SomniaDreamDexAdapter | null = null
function getAdapter(): SomniaDreamDexAdapter {
  adapter ??= new SomniaDreamDexAdapter({
    rpcUrl: process.env.SOMNIA_RPC_URL,
    wsRpcUrl: process.env.SOMNIA_WS_RPC_URL,
    indexerUrl: process.env.DREAMDEX_INDEXER_URL,
  })
  return adapter
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  })
}

/**
 * Price one contract on the side the player swiped.
 *
 * Falls back to an even-odds premium when the book is empty. That is a
 * deliberate, documented choice rather than a silent one: a free-tier duel
 * must still be playable on a market with no resting orders, and 0.5 is the
 * only non-arbitrary price when the market expresses no view. Staked duels
 * place real orders and use the real fill.
 */
async function priceSwipe(
  marketId: string,
  direction: number
): Promise<{ premium: bigint; filled: bigint }> {
  try {
    const quote = await getAdapter().getQuote({
      marketId,
      direction: direction === 0 ? "UP" : "DOWN",
      quantity: SWIPE_QUANTITY,
    })
    if (quote.avgPrice !== null && quote.fillableQuantity > 0n) {
      return { premium: quote.cost, filled: quote.fillableQuantity }
    }
  } catch (err) {
    log.info(
      `quote failed for ${marketId.slice(0, 10)}: ${(err as Error).message}`
    )
  }
  // Even odds: cost = quantity * 0.5.
  return {
    premium: (SWIPE_QUANTITY * (ONE_PROBABILITY / 2n)) / ONE_PROBABILITY,
    filled: SWIPE_QUANTITY,
  }
}

export async function handleRelayRequest(
  req: Request
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== "/relay/swipe") return null
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: "invalid JSON body" }, 400)
  }

  const parsed = validateSwipeRequest(body)
  if (typeof parsed === "string") {
    return json({ error: parsed }, 400)
  }

  // marketId is optional: without it the swipe is priced at even odds, which
  // is correct for a free duel and honest about being a quote, not a fill.
  const marketId = (body as { marketId?: string }).marketId
  const execution = marketId
    ? await priceSwipe(marketId, parsed.direction)
    : {
        premium: (SWIPE_QUANTITY * (ONE_PROBABILITY / 2n)) / ONE_PROBABILITY,
        filled: SWIPE_QUANTITY,
      }

  const result = await relaySwipe(parsed, execution)
  if (!result.ok) {
    return json({ error: result.error }, result.status ?? 502)
  }
  return json({ ok: true, txHash: result.txHash })
}
