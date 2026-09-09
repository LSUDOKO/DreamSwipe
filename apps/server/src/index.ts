/**
 * DreamSwipe backend entry — a single Bun.serve process hosting:
 *
 *   HTTP:
 *     GET  /health              service + venue status
 *     GET  /bot-arena/deck      live deck + the market context a bot may see
 *     POST /relay/swipe         submit a player's EIP-712-signed swipe
 *     POST /deckmaster/generate
 *     GET  /deckmaster/reveal?hash=0x…
 *
 *   WS:
 *     /ws                       matchmaking queue + duel-room broadcasts
 *                               (message types in src/ws/protocol.ts)
 *
 *   Background:
 *     somnia keeper             reads settlement from DreamDEX, writes
 *                               settleCard/finalize on chain. No-ops without
 *                               DREAMSWIPE_DUEL_ADDRESS + KEEPER_PRIVATE_KEY.
 *     match clock               authoritative swipe/queue deadlines
 *     chat prune                trims the chat backlog
 */
import { env } from "./env"
import { handleBotArenaRequest } from "./bot-arena-api"
import { handleRelayRequest } from "./relay-api"
import { createSomniaKeeper, trackedDuels } from "./somnia-keeper"
import { makeLogger } from "./log"
import { CORS_HEADERS, corsPreflight, json } from "./lib/http"
import { networkEnv } from "./network-env"
import { handleDeckmasterRequest, knownHashCount } from "./deckmaster"
import { handleDocsRequest } from "./docs"
import { handleAvatarRequest } from "./avatar-api"
import { handleDuelsRequest } from "./duels-api"
import {
  handleLeaderboardRequest,
  handleMyRankRequest,
} from "./leaderboard-api"
import { handleSeasonRequest } from "./season"
import { websocketHandler } from "./ws/handlers"
import { newSocketState } from "./ws/matchmaking"
import { connectedAddressCount, queueStats, roomCount } from "./ws/matchmaking"
import { startChatPruneLoop } from "./ws/chat"
import { startMatchClock, stopMatchClock } from "./ws/match-clock"
import {
  marketStreamStats,
  startMarketStream,
  stopMarketStream,
} from "./ws/market-stream"
import { closeDb, listCursors, predictMarketStats, ready } from "./db"

const log = makeLogger("server")

/**
 * Is the prediction venue actually usable right now?
 *
 * Twelve days once passed before anyone noticed the previous venue had stopped
 * creating markets, because `/health` reported `ok: true` throughout — nothing
 * it surfaced was about the upstream the whole game depends on. This is that
 * missing signal, now pointed at DreamDEX.
 *
 * Deliberately cheap: it reports what the process already knows plus the deck
 * source, and does NOT trigger a cold market scan. `bun run check:dreamdex`
 * is the deep probe.
 */
function venueHealth(): unknown {
  return {
    deckSource: env.deckSource,
    chainId: 50312,
    rpcUrl: process.env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network",
    duelContract: process.env.DREAMSWIPE_DUEL_ADDRESS ?? null,
    note: "run `bun --filter server run check:dreamdex` for a live venue probe",
  }
}

async function safeListCursors(): Promise<unknown> {
  try {
    return (await listCursors()).map((c) => ({
      tracker: c.trackerId.split("::").pop(),
      cursor: c.cursor,
      ageMs: Date.now() - c.updatedAt,
    }))
  } catch (e) {
    // /health is read on demand and shouldn't 500 — but log so a broken
    // DB is visible in stderr, not silently empty in the response.
    log.warn(
      `listCursors failed: ${e instanceof Error ? e.message : String(e)}`
    )
    return { error: "listCursors failed" }
  }
}

