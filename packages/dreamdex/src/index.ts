/**
 * `@workspace/dreamdex` — DreamSwipe's prediction-venue boundary.
 *
 * This entry is BROWSER-SAFE: types, pure book math, the market cache and the
 * Bot Arena agents. None of it touches Node builtins or the venue SDK.
 *
 * The live adapter lives behind `@workspace/dreamdex/adapter` because it
 * imports `node:url`/`node:module` and the markets SDK, which a Vite build
 * cannot resolve. Keeping that split explicit means the web app physically
 * cannot pull server-only code into the bundle by accident.
 */
export * from "./types"
export * from "./book-math"
export * from "./market-cache"
export * from "./agents"
