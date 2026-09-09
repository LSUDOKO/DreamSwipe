/**
 * Pre-duel readiness gate.
 *
 * ── Drastically simpler on Somnia ───────────────────────────────────────────
 *
 * The Sui version walked the player through a multi-step funding flow: create
 * a DeepBook `AccountWrapper`, deposit dUSDC into it, poll until the balance
 * landed, and only then let them queue. That whole account layer is gone —
 * DreamDEX settles against an ERC-20 the wallet already holds.
 *
 * So the only real questions left are the two that can actually block a duel:
 * does the player have gas, and (for a staked duel) do they hold the stake?
 * Both are checked against live chain state, and the gate opens as soon as
 * they pass.
 */
import { useEffect } from "react"
import { createPortal } from "react-dom"
import { PixelButton } from "@/components/pixel-button"
import { DepositModal } from "@/components/deposit-modal"
import { useState } from "react"
import { useCurrentAccount } from "@/hooks/use-wallet"
import { useWalletBalances } from "@/hooks/use-wallet-balances"
import { COLLATERAL_SYMBOL, formatCollateral } from "@/lib/chain"

interface Props {
  open: boolean
  /** Stake for the duel being entered, in collateral base units. 0n = free. */
  stake: bigint
  onClose: () => void
  /** Called once the player is genuinely able to enter. */
  onReady: (address: string) => void
}

export function OnboardingModal({ open, stake, onClose, onReady }: Props) {
  const account = useCurrentAccount()
  const { balanceBase, decimals, gas, isLoading, refetch } = useWalletBalances()
  const [fundingOpen, setFundingOpen] = useState(false)

  useEffect(() => {
    if (open) refetch()
  }, [open, refetch])

  if (!open) return null

  const hasGas = gas > 0
  const hasStake = stake === 0n || balanceBase >= stake
  const ready = Boolean(account) && hasGas && hasStake

  return createPortal(
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ready-title"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
        onClick={onClose}
      >
        <div
          className="pixel-frame relative w-full max-w-sm rounded-3xl bg-[#1b2548] font-pixel text-white"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="absolute top-3 right-3 grid size-7 place-items-center text-base text-white/55 hover:text-white"
          >
            ✕
          </button>

          <header className="px-6 pt-7 pb-4 text-center">
            <h2
              id="ready-title"
              className="text-base tracking-[0.18em] uppercase"
            >
              ready to duel?
            </h2>
            <p className="mt-1 text-xs tracking-[0.18em] text-white/45 uppercase">
              {stake === 0n
                ? "free duel — no stake"
                : `stake ${formatCollateral(stake, decimals)} ${COLLATERAL_SYMBOL}`}
            </p>
          </header>

          <div className="flex flex-col gap-2 px-6 pb-6">
            <Check
              label="wallet connected"
              ok={Boolean(account)}
              detail={account ? undefined : "connect a wallet to play"}
            />
            <Check
              label="gas for transactions"
              ok={hasGas}
              detail={
                hasGas
                  ? `${gas.toFixed(4)} STT`
                  : "no STT — transactions will fail"
              }
            />
            <Check
              label={stake === 0n ? "no stake required" : "stake available"}
              ok={hasStake}
              detail={
                stake === 0n
                  ? undefined
                  : `${formatCollateral(balanceBase, decimals)} ${COLLATERAL_SYMBOL} held`
              }
            />

            {!ready && !isLoading && (
              <PixelButton
                onClick={() => setFundingOpen(true)}
                className="mt-2 h-12 w-full"
              >
                get testnet funds
              </PixelButton>
            )}

            <PixelButton
              onClick={() => account && onReady(account.address)}
              disabled={!ready}
              className="mt-1 h-12 w-full"
            >
              {isLoading ? "checking…" : ready ? "enter duel" : "not ready"}
            </PixelButton>
          </div>
        </div>
      </div>

      {account && (
        <DepositModal
          open={fundingOpen}
          address={account.address}
          onClose={() => {
            setFundingOpen(false)
            refetch()
          }}
        />
      )}
    </>,
    document.body
  )
}

function Check({
  label,
  ok,
  detail,
}: {
  label: string
  ok: boolean
  detail?: string
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
      <div>
        <p className="text-[11px] tracking-[0.12em] text-white/75 uppercase">
          {label}
        </p>
        {detail && (
          <p className="mt-0.5 text-[9px] tracking-[0.12em] text-white/35 uppercase">
            {detail}
          </p>
        )}
      </div>
      <span
        className={`text-sm ${ok ? "text-emerald-300/90" : "text-white/25"}`}
        aria-label={ok ? "ready" : "not ready"}
      >
        {ok ? "✓" : "○"}
      </span>
    </div>
  )
}

export default OnboardingModal
