# صورة واحدة: الخادم ومعه لوحة الإدارة المبنيّة.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile
COPY apps apps
RUN pnpm --filter @eywaa/api build && pnpm --filter @eywaa/admin build
RUN pnpm --filter @eywaa/api deploy --prod --legacy /out/api \
 && cp -r apps/api/dist apps/api/migrations /out/api/ && cp -r apps/admin/dist /out/admin

FROM node:22-bookworm-slim
ENV NODE_ENV=production ADMIN_DIST=/app/admin STORAGE_DIR=/data/storage PORT=3000
WORKDIR /app/api
COPY --from=build /out/api ./
COPY --from=build /out/admin /app/admin
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 3000
# الترحيلات تُطبَّق عند كل إقلاع قبل أن يستقبل الخادم طلباً.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/main.js"]
