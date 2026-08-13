# Capere AI frontend

Next.js App Router application intended for Firebase App Hosting at `app.capereai.com`.

Copy `.env.example` to `.env.local`, set the Supabase public URL/key and API URL, then run `pnpm --filter @capere/frontend dev`.

Authentication uses Supabase SSR cookies. Browser code never receives an API or provider secret. `/api/capere/*` is a server-side BFF forwarding the user's Supabase bearer token to the backend.

For deployment, create the `CAPERE_FIREBASE_WEB_API_KEY` App Hosting secret,
connect the repository, and map the custom domain. Authentication is established
only through the verified GoHighLevel embedded SSO flow; there is no standalone
Capere login form.
