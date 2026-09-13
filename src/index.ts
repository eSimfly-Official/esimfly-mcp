/**
 * CLI entry: `npx -y @esimfly/mcp` (stdio transport).
 *
 * Env: ESIMFLY_ACCESS_CODE, ESIMFLY_SECRET_KEY (required),
 *      ESIMFLY_MCP_ALLOW_WRITES=true (optional), ESIMFLY_BASE_URL (optional).
 * Never write to stdout here — it is the MCP protocol channel.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createEsimflyMcpServer, MCP_VERSION } from './server.js';

const accessCode = process.env.ESIMFLY_ACCESS_CODE;
const secretKey = process.env.ESIMFLY_SECRET_KEY;

if (!accessCode || !secretKey) {
  console.error(
    '[esimfly-mcp] Missing credentials. Set ESIMFLY_ACCESS_CODE and ESIMFLY_SECRET_KEY ' +
      '(Business Dashboard → Settings → API Keys). See https://docs.esimfly.net',
  );
  process.exit(1);
}

const allowWrites = /^(1|true|yes)$/i.test(process.env.ESIMFLY_MCP_ALLOW_WRITES ?? '');

const server = createEsimflyMcpServer({
  config: {
    accessCode,
    secretKey,
    baseUrl: process.env.ESIMFLY_BASE_URL,
    userAgent: `esimfly-mcp/${MCP_VERSION}`,
  },
  allowWrites,
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[esimfly-mcp] v${MCP_VERSION} ready (${allowWrites ? 'read + write tools' : 'read-only'})`);
