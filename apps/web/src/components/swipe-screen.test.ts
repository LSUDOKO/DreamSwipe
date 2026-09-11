import { expect, test } from "bun:test"
import { fmtUsd } from "./swipe-screen"

/**
 * These pin the COLLATERAL DECIMALS, which is the one constant in this
 * codebase that fails silently when wrong (CLAUDE.md, "Load-bearing
 * constraints"). `fmtUsd` divided by 1e9 — the Sui-era convention — which
 * rendered every practice strike as "$0".
 */

test("formats micro-units (1e6), not 1e9", () => {
  // A practice spot of 538040 micro-units is ~$0.54, NOT $0.
  expect(fmtUsd("538040")).toBe("$0.54")
  expect(fmtUsd(1_000_000n)).toBe("$1")
})

test("a realistic BTC strike reads as whole dollars", () => {
  // 62_533 * 1e6 — large values round, so no cent noise on a big number.
  expect(fmtUsd(62_533_000_000n)).toBe("$62,533")
})

test("sub-dollar values keep cents rather than collapsing to $0", () => {
  // The actual regression: any value under $1 previously printed "$0".
  expect(fmtUsd(250_000n)).toBe("$0.25")
  expect(fmtUsd(10_000n)).toBe("$0.01")
})

test("zero is still zero", () => {
  expect(fmtUsd(0n)).toBe("$0")
})

test("accepts both string and bigint", () => {
  expect(fmtUsd("62533000000")).toBe(fmtUsd(62_533_000_000n))
})
