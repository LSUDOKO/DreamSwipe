/**
 * `@workspace/dreamdex` — DreamSwipe's prediction-venue boundary.
 *
 * Import venue types and math from here. The only module that touches the
 * Somnia/DreamDEX SDK is `./somnia-adapter`; everything else in the monorepo
 * should depend on the interface, not the implementation.
 */
export * from "./types"
export * from "./book-math"
export * from "./market-cache"
export {
  SomniaDreamDexAdapter,
  SHANNON_CHAIN_ID,
  DEFAULT_RPC_URL,
  DEFAULT_WS_RPC_URL,
  DEFAULT_INDEXER_URL,
  probabilityToPrice,
  priceToProbability,
  type SomniaAdapterConfig,
} from "./somnia-adapter"
