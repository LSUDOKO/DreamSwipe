/**
 * Somnia chain configuration for the web app.
 *
 * Replaces the Sui `dapp-kit.ts` / `config.ts` pair. One module owns the chain
 * definition, the wagmi config, and the deployed addresses, so nothing else in
 * the app constructs a client or hardcodes an address.
 *
 * ── Verified values ─────────────────────────────────────────────────────────
 *
 * Every constant here was checked against the live chain, because three of the
 * numbers in the original project spec were wrong in ways that fail silently:
 *
 *   chain id 50312     — eth_chainId → 0xc488, from two independent RPCs
 *   native gas STT     — spec said SOMI; SOMI is MAINNET (chain 5031)
 *   tUSDC, 6 decimals  — spec said USDso/18. USDso is mainnet-only, and the
 *                        two differ by 10^12 with nothing reverting to warn
 *                        you. Balances are formatted from the token's own
 *                        decimals(), never a literal.
 */
import { createConfig, http } from "wagmi"
import { defineChain } from "viem"
import { injected } from "wagmi/connectors"

/** Shannon testnet. Verified live. */
export const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Shannon Testnet",
  nativeCurrency: {
    // STT, not SOMI — SOMI is the mainnet token.
    name: "Somnia Test Token",
    symbol: "STT",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [
        import.meta.env.VITE_SOMNIA_RPC_URL ||
          "https://dream-rpc.somnia.network",
      ],
    },
  },
  blockExplorers: {
    default: {
      name: "Shannon Explorer",
      url: "https://shannon-explorer.somnia.network",
    },
  },
  testnet: true,
})

export const wagmiConfig = createConfig({
  chains: [somniaTestnet],
  connectors: [injected()],
  transports: {
    [somniaTestnet.id]: http(),
  },
})

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig
  }
}

/**
 * Deployed DreamSwipeDuel.
 *
 * Live on Shannon at the address below (see `deployments/somnia-testnet.json`).
 * Overridable via env so a redeploy does not need a code change.
 */
export const DUEL_ADDRESS = (import.meta.env.VITE_DREAMSWIPE_DUEL_ADDRESS ||
  "0x6b554BaFC2031b72AeB100cDAd111c2f70f2cC5c") as `0x${string}`

/**
 * Collateral token (tUSDC on testnet).
 *
 * 6 decimals here, 18 on mainnet USDso. Never hardcode the exponent in
 * formatting code — read `decimals()` or use `COLLATERAL_DECIMALS` below,
 * which exists so the one place that assumes a scale is greppable.
 */
export const COLLATERAL_ADDRESS = (import.meta.env.VITE_COLLATERAL_TOKEN ||
  "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E") as `0x${string}`

export const COLLATERAL_DECIMALS = 6
export const COLLATERAL_SYMBOL = "tUSDC"

/** One whole prediction contract, in collateral base units. */
export const ONE_COLLATERAL = 1_000_000n

/**
 * Stake tiers, in collateral base units (6 decimals).
 *
 * Rescaled from the Sui build's 6-decimal dUSDC values — they happen to share
 * a scale, but the constant is redefined here rather than imported so a future
 * mainnet move (18 decimals) cannot silently inherit a testnet number.
 */
export const STAKE_TIERS = {
  practice: 0n,
  free: 0n,
  starter: 1_000_000n, // 1 tUSDC
  casual: 3_000_000n, // 3
  standard: 5_000_000n, // 5
  high_roller: 10_000_000n, // 10
} as const

export type StakeTier = keyof typeof STAKE_TIERS

/** Explorer link for a transaction. */
export function txUrl(hash: string): string {
  return `${somniaTestnet.blockExplorers.default.url}/tx/${hash}`
}

/** Explorer link for an address. */
export function addressUrl(address: string): string {
  return `${somniaTestnet.blockExplorers.default.url}/address/${address}`
}

/** Shorten an address for display: 0x1234…abcd. */
export function shortAddress(address: string): string {
  if (address.length < 10) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/**
 * Format a collateral amount for display.
 *
 * Takes the decimals explicitly so a caller reading a live market cannot
 * accidentally format mainnet 18-decimal collateral with a testnet scale.
 */
export function formatCollateral(
  base: bigint,
  decimals: number = COLLATERAL_DECIMALS,
  fractionDigits = 2
): string {
  const negative = base < 0n
  const abs = negative ? -base : base
  const scale = 10n ** BigInt(decimals)
  const whole = abs / scale
  const frac = abs % scale
  const fracStr = frac
    .toString()
    .padStart(decimals, "0")
    .slice(0, fractionDigits)
  return `${negative ? "-" : ""}${whole}${fractionDigits > 0 ? `.${fracStr}` : ""}`
}

/** Format a probability price (millionths) as a percentage string. */
export function formatProbability(price: bigint, fractionDigits = 0): string {
  return `${((Number(price) / 1_000_000) * 100).toFixed(fractionDigits)}%`
}

/**
 * Case-insensitive address equality.
 *
 * REQUIRED for every address comparison in this app. wagmi returns EIP-55
 * checksummed addresses (mixed case) while the server stores and returns them
 * lowercase, so a bare `===` between the two is false for the SAME address.
 *
 * That mismatch is not a cosmetic bug: it silently made participants look like
 * spectators. The result modal never opened, a creator was listed as their own
 * opponent, and every `myIsP0`-keyed PnL selection was flipped — so a match row
 * could read "WIN" beside a negative return.
 */
export function sameAddress(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * The EVM zero address (42 chars).
 *
 * Named because the Sui-era constant was 66 chars, so `opponent !== ZERO_ADDR`
 * was always true and a duel with no challenger rendered an opponent row for
 * 0x0000…0000.
 */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/**
 * Maximum tUSDC per faucet call, in base units (10,000 at 6 decimals).
 *
 * Verified against the deployed token: 10,000 succeeds, 10,000 + 1 reverts.
 */
export const FAUCET_MAX = 10_000_000_000n

/** What the in-app faucet claims per press. */
export const FAUCET_AMOUNT = 1_000_000_000n // 1,000 tUSDC — plenty for testing

/**
 * Minimal ABI for the testnet collateral's public faucet.
 *
 * The token exposes a PERMISSIONLESS `faucet(uint256)` — verified callable
 * from an arbitrary address — so players can fund themselves in-app. Sending
 * them to a Telegram group for a token they can mint with one click was a
 * needless dead end in the middle of onboarding.
 */
export const faucetAbi = [
  {
    type: "function",
    name: "faucet",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const
