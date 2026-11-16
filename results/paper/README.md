# Results reported in the paper

## LLM use cases (Tables 4, 5 and 6)

The raw logs of the LLM benchmark in the paper: 9 LLMs, each running the 10 use cases 5 times.
One JSON line per use case per run: `status` (pass/fail), `message` (the prompt),
`llmProvider`, `llmModel`, `durationSeconds` (the chat round trip), `timestamp`, the LLM's
`response`, the `script` it generated or ran, the `expectedTool`, the `tools` it called (in
order) and `rightTool` (whether the tools that change something are exactly the expected one).

| File | Model | Passed | Right tool | Time (s) | Cost ($) | Run date |
|---|---|---:|---:|---:|---:|---|
| `llm-openrouter-google_gemini-2.5-flash.jsonl` | gemini-2.5-flash (OpenRouter) | 49/50 | 49 | 89.9 | 0.12 | 16 Nov |
| `llm-openrouter-openai_gpt-oss-120b.jsonl` | openai/gpt-oss-120b (OpenRouter) | 47/50 | 46 | 511.2 | 0.09 | 16 Nov |
| `llm-openrouter-deepseek_deepseek-chat.jsonl` | deepseek/deepseek-chat (OpenRouter) | 46/50 | 48 | 314.4 | 0.27 | 16 Nov |
| `llm-ollama-Qwen3.8_27B.jsonl` | Qwen3.8:27B (Ollama) | 45/50 | 45 | 2335.2 | 0.06 | 13 Nov |
| `llm-ollama-glm-4.7-flash.jsonl` | glm-4.7-flash (Ollama) | 44/50 | 46 | 1578.9 | 0.04 | 13 Nov |
| `llm-ollama-qwen3_30b-instruct.jsonl` | qwen3:30b-instruct (Ollama) | 42/50 | 46 | 631.1 | 0.02 | 13 Nov |
| `llm-ollama-bonsai-2_27b.jsonl` | bonsai-2:27b (Ollama) | 41/50 | 40 | 2247.2 | 0.06 | 13 Nov |
| `llm-ollama-bonsai-2.jsonl` | bonsai-2 (9b, Ollama) | 36/50 | 30 | 803.6 | 0.02 | 13 Nov |
| `llm-ollama-devstral-small-2.jsonl` | devstral-small-2 (Ollama) | 33/50 | 34 | 1607.0 | 0.04 | 13 Nov |

`npm run summarize -- results/paper` prints the passes per use case (Table 5) and the total and
mean round trip time per model (Table 6) from these files.

**Cost.** For the OpenRouter models, the difference in the OpenRouter account's usage before
and after the run, including the 5 warm-up requests that load the model (`What is the capital
of Laos?`), which are not logged. For the local models, an indicative $0.091 per hour of
round trip time: the hardware's purchase price ($4,000) over five years of continuous use
(5 x 365 x 24 h), without electricity.

**How they were measured.** With `test/llm-usecases.test.ts`'s use cases and checks, run with
`bun:test` from the SpaceTime source (server and agent run natively, not in Docker), on a
MacBook Pro (Apple M5 Pro, 48 GB unified memory). The local models ran in Ollama 0.40.11 on
the same machine. Model parameters (paper, Table 4):

| Model | Provider | Quantization | Temperature | Top p | Top k |
|---|---|---|---:|---:|---:|
| gemini-2.5-flash, openai/gpt-oss-120b, deepseek/deepseek-chat | OpenRouter | - | 0.1 | 1 | - |
| Qwen3.8:27B, qwen3:30b-instruct | Ollama | Q4_K_M | 0.7 | 0.9 | 20 |
| glm-4.7-flash, devstral-small-2 | Ollama | Q4_K_M | 0.7 | 0.9 | 40 |
| bonsai-2:27b, bonsai-2 (9b) | Ollama | Q2_0 | 0.7 | 0.9 | 20 |

For OpenRouter the agent sets no sampling parameters, so these are the defaults of the
llamaindex OpenAI client; OpenRouter chose the provider of each request (no provider pinned).

The agent differs between the two run dates:

- **13 November** (local models): SpaceTime core commit `ec8a8e34`. Its `create_automation`
  tool states that "today", "tomorrow" or a date means a one-off automation, so the LLM should
  not ask whether it is once or every day.
- **16 November** (OpenRouter models): commit `e01ebf4a`, which adds two changes to the agent.
  A tool call to a name that is not a tool (e.g. `Entity.filter`, a script function) is
  answered with an error the LLM can recover from, instead of ending the request. And a
  request stops after 20 LLM steps (`AGENT_MAX_STEPS`), which no passing request came near.

**Data.** The use cases act on the demo data (`npm run seed -- --demo`). bonsai-2 and
bonsai-2:27b ran while the 21,111 campus entities of the lamp benchmark were also loaded: the
lookups of "all lamps" then return 10,006 lamps. The other models ran on the demo data alone.

**Notes on the logs.**

- Qwen3.8:27B and qwen3:30b-instruct: the *Turn off all pumps* lines are a rerun of that use
  case alone (5 times each). In the full runs it failed every time, because an earlier run of
  another model had left an automation named *Turn off all pumps* behind, which the test
  checks against. Rerun on its own, it took Qwen3.8:27B about 13 s instead of about 33 s.
- A failure logged with 0 s and no tools is a test timeout: no response arrived.

**Reproducing them.** Run the agent from those commits, or from a release that includes them.
LLM output varies between runs: compare pass rates over several runs (`npm run sweep`), not
single results.

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
