# --- Stage 1: build ---
FROM node:20-alpine AS build

WORKDIR /app

# pnpm is needed even though the app deps are hoisted to a single package
RUN corepack enable

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
COPY backend/package.json ./backend/package.json
RUN pnpm install --frozen-lockfile --filter @capere/backend --config.confirmModulesPurge=false

COPY backend ./backend
COPY supabase ./supabase
RUN pnpm --filter @capere/backend build

# --- Stage 2: runtime ---
FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml* ./
COPY --from=build /app/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --filter @capere/backend --prod --config.confirmModulesPurge=false

COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/supabase/migrations ./supabase/migrations

EXPOSE 3000

# Override with "start:worker" for the worker process
CMD ["pnpm", "--filter", "@capere/backend", "start"]
