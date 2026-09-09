/**
 * GET /season — Season 0 leaderboard-prize config, for the rank-screen
 * display. Static (env-driven). The per-player staked-duel count + prize
 * eligibility ride on `/leaderboard` (they need the duel mirror).
 *
 * The prize pool is now ESCROWED on chain (`SeasonPrizePool.sol`), so this
 * endpoint reports the escrow address and the derived split; the authoritative
 * numbers — what is funded, what is allocated, what a given player can claim —
 * are read from the contract by the client, not from here. A server-reported
 * "claimable" would be a promise; the contract's is the fact.
 *
 * The headline total is DERIVED from the split so the top-line number and the
 * per-rank breakdown cannot drift apart.
 */
import { env } from "./env"
import { json } from "./lib/http"

/** Sum of every rank's prize across the configured tiers (the headline pool). */
export function seasonPrizePoolTotal(): number {
  return env.seasonPrizeSplit.reduce(
    (sum, t) => sum + t.amount * (t.rankEnd - t.rankStart + 1),
    0
  )
}

export function handleSeasonRequest(req: Request, url: URL): Response | null {
  if (url.pathname !== "/season" || req.method !== "GET") return null
  return json({
    season: {
      id: env.seasonId,
      name: env.seasonName,
      endsAt: env.seasonEndsAt,
      prizePool: {
        total: seasonPrizePoolTotal(),
        currency: env.seasonPrizeCurrency,
      },
      prizeSplit: env.seasonPrizeSplit,
      minStakedDuels: env.seasonMinStakedDuels,
      eligibilityNote: env.seasonEligibilityNote,
      // On-chain prize escrow. Present once SEASON_POOL_ADDRESS is set, which
      // is what lets the UI show that prizes are escrowed rather than promised.
      // Balances and per-player allocations are deliberately NOT mirrored here
      // — the client reads them from the contract.
      escrow: process.env.SEASON_POOL_ADDRESS
        ? {
            address: process.env.SEASON_POOL_ADDRESS,
            chainId: 50312,
            explorer: `https://shannon-explorer.somnia.network/address/${process.env.SEASON_POOL_ADDRESS}`,
          }
        : null,
    },
  })
}
