# SpaceTime benchmarks

This repository holds the benchmarks reported in the paper (see [Citing](#citing)). You can
run them against your own SpaceTime installation. SpaceTime is free of charge and installs
with Docker Compose. Its source code is not published, but this repository contains everything
needed to run the benchmarks: the test code, the data they use and the raw results.

There are two benchmarks:

| Benchmark | What it measures |
|---|---|
| **LLM use cases** (`test/llm-usecases.test.ts`) | 10 natural-language commands to the SpaceTime agent, such as *"Turn on garden pump if not raining and garden moisture 30% or less"*. The test checks each command by its effect: a property is switched, or an automation is created and then run under conditions the test sets up, to show that it does the right thing. Reports pass/fail and the chat round trip time per command. |
| **Lamps** (`test/lamps.test.ts`) | Switches on 10, 100, 1,000 and 10,000 lamps of a campus of 21,111 entities from an automation, through an entity connector, to a lamp service that takes 2 s to respond (a mock, like a cloud API). It does this two ways: a loop of `Entity.set()` calls, and one `Entity.setMany()`. Reports how long until every lamp is on. |

## Requirements

- **Docker** with Compose v2 (`docker compose version`). Docker Desktop on macOS or Windows,
  or Docker Engine on Linux. Allow at least 4 GB of memory.
- **Node.js 26** or later (`node --version`). The tests use Node's own test runner and run the
  TypeScript sources directly, with no build step.
- For the LLM benchmark, an **API key** for one LLM provider (Cohere, OpenRouter, Anthropic,
  Google Gemini, Groq, DeepSeek or Cerebras), or a local [Ollama](https://ollama.com).
- Free ports on localhost: 8010 (server), 8030 (agent), 3000, 3002, 3005 and 3006 (web
  interface), and 8099 (the mock lamp service).

## 1. Install SpaceTime

```sh
git clone https://github.com/axxem/spacetime-benchmarks.git
cd spacetime-benchmarks
cp .env.example .env
```

Edit `.env`:

- `VERSION`: the SpaceTime version to install. Keep the version the paper used to reproduce
  its results.
- `LLM_PROVIDER`, plus the API key of that provider, e.g.
  ```sh
  LLM_PROVIDER=cohere
  COHERE_API_KEY=<your key>
  ```
  `LLM_MODEL` selects a model of the provider. Leave it empty to use the agent's default.

Start SpaceTime:

```sh
docker compose up -d
```

The first start downloads the images and creates the databases in `./data`. The
server is ready when this answers `{"status":"ok",...}`:

```sh
curl http://localhost:8010/health
```

The agent reports the LLM it uses:

```sh
curl http://localhost:8030/
# {"status":"ok","provider":"cohere","model":"...","entity":"entity"}
```

The web interface is at http://localhost:3000.

## 2. Install the test dependencies and load the test data

```sh
npm ci
npm run seed
```

`npm run seed` loads two datasets:

- the **demo data**: a small office building with lamps, pumps, sensors and weather, which the
  LLM use cases act on (resets those entities)
- the **campus** for the lamp benchmark: 10 buildings × 10 floors × 10 areas × 10 rooms, with
  one lamp per room (replaces a previous campus)

It is safe to run again. `npm run seed -- --demo` or `-- --campus` loads only one of them.

## 3. Run the benchmarks

```sh
npm run test:lamps     # about 1-2 minutes
npm run test:llm       # about 3-5 minutes, makes 10 requests to the LLM
```

Each run prints its results and appends them to `results/local/`:

- `lamps.jsonl` and `llm-<provider>-<model>.jsonl`: one JSON line per test
- `environment-<run>.json`: the machine, Node and Docker versions, and the image digests of the
  installation the run measured

LLM output varies from run to run, so judge an LLM by its pass rate over several runs.
`npm run sweep` runs the LLM benchmark 5 times (`REPEAT=10 npm run sweep` for 10). To compare
several LLMs, list them; the agent is restarted with each one:

```sh
COMBOS="cohere,openrouter:cohere/command-a-plus,ollama:qwen3:30b-instruct" npm run sweep
```

To change the LLM by hand, edit `.env` and run `docker compose up -d agent`.

## 4. Compare with the paper

```sh
npm run summarize                              # your results (results/local)
npm run summarize -- results/paper results/local   # the paper's next to yours
```

This prints Markdown tables: the pass rate and median round trip per LLM and command, and the
median times per mode and number of lamps.

### What to expect

- **LLM**: pass rates depend on the model and vary between runs. The round trip times depend
  mostly on the provider's response times, not on your machine.
- **Lamps**: the times have a floor of the lamp service's 2 s response time. Above that, they
  depend on your CPU and on Docker's networking. On macOS and Windows, Docker runs in a virtual
  machine, and connections from the container to the mock lamp service on your machine go
  through it. The server sends at most 2,000 commands to one connector at a time (to stay
  within what cloud APIs accept), so 10,000 lamps take at least 5 rounds of 2 s.
- Settings in `.env`: `MOCK_LATENCY_MS` changes the lamp service's response time.
  `LAMP_MAX_CONCURRENCY` changes the cap of 2,000 (`0` means no cap). Without a cap, thousands
  of connections open at once. On macOS, raise the queue of pending connections first:
  `sudo sysctl -w kern.ipc.somaxconn=16384`. Results record the settings they ran with.

## Troubleshooting

- **`campus lamps expected, found 0`** or **`demo entity 'Garden pump' not found`**: run
  `npm run seed`.
- **`the server can't reach the mock lamp service`**: the server container calls the mock at
  `http://host.docker.internal:8099`. Check that a firewall allows incoming connections to
  Node on port 8099. On Linux, `host.docker.internal` is set up by `extra_hosts` in
  `docker-compose.yml`. If your setup differs, set `MOCK_HOST` to an address of your machine
  that the containers can reach.
- **The agent doesn't answer, or LLM tests fail at once**: check `docker compose logs agent`.
  A missing or wrong API key shows there.
- **Rate limits**: for providers with a per-minute limit, the tests send at most `RATE_LIMIT`
  (default 15) requests per minute.

## Removing SpaceTime

```sh
docker compose down
rm -rf data          # the databases
```

## Repository layout

```
docker-compose.yml     SpaceTime on one machine (no reverse proxy; databases not exposed)
.env.example           settings for docker compose and the tests
test/                  the benchmarks (node:test)
lib/                   HTTP client, campus dataset, mock lamp service, result recording
scripts/               seed, sweep, summarize
results/paper/         the results reported in the paper (see its README)
results/local/         your results (not committed)
```

The tests talk to SpaceTime only through its HTTP API (`SERVER_URL`, `AGENT_URL`), so they can
also run against an installation on another machine.

## Citing

> <authors>, <title>, <journal/conference>, <year>. DOI: <doi>

## License

The code in this repository is MIT licensed (see [LICENSE](LICENSE)). The license does not
cover the SpaceTime software itself, which is available free of charge as Docker images
(spacetimehub/*).
