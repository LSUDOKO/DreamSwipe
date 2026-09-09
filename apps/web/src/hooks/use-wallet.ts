/**
 * Wallet hooks — the EVM replacement for dApp Kit's `useCurrentAccount` &c.
 *
 * ── Why these keep the old shapes ───────────────────────────────────────────
 *
 * 22 files in this app called dApp Kit hooks. Rewriting each call site by hand
 * during a chain migration is how subtle breakage gets introduced into working
 * UI. Instead these expose the same SHAPES the app already consumes
 * (`account?.address`, `isConnecting`, …) backed by wagmi, so most files
 * migrate by changing an import rather than their logic.
 *
 * This is a deliberate, temporary compatibility layer, not a permanent
 * abstraction: new code should prefer wagmi's hooks directly.
 *
 * ── What genuinely changed ──────────────────────────────────────────────────
 *
 * zkLogin/Enoki has no EVM equivalent, so "continue with Google" is gone. Sign
 * in is now an injected EVM wallet (MetaMask, Rabby, …). That is a real
 * product change, not a shim: the app can no longer create a custodial-ish
 * social account, and the UI says so plainly rather than implying otherwise.
 */
import { useCallback, useMemo } from "react"
import {
  useAccount,
  useBalance,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
} from "wagmi"
import { erc20Abi } from "viem"
import {
  COLLATERAL_ADDRESS,
  COLLATERAL_DECIMALS,
  somniaTestnet,
} from "@/lib/chain"

/** Shape-compatible with dApp Kit's account object. */
export interface WalletAccount {
  address: `0x${string}`
}

/**
 * The connected account, or null.
 *
 * Named to match the old `useCurrentAccount` so call sites read the same.
 */
export function useCurrentAccount(): WalletAccount | null {
  const { address, isConnected } = useAccount()
  return useMemo(
    () => (isConnected && address ? { address } : null),
    [address, isConnected]
  )
}

/** True while a connection attempt is in flight. */
export function useIsConnecting(): boolean {
  const { isConnecting, isReconnecting } = useAccount()
  const { isPending } = useConnect()
  return isConnecting || isReconnecting || isPending
}

/**
 * Connect / disconnect, plus whether the wallet is on the right chain.
 *
 * `wrongNetwork` is surfaced rather than auto-switching silently: a wallet
 * pointed at another chain will make every read return nothing, and a user
 * seeing an empty app deserves to be told why.
 */
export function useWalletConnection() {
  const { connectors, connectAsync, isPending, error } = useConnect()
  const { disconnect } = useDisconnect()
  const { isConnected, chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()

  const injectedConnector = connectors[0]
  const hasWallet =
    typeof window !== "undefined" &&
    typeof (window as { ethereum?: unknown }).ethereum !== "undefined"

  const connect = useCallback(async () => {
    if (!injectedConnector) throw new Error("No wallet connector available")
    await connectAsync({ connector: injectedConnector })
  }, [connectAsync, injectedConnector])

  const switchToSomnia = useCallback(async () => {
    await switchChainAsync({ chainId: somniaTestnet.id })
  }, [switchChainAsync])

  return {
    connect,
    disconnect,
    switchToSomnia,
    isConnected,
    isPending,
    error,
    /** No injected provider present — the user needs to install a wallet. */
    hasWallet,
    /** Connected, but pointed at the wrong chain. */
    wrongNetwork: isConnected && chainId !== somniaTestnet.id,
  }
}

/**
 * Native STT balance (gas).
 *
 * Distinct from collateral: a player can hold plenty of tUSDC and still be
 * unable to transact, and conflating the two produces a baffling failure.
 */
export function useNativeBalance() {
  const { address } = useAccount()
  const { data, isLoading, refetch } = useBalance({
    address,
    query: { enabled: Boolean(address) },
  })
  return {
    value: data?.value ?? 0n,
    symbol: data?.symbol ?? "STT",
    decimals: data?.decimals ?? 18,
    isLoading,
    refetch,
  }
}

/**
 * Collateral (tUSDC) balance.
 *
 * `decimals` is READ FROM THE TOKEN, not assumed: testnet tUSDC is 6 and
 * mainnet USDso is 18, and a wrong literal misprices every displayed balance
 * by 10^12 without anything reverting. The constant is only a fallback for the
 * first render.
 */
export function useCollateralBalance() {
  const { address } = useAccount()

  const {
    data: balance,
    isLoading: balanceLoading,
    refetch,
  } = useReadContract({
    address: COLLATERAL_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  })

  const { data: decimals } = useReadContract({
    address: COLLATERAL_ADDRESS,
    abi: erc20Abi,
    functionName: "decimals",
  })

  return {
    value: (balance as bigint | undefined) ?? 0n,
    decimals: (decimals as number | undefined) ?? COLLATERAL_DECIMALS,
    isLoading: balanceLoading,
    refetch,
  }
}
