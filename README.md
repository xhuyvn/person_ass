# PersonalAss — OpenCode multi-agent configuration

Prepared 22/10/2026; adapted to your existing Ollama LAN configuration. Development tooling only; this does not change the app's runtime AI pipeline.

| Agent | Model route | Responsibility |
| --- | --- | --- |
| manager (primary/default) | DeepSeek via OpenRouter | Overall planning, acceptance, test design/execution, diagnosis, final review |
| coder (subagent) | Qwen3.8:27b via Ollama local/LAN | Source changes, migrations, tests and implementation configuration |
| verifier (subagent) | Same DeepSeek via OpenRouter | Optional second review/testing/debug diagnosis; no source edits |

The manager delegates one bounded task at a time, waits, inspects the diff, runs checks, diagnoses any failures and sends a fix task to coder. Only one local coder is active at a time. This sequence is enforced by agent prompts and manager task permissions, not a hard concurrency semaphore. Do not invoke a second coder manually in parallel.

## Install into your project

1. Extract this add-on and copy `opencode.json`, `.opencode/`, `scripts/start-opencode.ps1`, `scripts/preflight-opencode.ps1`, `.work/task-template.md` and `START-PROMPT.txt` into the project containing the original handoff. Merge directories; do not overwrite an existing OpenCode configuration without comparing/merging it. The launcher refuses to modify existing config content.
2. Install OpenCode and Ollama if needed. Keep the model tag exactly as shown by `ollama list`.
3. Set the API key in your terminal environment or let the launcher ask for it securely. Never place a real key in opencode.json or a committed file.
4. Launch from the project root using the examples below. The launcher sets session environment variables; it does not persist your key or alter your Ollama model.

PowerShell example (model ID listed by OpenRouter on 22/10/2026; replace if your preferred DeepSeek differs):

```powershell
.\scripts\start-opencode.ps1 -DeepSeekModel 'deepseek/deepseek-v4-pro-0813'
```

Your configured LAN endpoint is already the launcher default. To override it:

```powershell
.\scripts\start-opencode.ps1 -DeepSeekModel 'deepseek/deepseek-v4-pro-0813' -OllamaBaseUrl 'http://192.0.2.10:11434/v1'
```

If your installed tag is different:

```powershell
.\scripts\start-opencode.ps1 -DeepSeekModel 'deepseek/deepseek-v4-pro-0813' -LocalModel 'your-exact-tag' -ContextTokens 65536
```

The launcher requires that LocalModel already matches the single model key in opencode.json. To change that key, update the provider model entry and coder.model together first; this avoids silently rewriting your config. The default key is qwen3.8:27b.

Once OpenCode opens, confirm manager is selected and paste START-PROMPT.txt. `opencode agent list` lists agents; `/models` lists the available model routes. Avoid `ollama launch opencode` for this setup: its inline config can override the primary model selected by the project.

## Environment variables

- OPENROUTER_API_KEY: secret; supplied by launcher if absent.
- PERSONALASS_MANAGER_MODEL: full OpenCode reference, e.g. openrouter/deepseek/deepseek-v4-pro-0813.
- PERSONALASS_OLLAMA_BASE_URL: includes /v1, e.g. http://192.0.2.20:3039/v1 (giá trị thật do bạn đặt trong môi trường cục bộ; không commit địa chỉ LAN thật vào repo).

Native Windows PowerShell or PowerShell 7 can run the launcher. If using WSL, configure/run OpenCode within WSL and account for where Ollama is reachable; do not assume localhost resolves to the Windows host in every setup. The launcher itself is PowerShell-oriented.

## Local context: actual runtime vs configuration

The provided OpenCode metadata declares context=65536 and output=8192. This does not allocate or configure Ollama's context. Ollama must actually run with num_ctx >=65536; current Ollama OpenCode guidance specifies 64K+. The launcher checks the declared config value and the preflight can inspect model defaults, but neither proves the live allocation.

