# DeepSeek Build

- Built-in name: `deepseek-build`
- Underlying command: `grok agent --model deepseek-v4-flash stdio`
- API Base URL: `https://api.deepseek.com`
- Default Model: `deepseek-v4-flash`
- Supported Models: `deepseek-v4-flash`, `deepseek-v4-pro`

`acpx deepseek-build` launches the installed Grok Build ACP server with an isolated DeepSeek provider profile. The profile uses DeepSeek's OpenAI-compatible API endpoint and does not reuse Grok's xAI login, cached token, or provider key.

Credentials are resolved in this order:

1. Session environment `DEEPSEEK_API_KEY`
2. Parent process environment `DEEPSEEK_API_KEY`
3. The non-empty `api_key` of the `deepseek-api` provider in `~/.1agents/providers.json`

You can still set the environment variable explicitly before starting acpx:

```bash
export DEEPSEEK_API_KEY="placeholder"
```

The built-in maps the resolved key to the credential name expected by the Grok child process. The active provider does not need to be DeepSeek; the providers file lookup uses the exact `deepseek-api` provider ID. `XAI_API_KEY`, `OPENAI_API_KEY`, other provider entries, and cached Grok credentials are not accepted as fallbacks for this profile.

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
