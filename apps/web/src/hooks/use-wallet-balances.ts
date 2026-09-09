/**
 * Player balances.
 *
 * ── What the Somnia migration removed ───────────────────────────────────────
 *
 * On Sui a player had TWO balances: coins in their wallet, and a separate
 * DeepBook `AccountWrapper` they had to create and fund before they could
 * play. That second account is gone — DreamDEX event contracts settle against
 * a plain ERC-20 the wallet already holds, so there is nothing to derive, no
 * wrapper to create, and no deposit step before a first duel.
 *
 * The hook keeps returning a `managerId` field (always null) so the handful of
 * call sites that branch on "does this player have an account yet" keep
 * compiling during the migration. Those branches are now always false, which
 * is correct: on Somnia every connected wallet is ready to play.
 */
import {
  useCollateralBalance,
  useCurrentAccount,
  useNativeBalance,
} from "./use-wallet"

export interface WalletBalances {
  /** Collateral (tUSDC) in whole units, for display. */
  balance: number
  /** Raw collateral, base units — use this for any arithmetic. */
  balanceBase: bigint
  /** Decimals as reported by the token itself. */
  decimals: number
  /** Native STT for gas, in whole units. */
  gas: number
  /**
   * Always null on EVM. Retained so legacy "needs an account" branches keep
   * type-checking; there is no funding account to have.
   */
  managerId: string | null
  isLoading: boolean
  refetch: () => void
}

export function useWalletBalances(): WalletBalances {
  const account = useCurrentAccount()
  const collateral = useCollateralBalance()
  const native = useNativeBalance()

  return {
    balance: Number(collateral.value) / 10 ** collateral.decimals,
    balanceBase: collateral.value,
    decimals: collateral.decimals,
    gas: Number(native.value) / 10 ** native.decimals,
    managerId: null,
    isLoading: Boolean(account) && (collateral.isLoading || native.isLoading),
    refetch: () => {
      void collateral.refetch()
      void native.refetch()
    },
  }
}

/**
 * Whether this player can actually transact.
 *
 * Gas and collateral are reported separately on purpose: a player holding
 * plenty of tUSDC but no STT cannot send a transaction, and conflating the two
 * produces a baffling "why did nothing happen" failure.
 */
export function useCanTransact(): {
  hasGas: boolean
  hasCollateral: boolean
  ready: boolean
} {
  const { gas, balanceBase } = useWalletBalances()
  const hasGas = gas > 0
  const hasCollateral = balanceBase > 0n
  return { hasGas, hasCollateral, ready: hasGas }
}

/**
 * Collateral balance in whole units.
 *
 * Kept under its Sui-era name so header/layout call sites migrate unchanged.
 * On Somnia there is only ONE balance — the wallet's — so this and
 * `useManagerBalance` intentionally report the same number rather than
 * pretending a second funding account still exists.
 */
export function useDusdcBalance(): { data: number; isLoading: boolean } {
  const { balance, isLoading } = useWalletBalances()
  return { data: balance, isLoading }
}

/**
 * Legacy alias for the old DeepBook "manager" balance.
 *
 * There is no manager account on EVM. This returns the wallet balance and a
 * null `managerId`, so any "create your account first" branch is permanently
 * false — which is the truth: a connected wallet is already ready to play.
 */
export function useManagerBalance(): {
  data: { managerId: string | null; balance: number }
  isLoading: boolean
} {
  const { balance, isLoading } = useWalletBalances()
  return { data: { managerId: null, balance }, isLoading }
}

/**
 * Native gas balance, under its Sui-era name.
 *
 * The token is STT on Shannon (SOMI is mainnet), but the call sites only care
 * that it is "the coin that pays for gas", so the name is kept for the
 * migration.
 */
export function useSuiBalance(): { data: number; isLoading: boolean } {
  const { gas, isLoading } = useWalletBalances()
  return { data: gas, isLoading }
}

/** Force a balance refetch after a transaction lands. */
export function useInvalidateWalletBalances(): () => void {
  const { refetch } = useWalletBalances()
  return refetch
}