Set context in your Ollama model/server configuration before coding. If you create an alias, keep the provider model key and coder.model aligned with its exact tag. A 27B Q8 model with CPU offload and 64K context can be slow or memory-limited; test on your machine before committing to long tasks. No throughput or VRAM fit is promised. Do not advertise 64K while the runtime is still 16K.

Optional explicit alias recipe (does not run automatically): create a Modelfile containing FROM qwen3.8:27b and PARAMETER num_ctx 65536, run `ollama create personalass-qwen-coder -f Modelfile`, then change both configuration references to personalass-qwen-coder. This reuses the same quantization; it is not a smaller model. During a real coding request, inspect `ollama ps` on the Ollama machine and its logs to verify allocated context/memory.

## Verification before real project work

Run preflight for unauthenticated metadata/model availability checks. It sends no generation request or paid OpenRouter request. For an Ollama native URL that is not at the same root as /v1, provide -OllamaNativeUrl explicitly.

```powershell
.\scripts\preflight-opencode.ps1 -LocalModel 'qwen3.8:27b'
```

Then in a disposable synthetic repository ask manager: delegate to coder a file `.work/local-coder-smoke.txt` containing LOCAL_CODER_OK, then read it and run a command that checks the content, optionally ask verifier to inspect it. Confirm the actual model shown for the child is ollama/qwen3.8:27b and manager/verifier show the DeepSeek OpenRouter route. This smoke uses paid DeepSeek tokens and a real local generation; it is intentionally not performed automatically by the scripts. A model metadata tool_call=true flag alone does not prove tool calling works.

## Workflow boundaries

Manager can edit progress markdown only; verifier has edit tool denied. Shell remains enabled so agents can run tests/builds, which can write artifacts. These permissions and prompts are workflow controls, not an OS security sandbox; shell could bypass edit rules. Use a trusted development repo and synthetic app data. Because manager/verifier use OpenRouter, code excerpts, relevant docs and logs they inspect are sent to that service; keeping coder local does not make the overall development session local-only.

The original AGENTS.md permits delegation when authorized in the current session. This add-on's MULTI-AGENT-AUTHORIZATION.md records the requested workflow; pass it to a new coding session as authorization. Application runtime multi-agent behavior remains out of scope.

## Compatibility and actual validation

Configuration uses the documented `provider`, `agent`, `permission` syntax still represented by the published schema on 22/10/2026. The current schema also has newer plural encodings; do not mix generations casually. For an older release using a `bash` tool rather than `shell`, change the permission key after checking that installed release's documentation; this package targets the current documented shell tool.

Global settings and .opencode/agents definitions are merged, so existing entries can affect the final result. Inspect your effective setup. Steps limits bound individual agent turns, not total spend or guaranteed task completion. If a limit is reached, manager should save state and continue with a smaller task.

This pack was checked for JSON structure, model routing, prompt paths and delegation/permission invariants. OpenCode/Ollama and credentials were unavailable in the authoring environment; live tool use, PowerShell execution and provider interoperability have not been tested here. First-run smoke is required. No changes have been made to your Windows installation or running model.

## Correction to your existing model mapping

Your original provider has model key qwen3.5 and display name qwen3.8:27b. The display name does not change the request model ID. This pack uses the real model tag as the key: qwen3.8:27b, and the agent route ollama/qwen3.8:27b. Alternatively an alias key requires an explicit id mapping, but this pack avoids the extra alias.

The LAN endpoint is supplied by the operator through the launcher (`PERSONALASS_OLLAMA_BASE_URL`); no real LAN address is committed in this repository. opencode.json uses PERSONALASS_OLLAMA_BASE_URL supplied by the launcher. If you run plain opencode instead, set that variable, PERSONALASS_MANAGER_MODEL and OPENROUTER_API_KEY in the same terminal first. No connection or model request was sent to your LAN address during pack preparation.
