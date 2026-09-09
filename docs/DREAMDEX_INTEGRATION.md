# DreamDEX Integration

How DreamSwipe talks to DreamDEX Event Contracts on Somnia, and — just as
importantly — what was **verified** versus what is still assumed.

Everything in §1 was checked against live Shannon testnet during development.
Three of the values in the original project spec were wrong in ways that would
have silently mispriced the app; those corrections are called out explicitly.

---

## 1. Verified facts

### Network

| Fact | Value | How it was verified |
| --- | --- | --- |
| Shannon chain ID | **50312** | `eth_chainId` → `0xc488`, from two independent RPCs |
| RPC | `https://dream-rpc.somnia.network` | live `eth_blockNumber` |
| Client | `somnia-*-release` | `web3_clientVersion` |
| Testnet gas token | **STT** | ⚠️ spec said SOMI — SOMI is **mainnet** (chain 5031) |

### SDK

| Fact | Value |
| --- | --- |
| Package | **`@somnia-chain/markets-sdk`** (0.29.0) |
| ⚠️ Spec claimed | `@dreamdex-bot-kit/core` — **does not exist on npm** (404) |

`@dreamdex-bot-kit/core` is an *unpublished internal workspace name* inside the
Bot Kit monorepo. You consume the Bot Kit by cloning it; the installable SDK is
`@somnia-chain/markets-sdk`.

### Collateral — the dangerous one

| Environment | Token | Decimals |
| --- | --- | --- |
| Shannon **testnet** | tUSDC `0x70a86D…5d8E` | **6** |
| Mainnet | USDso | 18 |

⚠️ The spec claimed *"USDso is 18 decimals"* for testnet. Testnet collateral is
**tUSDC at 6 decimals**. The two differ by a factor of 10¹², and **nothing
reverts to tell you** — a constant that is correct on testnet misprices every
order, book read and balance on mainnet.

DreamSwipe therefore **never hardcodes the exponent**. `EventMarket` carries
`collateralDecimals`, read per-market from `getMarketOnchain().decimals`, and
all sizing derives from it. Confirmed live: `decimals: 6`.

### Market model

- **Price = probability in millionths.** `900_000` = 0.90 = "90% likely".
- **One book, quoted in UP/YES terms.** A DOWN price is always `1 − up`.
  All conversion happens in one place (`toUpPrice`).
- Outcome tokens are **ERC-6909 ids** on a shared `outcomeToken` singleton, not
  separate ERC-20s.
- A winning contract redeems **1:1** for collateral; a loser is worth zero; a
  **voided** market refunds *both* sides at 0.5.
- Status: `0 Listed · 1 Trading · 2 Locked · 3 Settling · 4 Resolved · 5 Voided`.
  **Only `1` accepts orders**, and a future expiry does *not* imply the market
  is open — status is checked on chain before any market is called tradable.

`MarketCreated` carries everything the deck engine needs:
`marketId (bytes32)`, `pool`, `yesId`, `noId`, `collateral`, `asset`, `strike`,
`tradingStart`, `expiry`, `oracleQuestionId`, `question`, `intervalSec`.

### Live observation

At development time the venue listed **8 markets** — BTC and ETH across
5m / 15m / 60m / 240m windows — and a sample 240m BTC book showed 6 bids and
3 asks, best bid `0.756`, best ask `0.782`. So spread, depth and imbalance are
computed from **real resting orders**, not placeholders.

---

## 2. Architecture

```
apps/web ──────────────► never imports venue types
apps/server
   ├── dreamdex-card-source.ts   deals a deck from live markets
   └── @workspace/dreamdex
         ├── types.ts            venue-neutral vocabulary + DreamDexAdapter
         ├── book-math.ts        pure CLOB math (no network, fully unit-tested)
         ├── agents.ts           Bot Arena strategies
         └── somnia-adapter.ts   ◄── THE ONLY file that imports the SDK
```

Nothing outside `packages/dreamdex` may import venue SDK types. This repo's own
history is the argument for that rule: the previous venue pin moved three times
(`4-16` → `6-24` → `8-21`), and a full teardown cost ~12 days of playability.

### Two decisions worth knowing

**Discovery does not depend on the indexer.** Markets are found by scanning
`MarketCreated` logs on chain. The venue publishes no event-contract REST
endpoint (the documented REST/WS surface is spot-only), and an indexer is
exactly the kind of third-party dependency that took this project down before.

**Reads need no private key.** Capabilities, discovery, books, quotes and
settlement all work unauthenticated — a player browsing DreamSwipe is never
asked for a key to see real market data. Writes require a signer and throw
`VenueReadOnlyError` when one is absent, rather than degrading into a fake
success.

---

## 3. Honesty rules

`specs/06_FRONTEND.md` says *"No fake live values"*. That is enforced in the
**type signatures**, not by convention:

