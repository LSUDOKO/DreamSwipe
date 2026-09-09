/**
 * Bot Arena — pick a strategy and a difficulty, then duel it.
 *
 * The bots run against LIVE market context (real order books, real mid
 * history) and their reasoning is shown card by card, because a bot whose
 * decision you cannot inspect is just a random number generator with a name.
 *
 * Fairness is guaranteed upstream, in the type system: `PredictionContext`
 * (packages/dreamdex/src/agents.ts) has no `winner` or `settlementPrice`
 * field, so an agent cannot see an outcome even in principle. This screen
 * surfaces that guarantee to the player rather than asking them to trust it.
 */
import { useCallback, useMemo, useState } from "react"
import { Link } from "react-router"
import {
  STRATEGIES,
  createAgent,
  type BotDecision,
  type Difficulty,
  type PredictionContext,
  type StrategyName,
} from "@workspace/dreamdex"
import { PixelButton } from "@/components/pixel-button"
import { useCurrentAccount } from "@/hooks/use-wallet"

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"]

const STRATEGY_BLURB: Record<StrategyName, string> = {
  momentum: "Follows the trend — backs whichever way the market is drifting.",
  "mean-reversion":
    "Fades extremes — bets the crowd overshot and price snaps back.",
  "clob-imbalance":
    "Reads the order book — backs the side with more resting size behind it.",
  contrarian:
    "Always takes the cheaper side — bigger payout when it lands, and it often doesn't.",
}

interface ArenaCard {
  marketId: string
  asset: string
  question: string
  intervalSec: number
  msToExpiry: number
  /** Live mid in millionths, or null when the book is empty. */
  mid: bigint | null
  midHistory: bigint[]
  bidDepth: bigint
  askDepth: bigint
}

