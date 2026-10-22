# Official references checked 22/10/2026

- https://opencode.ai/docs/agents/ — primary/subagent modes, model per agent, prompt files, steps and task permissions.
- https://opencode.ai/docs/config/ — project config merging, environment/file substitutions and compaction.
- https://opencode.ai/docs/permissions/ — shell/edit/task rules; edit permission is not a process sandbox.
- https://opencode.ai/config.json — current schema; compatibility keys remain present alongside newer encodings.
- https://opencode.ai/docs/providers/ — OpenRouter and OpenAI-compatible custom providers.
- https://opencode.ai/docs/cli/ — --agent, agent list and models.
- https://docs.ollama.com/integrations/opencode — Ollama integration and 64K+ context guidance.
- https://openrouter.ai/api/v1/models — current model IDs/capabilities; model example is not a promise of future availability.

The setup does not pin or install a specific OpenCode version. Record `opencode --version` during local setup and verify config/permissions against that version before relying on it.
