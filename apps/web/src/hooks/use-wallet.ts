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
/**
 * Turn a wallet/provider error into something a person can act on.
 *
 * viem's raw messages are written for developers. "User rejected the request.
 * Details: wallet must has at least one account" actually means the extension
 * is installed but LOCKED or has no account yet — the user did not reject
 * anything, and telling them they did sends them looking in the wrong place.
 */
export function describeWalletError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "")

  // Order matters. "already pending" is checked FIRST because MetaMask phrases
  // it as `Request of type 'wallet_requestPermissions' already pending`, which
  // would otherwise be swallowed by the locked-wallet pattern below and tell
  // the user to unlock a wallet that is already unlocked and waiting.
  if (/already pending|already processing/i.test(raw)) {
    return "A wallet request is already open — check your extension and finish it there."
  }
  // MetaMask reports a locked/account-less wallet as a REJECTION with this
  // detail, which is why the raw message misleads.
  if (/at least one account|no accounts|wallet_requestPermissions/i.test(raw)) {
    return "Your wallet is locked or has no account yet. Open the extension, unlock it (or create an account), then try again."
  }
  // A genuine user rejection: code 4001.
  if (/user rejected|user denied|4001/i.test(raw)) {
    return "Connection cancelled. Approve the request in your wallet to continue."
  }
  if (/chain|network|unrecognized/i.test(raw)) {
    return "Your wallet could not switch to Somnia Shannon. Approve the add-network prompt, or add chain 50312 manually."
  }
  if (/no wallet|not found|undefined/i.test(raw)) {
    return "No EVM wallet detected. Install MetaMask or another injected wallet, then reload."
  }
  return (
    raw.split("\n")[0]?.slice(0, 160) || "Could not connect to your wallet."
  )
}

export function useWalletConnection() {
  const { connectors, connectAsync, isPending, error } = useConnect()
  const { disconnect } = useDisconnect()
  const { isConnected, chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()

  /**
   * Pick the injected connector by ID, not by array position.
   *
   * `connectors[0]` is whatever wagmi happened to order first. With several
   * extensions installed (MetaMask + Phantom + Rabby all inject), that is not
   * reliably the one the user expects, and it can even be a connector with no
   * provider at all.
   */
  const injectedConnector = useMemo(
    () =>
      connectors.find((c) => c.id === "injected") ??
      connectors.find((c) => c.type === "injected") ??
      connectors[0],
    [connectors]
  )

  const hasWallet =
    typeof window !== "undefined" &&
    typeof (window as { ethereum?: unknown }).ethereum !== "undefined"

  /**
   * Connect, then make sure the wallet is actually on Somnia.
   *
   * The chain switch is part of connecting, not a separate step the user has
   * to discover: a wallet left on Ethereum mainnet connects fine and then every
   * contract read returns nothing, which looks like a broken app rather than a
   * wrong network. `switchChain` also prompts the wallet to ADD chain 50312 if
   * it does not know it yet.
   *
   * A failed switch is deliberately NOT fatal — the user is connected, and the
   * `wrongNetwork` banner gives them a second chance.
   */
  const connect = useCallback(async () => {
    if (!injectedConnector) {
      throw new Error("No EVM wallet detected. Install MetaMask, then reload.")
    }
    await connectAsync({
      connector: injectedConnector,
      chainId: somniaTestnet.id,
    })
    try {
      await switchChainAsync({ chainId: somniaTestnet.id })
    } catch {
      // Left on the wrong chain; the banner handles it.
    }
  }, [connectAsync, injectedConnector, switchChainAsync])

  const switchToSomnia = useCallback(async () => {
    await switchChainAsync({ chainId: somniaTestnet.id })
  }, [switchChainAsync])

  return {
    connect,
    disconnect,
    switchToSomnia,
    isConnected,
    isPending,
    /** Human-readable; see `describeWalletError`. */
    error: error ? describeWalletError(error) : null,
    hasWallet,
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
