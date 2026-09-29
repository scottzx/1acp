# Grok `_x.ai/exit_plan_mode` wire schema

Reverse-engineered from Grok Build ACP stdio (2026-07-18).

When the model calls `exit_plan_mode`, Grok's ACP server issues a **client extension method** so the host can show a plan-approval UI (TUI: Approve / Request changes / Quit).

## Method

| Field           | Value                           |
| --------------- | ------------------------------- |
| JSON-RPC method | `_x.ai/exit_plan_mode`          |
| Direction       | agent → client (`extMethod`)    |
| Related tool    | `exit_plan_mode` (`grok_build`) |

## Request (`ExitPlanModeExtRequest`, 3 fields)

```json
{
  "sessionId": "019f…",
  "toolCallId": "call-…",
  "planContent": "# Plan\n\n- step one\n- step two\n"
}
```

| Field         | Type   | Notes                                  |
| ------------- | ------ | -------------------------------------- |
| `sessionId`   | string | ACP session id                         |
| `toolCallId`  | string | Matching tool call id                  |
| `planContent` | string | Full plan markdown (camelCase on wire) |

## Response (adjacently tagged on `outcome`)

TUI actions map to:

| UI                  | Wire                                          | Effect                              |
| ------------------- | --------------------------------------------- | ----------------------------------- |
| **Approve**         | `{ "outcome": "approved", "comments"?: "…" }` | Leave plan mode; start implementing |
| **Request changes** | `{ "outcome": "rejected", "comments"?: "…" }` | Stay planning; revise plan          |
| **Quit**            | `{ "outcome": "abandoned" }`                  | Abandon plan; turn plan mode off    |

Optional `comments` is freeform feedback ("Additional feedback" in the TUI).

## acpx / bridge integration

- **Client**: `src/acp/client.ts` `extMethod` handles `_x.ai/exit_plan_mode`
- **Types / parse / CLI**: `src/acp/grok-exit-plan.ts`
- **Host callback**: `onExitPlanMode`
- **bridge-server**:
  - Outbound: `exit_plan_mode` `{ sessionId, requestId, toolCallId, planContent }`
  - Inbound: `respond_exit_plan_mode` `{ sessionId, requestId, outcome, comments? }`

## Frontend

- Composer-adjacent `ExitPlanPrompt` (same slot as permission / ask_user)
- Scrollable plan markdown + optional feedback + 3 buttons
- Nested receipt on the tool card after resolve