- Anything not derivable returns **`null`, never `0`**. A zero spread and an
  unknown spread must never be indistinguishable — "spread = 0" reads as a
  perfectly tight market when it actually means "no data".
- `insufficientLiquidity` is reported with a **partial** `fillableQuantity`.
  The UI shows what the book can really fill, never the size requested.
- **No tx hash, order id, fill or price is ever synthesized.** If the venue
  cannot answer, the adapter throws `VenueUnavailableError`.
- `getFills` deliberately **throws instead of returning `[]`**, because an
  empty array would be indistinguishable from "not implemented".
- `VenueCapabilities` drives UI gating, so an outage renders as a disabled
  panel rather than a plausible-looking number.

### Contrarian Edge

Presented as market-derived and educational, never a promised multiplier. It
reports only facts already true of the book: what each side costs now, and what
a winning contract pays back (`1 / price`). It makes **no claim** about which
side will win.

---

## 4. Two integration traps

Both cost real debugging time and are not in the official starter.

**1. SDK 0.29.0 blocks the starter's deep import.** The starter does
`import … from "@somnia-chain/markets-sdk/dist/eventsAbi.js"`, which now fails
with `ERR_PACKAGE_PATH_NOT_EXPORTED` — `exports` publishes only `.`, `./react`,
`./chains`, `./reactivity`, `./native`, and `marketCreatorEventsAbi` is **not**
re-exported from the main entry. The workaround is isolated in
`loadMarketCreatedEvent()` so that when the SDK re-exports it properly, one
function changes.

**2. Discovery is slow, and the naive fix is wrong.** Somnia caps `getLogs` at
1000 blocks, so discovery walks many windows. Measured:

| Approach | Time | Markets found |
| --- | --- | --- |
| Serial, 40 windows (as in the starter) | ~38 s | 4 — **missed the 240m markets entirely** |
| Concurrent, 240 windows | ~17.5 s | 8 |
| …with single-flight cache (warm) | **~1.5 s** | 8 |

Single-flight matters more than the TTL: when a match is made, several callers
ask for markets at once, and without de-duplication that is N concurrent
multi-second scans against the same RPC.

Only the *immutable* half of a market is cached. Creation data (id, pool,
strike, expiry) never changes; **status is always re-read on chain**, so a
cached sweep can never serve a stale tradability decision.

---

## 5. A real bug this caught

`bun --filter server run check:dreamdex` is a read-only health check that walks
capabilities → discovery → eligibility → live books → dealing a deck.

It immediately reported `2 eligible (need >= 3) — can start a duel: NO`.

**Cause:** with a 75-minute deck horizon, only the 5m/15m/60m pairs qualified.
Short windows roll continuously, so there are long stretches where the 5m and
15m markets sit inside the 90s headroom floor — leaving just the two 60m
markets, below the deck floor of 3. **No duel could start at all.**

**Fix:** widen the horizon to 255m so the 240m pair is admitted and the floor
stays reachable at the worst point of the short-window cycle. Soonest-settling
markets are still preferred, so a long window is a backstop, not a default.

Verified after the fix: a real 5-card deck, staggered 4m → 149m, one card per
distinct market. A regression test pins the 240m case.

This is the class of bug unit tests cannot find, because it only appears
against the venue's real market cadence.

---

## 6. Deck rules

`clamp(eligibleMarkets.length, 3, 5)`, and **never padded**.

A DreamDEX market already *is* a binary question with its own strike and
expiry, so a card maps 1:1 onto a market. Below 3 eligible markets the source
throws `NoCardsAvailableError` rather than duplicating one — two cards on the
same market would show the player the same question twice and settle
identically. That is a fake deck, and `specs/00_MASTER_SPEC.md` forbids it:

> If fewer than 3 eligible markets: do not fabricate.

Selection is **seed-deterministic**, because commit-reveal depends on it: the
server hashes the deck before reveal, so a non-reproducible order would make
the commitment unverifiable.

---

## 7. Known gaps

| Gap | Status |
| --- | --- |
| Per-market deep link | The observed `/{PAIR}/{INTERVAL}` form addresses a market **series**, not one window. No documented permalink exists. Labelled "trade this market", never as a receipt for a settled window. |
| Event-contract REST/WS | None published — the documented REST/WS surface is spot-only. |
| `getFills` | Throws rather than returning `[]`. PnL is computed from settlement plus recorded entry cost. |
| Live write path | Requires a faucet-funded Shannon key. Reads are fully verified; mint/order/redeem are implemented but not yet exercised end-to-end on chain. |

---

## 8. Verify it yourself

```bash
bun --filter server run check:dreamdex   # read-only, no key needed
```

Faucet (STT for gas + tUSDC for collateral), via the SomniaHacks dev group:
<https://t.me/+XHq0F0JXMyhmMzM0>
