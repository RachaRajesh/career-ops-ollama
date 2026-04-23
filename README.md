# Career-Ops (Ollama Edition)

A fork of [santifer/career-ops](https://github.com/santifer/career-ops) that swaps Claude Code for **local LLMs via Ollama**, adds an **interactive menu**, a **multi-link batch pipeline**, and a **human-in-the-loop auto-apply** feature.

Everything runs on your machine. No API keys, no data leaving your laptop.

---

## ⚠️ READ THIS FIRST — the `cv.md` gotcha

The most common first-run bug is the **Jane Doe bug** — your tailored PDFs come out with Jane Doe's information instead of yours. Here's how to avoid it:

1. The project reads your resume from a file named **`cv.md`** — not `cv.example.md`, not `resume.md`, not `my-cv.md`. Exactly `cv.md` in the project root.
2. There's an example file at `examples/cv.example.md` to show you the expected shape.
3. You need to **create `cv.md` with YOUR real content** — don't just copy the example over and leave it.

Exact commands:

```bash
# copy the shape/template
cp examples/cv.example.md cv.md

# NOW open cv.md and replace EVERYTHING with your actual resume content
nano cv.md          # or: code cv.md, vim cv.md, open -a TextEdit cv.md

# verify — the first line should be YOUR name, not "Jane Doe":
head -3 cv.md
```

If `head -3 cv.md` prints "Jane Doe", the menu will catch it and show a red warning in the setup status — but better to fix it now. **Do not proceed until `cv.md` shows your real name.**

---

## What's different from upstream

| Feature | Upstream | This fork |
|---|---|---|
| LLM backend | Claude Code / Gemini CLI / OpenCode | **Ollama (local)** — any model you pull |
| Entry point | Slash commands (`/career-ops ...`) | **`npm start` → interactive menu** |
| Multi-link workflow | Batch mode, parallel workers | **Interactive batch pipeline** — paste URLs, filter by score, pick winners |
| Evaluation pipeline | Claude reads `modes/*.md` | Ollama reads the same `modes/*.md` |
| Gap analysis | Part of evaluation | **Dedicated step** — flags JD requirements your CV doesn't show |
| Auto-apply | Not included (explicit non-goal upstream) | **Included, human-review required before submit** |

---

## Quick start

```bash
# 1. Install Ollama
# macOS:   brew install ollama
# Linux:   curl -fsSL https://ollama.com/install.sh | sh
# Windows: https://ollama.com/download

# 2. Start the Ollama server (runs in background on :11434)
brew services start ollama          # macOS — starts as a service
# or: ollama serve                  # any OS — blocks the terminal

# 3. Pull a model — see "Choosing a model" below
ollama pull qwen2.5:14b

# 4. Install this project
cd career-ops-ollama
npm install
npx playwright install chromium

# 5. Configure
cp .env.example .env
cp config/profile.example.yml config/profile.yml

# 6. Create cv.md — see the warning at the top of this README
cp examples/cv.example.md cv.md
nano cv.md                          # replace with YOUR real CV
head -3 cv.md                       # verify it's your name, not Jane Doe

# 7. Edit config files:
#    .env            → set OLLAMA_MODEL to match what you pulled
#    profile.yml     → fill in name, email, work_authorization especially

# 8. Launch the interactive menu
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
   [8]  Run setup check (doctor)             Verify Ollama is running and everything configured
   [9]  Help — what does this do?            Quick intro for first-time users
   [q]  Quit
```

Pick a number, answer the prompts, done.

---

## Option 1 vs Option 2 — which to use when

**Option 1 — single link**: You have one specific job you want to evaluate. Paste the URL, get a report, optionally generate a PDF separately from option 5.

**Option 2 — batch pipeline** (the new flow): You have a list of jobs from LinkedIn/email/your browser tabs and want to triage them. Here's what happens:

```
1. Paste N URLs (one per line, empty line when done)

2. Add any notes (e.g. "skip Meta, I already applied")

3. STAGE 1 — Script evaluates all N jobs, shows you a scoreboard:

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

5. STAGE 3 — For each picked job, the script runs this loop:
      → Gap analysis        (flags JD requirements not in your CV)
      → Continue?            (c = proceed, s = skip this job, q = quit)
      → Tailored PDF
      → Continue?
      → Auto-fill application (new browser window per job)
      → Continue?
      → next job
```

Every "Continue?" gives you three choices: continue, skip this job, or quit the pipeline. You always have manual control.

---

## About the "add points if I don't have it" feature

You asked for this and I want to be explicit about why I didn't build it as asked:

**The PDF generator WILL:**
- Reword your existing CV bullets to match JD keywords
- Reorder bullets so the relevant ones appear first
- Expand terse bullets with detail already in other parts of your CV
- Surface skills that appear implicitly in your experience (e.g. if you shipped a Kafka pipeline, it can mention "Kafka" in your skills list)

**The PDF generator WILL NOT:**
- Add companies, roles, or projects that aren't in `cv.md`
- Claim expertise in technologies that don't appear in your work history
- Inflate years of experience, team sizes, or impact metrics
- Invent certifications or education

Instead, there's a **gap analysis step** in the batch pipeline. It runs between evaluation and PDF and shows you:

```
Gap analysis:
(These are JD requirements your CV doesn't clearly show. You decide what's real.)

  ● Python              [probably have it]
      CV evidence: "Python, SQL" in skills section
      Already in skills — but consider calling out Python in bullet text too

  ● Terraform           [learnable]
      You've done Docker, Kubernetes, CI/CD — IaC is adjacent
      Don't claim it, but be ready to say "I've done similar IaC tooling"

  ● 8+ years RAG        [real gap]
      Your RAG experience is at UnitedHealth (2025+) — that's ~1 year
      Emphasize depth of RAG work instead of years count

⚠ Only add something to your CV if you GENUINELY have that experience.
  Inventing experience fails background checks and (on OPT/STEM OPT) can
  jeopardize your visa.
```

You look at the gaps, decide which are real for you, and manually update `cv.md` before running the pipeline again. That way your CV stays truthful and you still get the benefit of the analysis.

If you want to override this and have the LLM fabricate experience anyway, you'd need to edit `scripts/generate-pdf.mjs` yourself — the strict rules are in the system prompt there. I'd strongly advise against it, especially given F-1 OPT / STEM OPT context where resume fraud has visa consequences, but the code is yours now.

---

## Choosing a model

Your hardware decides what's feasible. For this specific task (JD evaluation, resume tailoring, form-filling — all structured-output work), these are the models I'd actually recommend in order of preference:

| Model | Memory | Best for |
|---|---|---|
| `qwen2.5:32b` | ~20 GB | M2 Pro / M3 Max / M4 Pro with 32GB+ RAM. Best quality. |
| `qwen2.5:14b` | ~9 GB | The sweet spot — great structured output, fast enough on most Macs |
| `qwen2.5:7b` | ~5 GB | 16GB RAM machines, still decent |
| `llama3.1:8b` | ~5 GB | Fallback if Qwen doesn't work for you |
| `deepseek-r1:14b` | ~9 GB | Reasoning-strong but chain-of-thought can bloat JSON |

**Skip:** uncensored/heretic fine-tunes. They regress on JSON formatting, which this pipeline depends on heavily. You don't need "uncensored" for job applications anyway.

Set your choice in `.env`:

```bash
OLLAMA_MODEL=qwen2.5:14b
OLLAMA_NUM_CTX=32768          # lets the model hold full CV + JD + profile
OLLAMA_TIMEOUT_MS=300000      # 5 min — generous for big models
```

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

All knobs live in `.env`. See `.env.example` for the full list; the important ones:

```bash
OLLAMA_HOST=http://localhost:11434   # where your Ollama server lives
OLLAMA_MODEL=qwen2.5:14b             # the model to use for evaluations
OLLAMA_TIMEOUT_MS=300000             # per-request timeout
OLLAMA_TEMPERATURE=0.3               # lower = more consistent scoring
OLLAMA_NUM_CTX=32768                 # context window — must be ≤ model's max
AUTO_APPLY_HEADLESS=false            # keep false so you can watch the browser
AUTO_APPLY_REQUIRE_CONFIRM=true      # script never clicks submit regardless
```

---

## Auto-apply: how it actually works

1. You run the pipeline (option 2) or option 6
2. Playwright opens the page in a **visible** browser window (new window per job in batch mode)
3. The script walks the form DOM, extracts every field + label
4. Your local LLM proposes answers for each field, drawing on `cv.md` and `config/profile.yml`
5. The script fills the fields (you can watch it happen)
6. **The script stops.** It prints a summary of what it filled, flags anything it was unsure about (salary, work authorization, EEO questions), and waits for you.
7. You review, fix anything wrong, then **you click Submit** yourself.

The script will never click Submit on your behalf. This is intentional and hard-coded.

See `docs/AUTO_APPLY.md` for the full safety model.

---

## Legal / ToS caveats

- Most major ATS platforms (Greenhouse, Lever, Workday, LinkedIn) prohibit **fully automated submission**. Human-reviewed auto-fill is a grayer area — you're the one submitting — but treat this as "use at your own risk."
- Don't batch-submit. Don't spray-and-pray. The filter is the point.
- **Don't point this at LinkedIn.** LinkedIn actively detects automation and will suspend accounts.
- The evaluation pipeline strongly recommends skipping anything scoring below 4.0/5.

---

## Credit

All of the genuinely hard work — the evaluation framework, the 6-block rubric, the PDF template design, the mode prompts — is Santiago Fernández's. This fork swaps the LLM backend, adds the menu, the multi-link pipeline, the gap analyzer, and the apply helper. Go star the [upstream repo](https://github.com/santifer/career-ops).

MIT License, same as upstream.
