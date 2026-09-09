import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider, Navigate } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WagmiProvider } from "wagmi"

import "@workspace/ui/globals.css"
import "@/styles/onboarding.css"
import { wagmiConfig } from "@/lib/chain"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import Landing from "@/routes/landing.tsx"
import Profile from "@/routes/profile.tsx"
import GameLayout from "@/routes/game/layout.tsx"
import GameHome from "@/routes/game/home.tsx"
import GamePvp from "@/routes/game/pvp.tsx"
import PlayDuel from "@/routes/game/play.tsx"
import DuelView from "@/routes/game/duel-view.tsx"
import GameHistory from "@/routes/game/history.tsx"
import GamePractice from "@/routes/game/practice.tsx"
import GameShop from "@/routes/game/shop.tsx"
import GameRank from "@/routes/game/rank.tsx"
import GameChat from "@/routes/game/chat.tsx"
import BotArena from "@/routes/game/bot-arena.tsx"

const router = createBrowserRouter([
  { path: "/", element: <Landing /> },
  { path: "/profile", element: <Profile /> },
  {
    path: "/game",
    element: <GameLayout />,
    children: [
      { index: true, element: <Navigate to="/game/home" replace /> },
      { path: "home", element: <GameHome /> },
      { path: "pvp", element: <GamePvp /> },
      { path: "play/:duelId", element: <PlayDuel /> },
      { path: "duel/:duelId", element: <DuelView /> },
      { path: "history", element: <GameHistory /> },
      { path: "practice", element: <GamePractice /> },
      { path: "bot-arena", element: <BotArena /> },
      { path: "shop", element: <GameShop /> },
      { path: "rank", element: <GameRank /> },
      { path: "inventory", element: <GameChat /> },
    ],
  },
])

const queryClient = new QueryClient()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  </StrictMode>
)
