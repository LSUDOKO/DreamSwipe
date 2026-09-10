/**
 * Bot Arena — a real duel against a strategy agent on live Somnia markets.
 *
 * ── What this screen has to actually do ─────────────────────────────────────
 *
 * An earlier version dealt a deck, took a swipe, printed the bot's answer, and
 * then stopped. No score, no progress, no outcome — a demo, not a game. This
 * version runs the whole loop: swipe every card, watch a running head-to-head,
 * then settle from the VENUE as each market resolves and declare a winner.
 *
 * ── Fairness stays structural ───────────────────────────────────────────────
 *
 * The bot decides from `PredictionContext`, which cannot express an outcome —
 * no winner, no settlement price. Settlement comes from a SEPARATE endpoint,
 * polled only after every card is locked in, and is never handed to the agent.
 * So the bot cannot see the future even in principle, and this screen cannot
 * leak it by accident.
 *
 * ── Scoring is the same economics as a staked duel ──────────────────────────
 *
 *   netResult = realizedValue - entryCost
 *
 * A winning binary contract redeems 1:1; a loser is worth zero; a voided market
 * refunds both sides at half. Entry costs come from the live book, so backing
 * the side the market thinks unlikely pays more — the reason this is a game of
 * reading the market rather than a coin-flip streak.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router"
import {
  ONE_PROBABILITY,
  STRATEGIES,
  cardPnl,
  createAgent,
  type BotDecision,
  type Difficulty,
  type Direction,
  type PredictionContext,
  type StrategyName,
} from "@workspace/dreamdex"
import { PixelButton } from "@/components/pixel-button"
import { useCurrentAccount } from "@/hooks/use-wallet"
import { apiUrl } from "@/lib/config"
import { formatCollateral } from "@/lib/chain"

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

/** One whole prediction contract, 6-decimal collateral. */
const STAKE_PER_CARD = 1_000_000n

interface ArenaCard {
  marketId: string
  asset: string
  question: string
  intervalSec: number
  msToExpiry: number
  mid: bigint | null
  midHistory: bigint[]
  bidDepth: bigint
  askDepth: bigint
}

interface Play {
  you: Direction
  bot: BotDecision
  /** What each side paid, priced off the live book at swipe time. */
  yourCost: bigint
  botCost: bigint
  settled: boolean
  winner: Direction | null
  voided: boolean
}

/**
 * Entry cost for a side, from the market's own mid.
 *
 * Backing the market-favoured side costs more and therefore pays less. That is
 * the whole reason scoring uses economics rather than a hit count. With no book
 * there is no price, so both sides cost the same and the card is a fair coin.
 */
function costOf(mid: bigint | null, dir: Direction): bigint {
  if (mid === null) return STAKE_PER_CARD / 2n
  const upCost = (STAKE_PER_CARD * mid) / ONE_PROBABILITY
  return dir === "UP" ? upCost : STAKE_PER_CARD - upCost
}

