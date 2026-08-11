# Context benchmark summary

Model: `opencode-go/deepseek-v4-flash` — usage multiplier 2x on reported tokens.
Thinking: `default` (fixed task condition, identical across all arms).
Cost = true API pricing: input cache-miss $0.14/1M, cache-hit $0.0028/1M (98% off), output $0.28/1M, no cache-write fee. Computed from provider raw tokens.
Token and cost figures below are already multiplied. Token totals are provider-reported via `step_finish`.

| metric | cold | context |
| --- | --- | --- |
| verified success rate | 0.75 | 1.00 |
| first-relevant recall | 1.00 | 1.00 |
| time to first relevant (ms, median) | 11583.5 | 1271 |
| time to first edit (ms, median) | 28651.5 | 12192 |
| exploration calls before first edit (median) | 7 | 4 |
| input tokens before first relevant (median) | 25595 | 0 |
| total input tokens (median) | 340418 | 176329 |
| cache hit % (median) | 92.3 | 84.9 |
| total tokens (median) | 343622 | 178386 |
| cost USD (sum) | 0.0220 | 0.0186 |

## Net savings vs cold (per task, median)

```text
gross_savings = cold_input - assisted_input
net_savings   = gross_savings - capsule_tokens - added_tool_output
net_pct       = net_savings / cold_input
```

### sess-ts
- gross_input_savings: 93326 (41.6%)
- net_savings (after capsule): 92956 (41.5%)
- exploration calls saved: 2.5
- success preserved: yes

### sess-go
- gross_input_savings: 245824 (50.6%)
- net_savings (after capsule): 245516 (50.5%)
- exploration calls saved: 4.5
- success preserved: yes

Run details in `results.csv`; transcripts in `raw/`.
Caveat: single-rep cells are diagnostic samples, not claims — the plan requires >=2 reps per arm.
