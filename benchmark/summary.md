# Context benchmark summary

Model: `opencode-go/deepseek-v4-flash` — usage multiplier 2x (deepseek-v4-flash billing).
Token and cost figures below are already multiplied. Token totals are provider-reported via `step_finish`.

| metric | cold | context |
| --- | --- | --- |
| verified success rate | 1.00 | 1.00 |
| first-relevant recall | 1.00 | 1.00 |
| time to first relevant (ms, median) | 11747 | 1173 |
| time to first edit (ms, median) | 36056 | 12933 |
| exploration calls before first edit (median) | 7 | 2 |
| input tokens before first relevant (median) | - | - |
| total input tokens (median) | 26198 | 26612 |
| total tokens (median) | 536328 | 363972 |
| cost USD (sum) | 0.0035 | 0.0030 |

## Net savings vs cold (per task, median)

```text
gross_savings = cold_input - assisted_input
net_savings   = gross_savings - capsule_tokens - added_tool_output
net_pct       = net_savings / cold_input
```

### sess-go
- gross_input_savings: -414 (-1.6%)
- net_savings (after capsule): -722 (-2.8%)
- exploration calls saved: 5
- success preserved: yes

Run details in `results.csv`; transcripts in `raw/`.
Caveat: single-rep cells are diagnostic samples, not claims — the plan requires >=2 reps per arm.
