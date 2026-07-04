import "dotenv/config";

const accountId = process.env.R2_ACCOUNT_ID ?? "";

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "",

  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
  embeddingDim: 1536,

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
} as const;
