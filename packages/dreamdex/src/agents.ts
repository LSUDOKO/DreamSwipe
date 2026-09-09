/**
 * Bot Arena — prediction agents.
 *
 * ── The fairness rule ───────────────────────────────────────────────────────
 *
 * `specs/07_BOT_ARENA.md` is unambiguous:
 *
 *   > Bots receive no future outcome data and no privileged settlement
 *   > information.
 *
 * That rule is enforced STRUCTURALLY here, not by convention. `PredictionContext`
 * is the agent's entire world, and it deliberately cannot express an outcome:
 * there is no `winner`, no `settlementPrice`, no `resolved`. An agent could not
 * cheat even if it tried, because the type system gives it nothing to cheat
 * with. A reviewer checking fairness only has to read the context type.
 *
 * The market context is also exactly what a human sees on the swipe card — the
 * live book, the mid, the price history, the time left. Same information, same
 * decision, so the arena is a genuine comparison rather than a rigged one.
 *
 * ── Relationship to the official Bot Kit ────────────────────────────────────
 *
 * The signal logic mirrors the Bot Kit's `momentum` and `mean-reversion`
 * strategies (rolling-window momentum; RSI/Bollinger stretch). What is NOT
 * reused is their order plumbing, and that is deliberate rather than lazy:
 * those bots are continuous spot traders that hold a position and manage
 * TP/SL over time. A DreamSwipe agent makes ONE discrete Up/Down call per
 * card and never manages a position. Wrapping a continuous trading loop to
 * extract a single boolean would be more code and less clarity.
 */
import { contrarianEdge } from "./book-math"
import { ONE_PROBABILITY, type Direction, type OrderBook } from "./types"

/**
 * Everything an agent is allowed to know when deciding a card.
 *
 * Contains no outcome information by construction — see the module docstring.
 */
export interface PredictionContext {
  /** Opaque market id, for logging and correlation only. */
  marketId: string
  /** Underlying asset, e.g. "BTC". */
  asset: string
  /** The question as shown on the card. */
  question: string
  /**
   * Live order book. `null` when the venue could not be read — an agent must
   * cope with that rather than assume a book exists.
   */
  book: OrderBook | null
  /**
   * Recent mid prices in millionths, oldest first, sampled from the same
   * market. Empty or short early in a window; agents must handle warm-up.
   */
  midHistory: bigint[]
  /** Milliseconds until the window expires. */
  msToExpiry: number
  /** Window length in seconds (300 = 5m). */
  intervalSec: number
}

/** An agent's call on one card. */
export interface BotDecision {
  direction: Direction
  /**
   * How strongly the signal fired, in [0, 1].
   *
   * Reported honestly: an agent with no usable signal returns a low confidence
   * and says so in `rationale`, rather than dressing up a coin flip.
   */
  confidence: number
  /** Human-readable reason, surfaced in the UI so the bot is legible. */
  rationale: string
}

/** The interface every strategy implements (per `specs/07_BOT_ARENA.md`). */
export interface PredictionAgent {
  readonly name: string
  readonly description: string
  decide(context: PredictionContext): Promise<BotDecision>
}

/** Difficulty scales how decisive an agent is, not what it can see. */
export type Difficulty = "easy" | "medium" | "hard"

/**
 * A coin flip, stated as such.
 *
 * Used when a strategy genuinely has no signal — an empty book, too little
 * history. Returning this with `confidence: 0` is the honest answer; inventing
 * a rationale for a random guess would mislead the player about what the bot
 * is doing.
 */
function noSignal(reason: string): BotDecision {
  return {
    direction: Math.random() < 0.5 ? "UP" : "DOWN",
    confidence: 0,
    rationale: `No usable signal (${reason}) — picking at random`,
  }
}

/**
 * Difficulty gate.
 *
 * An easier bot needs a stronger signal before it acts, and otherwise guesses.
 * This makes it genuinely weaker without ever giving it worse INFORMATION,
 * which would break the "same information as a human" rule.
 */
function difficultyThreshold(difficulty: Difficulty): number {
  switch (difficulty) {
    case "easy":
      return 0.6
    case "medium":
      return 0.3
    case "hard":
      return 0.0
  }
}

