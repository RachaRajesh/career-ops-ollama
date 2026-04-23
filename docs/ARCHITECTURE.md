# Architecture & customization

## How the pieces fit together

```
┌──────────────────────────────────────────────────────────────┐
│  Your inputs                                                 │
│  • cv.md                      ← your resume in markdown      │
│  • config/profile.yml         ← preferences, auth, salary    │
│  • modes/*.md                 ← evaluation prompts           │
└─────┬────────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│  scripts/lib/ollama.mjs       ← single source of LLM calls   │
│  (swap this one file to change providers)                    │
└─────┬────────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│  Commands (each calls ollama.mjs)                            │
│  • evaluate.mjs   — JD → report + tracker row                │
│  • batch.mjs      — evaluate many JDs in parallel            │
│  • scan.mjs       — crawl portals for new JDs                │
│  • generate-pdf.mjs — tailor CV for a report, render PDF     │
│  • tracker.mjs    — pretty-print the pipeline                │
│  • apply.mjs      — fill application forms (human submits)   │
│  • doctor.mjs     — sanity checks                            │
└─────┬────────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│  Outputs                                                     │
│  • reports/*.md   ← the 6-block evaluation                   │
│  • output/*.pdf   ← tailored CVs                             │
│  • data/tracker.tsv ← the master pipeline file               │
└──────────────────────────────────────────────────────────────┘
```

## Customizing the evaluation

**Want stricter scoring?** Edit `modes/_shared.md`. The cutoff, the rubric,
and the archetype list are all there.

**Want a different archetype set?** If you're not going after AI roles, the
archetypes in `_shared.md` will be wrong. Rewrite the list — backend
engineering, data engineering, whatever. The evaluator will adapt.

**Want to weight things differently?** `config/profile.yml` → `scoring_weights`.
The evaluator reads the profile as part of the prompt, so it'll honor custom
weights. Don't expect hard-math precision from a local LLM, though — treat
weights as directional.

## Swapping the LLM provider

Everything LLM-related lives in `scripts/lib/ollama.mjs`. If you wanted to
replace Ollama with, say, a local llama.cpp server, LM Studio, or even a
hosted API, you'd:

1. Change the `fetch` URL and request body format in `chat()`
2. Update the response parsing (different APIs return different shapes)
3. Keep the exported `chat`, `chatJSON`, `listModels`, `ping` signatures

Nothing else in the codebase cares.

## Why not stream responses?

We use `stream: false` on every request. For evaluations this makes things
simpler: one request, one response, parse, done. For an interactive chat UI
you'd stream; for a batch pipeline there's no point.

## Why JSON output for evaluations?

Ollama's `format: "json"` parameter is the biggest reliability win you get
from local models. It forces the model into grammar-constrained decoding —
the output is guaranteed to parse. Without it, a small model will often wrap
JSON in markdown fences, add commentary, or produce invalid JSON. Even with
it, `chatJSON()` has a retry path for models that ignore the flag.

## Why no retrieval over your past applications?

Upstream has more sophisticated deduplication + pattern analysis scripts
(`dedup-tracker.mjs`, `analyze-patterns.mjs`). This fork keeps just the
tracker TSV append. If you want those analytics, port them over — they don't
touch the LLM at all, so they work as-is.

## Why no Go dashboard in this fork?

The Go Bubble Tea dashboard in upstream (`dashboard/`) is entirely
provider-agnostic — it reads the TSV, not the LLM. You can drop it into this
fork unchanged. `npm run tracker` is the text-mode stand-in for people who
don't want to install Go.
