/**
 * Withdraw panel.
 *
 * ── There is nothing to withdraw from ───────────────────────────────────────
 *
 * On Sui, collateral lived inside a DeepBook `AccountWrapper` and had to be
 * withdrawn back to the wallet before it could be moved. On Somnia the wallet
 * holds the ERC-20 directly, so "withdraw" has no meaning: the tokens are
 * already where the player can spend them.
 *
 * Rather than delete the route (callers still link to it) this states that
 * plainly and points at the explorer. Keeping a withdraw form that moved
 * nothing would imply an account layer that does not exist.
 */
import { useEffect } from "react"
import { createPortal } from "react-dom"
import { PixelButton } from "@/components/pixel-button"
import { useWalletBalances } from "@/hooks/use-wallet-balances"
import {
  COLLATERAL_SYMBOL,
  addressUrl,
  formatCollateral,
  shortAddress,
} from "@/lib/chain"

export interface WithdrawModalProps {
  open: boolean
  address: string
  onClose: () => void
}

export function WithdrawModal({ open, address, onClose }: WithdrawModalProps) {
  const { balanceBase, decimals } = useWalletBalances()

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", handleKey)
    return () => {
      document.body.style.overflow = ""
      window.removeEventListener("keydown", handleKey)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="withdraw-title"
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
            id="withdraw-title"
            className="text-base tracking-[0.18em] uppercase"
          >
            your funds
          </h2>
        </header>

        <div className="flex flex-col gap-3 px-6 pb-6">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-center">
            <p className="text-lg tracking-[0.08em]">
              {formatCollateral(balanceBase, decimals)} {COLLATERAL_SYMBOL}
            </p>
            <p className="mt-1 text-[10px] tracking-[0.16em] text-white/40 uppercase">
              held directly by {shortAddress(address)}
            </p>
          </div>

          <p className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-[10px] leading-relaxed tracking-[0.08em] text-white/55">
            On Somnia there is no separate game account to withdraw from — your
            wallet holds the collateral directly, so it is already yours to move
            or spend. Escrow only ever holds a stake for the duration of a
            staked duel, and returns it on settle or timeout.
          </p>

          <PixelButton
            onClick={() =>
              window.open(addressUrl(address), "_blank", "noopener")
            }
            className="h-12 w-full"
          >
            view on explorer
          </PixelButton>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default WithdrawModal
