# Context benchmark summary

Model: `opencode-go/deepseek-v4-flash` — usage multiplier 2x (deepseek-v4-flash billing).
Token and cost figures below are already multiplied. Token totals are provider-reported via `step_finish`.

| metric | cold | context |
| --- | --- | --- |
| verified success rate | 0.75 | 0.00 |
| first-relevant recall | 1.00 | 0.25 |
| time to first relevant (ms, median) | 11583.5 | 0 |
| time to first edit (ms, median) | 28651.5 | 0 |
| exploration calls before first edit (median) | 7 | 0 |
| input tokens before first relevant (median) | - | - |
| total input tokens (median) | 25282 | 0 |
| total tokens (median) | 343622 | 0 |
| cost USD (sum) | 0.0115 | 0.0027 |

## Net savings vs cold (per task, median)

```text
gross_savings = cold_input - assisted_input
net_savings   = gross_savings - capsule_tokens - added_tool_output
net_pct       = net_savings / cold_input
```

### sess-ts
- gross_input_savings: 25159 (100.0%)
- net_savings (after capsule): 24789 (98.5%)
- exploration calls saved: 6.5
- success preserved: yes

### sess-go
- gross_input_savings: 13352 (50.8%)
- net_savings (after capsule): 13044 (49.7%)
- exploration calls saved: 5.5
- success preserved: yes

Run details in `results.csv`; transcripts in `raw/`.
Caveat: single-rep cells are diagnostic samples, not claims — the plan requires >=2 reps per arm.
