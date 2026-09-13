# Security

## Reporting a vulnerability

Email **support@esimfly.net** with the subject "MCP security". Please do not open a public issue.

## Design

- The server runs locally (stdio) with credentials from environment variables; they are used only by
  the bundled `@esimfly/sdk` to sign requests and are never logged or written to stdout.
- Read-only by default. Write tools require `ESIMFLY_MCP_ALLOW_WRITES=true` and a second call with
  `confirm: true`; `create_order` also requires the idempotency key from its own preview.
- Cancel and suspend are annotated `destructiveHint` so MCP hosts can require user approval.
- Do not expose this server over the network. If you need remote access, put it behind your own
  authenticated gateway and a dedicated, rate-limited API key.
