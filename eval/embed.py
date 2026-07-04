"""OpenAI embeddings for the eval harness (mirrors the agent's embed model)."""
import os

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
MODEL = os.environ.get("EMBEDDING_MODEL", "text-embedding-3-small")


def embed(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    res = _client.embeddings.create(model=MODEL, input=texts)
    return [d.embedding for d in res.data]
