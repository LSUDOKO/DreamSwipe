/**
 * Sign-in modal.
 *
 * ── What changed in the Somnia migration ────────────────────────────────────
 *
 * The Sui build offered "continue with Google" via Enoki zkLogin, which
 * created a wallet from an OAuth identity. **zkLogin has no EVM equivalent**,
 * so that option is gone rather than faked — DreamSwipe now connects an
 * injected EVM wallet (MetaMask, Rabby, …).
 *
 * The copy says so plainly. Showing a Google button that silently did
 * something else would be worse than losing the option.
 */
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { PixelButton } from "@/components/pixel-button"
import { describeWalletError, useWalletConnection } from "@/hooks/use-wallet"
import { somniaTestnet } from "@/lib/chain"

const WALLET_BRAND_STYLE = {
  "--pixel-face": "#f6851b",
  "--pixel-face-hi": "#ffa64d",
  "--pixel-face-lo": "#c96a12",
} as React.CSSProperties

export function LoginModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { connect, isPending, error, hasWallet, wrongNetwork, switchToSomnia } =
    useWalletConnection()
  // A connect can fail BEFORE wagmi records anything (no connector, a throw in
  // our own guard), so local failures are tracked separately and shown with
  // the same wording.
  const [localError, setLocalError] = useState<string | null>(null)
  const shownError = localError ?? error

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

  const handleConnect = async () => {
    if (!hasWallet) {
      window.open("https://metamask.io/download/", "_blank", "noopener")
      return
    }
    setLocalError(null)
    try {
      await connect()
      onClose()
    } catch (e) {
      // Never swallow this silently: a wallet that is merely LOCKED reports a
      // "user rejected" error, and showing nothing left the user staring at a
      // button that appeared to do nothing.
      setLocalError(describeWalletError(e))
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-title"
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
            id="login-title"
            className="text-base tracking-[0.18em] uppercase"
          >
            sign in to dreamswipe
          </h2>
          <p className="mt-1 text-xs tracking-[0.18em] text-white/45 uppercase">
            somnia shannon testnet
          </p>
        </header>

        <div className="flex flex-col gap-3 px-6 pb-6">
          <PixelButton
            onClick={handleConnect}
            disabled={isPending}
            style={WALLET_BRAND_STYLE}
            className="h-12"
          >
            <span className="flex w-full items-center justify-center gap-2">
              {isPending
                ? "connecting…"
                : hasWallet
                  ? "connect wallet"
                  : "install a wallet"}
            </span>
          </PixelButton>

          {wrongNetwork && (
            // Connected but on another chain: every read would come back empty,
            // so say why instead of rendering a blank app.
            <PixelButton onClick={() => void switchToSomnia()} className="h-12">
              switch to somnia testnet
            </PixelButton>
          )}

          {shownError && (
            <p className="text-center text-[10px] leading-relaxed tracking-[0.1em] text-red-300/85">
              {shownError}
            </p>
          )}

          <p className="mt-2 text-center text-[10px] leading-relaxed tracking-[0.14em] text-white/35">
            {hasWallet
              ? `Unlock your wallet first, then approve the connect and the Somnia (chain ${somniaTestnet.id}) prompt. Testnet only — no real funds.`
              : "No EVM wallet detected. Install MetaMask or another injected wallet, then reload this page."}
          </p>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default LoginModal
