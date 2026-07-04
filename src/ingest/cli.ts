import { ingestMaterial, ingestPending } from "./pipeline.js";

// Usage:
//   npm run ingest            # process all pending materials
//   npm run ingest <id>       # ingest a single material
const arg = process.argv[2];

const run =
  arg && arg !== "--pending"
    ? ingestMaterial(arg).then((r) => console.log(`ingested: ${r.chunks} chunks`))
    : ingestPending();

run
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
