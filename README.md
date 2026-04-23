# Career-Ops (Ollama Edition)

A local-first job search assistant. Runs on your computer, uses local AI models (Ollama), and helps you:

- **Score jobs** against your resume — should you apply or skip?
- **Tailor your resume** for each job automatically
- **Auto-fill applications** (you still review and click submit)

No API keys. No data leaves your laptop. Works offline once installed.

**Forked from** [santifer/career-ops](https://github.com/santifer/career-ops). Optional [openclaude](https://github.com/Gitlawb/openclaude) provider supported.

---

# 🚀 Brand new? Start here.

If you've never used a terminal before, follow this section literally — copy each command, paste it, press Enter.

## Step 1 — Install Ollama

Ollama is the program that runs AI models on your computer.

**On Mac:**
```bash
brew install ollama
```
*Don't have `brew`? Install it first from [brew.sh](https://brew.sh).*

**On Linux:**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**On Windows:** download the installer from [ollama.com/download](https://ollama.com/download).

## Step 2 — Start Ollama

Ollama needs to be running in the background.

**Mac:**
```bash
brew services start ollama
```

**Linux/Windows:**
```bash
ollama serve
```
*This blocks the terminal. Open a second terminal window for the next steps.*

## Step 3 — Download an AI model

This downloads the model to your laptop. Big download — 5 to 20 GB depending on which one. Only do this once.

**If your computer has 16 GB RAM** (most laptops):
```bash
ollama pull qwen2.5:14b
```

**If your computer has 32 GB RAM or more** (M-series Macs with 32+ GB):
```bash
ollama pull qwen2.5:32b
```

**If unsure or short on space:**
```bash
ollama pull llama3.1:8b
```

## Step 4 — Download this project

```bash
cd ~/Downloads
git clone https://github.com/RachaRajesh/career-ops-ollama.git
cd career-ops-ollama
```

## Step 5 — Install the project's dependencies

```bash
npm install
npx playwright install chromium
```

*You need Node.js 18 or newer. Check with `node --version`. If you don't have it, install from [nodejs.org](https://nodejs.org).*

## Step 6 — Set up your config files

Copy the templates:
```bash
cp .env.example .env
cp config/profile.example.yml config/profile.yml
cp examples/cv.example.md cv.md
```

Now you need to edit each one with YOUR information. Use any text editor — `nano`, `vim`, VS Code, TextEdit, whatever you're comfortable with. Examples below use `nano` because it's beginner-friendly.

### Edit `.env`

```bash
nano .env
```

Find the line that says `OLLAMA_MODEL=qwen2.5:14b`. Change it to whatever model you downloaded in Step 3.

Save: `Ctrl+O`, Enter, `Ctrl+X`.

### Edit `cv.md` ⚠️ IMPORTANT

```bash
nano cv.md
```

This file currently contains a fake person named "Jane Doe". **You MUST replace it with your real resume.** If you skip this, every PDF you generate will have Jane Doe's information instead of yours.

Delete everything in the file. Paste your real resume in markdown format. Use the example as a structure guide.

Verify after saving:
```bash
head -3 cv.md
```
The first line should be **your name**, not "Jane Doe".

### Edit `config/profile.yml`

```bash
nano config/profile.yml
```

Fill in your real information — especially:
- `name`, `email`, `phone`, `location`, `linkedin`, `github`
- `work_authorization` section (be honest — this ends up on real applications)
- `target_base_usd` if you're comfortable having the auto-apply fill salary fields

## Step 7 — Verify everything works

```bash
npm run doctor
```

You should see green checkmarks for everything:
```
✓ ollama server reachable
✓ Model "qwen2.5:14b" available
✓ cv.md exists
✓ config/profile.yml exists
✓ modes/ directory populated
✓ Playwright chromium installed
✓ LLM round-trip works
```

If any line is **red**, the error message tells you exactly what to fix. The most common issues:
- "Cannot reach Ollama" → run `brew services start ollama` (or `ollama serve`)
- "Model not pulled" → run `ollama pull <name>` for whatever model is in your `.env`
- "cv.md still contains Jane Doe" → go back to Step 6 and edit `cv.md` for real

## Step 8 — Launch the menu

```bash
npm start
```

You'll see this:

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

   [1]  Evaluate ONE job (single link)       Paste one URL, file, or JD text
   [2]  Batch pipeline (MULTIPLE links)      Paste N URLs → filter → PDF + apply
   [3]  Batch-evaluate a folder              Run every .txt/.md in ./jds
   [4]  Scan job portals                     Crawl configured companies
   [5]  Generate tailored PDF(s)             Single → PDF, or bulk for many
   [6]  Auto-fill one application            Open browser, fill form
   [7]  View tracker (your pipeline)         See every job you've evaluated
   [8]  Run setup check (doctor)             Verify everything works
   [9]  Help — what does this do?            Quick intro
   [q]  Quit
```

Type a number, press Enter, follow the prompts. **You're done with setup.**

---

# 📋 Common workflows

## "I have one job I want to evaluate"

```
npm start
→ press 1
→ press 1 (paste URL)
→ paste the job URL
→ wait 1-3 minutes
```

You get a score (1-5), strengths, gaps, and a recommendation. The report saves to `reports/`.

## "I have 5 jobs from LinkedIn — which should I apply to?"

```
npm start
→ press 2  (batch pipeline)
→ paste each URL on its own line
→ press Enter on an empty line when done
→ wait — script evaluates all 5
→ see scoreboard
→ pick which to take forward (e.g. "all scoring 4.0+")
→ for each: PDF gets generated, then app form opens for you to fill
```

## "I evaluated 12 jobs, now I want PDFs for the good ones"

```
npm start
→ press 5  (PDF generation)
→ press 3  (reports scoring ≥ 4.0)
→ confirm
```

PDFs land in `output/`, named like `Anthropic_AI-Engineer_2026-04-23_19-45.pdf`.

## "I want to auto-fill an application form"

⚠️ Read `docs/AUTO_APPLY.md` first. The script never clicks submit — you do. Don't use it on LinkedIn (they detect automation and suspend accounts).

```
npm start
→ press 6
→ paste the application URL (the actual form, not the job listing)
→ confirm your profile is honest
→ browser opens, fills the form
→ YOU review and click submit
```

---

# 🛠 Picking the right AI model

Your computer's RAM decides what's possible. Quality goes up with model size; speed goes down.

| Model | RAM needed | Speed | Quality |
|---|---|---|---|
| `qwen2.5:7b` | ~5 GB | Fast | OK |
| `qwen2.5:14b` | ~9 GB | Medium | **Recommended for most users** |
| `qwen2.5:32b` | ~20 GB | Slower | Best for resume tailoring quality |
| `llama3.1:8b` | ~5 GB | Fast | OK fallback |

**Skip:** "uncensored" or "heretic" fine-tunes. They produce worse JSON formatting, which this project depends on.

To switch models later:
```bash
ollama pull qwen2.5:32b           # download
nano .env                         # change OLLAMA_MODEL=qwen2.5:32b
npm run doctor                    # verify
```

---

# 📂 Where files go

```
career-ops-ollama/
├── cv.md                    ← YOUR RESUME (you create this)
├── .env                     ← YOUR CONFIG (you create this)
├── config/profile.yml       ← YOUR DETAILS (you create this)
│
├── reports/                 ← Evaluation reports land here
│                             Format: Company_Role_Date_Time.md
├── output/                  ← Tailored PDFs land here
│                             Format: Company_Role_Date_Time.pdf
├── data/tracker.tsv         ← Master list of every job evaluated
│
├── jds/                     ← Drop saved job descriptions here for batch
└── scripts/                 ← The actual code (don't edit unless you want to)
```

---

# 🔧 Common problems

| Problem | Fix |
|---|---|
| "Cannot reach Ollama" | Run `brew services start ollama` (Mac) or `ollama serve` |
| "Model not pulled" | Run `ollama pull <name>` for the model in `.env` |
| Generated PDF has Jane Doe's info | Edit `cv.md` to your real content. `head -3 cv.md` should show YOUR name |
| Workday URL fails to scrape | Workday blocks scrapers. Use option 1 → "Paste the JD text" instead |
| Evaluation timed out | Edit `.env`, set `OLLAMA_TIMEOUT_MS=600000` (10 min for big models) |
| Resume looks AI-generated | Bump to `qwen2.5:32b` if you have 32GB+ RAM. Smaller models keyword-stuff more. |
| `npm doctor` fails (not `npm run doctor`) | You typed it wrong. The right command is **`npm run doctor`** |
| Apply form fills wrong info | Check `config/profile.yml` — the script uses what you put there literally |

---

# 📚 More documentation

- `docs/SETUP.md` — detailed setup walkthrough
- `docs/AUTO_APPLY.md` — auto-apply safety model (read before using option 6)
- `docs/ARCHITECTURE.md` — how the pieces fit together
- `docs/OPENCLAUDE.md` — using openclaude as the AI provider (advanced, optional)

---

# 🤖 About auto-tailoring (the resume PDFs)

The PDF generator does these things:
- Rewords your existing bullets to surface JD-relevant keywords
- Reorders bullets so the most relevant ones appear first
- Promotes skills to the Skills section if your CV implies them
- Picks a clean, ATS-friendly layout

The PDF generator **does NOT**:
- Add experience or technologies you don't have
- Inflate years, team sizes, or impact metrics
- Mention tech in a job's bullets if your CV doesn't say you used it there
  - Example: if your CV says you used SageMaker at UnitedHealth (not "AWS" broadly), the tailored resume won't add "AWS" to the UnitedHealth bullets just because the JD asked for it
- Aim for 100% keyword match — that's an AI-detection red flag. Targets ~70%.

**Why it stays honest**: resume fraud fails background checks, gets offers rescinded, and on F-1 OPT / STEM OPT can jeopardize your visa. The tool is built to be a leg up, not a liability.

If you want to add an experience that's genuinely yours but isn't on your CV yet, edit `cv.md` directly — the tool will pick it up next run.

---

# ⚖️ Legal stuff

- Greenhouse, Lever, Workday, LinkedIn etc. **prohibit fully automated submission.** Human-reviewed auto-fill (what this does) is grayer — but use it carefully.
- **Don't point this at LinkedIn.** They detect automation and suspend accounts.
- **Don't spray-and-pray.** The whole point is filtering. The tool tells you to skip jobs scoring below 4.0; listen to it.
- Your `cv.md`, `profile.yml`, and `.env` stay on your computer. The only outbound traffic is the LLM call to your local Ollama (no internet) and Playwright opening application websites in a browser.

---

# 🙏 Credits

- **[santifer/career-ops](https://github.com/santifer/career-ops)** — original project. The evaluation rubric, mode prompts, and architecture are Santiago's work. Star it.
- **[Gitlawb/openclaude](https://github.com/Gitlawb/openclaude)** — optional LLM router.
- This fork — Ollama backend, interactive menu, multi-link pipeline, gap analyzer, auto-apply, organic resume tailoring, bulk PDF generation.

MIT License (inherited from upstream).

---

# 💬 Found a bug?

Open an issue on this fork's GitHub repo. Include:
- What you ran
- The full error message (paste, don't paraphrase)
- Output of `npm run doctor`

That's enough to debug 95% of issues.
