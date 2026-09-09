/**
 * Wallet / funding panel.
 *
 * ── Why this replaced ~1,800 lines ──────────────────────────────────────────
 *
 * The Sui version managed a DeepBook funding account: create an
 * `AccountWrapper`, deposit dUSDC into it, poll until the balance landed, then
 * withdraw back out. **None of that exists on Somnia.** DreamDEX event
 * contracts settle against a plain ERC-20 the wallet already holds, so there
 * is no account to create and no deposit step before a first duel.
 *
 * What remains is the honest thing: show what the wallet holds, and point at
 * the faucet when it holds nothing. There is no in-app faucet call because the
 * SomniaHacks faucet is a Telegram flow, not a contract — offering a "get
 * tokens" button that silently did nothing would be worse than a link.
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

/** Where testnet STT (gas) and tUSDC (collateral) come from. */
const FAUCET_URL = "https://t.me/+XHq0F0JXMyhmMzM0"

export interface DepositModalProps {
  open: boolean
  address: string
  onClose: () => void
}

export function DepositModal({ open, address, onClose }: DepositModalProps) {
  const { balanceBase, decimals, gas, isLoading, refetch } = useWalletBalances()

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

  // Refresh on open so a player returning from the faucet sees the new balance
  // without reloading the page.
  useEffect(() => {
    if (open) refetch()
  }, [open, refetch])

  if (!open) return null

  const needsGas = gas <= 0
  const needsCollateral = balanceBase <= 0n

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-title"
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
            id="wallet-title"
            className="text-base tracking-[0.18em] uppercase"
          >
            your wallet
          </h2>
          <a
            href={addressUrl(address)}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 block text-xs tracking-[0.18em] text-white/45 uppercase hover:text-white/70"
          >
            {shortAddress(address)}
          </a>
        </header>

        <div className="flex flex-col gap-3 px-6 pb-6">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] tracking-[0.16em] text-white/45 uppercase">
                collateral
              </span>
              <span className="text-sm tracking-[0.08em]">
                {isLoading
                  ? "…"
                  : `${formatCollateral(balanceBase, decimals)} ${COLLATERAL_SYMBOL}`}
              </span>
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-[10px] tracking-[0.16em] text-white/45 uppercase">
                gas
              </span>
              <span className="text-sm tracking-[0.08em]">
                {isLoading ? "…" : `${gas.toFixed(4)} STT`}
              </span>
            </div>
          </div>

          {(needsGas || needsCollateral) && (
            <div className="rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] p-4 text-[10px] leading-relaxed tracking-[0.08em] text-amber-100/80">
              {needsGas && needsCollateral
                ? "You need STT for gas and tUSDC for staked duels."
                : needsGas
                  ? "You have no STT, so transactions will fail. Grab some gas."
                  : "You have gas but no tUSDC — free duels work, staked ones need collateral."}
            </div>
          )}

          <PixelButton
            onClick={() => window.open(FAUCET_URL, "_blank", "noopener")}
            className="h-12 w-full"
          >
            open testnet faucet
          </PixelButton>

          <PixelButton onClick={() => refetch()} className="h-10 w-full">
            refresh balances
          </PixelButton>

          <p className="mt-1 text-center text-[10px] leading-relaxed tracking-[0.14em] text-white/35">
            somnia shannon testnet. faucet is the somniahacks telegram group —
            ask in the faucet topic for STT and {COLLATERAL_SYMBOL}.
          </p>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default DepositModal
