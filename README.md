# @esimfly/mcp — eSIMfly MCP server

[![eSimfly-Official/esimfly-mcp MCP server](https://glama.ai/mcp/servers/eSimfly-Official/esimfly-mcp/badges/score.svg)](https://glama.ai/mcp/servers/eSimfly-Official/esimfly-mcp) [![npm](https://img.shields.io/npm/v/%40esimfly%2Fmcp)](https://www.npmjs.com/package/@esimfly/mcp) [![CI](https://github.com/eSimfly-Official/esimfly-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/eSimfly-Official/esimfly-mcp/actions/workflows/ci.yml) [![smithery badge](https://smithery.ai/badge/akam19901205/esimfly)](https://smithery.ai/servers/akam19901205/esimfly) [![M8ven Score](https://m8ven.ai/badge/mcp/esimfly-official/esimfly-mcp)](https://m8ven.ai/mcp/esimfly-official/esimfly-mcp)

Give your AI assistant hands on the eSIMfly Business API. With this
[Model Context Protocol](https://modelcontextprotocol.io) server, Claude, Cursor, ChatGPT and other
MCP clients can search eSIM plans with your wholesale prices, check balances and usage, diagnose
"no data" problems from live network data — and, if you enable it, place orders and top-ups with an
explicit confirmation step.

- **Read-only by default.** Nothing can spend your balance unless you opt in.
- **Two-step writes.** Every write tool returns a preview (what, cost, balance) until called with `confirm: true`.
- **Built on the official [`@esimfly/sdk`](https://www.npmjs.com/package/@esimfly/sdk)** — signing, retries and error codes handled.
- Ships two prompts: the complete integration guide and an eSIM diagnosis workflow.

Docs: **https://docs.esimfly.net** · Credentials: Business Dashboard → Settings → API Keys.

## Hosted server (no install)

Prefer not to run anything locally? eSIMfly hosts this same server at **`https://mcp.esimfly.net/mcp`**.
Add it as a remote MCP server in Claude.ai, ChatGPT, Claude Code (`claude mcp add --transport http esimfly https://mcp.esimfly.net/mcp`),
Cursor or VS Code and sign in with your eSIMfly business account — OAuth 2.1, no keys to paste, write
tools opt-in on the consent screen. Details: https://docs.esimfly.net/docs/mcp-server

## Local install

The server runs locally over stdio; your API key never leaves your machine.

### Claude Desktop

`claude_desktop_config.json` → `mcpServers`:

```json
{
  "mcpServers": {
    "esimfly": {
      "command": "npx",
      "args": ["-y", "@esimfly/mcp"],
      "env": {
        "ESIMFLY_ACCESS_CODE": "esf_...",
        "ESIMFLY_SECRET_KEY": "sk_..."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add esimfly -e ESIMFLY_ACCESS_CODE=esf_... -e ESIMFLY_SECRET_KEY=sk_... -- npx -y @esimfly/mcp
```

### Cursor / Windsurf / other MCP clients

`.cursor/mcp.json` (or the client's equivalent):

```json
{
  "mcpServers": {
    "esimfly": {
      "command": "npx",
      "args": ["-y", "@esimfly/mcp"],
      "env": { "ESIMFLY_ACCESS_CODE": "esf_...", "ESIMFLY_SECRET_KEY": "sk_..." }
    }
  }
}
```

### Docker

```bash
docker build -t esimfly-mcp .
docker run -i --rm -e ESIMFLY_ACCESS_CODE=esf_... -e ESIMFLY_SECRET_KEY=sk_... esimfly-mcp
```

### Enable write tools

Add `"ESIMFLY_MCP_ALLOW_WRITES": "true"` to `env`. Without it the ordering, top-up, cancel,
suspend, SMS and webhook tools are not even registered.

## Try it

- "Find the cheapest 5 GB plan for Turkey and tell me my margin at €9.99."
- "Which of my eSIMs are active and below 200 MB?"
- "ICCID 8948010010036785060 says no data — diagnose it." *(uses the `diagnose_esim` prompt)*
- "Set up webhooks for installed / status / low-data events at https://my.app/hooks." *(write tool, previews first)*
- "Build me a Node.js integration." *(uses the `esimfly_integration_guide` prompt)*

## Tools

| Tool | What it does | Mode |
|---|---|---|
| `search_packages` | Catalogue search by destination / type with your cost price | read |
| `get_balance` | Account (or enterprise) balance | read |
| `list_esims` | Your eSIMs with status, data left, validity | read |
| `get_esim_usage` | Stored usage for one eSIM (cheap) | read |
| `get_esim_live_status` | Live status from the network: install state, last network, device, usage | read (expensive) |
| `get_network_events` | Last 7 days of attach / data-session events, wrong-network flag | read |
| `get_usage_report` | Daily usage by country and operator (up to 90 days) | read |
| `list_orders` / `get_order` | Order history and one order with its eSIM | read |
| `get_topup_packages` | Top-up options for one eSIM | read |
| `get_webhook_settings` | Webhook URL, events, recent deliveries | read |
| `create_order` | Buy eSIMs — preview → `confirm: true` + idempotency key | write |
| `topup_esim` | Add data to an eSIM — preview shows package and cost | write |
| `cancel_esim` | Cancel an unused eSIM and refund to balance | write (destructive) |
| `suspend_esim` / `activate_esim` | Block / restore network access | write |
| `send_sms` | Text the device holding the eSIM | write |
| `set_webhook` | Configure webhook URL and events | write |

Prompts: `esimfly_integration_guide` (optional `stack`), `diagnose_esim` (`iccid`).

## Safety model

- Read-only unless `ESIMFLY_MCP_ALLOW_WRITES=true`.
- Write tools are two-step: a call without `confirm` returns a preview and makes no mutable API call;
  `create_order` additionally requires the `idempotency_key` from its own preview, so an agent
  cannot place the same order twice.
- Tool annotations mark reads as `readOnlyHint` and cancel/suspend as `destructiveHint`, so hosts
  that ask for user approval on risky tools do so.
- The server never logs credentials and never writes to stdout except the MCP protocol.
- Give the agent a dedicated API key with the smallest rate limits you are comfortable with, and
  rotate it from the dashboard if in doubt.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `ESIMFLY_ACCESS_CODE` | yes | API access code (`esf_…`) |
| `ESIMFLY_SECRET_KEY` | yes | API secret key (`sk_…`) |
| `ESIMFLY_MCP_ALLOW_WRITES` | no | `true` to register write tools |
| `ESIMFLY_BASE_URL` | no | Override the API base URL |

## Embedding

```ts
import { createEsimflyMcpServer } from '@esimfly/mcp';
const server = createEsimflyMcpServer({ config: { accessCode, secretKey }, allowWrites: false });
// connect it to any MCP transport
```

## Releasing (maintainers)

Bump `version` in `package.json`, `server.json` and `MCP_VERSION` in `src/server.ts`, add a
CHANGELOG entry, push, then publish a GitHub Release tagged `vX.Y.Z` — the workflow publishes to
npm with Trusted Publishing (OIDC), and the MCP Registry entry is republished
automatically afterwards (GitHub OIDC, no tokens).

## Support

support@esimfly.net · https://docs.esimfly.net