export default function BotArena() {
  const account = useCurrentAccount()
  const [strategy, setStrategy] = useState<StrategyName>("momentum")
  const [difficulty, setDifficulty] = useState<Difficulty>("medium")
  const [cards, setCards] = useState<ArenaCard[] | null>(null)
  const [plays, setPlays] = useState<(Play | null)[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settling, setSettling] = useState(false)

  const agent = useMemo(
    () => createAgent(strategy, difficulty),
    [strategy, difficulty]
  )

  const start = useCallback(async () => {
    setLoading(true)
    setError(null)
    setPlays([])
    setCards(null)
    try {
      const res = await fetch(apiUrl("/bot-arena/deck"))
      if (!res.ok) {
        throw new Error(
          res.status === 503
            ? "No live markets right now — the venue rolls windows continuously, so try again in a minute."
            : `Server returned ${res.status}`
        )
      }
      const body = (await res.json()) as { cards?: ArenaCard[] }
      if (!body.cards?.length) throw new Error("No eligible markets right now.")

      const parsed = body.cards.map((c) => ({
        ...c,
        mid: c.mid === null ? null : BigInt(c.mid),
        midHistory: (c.midHistory ?? []).map((m) => BigInt(m)),
        bidDepth: BigInt(c.bidDepth ?? 0),
        askDepth: BigInt(c.askDepth ?? 0),
      }))
      setCards(parsed)
      setPlays(new Array(parsed.length).fill(null))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  /** Swipe a card: lock your side in, then ask the bot for its own call. */
  const pick = useCallback(
    async (idx: number, you: Direction) => {
      const card = cards?.[idx]
      if (!card || plays[idx]) return

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
      const bot = await agent.decide(context)

      setPlays((prev) => {
        const next = [...prev]
        next[idx] = {
          you,
          bot,
          yourCost: costOf(card.mid, you),
          botCost: costOf(card.mid, bot.direction),
          settled: false,
          winner: null,
          voided: false,
        }
        return next
      })
    },
    [agent, cards, plays]
  )

  const allSwiped =
    cards !== null && plays.length > 0 && plays.every((p) => p !== null)
  const anyUnsettled = plays.some((p) => p && !p.settled)

  /**
   * Poll the venue for settlement once every card is swiped.
   *
   * Deliberately starts only after the LAST swipe. Settlement must never be
   * reachable while a card is still open, or this screen would be handing the
   * player the answer to a question they have not yet answered.
   */
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (!allSwiped || !anyUnsettled || !cards) return

    const check = async () => {
      setSettling(true)
      try {
        const ids = cards.map((c) => c.marketId).join(",")
        const res = await fetch(
          apiUrl(`/bot-arena/settlement?marketIds=${ids}`)
        )
        if (!res.ok) return
        const body = (await res.json()) as {
          markets?: {
            marketId: string
            resolved: boolean
            winner?: Direction | null
            voided?: boolean
          }[]
        }
        const byId = new Map((body.markets ?? []).map((m) => [m.marketId, m]))
        setPlays((prev) =>
          prev.map((p, i) => {
            if (!p || p.settled) return p
            const s = byId.get(cards[i]!.marketId)
            if (!s?.resolved) return p
            return {
              ...p,
              settled: true,
              winner: s.winner ?? null,
              voided: Boolean(s.voided),
            }
          })
        )
      } catch {
        // A failed poll is not fatal — the interval retries.
      } finally {
        setSettling(false)
      }
    }

    void check()
    pollRef.current = setInterval(() => void check(), 20_000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [allSwiped, anyUnsettled, cards])

  // Running head-to-head, from realized economics only.
  const { yourScore, botScore, settledCount } = useMemo(() => {
    let you = 0n
    let bot = 0n
    let n = 0
    for (const p of plays) {
      if (!p?.settled) continue
      n++
      you += cardPnl({
        direction: p.you,
        quantity: STAKE_PER_CARD,
        entryCost: p.yourCost,
        winner: p.winner,
        voided: p.voided,
      })
      bot += cardPnl({
        direction: p.bot.direction,
        quantity: STAKE_PER_CARD,
        entryCost: p.botCost,
        winner: p.winner,
        voided: p.voided,
      })
    }
    return { yourScore: you, botScore: bot, settledCount: n }
  }, [plays])

  const swipedCount = plays.filter(Boolean).length
  const complete = settledCount > 0 && settledCount === plays.length

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-24 font-pixel text-white">
      <header className="mb-6">
        <h1 className="text-lg tracking-[0.18em] uppercase">bot arena</h1>
        <p className="mt-1 text-xs tracking-[0.15em] text-white/45 uppercase">
          duel a strategy agent on live somnia markets
        </p>
      </header>

      {/* Scoreboard — present from the first swipe so this reads as a duel. */}
      {cards && (
        <section className="mb-5 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
          <div className="flex items-center justify-between gap-3">
            <Side label="you" score={yourScore} live={settledCount > 0} />
            <div className="shrink-0 text-center">
              <p className="text-[10px] tracking-[0.16em] text-white/40 uppercase">
                {swipedCount}/{plays.length} swiped
              </p>
              <p className="mt-0.5 text-[10px] tracking-[0.16em] text-white/40 uppercase">
                {settledCount}/{plays.length} settled
              </p>
            </div>
            <Side
              label={strategy.replace("-", " ")}
              score={botScore}
              live={settledCount > 0}
              right
            />
          </div>

          {complete && (
            <p className="mt-3 border-t border-white/10 pt-3 text-center text-sm tracking-[0.12em] uppercase">
              {yourScore > botScore ? (
                <span className="text-emerald-300">you win</span>
              ) : botScore > yourScore ? (
                <span className="text-red-300">bot wins</span>
              ) : (
                <span className="text-white/70">draw</span>
              )}
            </p>
          )}
          {allSwiped && !complete && (
            <p className="mt-3 border-t border-white/10 pt-3 text-center text-[10px] leading-relaxed tracking-[0.1em] text-white/45">
              {settling ? "Checking settlement…" : "Waiting on the venue."}{" "}
              Cards settle at their own expiry. This page keeps checking — you
              can leave it open.
            </p>
          )}
        </section>
      )}

      {!cards && (
        <>
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
              Difficulty changes how strong a signal the bot needs before it
              acts — never what it can see. It reads exactly what you read.
            </p>
          </section>

          <PixelButton
            onClick={() => void start()}
            disabled={loading}
            className="h-12 w-full"
          >
            {loading ? "loading live markets…" : "deal a deck"}
          </PixelButton>
        </>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-[11px] leading-relaxed tracking-[0.08em] text-red-200/90">
          {error}
        </div>
      )}

      {cards && (
        <div className="mt-2 flex flex-col gap-3">
          {cards.map((card, i) => (
            <CardRow
              key={card.marketId}
              card={card}
              play={plays[i] ?? null}
              onPick={(dir) => void pick(i, dir)}
            />
          ))}

          <PixelButton
            onClick={() => void start()}
            className="mt-2 h-11 w-full"
          >
            new deck
          </PixelButton>
          <Link
            to="/game/home"
            className="mt-1 text-center text-[10px] tracking-[0.15em] text-white/40 uppercase hover:text-white/70"
          >
            back to lobby
          </Link>
        </div>
      )}

      {!account && (
        <p className="mt-6 text-center text-[10px] tracking-[0.14em] text-white/35 uppercase">
          bot arena is free — connect a wallet only for staked pvp
        </p>
      )}
    </div>
  )
}

function Side({
  label,
  score,
  live,
  right,
}: {
  label: string
  score: bigint
  live: boolean
  right?: boolean
}) {
  const tone =
    score > 0n
      ? "text-emerald-300"
      : score < 0n
        ? "text-red-300"
        : "text-white/70"
  return (
    <div className={`min-w-0 flex-1 ${right ? "text-right" : ""}`}>
      <p className="truncate text-[10px] tracking-[0.16em] text-white/45 uppercase">
        {label}
      </p>
      <p className={`mt-0.5 text-base tracking-[0.06em] ${tone}`}>
        {live ? `${score > 0n ? "+" : ""}${formatCollateral(score)}` : "—"}
      </p>
    </div>
  )
}

function CardRow({
  card,
  play,
  onPick,
}: {
  card: ArenaCard
  play: Play | null
  onPick: (d: Direction) => void
}) {
  const mins = Math.max(0, Math.round(card.msToExpiry / 60000))
  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs tracking-[0.15em] text-white/80 uppercase">
          {card.asset} · {Math.round(card.intervalSec / 60)}m
        </span>
        <span className="text-[10px] tracking-[0.12em] text-white/40 uppercase">
          {play?.settled
            ? play.voided
              ? "voided"
              : `settled ${play.winner}`
            : `settles in ${mins}m`}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed tracking-[0.06em] text-white/60">
        {card.question}
      </p>
      <p className="mt-2 text-[10px] tracking-[0.12em] text-white/35 uppercase">
        {card.mid === null
          ? "no quotes resting — both sides priced even"
          : `market: ${((Number(card.mid) / 1e6) * 100).toFixed(1)}% up`}
      </p>

      {!play ? (
        <div className="mt-3 flex gap-2">
          <PixelButton onClick={() => onPick("DOWN")} className="h-10 flex-1">
            no / down
          </PixelButton>
          <PixelButton onClick={() => onPick("UP")} className="h-10 flex-1">
            yes / up
          </PixelButton>
        </div>
      ) : (
        <div className="mt-3 space-y-1.5 text-[10px] tracking-[0.12em]">
          <ScoreLine
            who="you"
            dir={play.you}
            cost={play.yourCost}
            play={play}
            highlight
          />
          <ScoreLine
            who="bot"
            dir={play.bot.direction}
            cost={play.botCost}
            play={play}
          />
          <p className="pt-1 text-[10px] tracking-[0.04em] text-white/40 normal-case">
            {play.bot.rationale}
          </p>
        </div>
      )}
    </article>
  )
}

function ScoreLine({
  who,
  dir,
  cost,
  play,
  highlight,
}: {
  who: string
  dir: Direction
  cost: bigint
  play: Play
  highlight?: boolean
}) {
  const pnl = play.settled
    ? cardPnl({
        direction: dir,
        quantity: STAKE_PER_CARD,
        entryCost: cost,
        winner: play.winner,
        voided: play.voided,
      })
    : null
  return (
    <p className={highlight ? "text-white/80" : "text-amber-200/85"}>
      {who}: {dir} · paid {formatCollateral(cost)}
      {pnl !== null && (
        <span className={pnl >= 0n ? "text-emerald-300" : "text-red-300"}>
          {" "}
          → {pnl > 0n ? "+" : ""}
          {formatCollateral(pnl)}
        </span>
      )}
    </p>
  )
}
