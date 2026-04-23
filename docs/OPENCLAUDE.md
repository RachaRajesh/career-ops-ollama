# Using openclaude as the LLM provider (optional)

**Short version: this is an opt-in alternative. Keep `LLM_PROVIDER=ollama` unless you have a specific reason to switch.**

## What openclaude is

[openclaude](https://github.com/Gitlawb/openclaude) is a coding-agent CLI that speaks OpenAI-compatible HTTP to a range of backends — OpenAI, DeepSeek, Gemini, Ollama, GitHub Models, and ~200 more via OpenAI-compatible APIs. Think of it as a unified routing layer sitting in front of many model providers.

Career-ops can route its LLM calls through openclaude instead of talking to Ollama directly. The existing Ollama path stays fully intact; it's just an alternate endpoint.

## Why you'd want to

- You're already using openclaude for other workflows and want one unified config.
- You want to swap providers (e.g. Ollama for simple tasks, DeepSeek for harder evaluations) without touching career-ops' code.
- You want to compare output quality across providers using the same prompts.

## Why you probably shouldn't (honest version)

At the time of writing, openclaude has two open issues that matter:

- **[#486](https://github.com/Gitlawb/openclaude/issues/486)** — local Ollama models can't read files through openclaude.
- **[#557](https://github.com/Gitlawb/openclaude/issues/557)** — tool calling with Ollama sometimes prints JSON but doesn't execute.

Career-ops' evaluate/apply/pipeline flows **do not use** openclaude's agentic features (file reading, tool calling, agent loops). We feed plaintext to the LLM and parse plain JSON responses, all handled in JavaScript. So these known bugs don't affect our flows.

**But** — adding a translation layer means more failure modes. If the openclaude HTTP server isn't running, if the OpenAI-compatible translation drops a field, if the response format differs slightly between openclaude versions — you'll see breakages the direct-Ollama path simply can't have. Benefit yourself honestly: do you actually need openclaude's unification, or is one Ollama server fine?

## How to switch

1. Install and set up openclaude per its docs: https://github.com/Gitlawb/openclaude
2. Start its HTTP server. Different openclaude versions expose this differently; check the advanced-setup docs for your version. The server must expose `POST /v1/chat/completions` (OpenAI format).
3. Configure openclaude to route to whatever model you want — most commonly Ollama. Inside openclaude: `/provider` to pick, or use env vars per openclaude's setup guide.
4. Edit career-ops' `.env`:

   ```bash
   LLM_PROVIDER=openclaude
   OPENCLAUDE_BASE_URL=http://localhost:3000/v1    # match your openclaude server
   OPENCLAUDE_MODEL=qwen2.5:14b                    # match what openclaude serves
   OPENCLAUDE_API_KEY=                             # blank for local-only
   ```

5. Run the doctor to verify end-to-end connectivity:

   ```bash
   npm run doctor
   ```

   You should see `provider: openclaude` at the top and all checks green. If the model check shows `SKIP`, that's fine — some openclaude versions don't implement `/v1/models`, and the final "LLM round-trip works" check confirms connectivity regardless.

6. Run a real evaluation:

   ```bash
   npm run evaluate -- --file ./jds/sample.txt
   ```

   Every other command (pipeline, apply, pdf, batch) now goes through openclaude automatically.

## How to switch back

```bash
# in .env
LLM_PROVIDER=ollama
```

That's it. Direct-to-Ollama is the default and requires nothing else to be running.

## Using cloud providers through openclaude

If you configure openclaude to route to DeepSeek, OpenAI, or another cloud provider (rather than local Ollama), you likely need to set `OPENCLAUDE_API_KEY` in career-ops' `.env` too. Check openclaude's auth model — some versions forward keys automatically, others expect the key on inbound requests.

## Troubleshooting

**`Cannot reach openclaude at http://localhost:3000/v1`**
openclaude's HTTP server isn't running. Start it per openclaude's docs.

**`openclaude 401: Unauthorized`**
If you're routing to a cloud provider, set `OPENCLAUDE_API_KEY` in `.env`.

**Evaluations come back malformed / bad JSON**
OpenAI-compatible `response_format: "json_object"` isn't universally supported. Career-ops' `chatJSON` function has a salvage path, but if a particular model+openclaude combination is consistently malformed, set `LLM_PROVIDER=ollama` and go direct instead — you lose no functionality.

**Apply script fills forms worse through openclaude than through direct Ollama**
Known issue shape. The apply script expects strictly-formatted JSON; the openclaude translation layer can introduce subtle formatting differences. For the apply feature specifically, direct Ollama is more reliable. You can mix — use openclaude for evaluate/pipeline and direct Ollama for apply by toggling `LLM_PROVIDER` per command:

```bash
LLM_PROVIDER=openclaude npm run evaluate -- --url https://...
LLM_PROVIDER=ollama     npm run apply    -- --url https://...
```

Same `.env` values, just overridden for that single command.
