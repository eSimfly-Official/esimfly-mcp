# Changelog

## 0.2.0 — 2026-11-19

Built on `@esimfly/sdk` 0.2.0.

- **`topup_esim` is now idempotent:** the preview returns an `idempotency_key`, and `confirm: true`
  requires it (like `create_order`), so an agent retrying a top-up can never apply or charge it twice.
- **New read tool `get_topup`:** a top-up's status by its `orderReference`.
- `create_order` reports partial fills: `quantity`, `requested_quantity` and `note` (charged for
  `quantity` only).
- `search_packages` rows include `voice_minutes` / `sms_count` (a count or `'unlimited'`) on plans
  with voice / SMS, and `phone_number` / `roaming` on phone-number lines.

## 0.1.3 — 2026-09-14

Server metadata for directories and clients: title, description, website and icons in the MCP handshake (`serverInfo`).

## 0.1.2 — 2026-09-14

Hosted endpoint published: https://mcp.esimfly.net/mcp (OAuth 2.1, same tools). Registry entry now lists the remote alongside the npm package. No code changes.

## 0.1.1 — 2026-09-13

Registry metadata: correct MCP registry name (io.github.eSimfly-Official/esimfly-mcp). No functional change.

## 0.1.0 — 2026-09-13

Initial release: 11 read tools, 7 opt-in two-step write tools, `esimfly_integration_guide` and
`diagnose_esim` prompts. Stdio transport, built on @esimfly/sdk.
