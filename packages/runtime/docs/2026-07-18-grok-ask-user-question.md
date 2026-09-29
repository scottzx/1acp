# Grok `_x.ai/ask_user_question` wire schema

Reverse-engineered from Grok Build ACP stdio (agent → client extension method), 2026-07-18.

When the model calls the `ask_user_question` tool, Grok's ACP server issues a **client extension method** request. The ACP client must implement this method or the tool fails with:

```text
Failed to reach the client for user question: "Method not found": _x.ai/ask_user_question
```

## Method

| Field           | Value                              |
| --------------- | ---------------------------------- |
| JSON-RPC method | `_x.ai/ask_user_question`          |
| Direction       | agent → client (`extMethod`)       |
| Related tool    | `ask_user_question` (`grok_build`) |

## Request (`AskUserQuestionExtRequest`, 4 fields)

```json
{
  "sessionId": "019f…",
  "toolCallId": "call-…",
  "questions": [
    {
      "question": "Pick a color?",
      "options": [
        { "label": "Red", "description": "Choose red", "preview": null },
        { "label": "Blue", "description": "Choose blue" }
      ],
      "multiSelect": null
    }
  ],
  "mode": "default"
}
```

| Field                     | Type              | Notes                                                        |
| ------------------------- | ----------------- | ------------------------------------------------------------ |
| `sessionId`               | string            | ACP session id                                               |
| `toolCallId`              | string            | Matching tool call id                                        |
| `questions`               | array             | One or more MC questions                                     |
| `questions[].question`    | string            | Full question text (also the answer map key)                 |
| `questions[].options`     | array             | `{ label, description, preview? }`                           |
| `questions[].multiSelect` | `boolean \| null` | Wire is **camelCase**. Tool JSON schema uses `multi_select`. |
| `mode`                    | string            | Observed: `"default"`                                        |

### Tool input schema (model-facing, not the ext method)

```json
{
  "questions": [
    {
      "question": "…",
      "options": [{ "label": "…", "description": "…", "preview": null }],
      "multi_select": null
    }
  ]
}
```

Every question implicitly supports an "Other" free-text answer in the TUI.

## Response (adjacently tagged on `outcome`)

Serde error when wrong: `expected one of accepted, chat_about_this, skip_interview, cancelled`.

### `accepted`

`answers` is a **map** keyed by question text. Values are untagged `StringOrVec` (`string | string[]`).

```json
{
  "outcome": "accepted",
  "answers": {
    "Pick a color?": "Red",
    "Which colors?": ["Red", "Blue"]
  },
  "partial_answers": false
}
```

| Field             | Required | Notes                                                                                   |
| ----------------- | -------- | --------------------------------------------------------------------------------------- |
| `outcome`         | yes      | `"accepted"`                                                                            |
| `answers`         | yes      | `Record<questionText, string \| string[]>` — **must be an object**, not an array        |
| `partial_answers` | no       | boolean; accepted by parser                                                             |
| `annotations`     | no       | `Record<questionText, QuestionAnnotation>` (struct, 2 fields) — optional, rarely needed |

### Unit outcomes

```json
{ "outcome": "skip_interview" }
```

```json
{ "outcome": "chat_about_this" }
```

```json
{ "outcome": "cancelled" }
```

| Outcome           | Tool-side effect (observed)                    |
| ----------------- | ---------------------------------------------- |
| `accepted`        | `User has answered your questions: "Q"="A", …` |
| `skip_interview`  | Stop clarifying; finish plan with current info |
| `chat_about_this` | User wants to discuss/reformulate questions    |
| `cancelled`       | User declined; continue with best judgment     |

## acpx / bridge integration

- **Client**: `src/acp/client.ts` `extMethod` handles `_x.ai/ask_user_question`.
- **Types / parse / CLI**: `src/acp/grok-ask-user.ts`.
- **Host callback**: `AcpClientOptions.onAskUserQuestion` / `AcpRuntimeOptions.onAskUserQuestion`.
- **bridge-server**:
  - Outbound event: `ask_user_question` `{ sessionId, requestId, toolCallId, mode, questions }`
  - Inbound action: `respond_ask_user_question` `{ sessionId, requestId, outcome, answers?, partial_answers? }`

## Capture notes

Validated with a mock ACP client against `grok agent stdio`:

- Wrong: `{ type: "Accepted", answers: [...] }` → `missing field outcome`
- Wrong: `{ outcome: "Accepted", answers: [...] }` → unknown variant casing
- Wrong: `{ outcome: "accepted", answers: ["Red"] }` → `invalid type: sequence, expected a map`
- Right: `{ outcome: "accepted", answers: { "Pick a color?": "Red" } }` → tool completed