const server = Bun.serve({
  port: env.port,

  // Bun.serve defaults to a 10s idleTimeout, which silently killed the FIRST
  // request to /bot-arena/deck after every restart: a cold market-discovery
  // sweep is a multi-hundred-request `getLogs` scan against the public Somnia
  // RPC and was measured at ~17s (warm, from cache, it is ~1.5s). The client
  // saw an empty response with no error anywhere, which is the worst possible
  // way to fail.
  //
  // 60s leaves headroom for a cold scan on a slow RPC while still bounding a
  // genuinely stuck request.
  idleTimeout: 60,

  async fetch(req, server) {
    const url = new URL(req.url)

    if (req.method === "OPTIONS") return corsPreflight()

    const botArena = await handleBotArenaRequest(req)
    if (botArena) return botArena

    const relayed = await handleRelayRequest(req)
    if (relayed) return relayed

    if (url.pathname === "/health") {
      // Both reads hit Postgres — run them together and degrade
      // gracefully (null / error payload) so /health still answers even
      // if the DB is briefly unreachable.
      const [decks, cursors] = await Promise.all([
        knownHashCount().catch(() => null),
        safeListCursors(),
      ])
      return json({
        ok: true,
        port: env.port,
        network: env.network,
        decks,
        ws: {
          connectedAddresses: connectedAddressCount(),
          rooms: roomCount(),
          queues: queueStats(),
        },
        services: {
          keeper: somniaKeeper ? "enabled" : "disabled (no keeper key)",
          relayer: process.env.RELAYER_PRIVATE_KEY
            ? "enabled"
            : "disabled (no RELAYER_PRIVATE_KEY)",
        },
        cursors,
        venue: venueHealth(),
        marketStream: marketStreamStats(),
        somnia: {
          duelAddress: process.env.DREAMSWIPE_DUEL_ADDRESS ?? null,
          keeper: somniaKeeper ? somniaKeeper.address : "disabled",
          trackedDuels: trackedDuels().length,
        },
      })
    }

    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: newSocketState() })
      if (upgraded) return undefined as unknown as Response
      return new Response("upgrade failed", { status: 400 })
    }

    const deck = await handleDeckmasterRequest(req, url)
    if (deck) return deck

    const docs = await handleDocsRequest(req, url)
    if (docs) return docs

    const duels = await handleDuelsRequest(req, url)
    if (duels) return duels

    const leaderboard = await handleLeaderboardRequest(req, url)
    if (leaderboard) return leaderboard

    const myRank = await handleMyRankRequest(req, url)
    if (myRank) return myRank

    const season = handleSeasonRequest(req, url)
    if (season) return season

    const avatar = await handleAvatarRequest(req, url)
    if (avatar) return avatar

    return new Response("Go to /docs for documentation", {
      status: 200,
      headers: CORS_HEADERS,
    })
  },

  websocket: websocketHandler,
})

log.info(`listening on http://localhost:${server.port}`)
log.info(
  `  networks: ${env.enabledNetworks.join(", ")} (default ${env.network}; ` +
    `background services run on the default only)`
)
log.info(`  GET  /health`)
log.info(`  POST /deckmaster/generate`)
log.info(`  GET  /deckmaster/reveal?hash=0x...`)
log.info(`  GET  /sponsor`)
log.info(`  POST /sponsor`)
log.info(`  GET  /duels/recent`)
log.info(`  GET  /duels/{id}`)
log.info(`  GET  /leaderboard`)
log.info(`  GET  /leaderboard/me?address=0x...`)
log.info(`  GET  /season`)
log.info(`  GET  /avatars?addresses=0x..,0x..`)
log.info(`  POST /avatar`)
log.info(`  GET  /manager?owner=0x...`)
log.info(`  GET  /openapi.json`)
log.info(`  GET  /docs (Scalar UI)`)
log.info(`  WS   /ws`)
log.info(`Go to http://localhost:${server.port}/docs for documentation`)
if (!env.sponsorSecretKey) {
  log.warn(`sponsor disabled — set SPONSOR_SECRET_KEY in apps/server/.env`)
}
if (!env.flickyPackageId) {
  log.warn(
    `flicky package id not found — set FLICKY_PACKAGE_ID or publish via apps/contracts`
  )
}

