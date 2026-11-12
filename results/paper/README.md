# Results reported in the paper

## LLM use cases (Tables 5 and 6)

The raw logs of the LLM benchmark in the paper: 10 LLMs, each running the 10 use cases 5 times,
from 28 October to 2 November 2026. One JSON line per use case per run: `status` (pass/fail),
`message` (the prompt), `llmProvider`, `llmModel`, `durationSeconds` (the chat round trip),
`timestamp`, the LLM's `response`, and the `script` it generated or ran.

| File | Model | Runs | Passed | Run date |
|---|---|---:|---:|---|
| `llm-gemini-gemini-2.5-flash.jsonl` | gemini-2.5-flash (Google) | 5 | 48/50 | 28 Oct |
| `llm-openrouter-cohere_command-a-plus.jsonl` | cohere/command-a-plus (OpenRouter) | 5 | 46/50 | 2 Nov |
| `llm-openrouter-deepseek_deepseek-chat.jsonl` | deepseek/deepseek-chat (OpenRouter) | 5 | 46/50 | 29 Oct |
| `llm-ollama-Qwen3.8_27B.jsonl` | Qwen3.8:27B (Ollama) | 5 | 45/50 | 28 Oct |
| `llm-ollama-qwen3_30b-instruct.jsonl` | qwen3:30b-instruct (Ollama) | 5 | 45/50 | 28 Oct |
| `llm-ollama-glm-4.7-flash.jsonl` | glm-4.7-flash (Ollama) | 5 | 45/50 | 28 Oct |
| `llm-ollama-bonsai-2_27b.jsonl` | bonsai-2:27b (Ollama) | 5 | 42/50 | 29 Oct |
| `llm-ollama-devstral-small-2.jsonl` | devstral-small-2 (Ollama) | 5 | 37/50 | 29 Oct |
| `llm-ollama-bonsai-2.jsonl` | bonsai-2 (Ollama) | 5 | 33/50 | 28 Oct |
| `llm-ollama-mistral-small3.2_24b.jsonl` | mistral-small3.2:24b (Ollama) | 5 | 30/50 | 29 Oct |

`npm run summarize -- results/paper` prints the passes per use case (Table 5) and the total and
mean round trip time per model (Table 6) from these files.

**How they were measured.** With the use case test suite that `test/llm-usecases.test.ts` was
ported from: the same prompts and checks, run with `bun:test` against the development version of
SpaceTime that preceded release 1.5.0 (server and agent run from source, git commit `6ff41ae4`),
on a MacBook Pro (Apple M5 Pro, 48 GB unified memory). The local models ran in Ollama 0.40.11
on the same machine. Model parameters (paper, Table 4):

| Model | Provider | Quantization | Temperature | Top p | Top k |
|---|---|---|---:|---:|---:|
| gemini-2.5-flash | Google | - | 0.1 | 1 | - |
| cohere/command-a-plus, deepseek/deepseek-chat | OpenRouter | - | 0.1 | 1 | - |
| Qwen3.8:27B, qwen3:30b-instruct | Ollama | Q4_K_M | 0.7 | 0.9 | 20 |
| glm-4.7-flash, devstral-small-2 | Ollama | Q4_K_M | 0.7 | 0.9 | 40 |
| bonsai-2:27b, bonsai-2 (9b) | Ollama | Q2_0 | 0.7 | 0.9 | 20 |

**Reproducing them.** No Docker image of that development version was released; release 1.5.0
is the first one that contains it (the earlier 1.4.0 image on Docker Hub is from June 2026 and
much older). Between the benchmark runs and 1.5.0, the agent's system prompt and the tools and
tool descriptions presented to the LLM are unchanged. What changed is how the server stores and
runs the generated automations (moved from MongoDB to Postgres) and the agent's document store,
which these use cases don't use. A run against 1.5.0 therefore gives the LLMs the same input,
but LLM output varies between runs: compare pass rates over several runs (`npm run sweep`), not
single results.

These logs have no `runId`: each run wrote one line per use case, in order. In the
devstral-small-2 log, line 28 is the 3rd run of *Turn off all pumps*, which failed before its
chat request was sent (0 s, no response). That version of the test logged it under the next
prompt, *Turn off all lamps in the office building*. The data is left as recorded, so summarize
shows 4 and 6 results for those two prompts.

## Lamps (Table 7)

| Lamps | Filter | Script A (loop) | Peak concurrency | Script B (setMany) | Peak concurrency |
|---:|---:|---:|---:|---:|---:|
| 10 | 93 ms | 2.2 s | 10 | 2.3 s | 10 |
| 100 | 93 ms | 2.4 s | 100 | 2.2 s | 100 |
| 1,000 | 109 ms | 3.2 s | 1,000 | 2.4 s | 1,000 |
| 10,000 | 297 ms | 11.8 s | 2,262 | 3.6 s | 10,000 |

Transcribed from the paper: no raw log was kept of these runs. They were measured with the
development version that became release 1.5.0 (`setMany` is new in it), the server running
natively (Node.js 26.7, Postgres 18) on the same MacBook Pro, with the mock lamp
service (2 s latency) in the test's own process and macOS `kern.ipc.somaxconn` raised to 16384.
Script B ran without a cap on concurrent commands (`maxConcurrency` -1).

`test/lamps.test.ts` measures the same two scripts through the HTTP API against a Docker
install. Unless `LAMP_MAX_CONCURRENCY` is set, the server's default cap of 2,000 commands in
flight applies, so setMany on 10,000 lamps takes about 5 rounds of 2 s. The Docker network
adds to all times. See *What to expect* in the main README.
