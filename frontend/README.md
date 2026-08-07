# Capere AI frontend

Next.js App Router application intended for Firebase App Hosting at `app.capereai.com`.

Copy `.env.example` to `.env.local`, set the Supabase public URL/key and API URL, then run `pnpm --filter @capere/frontend dev`.

Authentication uses Supabase SSR cookies. Browser code never receives an API or provider secret. `/api/capere/*` is a server-side BFF forwarding the user's Supabase bearer token to the backend.

For deployment, create the `CAPERE_SUPABASE_URL` and `CAPERE_SUPABASE_ANON_KEY` Firebase secrets, connect the repository, map the custom domain, and set Supabase's redirect URL to `https://app.capereai.com/auth/callback`.
