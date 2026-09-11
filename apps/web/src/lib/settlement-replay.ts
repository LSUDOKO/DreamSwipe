/**
 * Settlement replay for a finished duel.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A COMPLETE duel has nothing left to stream: `marketIds` is empty, so no
 * oracle ticks arrive and every card renders its final colour on first paint.
 * The screen is correct and completely static — the game's one dramatic
 * moment, five cards resolving, is already over before the page is drawn.
 *
 * This replays that moment. Cards reveal one at a time; a card past the
 * cursor renders in its normal pre-settle state, so the reveal reuses the
 * EXISTING visual language rather than adding a parallel set of "replay"
 * styles that could drift from the real thing.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 *
 * It never invents an outcome. The data is already final and unchanged — this
 * only gates WHEN each already-known result becomes visible. A card cannot
 * reveal as anything other than what the chain settled, because the reveal
 * carries no outcome of its own: it is an index cursor, nothing more.
 *
 * Replay is therefore safe to skip, and skipping is not a different result.
 */

/** Delay before the first card flips, so the page settles before it starts. */
export const REPLAY_LEAD_IN_MS = 500

/** Gap between consecutive card reveals. */
export const REPLAY_STEP_MS = 750

/**
 * When each card index should be revealed, in ms from replay start.
 *
 * Exported for tests and so the caller can size a progress affordance without
 * re-deriving the cadence.
 */
export function revealScheduleMs(cardCount: number): number[] {
  return Array.from(
    { length: Math.max(0, cardCount) },
    (_, i) => REPLAY_LEAD_IN_MS + i * REPLAY_STEP_MS
  )
}

/** Total wall time of a full replay, including the lead-in. */
export function replayDurationMs(cardCount: number): number {
  if (cardCount <= 0) return 0
  return REPLAY_LEAD_IN_MS + (cardCount - 1) * REPLAY_STEP_MS
}

/**
 * Whether a duel should replay at all.
 *
 * Only a finished duel replays: a live one is already dramatic on its own,
 * and gating a live card would HIDE information the player needs while they
 * can still act on it.
 *
 * `seenBefore` suppresses the replay on a revisit — the animation is a
 * first-view flourish, and re-watching it every time you open a months-old
 * duel from history would be an obstacle, not a feature.
 */
export function shouldReplay(input: {
  status: string
  cardCount: number
  seenBefore: boolean
  reducedMotion: boolean
}): boolean {
  if (input.reducedMotion) return false
  if (input.seenBefore) return false
  if (input.status !== "COMPLETE") return false
  return input.cardCount > 0
}

/** localStorage key marking a duel's replay as already watched. */
export function replaySeenKey(duelId: string): string {
  return `dreamswipe.replay-seen.${duelId}`
}
