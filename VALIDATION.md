# Configuration validation — LAN revision

22/10/2026. Static checks passed: JSON parse; existing provider ID ollama preserved; coder route ollama/qwen3.8:27b matches the provider model key; prompt paths resolve; scripts default to a LAN endpoint configured by the operator (giá trị thật nằm trong biến môi trường cục bộ, không commit vào repo); manager/verifier remain DeepSeek via OpenRouter; delegation remains manager to coder/verifier, with no nested delegation.

No live requests were sent to the LAN endpoint. OpenCode execution, PowerShell runtime, credentials, tool calls and actual Ollama context allocation remain untested here. Declared 64K context must match the real runtime; this pack does not change Ollama.
