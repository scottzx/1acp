# DeepSeek Build

- Built-in name: `deepseek-build`
- Underlying command: `grok agent --model deepseek-v4-flash stdio`
- API Base URL: `https://api.deepseek.com`
- Default Model: `deepseek-v4-flash`
- Supported Models: `deepseek-v4-flash`, `deepseek-v4-pro`

`acpx deepseek-build` launches the installed Grok Build ACP server with an isolated DeepSeek provider profile. The profile uses DeepSeek's OpenAI-compatible API endpoint and does not reuse Grok's xAI login, cached token, or provider key.

Set `DEEPSEEK_API_KEY` before starting acpx:

```bash
export DEEPSEEK_API_KEY="placeholder"
```

The built-in maps this key to the credential name expected by the Grok child process. `XAI_API_KEY` and `OPENAI_API_KEY` are not accepted as fallbacks for this profile.

## Quick Start

```bash
acpx deepseek-build sessions new
acpx deepseek-build 'review this PR'
acpx deepseek-build exec 'explain this codebase'
acpx --model deepseek-v4-pro deepseek-build exec 'review this architecture'
```

## Model Selection

By default, sessions use `deepseek-v4-flash`. Use the existing global `--model` option when creating or executing a session to select another model advertised by DeepSeek:

- `deepseek-v4-flash` (default)
- `deepseek-v4-pro`

Sessions created by older development versions of this built-in used the same stored command identity as `grok-build`. They cannot be distinguished safely and are not migrated; create a new `deepseek-build` session after upgrading.
