# Career-Ops (Ollama Edition)

A fork of [santifer/career-ops](https://github.com/santifer/career-ops) that swaps Claude Code for **local LLMs via Ollama**, plus adds a **human-in-the-loop auto-apply** feature.

Everything runs on your machine. No API keys, no data leaving your laptop.

---

## What's different from upstream

| Feature | Upstream | This fork |
|---|---|---|
| LLM backend | Claude Code / Gemini CLI / OpenCode | **Ollama (local)** — any model you pull |
| Invocation | Slash commands (`/career-ops ...`) | **Plain `npm run` commands** |
| Evaluation pipeline | Claude reads `modes/*.md` | Ollama reads the same `modes/*.md` |
| PDF / scanner / tracker / dashboard | Unchanged | Unchanged — provider-agnostic |
| Auto-apply | Not included (explicit non-goal upstream) | **Included, human-review required before submit** |

The evaluation quality depends entirely on which Ollama model you run. An 8B model will give you decent scoring; a 14B+ reasoning model (Qwen 2.5, DeepSeek-R1) is closer to Claude/Gemini quality.

---

## Quick start

```bash
# 1. Install Ollama
# macOS:   brew install ollama
# Linux:   curl -fsSL https://ollama.com/install.sh | sh
# Windows: https://ollama.com/download

# 2. Start the Ollama server (runs in background on :11434)
ollama serve &

# 3. Pull a model — pick one:
ollama pull llama3.1:8b         # fast, ~5GB RAM
ollama pull qwen2.5:14b         # better reasoning, ~9GB RAM
ollama pull deepseek-r1:14b     # strongest reasoning, ~9GB RAM

# 4. Install this project
cd career-ops-ollama
npm install
npx playwright install chromium

# 5. Configure
cp .env.example .env
# Edit .env: set OLLAMA_MODEL to whatever you pulled

# 6. Add your CV
#    Create cv.md in the project root with your resume in markdown.
#    See examples/cv.example.md for the expected shape.

# 7. Launch the interactive menu
npm start

#   (or run commands directly — see below)
```

# 7. Launch the interactive menu — does everything from one screen
npm start
```

That last command opens a menu like this:

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
    model: llama3.1:8b

  What would you like to do?

   [1]  Evaluate a job                   Paste a URL, file, or JD text → get a scored report
   [2]  Batch-evaluate a folder          Run every .txt/.md in ./jds through the evaluator
   [3]  Scan job portals                 Crawl configured companies for new listings
   [4]  Generate tailored PDF            Turn an evaluation report into an ATS-optimized CV
   [5]  Auto-fill an application         Opens browser, fills form, you review + submit
   [6]  View tracker (your pipeline)     Pretty-print every job you've evaluated
   [7]  Run setup check (doctor)         Verify Ollama is running and everything is configured
   [8]  Help — what does this do?        Quick intro for first-time users
   [q]  Quit

  Enter a number (or q to quit) ›
```

Pick a number, answer its prompts, done. You never need to remember flags.

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
```

Or: paste a JD as an argument, and `evaluate` auto-detects whether it's a URL, file path, or raw text.

---

## Configuration

All knobs live in `.env`. See `.env.example` for the full list; the important ones:

```bash
OLLAMA_HOST=http://localhost:11434   # where your Ollama server lives
OLLAMA_MODEL=llama3.1:8b             # the model to use for evaluations
OLLAMA_TIMEOUT_MS=120000             # per-request timeout
OLLAMA_TEMPERATURE=0.3               # lower = more consistent scoring
AUTO_APPLY_HEADLESS=false            # keep false so you can watch the browser
AUTO_APPLY_REQUIRE_CONFIRM=true      # NEVER set this to false unless you know what you're doing
```

---

## Auto-apply: how it actually works

This is the feature people most often misunderstand, so I'll be explicit.

1. You run `npm run apply -- --url https://boards.greenhouse.io/acme/jobs/123456`
2. Playwright opens the page in a **visible** browser window
3. The script walks the form DOM, extracts every field + label
4. Your local LLM proposes answers for each field, drawing on `cv.md` and `config/profile.yml`
5. The script fills the fields (you can watch it happen)
6. **The script stops.** It prints a summary of what it filled, flags anything it was unsure about (e.g. salary, work authorization, EEO questions), and waits for you.
7. You review, fix anything wrong, then **you click Submit** yourself.

The script will never click Submit on your behalf. This is intentional and hard-coded — `AUTO_APPLY_REQUIRE_CONFIRM=true` is the default and the "off" path isn't wired up. If you want a different behavior, you fork this fork.

Why this matters: local LLMs hallucinate on structured form-filling more than hosted frontier models do. Work authorization, visa status, desired salary, willingness to relocate, veteran status — getting any of these wrong on a real application is bad. The human check is the safety net.

---

## Legal / ToS caveats

- Most major ATS platforms (Greenhouse, Lever, Workday, LinkedIn) prohibit **fully automated submission**. Human-reviewed auto-fill is a grayer area — you're the one submitting — but treat this as "use at your own risk."
- Don't batch-submit. Don't spray-and-pray. The filter is the point of the upstream project, and it's the point here too.
- The evaluation pipeline still strongly recommends skipping anything scoring below 4.0/5.

---

## Credit

All of the genuinely hard work — the evaluation framework, the 6-block rubric, the PDF template, the Go dashboard, the mode prompts — is Santiago Fernández's. This fork just swaps the LLM backend and adds the apply helper. Go star the [upstream repo](https://github.com/santifer/career-ops).

MIT License, same as upstream.
