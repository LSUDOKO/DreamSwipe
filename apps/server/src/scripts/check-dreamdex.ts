/**
 * Live DreamDEX health check.
 *
 * Answers, against the real chain, the question that matters before a demo:
 * "can DreamSwipe actually deal a deck right now, and is the market data
 * real?"
 *
 * This is the DreamDEX counterpart to `check-sources.ts`, which exists because
 * a silent upstream outage cost this project ~12 days of playability. A
 * generic "market list failed" told nobody anything; this prints exactly which
 * stage broke.
 *
 * Read-only — needs no private key.
 *
 *   bun run check:dreamdex
 */
import {
  SomniaDreamDexAdapter,
  contrarianEdge,
  ONE_PROBABILITY,
} from "@workspace/dreamdex"
import {
  MAX_HORIZON_MS,
  MIN_DECK_SIZE,
  MIN_HEADROOM_MS,
  buildDreamDexDeck,
  selectEligibleMarkets,
} from "../dreamdex-card-source"

function pct(price: bigint): string {
  return `${((Number(price) / Number(ONE_PROBABILITY)) * 100).toFixed(1)}%`
}

function fmtSize(base: bigint, decimals: number): string {
  return (Number(base) / 10 ** decimals).toFixed(2)
}

async function main() {
  const started = Date.now()
  const adapter = new SomniaDreamDexAdapter()

  console.log("── Venue capabilities ─────────────────────────────────────")
  const caps = await adapter.capabilities()
  console.log(`  readable   ${caps.readable}`)
  console.log(`  writable   ${caps.writable}`)
  console.log(`  orderBook  ${caps.orderBook}`)
  console.log(`  cashOut    ${caps.cashOut}`)
  if (caps.reason) console.log(`  note       ${caps.reason}`)

  if (!caps.readable) {
    console.error("\nFAIL: cannot reach Somnia. Nothing else can work.")
    process.exit(1)
  }

  console.log("\n── Market discovery ───────────────────────────────────────")
  const t0 = Date.now()
  const markets = await adapter.listMarkets({ tradingOnly: false })
  console.log(
    `  ${markets.length} market(s) discovered in ${Date.now() - t0}ms`
  )

  const nowMs = Date.now()
  for (const m of markets) {
    const mins = Math.round((m.expirySec * 1000 - nowMs) / 60000)
    console.log(
      `    ${m.asset.padEnd(4)} ${String(m.intervalSec / 60).padStart(4)}m window  ` +
        `expires in ${String(mins).padStart(4)}m  ${m.status.padEnd(8)} ` +
        `dec=${m.collateralDecimals}`
    )
  }

  console.log("\n── Deck eligibility ───────────────────────────────────────")
  console.log(
    `  band: settles between ${MIN_HEADROOM_MS / 1000}s and ${MAX_HORIZON_MS / 60000}m from now`
  )
  const eligible = selectEligibleMarkets(markets, nowMs)
  console.log(
    `  ${eligible.length} eligible (need >= ${MIN_DECK_SIZE} to deal a deck)`
  )

  console.log("\n── Live order books ───────────────────────────────────────")
  let withLiquidity = 0
  for (const m of eligible.slice(0, 6)) {
    try {
      const book = await adapter.getOrderBook(m.id)
      const label = `${m.asset}/${m.intervalSec / 60}m`
      if (book.bestBid === null && book.bestAsk === null) {
        // Honest empty state, not a fabricated spread.
        console.log(`  ${label.padEnd(10)} empty book — no quotes resting`)
        continue
      }
      withLiquidity++
      const spread = book.spread === null ? "n/a" : pct(book.spread)
      const imbalance =
        book.imbalance === null
          ? "n/a"
          : `${(book.imbalance * 100).toFixed(1)}%`
      console.log(
        `  ${label.padEnd(10)} bid=${book.bestBid === null ? "—" : pct(book.bestBid)} ` +
          `ask=${book.bestAsk === null ? "—" : pct(book.bestAsk)} ` +
          `spread=${spread} depth=${fmtSize(book.bidDepth, m.collateralDecimals)}/` +
          `${fmtSize(book.askDepth, m.collateralDecimals)} imbalance=${imbalance}`
      )
      const edge = contrarianEdge(book)
      if (edge) {
        console.log(
          `             contrarian: crowd on ${edge.crowdedSide}, ` +
            `${edge.contrarianSide} pays ${edge.contrarianReturn.toFixed(2)}x`
        )
      }
    } catch (err) {
      console.log(
        `  ${m.asset}/${m.intervalSec / 60}m book read failed: ${(err as Error).message}`
      )
    }
  }

  console.log("\n── Deal a deck ────────────────────────────────────────────")
  try {
    const deck = await buildDreamDexDeck({
      adapter,
      seed: crypto.getRandomValues(new Uint8Array(32)),
      nowMs: Date.now(),
    })
    console.log(`  dealt ${deck.cards.length} card(s):`)
    deck.cards.forEach((c, i) => {
      const mins = Math.round((c.expiryMs - Date.now()) / 60000)
      console.log(
        `    ${i + 1}. ${c.asset} ${c.intervalSec / 60}m — "${c.question}" (settles in ${mins}m)`
      )
    })
  } catch (err) {
    console.log(`  cannot deal: ${(err as Error).message}`)
  }

  console.log("\n── Summary ────────────────────────────────────────────────")
  const canDeal = eligible.length >= MIN_DECK_SIZE
  console.log(`  markets live        ${markets.length}`)
  console.log(`  deck-eligible       ${eligible.length}`)
  console.log(`  books with quotes   ${withLiquidity}`)
  console.log(`  can start a duel    ${canDeal ? "YES" : "NO"}`)
  console.log(`  elapsed             ${Date.now() - started}ms`)

  if (!canDeal) {
    console.log(
      "\n  Not a bug on its own: the venue rolls short windows continuously,\n" +
        "  so a gap between windows can briefly leave too few eligible markets."
    )
  }

  // The SDK holds a websocket open, so the process will not exit on its own.
  process.exit(0)
}

main().catch((err) => {
  console.error("check:dreamdex failed:", err)
  process.exit(1)
})
