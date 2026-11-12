# Results reported in the paper

The raw results of the measurements in the paper, made with this repository against SpaceTime
`<VERSION>` (see the `environment-*.json` files for the exact image digests, machine and
settings):

- `llm-<provider>-<model>.jsonl`: LLM use cases, one line per command per run
- `lamps.jsonl`: lamp benchmark, one line per mode and number of lamps per run

`npm run summarize -- results/paper` prints the tables in the paper from these files.
