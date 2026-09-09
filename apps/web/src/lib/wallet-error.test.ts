/**
 * Wallet error-message tests.
 *
 * These exist because of a real report: connecting showed
 *
 *   "User rejected the request. Details: wallet must has at least one account"
 *
 * The user had rejected nothing — their wallet was LOCKED. MetaMask reports a
 * locked or account-less wallet as a rejection, so passing viem's raw text
 * through sent the user looking in entirely the wrong place.
 *
 * Each case below maps a real provider string to advice that names the actual
 * fix. Getting these wrong is worse than showing nothing, so they are pinned.
 */
import { describe, expect, it } from "bun:test"
import { describeWalletError } from "@/hooks/use-wallet"

describe("describeWalletError", () => {
  it("explains a LOCKED wallet rather than repeating 'user rejected'", () => {
    // The exact string that prompted this fix.
    const msg = describeWalletError(
      new Error(
        "User rejected the request. Details: wallet must has at least one account Version: viem@2.21.0"
      )
    )
    expect(msg).toContain("locked")
    expect(msg).toMatch(/unlock|create an account/i)
    // Must NOT blame the user for rejecting, which is what misled them.
    expect(msg.toLowerCase()).not.toContain("cancelled")
  })

  it("handles the 'no accounts' phrasing other wallets use", () => {
    expect(describeWalletError(new Error("no accounts available"))).toContain(
      "locked"
    )
  })

  it("reports a genuine rejection as a cancellation", () => {
    const msg = describeWalletError(
      new Error("User rejected the request. (code 4001)")
    )
    expect(msg).toContain("cancelled")
    expect(msg).toMatch(/approve/i)
  })

  it("points at the extension when a request is already open", () => {
    const msg = describeWalletError(
      new Error("Request of type 'wallet_requestPermissions' already pending")
    )
    expect(msg).toMatch(/already open|finish it there/i)
  })

  it("explains a chain problem in terms of adding Somnia", () => {
    const msg = describeWalletError(
      new Error("Unrecognized chain ID. Try adding the chain first.")
    )
    expect(msg).toMatch(/somnia|50312/i)
  })

  it("tells a user with no wallet to install one", () => {
    const msg = describeWalletError(new Error("no wallet detected"))
    expect(msg).toMatch(/install/i)
  })

  it("falls back to the first line, truncated, for anything unrecognized", () => {
    const msg = describeWalletError(
      new Error(
        `something exotic went wrong\nstack line that should be dropped`
      )
    )
    expect(msg).toBe("something exotic went wrong")
    expect(msg).not.toContain("stack line")
  })

  it("never returns an empty string", () => {
    // An empty message would render a blank red line, which reads as a
    // rendering bug rather than an error.
    for (const input of [undefined, null, "", new Error("")]) {
      expect(describeWalletError(input).length).toBeGreaterThan(0)
    }
  })
})
