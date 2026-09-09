# DreamSwipe — Swipe the market. Beat the crowd.

> Two players. One deck. Swipe YES/NO through live binary prediction markets,
> and on-chain escrow pays whoever read the market better.
> A PvP prediction duel on **Somnia**, powered by **DreamDEX Event Contracts**.

**Live on Somnia Shannon testnet (chain 50312).**

| | |
| --- | --- |
| **Duel contract** | [`0x6b554BaFC2031b72AeB100cDAd111c2f70f2cC5c`](https://shannon-explorer.somnia.network/address/0x6b554BaFC2031b72AeB100cDAd111c2f70f2cC5c) |
| **On-chain primitive** | DreamDEX Event Contracts (binary Up/Down markets) |
| **Collateral** | tUSDC — 6 decimals (testnet); USDso/18 is mainnet-only |
| **Gas** | STT. Players sign swipes; a relayer pays. |

---

## The pitch

Prediction markets are powerful but look like a Bloomberg terminal. Swipe-betting
apps proved retail loves feel-based prediction UX — but they're shallow,
custodial, and have **no real opponent**.

DreamSwipe is both. Two players swipe through the same deck of live DreamDEX
event contracts. Scoring is the actual economics — `netResult = realizedValue −
entryCost` — so the winner is whoever genuinely read the market better, not
whoever tapped faster.

---

## Verified on chain, not asserted

The full lifecycle has been executed against the deployed contract with real
transactions (`bun --filter server run e2e:somnia`):

```
createDuel → joinDuel (2nd wallet) → revealDeck
           → 2× relayed swipe → settleCard ×3 → finalize
```

Result read back from chain: `status Complete · 3/3 settled · p0 +600000 ·
p1 −400000`. Those numbers are the economics exactly — backing UP at 0.40 and
winning redeems 1.00 (+0.60); the loser forfeits their 0.40 premium.

**Neither player sent a transaction.** Both signed EIP-712 messages and the
relayer submitted them. No wallet popup mid-duel, no gas from the player.

Check the venue yourself, read-only and without a key:

```bash
bun --filter server run check:dreamdex
```

---

## Architecture

```
apps/web            React 19 · Vite · Tailwind · wagmi + viem
apps/server         Bun · WS relay · matchmaking · relayer · keeper · MMR
apps/contracts-evm  Solidity (Foundry) · DreamSwipeDuel
packages/dreamdex   venue boundary: types, CLOB math, Bot Arena agents
packages/ui         shared shadcn components
```

One rule holds the design together: **nothing outside `packages/dreamdex` may
import the venue SDK.** This repo already lost ~12 days of playability when a
previous venue was torn down, so "what are the cards" is swappable without
touching "run a duel".

### Honesty is enforced in the types

`specs/06_FRONTEND.md` says *"No fake live values"*, and that is a type
signature here, not a convention:

- anything not derivable returns **`null`, never `0`** — a zero spread and an
  unknown spread must never look alike
- `insufficientLiquidity` carries a **partial** fillable size, so the UI shows
  what the book can really fill
- no tx hash, order id, fill or price is ever synthesized; the adapter throws
  `VenueUnavailableError` instead
- `getFills` **throws rather than returning `[]`**, because an empty array is
  indistinguishable from "not implemented"

---

## Game modes

| Mode | Stake | Chain |
| --- | --- | --- |
| **Practice** | — | none — fully simulated |
| **Bot Arena** | — | live market data, 4 strategy agents |
| **Free PvP** | 0 | same engine, money flow gated off |
| **Staked PvP** | tUSDC | escrowed, winner takes the pot |

Free and Staked share **one** code path. The tier gates only whether collateral
moves, and a Free duel carrying a stake reverts on chain.

### Bot Arena fairness

Bots see exactly what a human sees. That is structural: `PredictionContext` has
no `winner`, `settlementPrice` or `resolved` field, so an agent **cannot** see
an outcome even in principle. A test pins the exact key set, so adding one later
trips a tripwire.

Difficulty raises the signal threshold a bot needs before acting — it never
changes what the bot can see.

---

## Quick start

```bash
bun install
cp .env.example .env        # add a funded Shannon key for writes
bun dev                     # web :5173 + server :3001
```

Testnet STT (gas) and tUSDC (collateral) come from the SomniaHacks faucet:
<https://t.me/+XHq0F0JXMyhmMzM0>

```bash
bun typecheck   # 6/6 packages
bun run test    # 364 tests
bun build

cd apps/contracts-evm && forge test   # 41 tests, incl. fuzzed escrow conservation
```

---

## Two traps worth knowing

Both cost real debugging time and are documented in
[`docs/DREAMDEX_INTEGRATION.md`](docs/DREAMDEX_INTEGRATION.md).

**Somnia deploy gas.** Foundry estimated 3,394,836 gas; the deploy actually
needed **38,853,709** — 11×. Worse, an under-limit deploy mines with
`status: 0` and burns the entire limit while `eth_call` simulation still
succeeds, so simulation cannot catch it. Three deploys failed that way before
60M worked.

**The spec pack's DreamDEX constants were wrong in three ways** — package name,
collateral token, and decimals. Building on them unchecked would have mispriced
every order by 10¹² on mainnet with nothing reverting to warn you. Corrections
are recorded in [`docs/MIGRATION_AUDIT.md`](docs/MIGRATION_AUDIT.md) §2.2.

---

## Docs

| | |
| --- | --- |
| [`MIGRATION_AUDIT.md`](docs/MIGRATION_AUDIT.md) | what was reused, replaced, and verified |
| [`DREAMDEX_INTEGRATION.md`](docs/DREAMDEX_INTEGRATION.md) | venue facts, traps, and a real bug the health check caught |
| [`deployments/somnia-testnet.json`](deployments/somnia-testnet.json) | addresses, tx hashes, gas findings |

---

## License

Apache-2.0