function applyDifficulty(
  decision: BotDecision,
  difficulty: Difficulty
): BotDecision {
  if (decision.confidence < difficultyThreshold(difficulty)) {
    return {
      ...noSignal(`signal too weak for ${difficulty} difficulty`),
      rationale: `${decision.rationale} — but too weak to act on at ${difficulty} difficulty`,
    }
  }
  return decision
}

/**
 * Momentum: follow the recent direction of travel.
 *
 * Compares the average of the recent half of the mid history against the older
 * half. A market drifting toward UP is taken as evidence it continues.
 *
 * Mirrors the Bot Kit momentum strategy's core signal, reduced to a single
 * directional call.
 */
export class MomentumAgent implements PredictionAgent {
  readonly name = "Momentum"
  readonly description =
    "Follows recent price movement — backs the side the market is drifting toward."
  private readonly difficulty: Difficulty
  private readonly minSamples: number

  constructor(difficulty: Difficulty = "medium", minSamples: number = 4) {
    this.difficulty = difficulty
    this.minSamples = minSamples
  }

  async decide(context: PredictionContext): Promise<BotDecision> {
    const history = context.midHistory
    if (history.length < this.minSamples) {
      return noSignal(
        `only ${history.length}/${this.minSamples} price samples so far`
      )
    }

    const half = Math.floor(history.length / 2)
    const older = history.slice(0, half)
    const recent = history.slice(half)

    const avgOlder = average(older)
    const avgRecent = average(recent)
    if (avgOlder === 0) return noSignal("degenerate price history")

    // Fractional drift in probability terms.
    const drift = (avgRecent - avgOlder) / avgOlder
    const direction: Direction = drift >= 0 ? "UP" : "DOWN"

    // A 10% probability drift is treated as a maximally strong signal.
    const confidence = Math.min(Math.abs(drift) / 0.1, 1)

    return applyDifficulty(
      {
        direction,
        confidence,
        rationale: `Mid moved ${(drift * 100).toFixed(2)}% over the last ${history.length} samples — momentum favours ${direction}`,
      },
      this.difficulty
    )
  }
}

/**
 * Mean reversion: fade an over-extended market.
 *
 * When the market prices one side far from even, this bets the crowd has
 * overshot and takes the other side. The opposite thesis to Momentum, so the
 * two disagree in exactly the situations that make a duel interesting.
 *
 * Mirrors the Bot Kit mean-reversion "stretched, so fade it" signal.
 */
export class MeanReversionAgent implements PredictionAgent {
  readonly name = "Mean Reversion"
  readonly description =
    "Fades over-extended markets — backs the less crowded side when the crowd looks stretched."
  private readonly difficulty: Difficulty
  private readonly stretchThreshold: number

  constructor(
    difficulty: Difficulty = "medium",
    stretchThreshold: number = 0.15
  ) {
    this.difficulty = difficulty
    this.stretchThreshold = stretchThreshold
  }

  async decide(context: PredictionContext): Promise<BotDecision> {
    const book = context.book
    if (!book || book.mid === null) {
      return noSignal("no two-sided book to measure a mean against")
    }

    const upProbability = Number(book.mid) / Number(ONE_PROBABILITY)
    const stretch = upProbability - 0.5

    if (Math.abs(stretch) < this.stretchThreshold) {
      return applyDifficulty(
        {
          // Near even there is nothing to revert from; lean weakly to the
          // cheaper side and report the low confidence honestly.
          direction: upProbability >= 0.5 ? "DOWN" : "UP",
          confidence: Math.abs(stretch) / this.stretchThreshold / 4,
          rationale: `Market is near even (${(upProbability * 100).toFixed(1)}% UP) — little to revert from`,
        },
        this.difficulty
      )
    }

    // Stretched: take the other side.
    const direction: Direction = stretch > 0 ? "DOWN" : "UP"
    const confidence = Math.min(Math.abs(stretch) / 0.4, 1)

    return applyDifficulty(
      {
        direction,
        confidence,
        rationale: `Market is stretched to ${(upProbability * 100).toFixed(1)}% UP — fading the crowd by backing ${direction}`,
      },
      this.difficulty
    )
  }
}

