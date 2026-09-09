/**
 * Season prize claim panel.
 *
 * Reads the ESCROW, not the server. The server's `/season` endpoint describes
 * the prize split; this shows what the contract will actually pay this wallet,
 * because those are different claims and only one of them is enforceable.
 *
 * The panel renders nothing at all when the wallet has no allocation — an
 * empty "claim your prize" card on a screen where you won nothing is noise,
 * and a disabled claim button invites a click that would revert.
 */
import { useCallback, useEffect, useState } from "react"
import { useConfig } from "wagmi"
import { PixelButton } from "@/components/pixel-button"
import { useCurrentAccount } from "@/hooks/use-wallet"
import {
  COLLATERAL_SYMBOL,
  formatCollateral,
  txUrl,
  addressUrl,
} from "@/lib/chain"
import {
  SEASON_POOL_ADDRESS,
  SeasonState,
  claimPrize,
  fetchAllocation,
  fetchClaimable,
  fetchHasClaimed,
  fetchSeason,
  seasonIdOf,
} from "@/lib/season-pool"

type Phase =
  | { kind: "loading" }
  | { kind: "none" } // nothing allocated to this wallet
  | { kind: "pending" } // allocated, season not finalized yet
  | { kind: "claimable"; amount: bigint }
  | { kind: "claiming" }
  | { kind: "claimed"; txHash?: string }
  | { kind: "error"; message: string }

export function SeasonClaim({ seasonLabel }: { seasonLabel: string }) {
  const account = useCurrentAccount()
  const config = useConfig()
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })

  const load = useCallback(async () => {
    if (!account) {
      setPhase({ kind: "none" })
      return
    }
    try {
      const seasonId = seasonIdOf(seasonLabel)
      const [season, allocation, claimed] = await Promise.all([
        fetchSeason(config, seasonId),
        fetchAllocation(config, seasonId, account.address),
        fetchHasClaimed(config, seasonId, account.address),
      ])

      // A season that was never created reads as state 0 — treat it as "no
      // prize here" rather than surfacing a contract-shaped error to a player.
      if (season.state === SeasonState.None || allocation === 0n) {
        setPhase({ kind: "none" })
        return
      }
      if (claimed) {
        setPhase({ kind: "claimed" })
        return
      }
      if (season.state !== SeasonState.Finalized) {
        setPhase({ kind: "pending" })
        return
      }
      const amount = await fetchClaimable(config, seasonId, account.address)
      setPhase(
        amount > 0n ? { kind: "claimable", amount } : { kind: "claimed" }
      )
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message.slice(0, 140) })
    }
  }, [account, config, seasonLabel])

  useEffect(() => {
    void load()
  }, [load])

  const onClaim = useCallback(async () => {
    setPhase({ kind: "claiming" })
    try {
      const txHash = await claimPrize(config, seasonIdOf(seasonLabel))
      setPhase({ kind: "claimed", txHash })
    } catch (e) {
      // A user-rejected wallet prompt is normal; show the reason and let them
      // retry rather than leaving the panel stuck in "claiming".
      setPhase({ kind: "error", message: (e as Error).message.slice(0, 140) })
    }
  }, [config, seasonLabel])

  // Nothing to say to a player with no allocation.
  if (phase.kind === "none" || phase.kind === "loading") return null

  return (
    <section className="mt-4 rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-4 font-pixel">
      <h3 className="text-[11px] tracking-[0.18em] text-amber-100/90 uppercase">
        season prize
      </h3>

      {phase.kind === "pending" && (
        <p className="mt-2 text-[10px] leading-relaxed tracking-[0.08em] text-white/55">
          You have an allocation, but the season is not finalized yet. Prizes
          unlock once the operator finalizes — after that the allocations are
          frozen on chain and nobody can change them.
        </p>
      )}

      {phase.kind === "claimable" && (
        <>
          <p className="mt-2 text-lg tracking-[0.06em] text-white">
            {formatCollateral(phase.amount)} {COLLATERAL_SYMBOL}
          </p>
          <p className="mt-1 text-[10px] tracking-[0.1em] text-white/45 uppercase">
            escrowed on chain · yours to claim
          </p>
          <PixelButton
            onClick={() => void onClaim()}
            className="mt-3 h-11 w-full"
          >
            claim prize
          </PixelButton>
        </>
      )}

      {phase.kind === "claiming" && (
        <p className="mt-2 text-[10px] tracking-[0.12em] text-white/60 uppercase">
          claiming…
        </p>
      )}

      {phase.kind === "claimed" && (
        <>
          <p className="mt-2 text-[10px] tracking-[0.12em] text-emerald-300/90 uppercase">
            claimed
          </p>
          {phase.txHash && (
            <a
              href={txUrl(phase.txHash)}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 block text-[10px] tracking-[0.1em] text-white/40 underline hover:text-white/70"
            >
              view transaction
            </a>
          )}
        </>
      )}

      {phase.kind === "error" && (
        <>
          <p className="mt-2 text-[10px] leading-relaxed tracking-[0.08em] text-red-300/80">
            {phase.message}
          </p>
          <PixelButton onClick={() => void load()} className="mt-3 h-10 w-full">
            retry
          </PixelButton>
        </>
      )}

      <a
        href={addressUrl(SEASON_POOL_ADDRESS)}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-3 block text-[9px] tracking-[0.12em] text-white/30 uppercase hover:text-white/60"
      >
        prize pool contract
      </a>
    </section>
  )
}

export default SeasonClaim