// ─── Background services ────────────────────────────────────────────────────
//
// Boot in parallel after the fetch handler is live so a startup hiccup
// in either subsystem doesn't take down the HTTP/WS server.

// Create the Postgres schema up front so a bad DATABASE_URL surfaces in
// the logs at boot rather than on the first duel. Non-fatal: the HTTP/WS
// layer still answers (and /health reports the DB state) if this fails.
// NOTE: `ready()` can throw SYNCHRONOUSLY (getSql() validates DATABASE_URL
// before any await), in which case a trailing `.catch()` never runs and the
// throw escapes to module scope — killing the process at boot. That defeated
// the "non-fatal" intent entirely: an unset or briefly-bad DATABASE_URL took
// the whole server down instead of degrading to DB-less operation.
//
// Wrapping in an async IIFE turns the sync throw into a rejection the catch
// can actually see. The venue endpoints (/bot-arena/deck, /relay/swipe) and
// the WS layer need no database, so they stay up either way.
// `ready()` memoizes its promise and ~20 db.ts functions await it. When the DB
// is unreachable, whichever background loop touches it first leaves a rejected
// memoized promise that no one else subscribes to, and Bun treats that orphan
// as an unhandled rejection and EXITS — even though the boot path below caught
// its own copy. The result was that an unset DATABASE_URL killed a server whose
// venue endpoints (/bot-arena/deck, /relay/swipe) and WS layer need no database
// at all.
//
// Rather than audit every caller, DB-origin rejections are absorbed here and
// logged once. Anything else keeps the default fatal behaviour, so this does
// not become a blanket "ignore all errors".
let dbFailureLogged = false
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/DATABASE_URL|postgres|ECONNREFUSED/i.test(message)) {
    if (!dbFailureLogged) {
      dbFailureLogged = true
      log.error(`database unavailable, continuing without it: ${message}`)
    }
    return
  }
  log.error(`unhandled rejection: ${message}`)
  throw reason
})

void (async () => {
  try {
    await ready()
    log.info("postgres schema ready")
  } catch (e) {
    log.error(
      `postgres init failed (continuing without DB): ${
        e instanceof Error ? e.message : String(e)
      }`
    )
  }
})()

// Background services run on the DEFAULT network only. The Sui indexer,
// DeepBook oracle stream and predict watch that used to boot here are gone with
// the Somnia migration — settlement now comes from the venue via the keeper
// below, so there are no chain events to index separately.

startMatchClock()
startMarketStream()
startChatPruneLoop()

// Somnia settlement keeper. Reads outcomes from DreamDEX and writes
// settleCard/finalize on chain. No-ops without DREAMSWIPE_DUEL_ADDRESS +
// KEEPER_PRIVATE_KEY, so a read-only deployment boots cleanly.
const somniaKeeper = createSomniaKeeper()
if (somniaKeeper) {
  somniaKeeper.start()
} else {
  log.warn(
    "somnia keeper disabled — set DREAMSWIPE_DUEL_ADDRESS + KEEPER_PRIVATE_KEY"
  )
}

// ─── Shutdown ───────────────────────────────────────────────────────────────
//
// `bun --watch` sends SIGTERM on file change; pressing ^C sends SIGINT.
// Closing the DB explicitly flushes the WAL and releases the file lock so
// the next boot doesn't trip the disk-I/O smoke test on a stale handle.

async function shutdown(signal: string): Promise<void> {
  log.info(`received ${signal}, shutting down`)
  stopMatchClock()
  stopMarketStream()
  try {
    server.stop()
  } catch (e) {
    log.warn(
      `server.stop failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  // Close the pool so in-flight queries drain and connections are
  // released cleanly before the process exits.
  await closeDb()
  process.exit(0)
}

process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
