import { expect, test } from "bun:test"
import {
  REPLAY_LEAD_IN_MS,
  REPLAY_STEP_MS,
  replayDurationMs,
  replaySeenKey,
  revealScheduleMs,
  shouldReplay,
} from "./settlement-replay"

test("schedule staggers one card per step after the lead-in", () => {
  expect(revealScheduleMs(3)).toEqual([
    REPLAY_LEAD_IN_MS,
    REPLAY_LEAD_IN_MS + REPLAY_STEP_MS,
    REPLAY_LEAD_IN_MS + 2 * REPLAY_STEP_MS,
  ])
})

test("schedule is empty for a deck with no cards", () => {
  expect(revealScheduleMs(0)).toEqual([])
  // Never throws or produces negative-length output on a bad count.
  expect(revealScheduleMs(-2)).toEqual([])
})

test("duration ends on the LAST reveal, not a step past it", () => {
  // A trailing step would leave the screen idle after the final card flips.
  expect(replayDurationMs(5)).toBe(REPLAY_LEAD_IN_MS + 4 * REPLAY_STEP_MS)
  expect(replayDurationMs(1)).toBe(REPLAY_LEAD_IN_MS)
  expect(replayDurationMs(0)).toBe(0)
})

const base = {
  status: "COMPLETE",
  cardCount: 5,
  seenBefore: false,
  reducedMotion: false,
}

test("replays a finished duel on first view", () => {
  expect(shouldReplay(base)).toBe(true)
})

test("never replays a live duel", () => {
  // Gating a live card would hide information the player can still act on.
  expect(shouldReplay({ ...base, status: "ACTIVE" })).toBe(false)
  expect(shouldReplay({ ...base, status: "PENDING" })).toBe(false)
})

test("does not replay on a revisit", () => {
  expect(shouldReplay({ ...base, seenBefore: true })).toBe(false)
})

test("reduced motion opts out entirely", () => {
  expect(shouldReplay({ ...base, reducedMotion: true })).toBe(false)
})

test("an empty deck has nothing to replay", () => {
  expect(shouldReplay({ ...base, cardCount: 0 })).toBe(false)
})

test("seen-key is namespaced per duel", () => {
  expect(replaySeenKey("0xabc")).toBe("dreamswipe.replay-seen.0xabc")
  expect(replaySeenKey("0xabc")).not.toBe(replaySeenKey("0xdef"))
})
