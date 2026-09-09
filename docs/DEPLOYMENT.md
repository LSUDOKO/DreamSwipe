# Deployment

DreamSwipe is two deployables plus two already-deployed contracts.

| Piece | Where | Status |
| --- | --- | --- |
| `DreamSwipeDuel` | Somnia Shannon (50312) | **deployed** — [`0x6b554BaF…cC5c`](https://shannon-explorer.somnia.network/address/0x6b554BaFC2031b72AeB100cDAd111c2f70f2cC5c) |
| `SeasonPrizePool` | Somnia Shannon (50312) | **deployed** — [`0xB3808140…B4a7`](https://shannon-explorer.somnia.network/address/0xB380814066dcb5d0b4d4968742bFdC005D1FB4a7) |
| `apps/server` | any Bun host (Railway config included) | needs env |
| `apps/web` | any static host | needs one env var |

---

## 1. Server

Runs anywhere Bun does. `railway.json` is included and sets the health check to
`/health`.

```bash
bun install --frozen-lockfile
bun apps/server/src/index.ts
```

### Environment

Only two variables are strictly required for a **read-only** deployment — the
lobby, Bot Arena, market data and WebSocket all work without a key or a
database:

```bash
DREAMSWIPE_DUEL_ADDRESS=0x6b554BaFC2031b72AeB100cDAd111c2f70f2cC5c
SEASON_POOL_ADDRESS=0xB380814066dcb5d0b4d4968742bFdC005D1FB4a7
```

Add these to enable the rest:

| Variable | Enables | Without it |
| --- | --- | --- |
| `DATABASE_URL` | leaderboard, chat, match history, duel mirror | those degrade to empty; **the server still boots and plays** |
| `RELAYER_PRIVATE_KEY` | gasless relayed swipes | `/relay/swipe` returns 503 |
| `KEEPER_PRIVATE_KEY` | card settlement + finalize | duels never settle |
| `SOMNIA_RPC_URL` | custom RPC | falls back to `https://dream-rpc.somnia.network` |
| `ALLOWED_ORIGIN` | CORS lock-down | permissive |

The relayer and keeper keys need **STT for gas**. They can be the same key.
Neither can move escrow to an arbitrary address — payouts are computed from
recorded swipes and can only reach the two players.

**Never commit a key.** `.env` is gitignored; `.env.example` documents every
variable.

### Degradation is deliberate

A missing `DATABASE_URL` logs once and continues. That is load-bearing: the
venue endpoints and WebSocket need no database, and an earlier version of this
server *exited* on a DB error, taking the whole game down over an optional
dependency.

---

## 2. Web

Static build; any host works.

```bash
bun install --frozen-lockfile
bun --filter web run build     # → apps/web/dist
```

`apps/web/.env.production` carries the contract addresses and chain config
already. **Set one variable at build time** so the bundle points at your
deployed server:

```bash
VITE_SERVER_HTTP_URL=https://your-server.example.com
VITE_SERVER_WS_URL=wss://your-server.example.com/ws
```

These are inlined at build time, so they must be present when `vite build`
runs — setting them only at runtime does nothing.

Verify the bundle after building:

```bash
grep -c 6b554BaF apps/web/dist/assets/index-*.js   # duel contract present
grep -c dream-rpc.somnia apps/web/dist/assets/index-*.js
```

---

## 3. Contracts

Already deployed. Redeploy only if you change them:

```bash
cd apps/contracts-evm
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
git clone --depth 1 -b v5.1.0 \
  https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
forge test                      # 71 tests

PRIVATE_KEY=0x… forge create src/DreamSwipeDuel.sol:DreamSwipeDuel \
  --rpc-url https://dream-rpc.somnia.network --broadcast \
  --gas-limit 60000000 --constructor-args <keeper-address>
```

### Somnia gas — read this before deploying

Gas estimation on Somnia is unreliable **in both directions**, and the failure
mode is expensive:

- `DreamSwipeDuel` (11.4 KB runtime) needed **38.85M gas against a 3.39M
  estimate** — 11×.
- `SeasonPrizePool` (4.4 KB) needed 15.57M.
- A tUSDC faucet call estimated at 1.38M actually used 253K — but a 500K limit
  still mined with **status 0 and burned the entire limit**.

An under-limit transaction mines as failed and consumes everything, while
`eth_call` simulation still succeeds — so **simulation cannot catch it**. Three
deploys failed this way before one worked.

Over-provision the limit; unused gas is refunded on success. One caveat: the
limit is also balance-checked upfront (`limit × gasPrice` must be affordable),
so an absurdly large limit is rejected as "insufficient balance".

---

## 4. Funding

| Token | Purpose | Source |
| --- | --- | --- |
| STT | gas | [SomniaHacks group](https://t.me/+XHq0F0JXMyhmMzM0) |
| tUSDC | collateral | **on-chain** — call `faucet(uint256)` on the token |

tUSDC needs no external step:

```bash
cast send 0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E \
  'faucet(uint256)' 5000000000 --gas-limit 5000000 \
  --rpc-url https://dream-rpc.somnia.network --private-key $PK
```

---

## 5. Verify a deployment

```bash
curl https://your-server/health                    # ok:true + venue + services
bun --filter server run check:dreamdex             # live venue probe, no key
bun --filter server run e2e:somnia                 # full free-tier duel
bun --filter server run e2e:staked                 # staked duel, real collateral
bun --filter server run e2e:season                 # prize create→fund→claim
```

The last three send real transactions and need a funded key.

`/health` reports which services actually came up:

```json
{
  "ok": true,
  "venue": { "chainId": 50312, "duelContract": "0x6b554BaF…" },
  "services": { "keeper": "enabled", "relayer": "enabled" },
  "somnia": { "trackedDuels": 0, "indexedDuels": 0 }
}
```

A `"disabled (no keeper key)"` there is the single most likely reason a duel
reaches lockup and never settles.

---

## 6. Recovery

| Situation | What happens | Action |
| --- | --- | --- |
| Server restarts | keeper and indexer re-read state from chain; the indexer backfills recent `DuelCreated` | none — chain is the source of truth |
| Database lost | leaderboard/chat/history empty; duels still playable | restore or start fresh |
| Keeper key rotated | set `KEEPER_PRIVATE_KEY`, then `setKeeper` on the contract as admin | both, or settlement stops |
| Venue has no live markets | decks refuse to deal with `DREAMDEX_NO_LIVE_MARKETS` | wait — windows roll every few minutes |
| Duel stuck unsettled | escrow is never trapped | `claimDuelTimeout` after 2h, permissionless |
