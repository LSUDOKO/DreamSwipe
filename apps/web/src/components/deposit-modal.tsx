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
import { useCallback, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { useConfig } from "wagmi"
import { waitForTransactionReceipt } from "wagmi/actions"
import { PixelButton } from "@/components/pixel-button"
import { useWalletBalances } from "@/hooks/use-wallet-balances"
import { claimFaucet } from "@/lib/duel"
import { FAUCET_AMOUNT } from "@/lib/chain"
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

type ClaimState =
  | { kind: "idle" }
  | { kind: "claiming" }
  | { kind: "done" }
  | { kind: "error"; message: string }

export function DepositModal({ open, address, onClose }: DepositModalProps) {
  const { balanceBase, decimals, gas, isLoading, refetch } = useWalletBalances()
  const config = useConfig()
  const [claim, setClaim] = useState<ClaimState>({ kind: "idle" })

  /**
   * Claim tUSDC from the token's own permissionless faucet.
   *
   * This replaced a link to a Telegram group. Collateral is one click away on
   * chain, so sending a player out of the app mid-onboarding to ask a human
   * for a token they can mint themselves was a dead end.
   *
   * Gas still comes from the faucet group — the token mints collateral, not
   * STT — so the button is disabled without gas rather than failing at the
   * wallet prompt.
   */
  const onClaim = useCallback(async () => {
    setClaim({ kind: "claiming" })
    try {
      const hash = await claimFaucet(config, FAUCET_AMOUNT)
      // Wait for the receipt: "submitted" is not "succeeded" on Somnia, where
      // an under-limit tx mines with status 0.
      const receipt = await waitForTransactionReceipt(config, { hash })
      if (receipt.status !== "success") {
        throw new Error("The faucet transaction reverted. Try again.")
      }
      await refetch()
      setClaim({ kind: "done" })
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      setClaim({
        kind: "error",
        message: /user rejected|denied/i.test(raw)
          ? "Claim cancelled — approve the transaction in your wallet."
          : raw.split("\n")[0]?.slice(0, 140) || "Faucet claim failed.",
      })
    }
  }, [config, refetch])

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

          {/* Collateral: claimable in-app, one transaction. */}
          <PixelButton
            onClick={() => void onClaim()}
            disabled={claim.kind === "claiming" || needsGas}
            className="h-12 w-full"
          >
            {claim.kind === "claiming"
              ? "claiming…"
              : `get ${FAUCET_AMOUNT / 1_000_000n} ${COLLATERAL_SYMBOL}`}
          </PixelButton>

          {claim.kind === "done" && (
            <p className="text-center text-[10px] tracking-[0.14em] text-emerald-300/90 uppercase">
              claimed — balance updated
            </p>
          )}
          {claim.kind === "error" && (
            <p className="text-center text-[10px] leading-relaxed tracking-[0.1em] text-red-300/85">
              {claim.message}
            </p>
          )}

          {/* Gas cannot be minted — it still comes from the faucet group. */}
          {needsGas && (
            <PixelButton
              onClick={() => window.open(FAUCET_URL, "_blank", "noopener")}
              className="h-11 w-full"
            >
              get STT for gas
            </PixelButton>
          )}

          <PixelButton onClick={() => refetch()} className="h-10 w-full">
            refresh balances
          </PixelButton>

          <p className="mt-1 text-center text-[10px] leading-relaxed tracking-[0.14em] text-white/35">
            {needsGas
              ? "STT for gas comes from the SomniaHacks group; collateral is claimable here once you have gas."
              : `${COLLATERAL_SYMBOL} is claimable straight from the token contract — no external step.`}
          </p>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default DepositModal
