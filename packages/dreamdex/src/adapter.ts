/**
 * Live venue adapter — SERVER ONLY.
 *
 * Imports `node:url`, `node:module` and `@somnia-chain/markets-sdk`, so this
 * must never reach a browser bundle. The browser-safe surface is the package
 * root (`@workspace/dreamdex`).
 */
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
