import "dotenv/config";

const accountId = process.env.R2_ACCOUNT_ID ?? "";

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "",

  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
  embeddingDim: 1536,
  chatModel: process.env.CHAT_MODEL ?? "gpt-4o-mini",

  // Agent HTTP server
  port: Number(process.env.PORT ?? 2024),
  internalSecret: process.env.INTERNAL_JWT_SECRET ?? "",

  // R2 (S3-compatible). Accept an explicit endpoint or derive it from the account id.
  r2: {
    endpoint:
      process.env.R2_ENDPOINT ??
      (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : ""),
    region: process.env.R2_REGION ?? "auto",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: process.env.R2_BUCKET ?? "",
  },

  chunk: {
    targetTokens: Number(process.env.CHUNK_TARGET_TOKENS ?? 500),
    overlapTokens: Number(process.env.CHUNK_OVERLAP_TOKENS ?? 50),
  },

  // Error tracking (Sentry). Empty DSN = no-op (e.g. local dev).
  // appEnv distinguishes production/perf (NODE_ENV is "production" on both
  // Railway envs); RAILWAY_ENVIRONMENT_NAME is Railway's auto-injected value.
  sentryDsn: process.env.SENTRY_DSN ?? "",
  appEnv: process.env.APP_ENV ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? "development",
} as const;