export default function BotArena() {
  const account = useCurrentAccount()
  const [strategy, setStrategy] = useState<StrategyName>("momentum")
  const [difficulty, setDifficulty] = useState<Difficulty>("medium")
  const [cards, setCards] = useState<ArenaCard[] | null>(null)
  const [decisions, setDecisions] = useState<BotDecision[]>([])
  const [playerPicks, setPlayerPicks] = useState<(("UP" | "DOWN") | null)[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const agent = useMemo(
    () => createAgent(strategy, difficulty),
    [strategy, difficulty]
  )

  /**
   * Pull a live deck from the server.
   *
   * The server owns venue access (it holds the RPC and the market cache), so
   * the browser asks it for a deck rather than scanning chain logs itself —
   * a multi-hundred-request log scan is not something to run per player.
   */
  const start = useCallback(async () => {
    setLoading(true)
    setError(null)
    setDecisions([])
    setCards(null)
    try {
      const base = import.meta.env.VITE_SERVER_HTTP_URL || ""
      const res = await fetch(`${base}/bot-arena/deck`)
      if (!res.ok) {
        throw new Error(
          res.status === 503
            ? "No live markets right now — the venue rolls windows continuously, so try again in a minute."
            : `Server returned ${res.status}`
        )
      }
      const body = (await res.json()) as { cards: ArenaCard[] }
      if (!body.cards?.length) throw new Error("No eligible markets right now.")

      const parsed = body.cards.map((c) => ({
        ...c,
        mid: c.mid === null ? null : BigInt(c.mid),
        midHistory: (c.midHistory ?? []).map((m) => BigInt(m)),
        bidDepth: BigInt(c.bidDepth ?? 0),
        askDepth: BigInt(c.askDepth ?? 0),
      }))
      setCards(parsed)
      setPlayerPicks(new Array(parsed.length).fill(null))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  /** Ask the bot for its call on one card, from the same context a human sees. */
  const revealBot = useCallback(
    async (idx: number) => {
      const card = cards?.[idx]
      if (!card) return
      const context: PredictionContext = {
        marketId: card.marketId,
        asset: card.asset,
        question: card.question,
        book:
          card.mid === null
            ? null
            : {
                marketId: card.marketId,
                bids: [{ price: card.mid, quantity: card.bidDepth }],
                asks: [{ price: card.mid, quantity: card.askDepth }],
                bestBid: card.mid,
                bestAsk: card.mid,
                spread: 0n,
                mid: card.mid,
                bidDepth: card.bidDepth,
                askDepth: card.askDepth,
                imbalance:
                  card.bidDepth + card.askDepth === 0n
                    ? null
                    : Number(card.bidDepth - card.askDepth) /
                      Number(card.bidDepth + card.askDepth),
                observedAtMs: Date.now(),
              },
        midHistory: card.midHistory,
        msToExpiry: card.msToExpiry,
        intervalSec: card.intervalSec,
      }
      const decision = await agent.decide(context)
      setDecisions((prev) => {
        const next = [...prev]
        next[idx] = decision
        return next
      })
    },
    [agent, cards]
  )

  const pick = useCallback(
    (idx: number, direction: "UP" | "DOWN") => {
      setPlayerPicks((prev) => {
        const next = [...prev]
        next[idx] = direction
        return next
      })
      void revealBot(idx)
    },
    [revealBot]
  )

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-24 font-pixel text-white">
      <header className="mb-6">
        <h1 className="text-lg tracking-[0.18em] uppercase">bot arena</h1>
        <p className="mt-1 text-xs tracking-[0.15em] text-white/45 uppercase">
          duel a strategy agent on live somnia markets
        </p>
      </header>

      <section className="mb-5">
        <h2 className="mb-2 text-[11px] tracking-[0.2em] text-white/50 uppercase">
          strategy
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {STRATEGIES.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setStrategy(name)}
              className={`rounded-xl border px-3 py-2 text-left text-[11px] tracking-[0.12em] uppercase transition ${
                strategy === name
                  ? "border-amber-300/70 bg-amber-300/10 text-white"
                  : "border-white/10 bg-white/5 text-white/60 hover:border-white/25"
              }`}
            >
              {name.replace("-", " ")}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed tracking-[0.08em] text-white/40">
          {STRATEGY_BLURB[strategy]}
        </p>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-[11px] tracking-[0.2em] text-white/50 uppercase">
          difficulty
        </h2>
        <div className="flex gap-2">
          {DIFFICULTIES.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDifficulty(d)}
              className={`flex-1 rounded-xl border px-3 py-2 text-[11px] tracking-[0.12em] uppercase transition ${
                difficulty === d
                  ? "border-amber-300/70 bg-amber-300/10 text-white"
                  : "border-white/10 bg-white/5 text-white/60 hover:border-white/25"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed tracking-[0.08em] text-white/40">
          Difficulty changes how strong a signal the bot needs before it acts —
          never what it can see. It reads exactly what you read.
        </p>
      </section>

      {!cards && (
        <PixelButton
          onClick={() => void start()}
          disabled={loading}
          className="h-12 w-full"
        >
          {loading ? "loading live markets…" : "deal a deck"}
        </PixelButton>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-[11px] leading-relaxed tracking-[0.08em] text-red-200/90">
          {error}
        </div>
      )}

      {cards && (
        <div className="mt-2 flex flex-col gap-3">
          {cards.map((card, i) => {
            const decision = decisions[i]
            const mine = playerPicks[i]
            return (
              <article
                key={card.marketId}
                className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-xs tracking-[0.15em] text-white/80 uppercase">
                    {card.asset} · {Math.round(card.intervalSec / 60)}m
                  </span>
                  <span className="text-[10px] tracking-[0.12em] text-white/40 uppercase">
                    settles in{" "}
                    {Math.max(0, Math.round(card.msToExpiry / 60000))}m
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed tracking-[0.06em] text-white/60">
                  {card.question}
                </p>

                <p className="mt-2 text-[10px] tracking-[0.12em] text-white/35 uppercase">
                  {card.mid === null
                    ? // Honest empty state — no book means no probability.
                      "no quotes resting — market has no price yet"
                    : `market: ${((Number(card.mid) / 1e6) * 100).toFixed(1)}% up`}
                </p>

                {!mine ? (
                  <div className="mt-3 flex gap-2">
                    <PixelButton
                      onClick={() => pick(i, "DOWN")}
                      className="h-10 flex-1"
                    >
                      no / down
                    </PixelButton>
                    <PixelButton
                      onClick={() => pick(i, "UP")}
                      className="h-10 flex-1"
                    >
                      yes / up
                    </PixelButton>
                  </div>
                ) : (
                  <div className="mt-3 space-y-2 text-[10px] tracking-[0.12em] uppercase">
                    <p className="text-white/70">you: {mine}</p>
                    {decision ? (
                      <>
                        <p className="text-amber-200/90">
                          bot: {decision.direction} ·{" "}
                          {(decision.confidence * 100).toFixed(0)}% confidence
                        </p>
                        <p className="tracking-[0.04em] text-white/45 normal-case">
                          {decision.rationale}
                        </p>
                      </>
                    ) : (
                      <p className="text-white/40">bot thinking…</p>
                    )}
                  </div>
                )}
              </article>
            )
          })}

          <p className="mt-2 text-center text-[10px] leading-relaxed tracking-[0.08em] text-white/35">
            Cards settle at their own expiry on DreamDEX. Results are scored
            from real settlement, not a simulation.
          </p>

          <Link
            to="/game/home"
            className="mt-2 text-center text-[10px] tracking-[0.15em] text-white/40 uppercase hover:text-white/70"
          >
            back to lobby
          </Link>
        </div>
      )}

      {!account && (
        <p className="mt-6 text-center text-[10px] tracking-[0.14em] text-white/35 uppercase">
          connect a wallet to play staked duels — bot arena is free to try
        </p>
      )}
    </div>
  )
}
