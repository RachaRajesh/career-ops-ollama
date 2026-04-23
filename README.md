# Career-Ops (Ollama Edition)

A local-first fork of [santifer/career-ops](https://github.com/santifer/career-ops) that swaps Claude Code for **local LLMs via Ollama**, with an optional [openclaude](https://github.com/Gitlawb/openclaude) provider, an **interactive menu**, a **multi-link batch pipeline**, and a **human-in-the-loop auto-apply** feature.

Everything runs on your machine. No API keys required, no data leaving your laptop.

---

## Forked from

This project stands on the shoulders of two open-source projects. If you find this fork useful, star the upstream repos:

- **[santifer/career-ops](https://github.com/santifer/career-ops)** — the original job search system. The evaluation rubric, PDF template, mode prompts, Go dashboard, and general architecture are Santiago's work. This fork swaps the LLM backend and adds a few features; the hard thinking about *how* to evaluate jobs is all his.
- **[Gitlawb/openclaude](https://github.com/Gitlawb/openclaude)** — optional provider. Coding-agent CLI that routes to 200+ models through an OpenAI-compatible API. Used here as an alternate LLM backend when you want unified provider routing.

MIT License, inherited from upstream.

---

## What's different from upstream

| Feature | Upstream | This fork |
|---|---|---|
| LLM backend | Claude Code / Gemini CLI / OpenCode | **Ollama (default)** or **openclaude** (opt-in) |
| Entry point | Slash commands (`/career-ops ...`) | **`npm start` → interactive menu** |
| Multi-link workflow | Batch parallel workers | **Interactive batch pipeline** — paste URLs, filter by score, pick winners |
| Gap analysis | Part of evaluation | **Dedicated step** — flags JD requirements your CV doesn't show |
| Auto-apply | Not included (explicit non-goal upstream) | **Included, human-review required before submit** |

---

## Quick start

```bash
# 1. Install Ollama
# macOS:   brew install ollama
# Linux:   curl -fsSL https://ollama.com/install.sh | sh
# Windows: https://ollama.com/download

# 2. Start the Ollama server (runs on :11434)
brew services start ollama          # macOS — runs as a service
# or: ollama serve                  # any OS — blocks the terminal

# 3. Pull a model (see "Choosing a model" below)
ollama pull qwen2.5:14b

# 4. Install this project
cd career-ops-ollama
npm install
npx playwright install chromium

# 5. Configure
cp .env.example .env                           # edit: set OLLAMA_MODEL
cp config/profile.example.yml config/profile.yml
cp examples/cv.example.md cv.md                # ⚠ see "The CV file gotcha" below

# 6. Launch the interactive menu
npm start
```

---

## The menu

`npm start` opens this:

```
  ╔══════════════════════════════════════════════╗
  ║        CAREER-OPS · Ollama Edition           ║
  ║        local-LLM job search toolkit          ║
  ╚══════════════════════════════════════════════╝

  Setup:
    ✓ Ollama configured
    ✓ Your CV (cv.md)
    ✓ Profile
    ✓ .env file
    model: qwen2.5:14b

  What would you like to do?

   [1]  Evaluate ONE job (single link)       Paste one URL, file, or JD text → scored report
   [2]  Batch pipeline (MULTIPLE links)      Paste N URLs → filter by score → PDF + apply picks
   [3]  Batch-evaluate a folder              Run every .txt/.md in ./jds through the evaluator
   [4]  Scan job portals                     Crawl configured companies for new listings
   [5]  Generate tailored PDF                Turn an existing report into an ATS-optimized CV
   [6]  Auto-fill one application            Open browser, fill form, you review + submit
   [7]  View tracker (your pipeline)         Pretty-print every job you've evaluated
   [8]  Run setup check (doctor)             Verify everything is configured
   [9]  Help — what does this do?            Quick intro for first-time users
   [q]  Quit
```

Pick a number, answer the prompts, done.

---

## Option 1 vs Option 2 — which to use when

**Option 1 — single link**: You have one specific job you want to evaluate. Paste the URL, get a report, optionally generate a PDF separately from option 5.

**Option 2 — batch pipeline**: You have a list of jobs and want to triage them:

```
1. Paste N URLs (one per line, empty line when done)

2. Add any notes (e.g. "skip Meta, I already applied")

3. STAGE 1 — Script evaluates all N jobs, shows a scoreboard:

      #   Company       Role                           Score  Verdict
      ─── ───────────── ──────────────────────────────  ─────  ───────
       1  Anthropic     Applied AI Engineer             4.7    strong
       2  Retool        Senior ML Platform Engineer     4.3    apply
       3  Langfuse      Founding Engineer (AI)          4.1    apply
       4  Gong          Senior Data Scientist           3.6    maybe
       5  Meta          ML Infra (L5)                   2.8    skip

4. STAGE 2 — You pick which ones to take forward:
      [a] All of them
      [t] Top scorers only (≥ 4.0)     ← typical choice
      [p] Premium scorers only (≥ 4.5)
      [m] Manual pick — I give row numbers like "1,3" or "1-3"

5. STAGE 3 — For each picked job:
      → Gap analysis        (flags JD requirements not in your CV)
      → Continue?            (c = proceed, s = skip this job, q = quit)
      → Tailored PDF
      → Continue?
      → Auto-fill application (new browser window per job)
      → Continue?
      → next job
```

---

## Choosing a model

For this task (JD evaluation, resume tailoring, form-filling — all structured-output work):

| Model | Memory | Best for |
|---|---|---|
| `qwen2.5:32b` | ~20 GB | M2 Pro / M3 Max / M4 Pro with 32GB+ RAM. Best quality. |
| `qwen2.5:14b` | ~9 GB | The sweet spot — great JSON reliability, fast enough on most Macs |
| `qwen2.5:7b` | ~5 GB | 16GB RAM machines, still decent |
| `llama3.1:8b` | ~5 GB | Fallback if Qwen doesn't work for you |
| `deepseek-r1:14b` | ~9 GB | Reasoning-strong but chain-of-thought can bloat JSON |

**Skip:** uncensored/heretic fine-tunes. They regress on JSON formatting, which this pipeline depends on heavily.

Set your choice in `.env`:

```bash
OLLAMA_MODEL=qwen2.5:14b
OLLAMA_NUM_CTX=32768          # lets the model hold full CV + JD + profile
OLLAMA_TIMEOUT_MS=300000      # 5 min — generous for big models
```

---

## LLM providers — Ollama (default) or openclaude (optional)

Career-ops supports two LLM backends:

**`LLM_PROVIDER=ollama`** (default) — talks directly to your local Ollama server. Reliable, fast, what this project was built around. Recommended unless you have a specific reason to switch.

**`LLM_PROVIDER=openclaude`** (optional) — routes through [openclaude's](https://github.com/Gitlawb/openclaude) OpenAI-compatible API. Useful if you're already using openclaude for other workflows and want unified provider routing across Ollama, OpenAI, DeepSeek, Gemini, and 200+ others.

Switching is one env var change. Full setup guide in [docs/OPENCLAUDE.md](docs/OPENCLAUDE.md). Honest tradeoffs covered there — openclaude has open bugs around tool-calling with local Ollama that don't affect career-ops' current flows but are worth knowing about.

You can also mix per-command:

```bash
LLM_PROVIDER=openclaude npm run evaluate -- --url https://...
LLM_PROVIDER=ollama     npm run apply    -- --url https://...
```

---

## The CV file gotcha — READ THIS

The #1 first-run bug is the **Jane Doe bug** — your tailored PDFs come out with Jane Doe's info instead of yours.

The project reads your resume from a file named **`cv.md`** — not `cv.example.md`, not `resume.md`. Exactly `cv.md` in the project root.

```bash
# copy the template
cp examples/cv.example.md cv.md

# open cv.md and replace EVERYTHING with your real resume
nano cv.md          # or: code cv.md, vim cv.md, open -a TextEdit cv.md

# verify — the first line should be YOUR name, not "Jane Doe":
head -3 cv.md
```

The menu's setup status will show a red warning if it detects the Jane Doe example is still there, but it's better to fix it now.

---

## Commands (if you prefer the terminal directly)

```bash
npm start                               # interactive menu (recommended)
npm run doctor                          # environment checks
npm run evaluate -- "JD text..."        # evaluate one job (paste JD)
npm run evaluate -- --file path/to.txt  # evaluate one job (from file)
npm run evaluate -- --url https://...   # evaluate one job (scrape URL)
npm run pdf -- --report reports/X.md    # generate ATS PDF from a report
npm run scan                            # scan configured portals
npm run batch -- --dir ./jds            # batch-evaluate every file in a dir
npm run tracker                         # print the tracker TSV
npm run apply -- --url https://...      # auto-fill form, pause for review
node scripts/pipeline.mjs               # multi-link pipeline (same as menu option 2)
```

---

## Configuration

All knobs live in `.env`. The important ones:

```bash
LLM_PROVIDER=ollama                  # or "openclaude" — see docs/OPENCLAUDE.md
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen2.5:14b
OLLAMA_TIMEOUT_MS=300000
OLLAMA_TEMPERATURE=0.3
OLLAMA_NUM_CTX=32768
AUTO_APPLY_HEADLESS=false            # keep false so you can watch the browser
AUTO_APPLY_REQUIRE_CONFIRM=true      # script never clicks submit regardless
```

See `.env.example` for the full list with comments.

---

## Auto-apply: how it actually works

1. You run the pipeline (option 2) or option 6
2. Playwright opens the page in a **visible** browser window (new window per job in batch mode)
3. The script walks the form DOM, extracts every field + label
4. Your local LLM proposes answers for each field, drawing on `cv.md` and `config/profile.yml`
5. The script fills the fields (you can watch it happen)
6. **The script stops.** It prints a summary of what it filled, flags anything it was unsure about (salary, work authorization, EEO questions), and waits for you.
7. You review, fix anything wrong, then **you click Submit** yourself.

The script will never click Submit on your behalf. This is hard-coded.

See `docs/AUTO_APPLY.md` for the full safety model.

### A note on "add points in resume if I don't have it"

The PDF generator rewords, reorders, and surfaces what's already in your CV. It does **not** invent experience you don't have. Instead, the pipeline runs a **gap analysis** step that flags JD requirements your CV doesn't clearly show, labeled `probably have it` / `learnable` / `real gap`. You decide what's real for you and update `cv.md` manually.

Why not auto-fabricate: resume fraud fails background checks, gets offers rescinded, and on F-1 OPT / STEM OPT can jeopardize your visa. The tool stays honest by design.

---

## Legal / ToS caveats

- Most major ATS platforms (Greenhouse, Lever, Workday, LinkedIn) prohibit **fully automated submission**. Human-reviewed auto-fill is grayer — you're the one submitting — but treat this as "use at your own risk."
- Don't batch-submit. Don't spray-and-pray. The filter is the point.
- **Don't point this at LinkedIn.** LinkedIn actively detects automation and will suspend accounts.
- The evaluation pipeline strongly recommends skipping anything scoring below 4.0 / 5.

---

## Docs index

- [`docs/SETUP.md`](docs/SETUP.md) — step-by-step install
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pieces fit together
- [`docs/AUTO_APPLY.md`](docs/AUTO_APPLY.md) — the auto-apply safety model in detail
- [`docs/OPENCLAUDE.md`](docs/OPENCLAUDE.md) — using openclaude as the LLM provider

---

## Credits

- **[santifer/career-ops](https://github.com/santifer/career-ops)** — Santiago Fernández's original project. The evaluation framework, 6-block rubric, PDF template design, mode prompts, and Go dashboard are his. Go star it.
- **[Gitlawb/openclaude](https://github.com/Gitlawb/openclaude)** — optional LLM provider.
- This fork — LLM backend swap, provider-switching dispatcher, interactive menu, multi-link pipeline, gap analyzer, auto-apply helper.

MIT License, same as upstream.
