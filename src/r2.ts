import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { config } from "./config.js";

function assertR2Configured() {
  if (
    !config.r2.endpoint ||
    !config.r2.accessKeyId ||
    !config.r2.secretAccessKey ||
    !config.r2.bucket
  ) {
    throw new Error("R2 is not configured. Set R2_ACCOUNT_ID or R2_ENDPOINT, plus R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET.");
  }
}

const s3 = new S3Client({
  region: config.r2.region,
  endpoint: config.r2.endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
});

/** Read a stored object's bytes by its R2 key. */
export async function getObjectBytes(key: string): Promise<Buffer> {
  assertR2Configured();
  const res = await s3.send(new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}
