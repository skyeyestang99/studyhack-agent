# StudyHack — Agent Server (backend)

The persistent backend service for StudyHack: the **LangGraph agent + retrieval layer**, deployed on **Railway**.

> In the split architecture (design Doc 1 §3.2), the Next.js **API routes** live in the *frontend* repo (on Vercel); **this** repo is the stateful agent server that Vercel proxies to. Keeping it separate is intentional — it's a long-running process with in-memory tool-call state, which is why it can't be serverless.

## Status
🚧 Scaffolding. **Runtime not yet chosen** — first decision before any code:
- **LangGraph.js (Node/TS)** — one language across the whole stack (frontend is Next.js/TS); simpler hiring/context-switching.
- **LangGraph (Python)** — richer LangChain/LangGraph + LlamaIndex ecosystem, most examples/docs.

(Recommendation: default to whichever the team is faster in; the agent logic is small enough that ecosystem maturity (Python) only matters if we hit gaps.)

## Responsibilities (design Doc 3)
- `loadMaterialsMiddleware` — deterministic scope resolution → pgvector search → load full parsed Markdown into `state.files`
- LangGraph agent — `ls`/`grep`/`read_file` tools, Approach→Solution→Key-Takeaways prompt, grounding guardrail
- SSE streaming back to Vercel; conversation checkpoints via `PostgresSaver`
- LangSmith tracing
- Verifies the internal JWT minted by Vercel (Doc 2 §6.2)

## Environment
See `.env.example`. All secrets are server-side only.

## Related
- Design docs (HLD + 2 LLDs) live in the app repo: `skyeyestang99/StudyAiApplication`
- Frontend + Next.js API routes: same app repo (`frontend/`)