/**
 * CLOB Imbalance: read resting order-book pressure.
 *
 *   imbalance = (bidDepth - askDepth) / (bidDepth + askDepth)
 *
 * More resting bid depth than ask depth is read as buy-side pressure on UP.
 *
 * Requires a real minimum depth before acting. The spec asks for a depth
 * threshold specifically because imbalance computed over a nearly empty book
 * is noise: two small orders can read as ±1.0 and mean nothing.
 */
export class ClobImbalanceAgent implements PredictionAgent {
  readonly name = "CLOB Imbalance"
  readonly description =
    "Reads resting order-book depth — backs the side with more size behind it."
  private readonly difficulty: Difficulty
  private readonly minDepth: bigint

  constructor(
    difficulty: Difficulty = "medium",
    minDepth: bigint = 1_000_000n
  ) {
    this.difficulty = difficulty
    this.minDepth = minDepth
  }

  async decide(context: PredictionContext): Promise<BotDecision> {
    const book = context.book
    if (!book) return noSignal("order book unavailable")

    const totalDepth = book.bidDepth + book.askDepth
    if (totalDepth < this.minDepth) {
      return noSignal(
        `book too thin (${totalDepth} < ${this.minDepth} base units) to read imbalance`
      )
    }
    if (book.imbalance === null) return noSignal("empty book")

    const direction: Direction = book.imbalance >= 0 ? "UP" : "DOWN"
    const confidence = Math.min(Math.abs(book.imbalance), 1)

    return applyDifficulty(
      {
        direction,
        confidence,
        rationale: `Book imbalance ${(book.imbalance * 100).toFixed(1)}% (${book.bidDepth} bid vs ${book.askDepth} ask) — pressure favours ${direction}`,
      },
      this.difficulty
    )
  }
}

/**
 * Contrarian: back whichever side the market has priced as less likely.
 *
 * The playable counterpart to the "Contrarian Edge" indicator shown to humans.
 * It makes no claim about being right — only that the less crowded side pays
 * more when it wins, which is a fact about current pricing.
 */
export class ContrarianAgent implements PredictionAgent {
  readonly name = "Contrarian"
  readonly description =
    "Always backs the less crowded side — higher payout when it lands, and it often doesn't."
  private readonly difficulty: Difficulty

  constructor(difficulty: Difficulty = "medium") {
    this.difficulty = difficulty
  }

  async decide(context: PredictionContext): Promise<BotDecision> {
    const book = context.book
    if (!book) return noSignal("order book unavailable")

    const edge = contrarianEdge(book)
    if (!edge) return noSignal("no mid price, so no crowd to fade")

    return applyDifficulty(
      {
        direction: edge.contrarianSide,
        confidence: Math.min(Math.abs(edge.upProbability - 0.5) * 2, 1),
        rationale: `Crowd is on ${edge.crowdedSide} (${(edge.upProbability * 100).toFixed(1)}% UP); backing ${edge.contrarianSide} pays ${edge.contrarianReturn.toFixed(2)}x if it lands`,
      },
      this.difficulty
    )
  }
}

/** Registry of the strategies the Bot Arena offers. */
export type StrategyName =
  | "momentum"
  | "mean-reversion"
  | "clob-imbalance"
  | "contrarian"

export function createAgent(
  strategy: StrategyName,
  difficulty: Difficulty = "medium"
): PredictionAgent {
  switch (strategy) {
    case "momentum":
      return new MomentumAgent(difficulty)
    case "mean-reversion":
      return new MeanReversionAgent(difficulty)
    case "clob-imbalance":
      return new ClobImbalanceAgent(difficulty)
    case "contrarian":
      return new ContrarianAgent(difficulty)
  }
}

export const STRATEGIES: readonly StrategyName[] = [
  "momentum",
  "mean-reversion",
  "clob-imbalance",
  "contrarian",
] as const

function average(values: bigint[]): number {
  if (values.length === 0) return 0
  let sum = 0n
  for (const v of values) sum += v
  return Number(sum) / values.length
}
