/**
 * Funding screen (formerly "shop").
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 *
 * On Sui this was a SUI ↔ dUSDC AMM swap, because a zkLogin wallet arrived
 * holding gas but no stake token and needed a way to convert. On Somnia the
 * faucet hands out BOTH tokens directly — STT for gas and tUSDC for
 * collateral — so an in-app swap solves a problem that no longer exists.
 *
 * Rather than ship a swap against liquidity DreamSwipe does not own (and must
 * not imply is official DreamDEX liquidity), this shows real balances and
 * points at the real faucet.
 */
import { useOutletContext } from "react-router"
import { PixelButton } from "@/components/pixel-button"
import type { GameOutletContext } from "./layout"
import { useCurrentAccount } from "@/hooks/use-wallet"
import { useWalletBalances } from "@/hooks/use-wallet-balances"
import {
  COLLATERAL_SYMBOL,
  addressUrl,
  formatCollateral,
  shortAddress,
} from "@/lib/chain"

const FAUCET_URL = "https://t.me/+XHq0F0JXMyhmMzM0"

export default function GameShop() {
  const account = useCurrentAccount()
  useOutletContext<GameOutletContext>()
  const { balanceBase, decimals, gas, isLoading, refetch } = useWalletBalances()

  if (!account) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 pt-10 text-center font-pixel text-white/60">
        <p className="text-xs tracking-[0.18em] uppercase">
          connect a wallet to see your balances
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-lg px-4 pt-6 pb-24 font-pixel text-white">
      <header className="mb-6">
        <h1 className="text-lg tracking-[0.18em] uppercase">funding</h1>
        <p className="mt-1 text-xs tracking-[0.15em] text-white/45 uppercase">
          somnia shannon testnet
        </p>
      </header>

      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
        <Row
          label="collateral"
          value={
            isLoading
              ? "…"
              : `${formatCollateral(balanceBase, decimals)} ${COLLATERAL_SYMBOL}`
          }
          hint="stakes staked duels"
        />
        <div className="my-3 h-px bg-white/10" />
        <Row
          label="gas"
          value={isLoading ? "…" : `${gas.toFixed(4)} STT`}
          hint="pays for on-chain actions"
        />
      </div>

      <p className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-[10px] leading-relaxed tracking-[0.08em] text-white/50">
        Testnet tokens come from the SomniaHacks faucet — ask in the faucet
        topic for STT and {COLLATERAL_SYMBOL}. There is no in-app swap: the
        faucet gives you both, so converting between them would serve no
        purpose.
      </p>

      <div className="mt-4 flex flex-col gap-2">
        <PixelButton
          onClick={() => window.open(FAUCET_URL, "_blank", "noopener")}
          className="h-12 w-full"
        >
          open faucet
        </PixelButton>
        <PixelButton onClick={() => refetch()} className="h-10 w-full">
          refresh
        </PixelButton>
      </div>

      <a
        href={addressUrl(account.address)}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-5 block text-center text-[10px] tracking-[0.15em] text-white/35 uppercase hover:text-white/70"
      >
        {shortAddress(account.address)} on explorer
      </a>
    </div>
  )
}

function Row({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="flex items-baseline justify-between">
      <div>
        <p className="text-[11px] tracking-[0.14em] text-white/70 uppercase">
          {label}
        </p>
        <p className="mt-0.5 text-[9px] tracking-[0.12em] text-white/35 uppercase">
          {hint}
        </p>
      </div>
      <span className="text-sm tracking-[0.08em]">{value}</span>
    </div>
  )
}
