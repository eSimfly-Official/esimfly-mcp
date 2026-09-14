/**
 * eSIMfly MCP server — exposes the eSIMfly Business API to AI agents as tools.
 *
 * Read tools are always available. Write tools (orders, top-ups, cancel,
 * suspend, SMS, webhook config) exist only when `allowWrites` is on, and each
 * one is two-step: a call without `confirm: true` returns a preview (what it
 * will do, what it costs, your balance) and never touches the API mutably.
 */
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ESIMfly, ESIMflyError, type ESIMflyConfig, type Package } from '@esimfly/sdk';

export const MCP_VERSION = '0.1.3';
const FULL_PROMPT_URL = 'https://docs.esimfly.net/llm/esimfly-api-full-prompt.txt';
const DOCS_URL = 'https://docs.esimfly.net';

export interface EsimflyMcpOptions {
  /** Pre-built client (tests, embedding). Takes precedence over `config`. */
  client?: ESIMfly;
  /** Credentials used to build the client when `client` is not given. */
  config?: ESIMflyConfig;
  /** Register the money-moving / state-changing tools. Default false. */
  allowWrites?: boolean;
  /** Used to fetch the integration prompt for the `esimfly_integration_guide` prompt. */
  fetch?: typeof fetch;
}

type ToolResult = CallToolResult;

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const failure = (err: unknown): ToolResult => {
  if (err instanceof ESIMflyError) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({ error: err.code, message: err.message, status: err.status ?? null, details: err.response ?? null }, null, 2),
      }],
    };
  }
  return { isError: true, content: [{ type: 'text', text: `Unexpected error: ${(err as Error)?.message ?? String(err)}` }] };
};

const run = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    return failure(err);
  }
};

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

const iccidArg = z.string().min(15).max(22).describe('ICCID of the eSIM (19-20 digits)');

function compactPackage(p: Package) {
  return {
    package_code: p.package_code,
    name: p.name,
    region: p.region,
    type: p.type,
    data_gb: p.data_amount_gb,
    validity_days: p.validity_days,
    cost: p.cost,
    currency: p.currency,
    is_unlimited: p.is_unlimited,
    has_voice: p.has_voice ?? false,
    has_sms: p.has_sms ?? false,
    countries: p.countries ? (p.countries.length > 12 ? [...p.countries.slice(0, 12), `+${p.countries.length - 12} more`] : p.countries) : undefined,
    networks: p.networks?.length ?? p.locationNetworkList?.reduce((n, l) => n + (l.operatorList?.length ?? 0), 0),
  };
}

export function createEsimflyMcpServer(options: EsimflyMcpOptions = {}): McpServer {
  const client = options.client ?? new ESIMfly(options.config ?? ({} as ESIMflyConfig));
  const allowWrites = options.allowWrites ?? false;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const server = new McpServer(
    {
      name: 'esimfly',
      version: MCP_VERSION,
      title: 'eSIMfly',
      description: 'Wholesale eSIM data plans for 200+ countries: search plans with your prices, check balance and usage, diagnose eSIM connectivity, and (opt-in) order and top up.',
      websiteUrl: 'https://esimfly.net/esim-api',
      icons: [
        { src: 'https://esimfly.net/images/logo-blue.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
        { src: 'https://esimfly.net/images/logo.png', mimeType: 'image/png' },
      ],
    },
    {
      instructions: [
        'Tools for the eSIMfly Business API (wholesale eSIM data plans for 200+ countries).',
        'Package codes are opaque strings: pass them back exactly as returned. Prices (cost) are the partner buy price in the account currency.',
        'get_esim_usage is cheap; get_esim_live_status and get_network_events query the mobile network live — use them for diagnosis, not routinely.',
        allowWrites
          ? 'Write tools are enabled. Every write is two-step: call without confirm to get a preview (cost, balance), then call again with confirm: true. Never confirm on the user\'s behalf without telling them the cost.'
          : 'This server is read-only: ordering, top-ups, cancel, suspend, SMS and webhook changes are disabled (start with ESIMFLY_MCP_ALLOW_WRITES=true to enable).',
        `Documentation: ${DOCS_URL}`,
      ].join('\n'),
    },
  );

  // ------------------------------------------------------------------ read tools
  server.registerTool(
    'search_packages',
    {
      title: 'Search eSIM packages',
      description:
        'Find eSIM data packages you can sell, with your wholesale price. Filter by destination name (search), type (local / regional / global) and page. Returns compact rows; use limit up to 100.',
      inputSchema: {
        search: z.string().optional().describe('Country or region name, e.g. "Turkey", "Europe"'),
        type: z.enum(['local', 'regional', 'global']).optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
      },
      annotations: READ,
    },
    async ({ search, type, page, limit }) =>
      run(async () => {
        const res = await client.packages.list({ search, type, page, limit: limit ?? 20 });
        return text({ pagination: res.pagination, packages: res.packages.map(compactPackage) });
      }),
  );

  server.registerTool(
    'get_balance',
    { title: 'Get account balance', description: 'Current prepaid balance (or enterprise balance) and currency.', inputSchema: {}, annotations: READ },
    async () => run(async () => text(await client.balance.get())),
  );

  server.registerTool(
    'list_esims',
    {
      title: 'List eSIMs',
      description: 'eSIMs on the account with status, data left and validity. Search by ICCID, package name or code; filter by status.',
      inputSchema: {
        search: z.string().optional(),
        status: z.enum(['all', 'NEW', 'ACTIVE', 'EXPIRED', 'CANCELLED', 'DEPLETED', 'DELETED']).optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
      },
      annotations: READ,
    },
    async ({ search, status, page, limit }) =>
      run(async () => {
        const res = await client.esims.list({ search, status, page, limit: limit ?? 20 });
        return text({
          pagination: res.pagination,
          esims: res.esims.map((e) => ({
            id: e.id,
            iccid: e.iccid,
            package_name: e.package_name,
            package_code: e.package_code,
            status: e.status,
            data: e.data,
            validity: e.validity,
            countries: e.countries,
            created_at: e.created_at,
            esim_status: e.esim_status ?? null,
            profile_status: e.profile_status ?? null,
          })),
        });
      }),
  );

  server.registerTool(
    'get_esim_usage',
    {
      title: 'Get eSIM usage',
      description: 'Stored data usage and validity for one eSIM (cheap; fresh as of the last sync). Identify by ICCID or order reference.',
      inputSchema: { iccid: z.string().optional(), order_reference: z.string().optional() },
      annotations: READ,
    },
    async ({ iccid, order_reference }) =>
      run(async () => {
        if (!iccid && !order_reference) throw new ESIMflyError('Provide iccid or order_reference', { code: 'MISSING_IDENTIFIER' });
        return text(await client.esims.usage(iccid ? { iccid } : { orderId: order_reference! }));
      }),
  );

  server.registerTool(
    'get_esim_live_status',
    {
      title: 'Get live eSIM status (network query)',
      description:
        'LIVE status straight from the mobile network: lifecycle status, profile install state, last network (operator, country, MCC/MNC, 4G/5G), device model and IMEI, activation and last-usage dates, data used. Expensive — use for diagnosis ("no data", "is it installed?"), not routinely.',
      inputSchema: { iccid: iccidArg },
      annotations: READ,
    },
    async ({ iccid }) => run(async () => text(await client.esims.status({ iccid }))),
  );

  server.registerTool(
    'get_network_events',
    {
      title: 'Get network events (last 7 days)',
      description:
        'Attach and data-session events for one eSIM, newest first, each flagged is_allowed. wrong_network_count > 0 means the device latched onto a network outside the plan — the usual cause of "connected but no data" (fix: airplane-mode toggle or manual network selection).',
      inputSchema: { iccid: iccidArg },
      annotations: READ,
    },
    async ({ iccid }) => run(async () => text(await client.esims.networkEvents({ iccid }))),
  );

  server.registerTool(
    'get_usage_report',
    {
      title: 'Get daily usage report',
      description: 'Daily data usage for one eSIM over the last N days (default 7, max 90) with per-country and per-operator breakdown.',
      inputSchema: { iccid: iccidArg, days: z.number().int().min(1).max(90).optional() },
      annotations: READ,
    },
    async ({ iccid, days }) => run(async () => text(await client.esims.usageReport({ iccid }, days))),
  );

  server.registerTool(
    'list_orders',
    {
      title: 'List orders',
      description: 'Order history with filters (status, date range ISO 8601, search by reference / package) and a revenue summary.',
      inputSchema: {
        status: z.enum(['all', 'pending', 'completed', 'failed', 'cancelled']).optional(),
        from_date: z.string().optional(),
        to_date: z.string().optional(),
        search: z.string().optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
      },
      annotations: READ,
    },
    async ({ status, from_date, to_date, search, page, limit }) =>
      run(async () => text(await client.orders.list({ status, from_date, to_date, search, page, limit: limit ?? 20 }))),
  );

  server.registerTool(
    'get_order',
    {
      title: 'Get order',
      description: 'One order by reference, including its eSIM (ICCID, install links, pending state).',
      inputSchema: { order_reference: z.string() },
      annotations: READ,
    },
    async ({ order_reference }) => run(async () => text(await client.orders.get(order_reference))),
  );

  server.registerTool(
    'get_topup_packages',
    {
      title: 'Get top-up packages for an eSIM',
      description: 'Top-up options for ONE eSIM (they depend on its provider and location), with your price. Returns ESIM_NOT_TOPPABLE when the eSIM state does not allow top-ups.',
      inputSchema: { iccid: iccidArg, limit: z.number().int().min(1).max(100).optional() },
      annotations: READ,
    },
    async ({ iccid, limit }) => run(async () => text(await client.topups.packages({ iccid, limit: limit ?? 50 }))),
  );

  server.registerTool(
    'get_webhook_settings',
    {
      title: 'Get webhook settings',
      description: 'Configured webhook URL, subscribed events, available events and the last deliveries.',
      inputSchema: {},
      annotations: READ,
    },
    async () => run(async () => text(await client.webhooks.get())),
  );

  // ------------------------------------------------------------------ write tools (opt-in, two-step)
  if (allowWrites) {
    const confirmArg = z.boolean().optional().describe('Omit to get a preview; pass true to execute');

    server.registerTool(
      'create_order',
      {
        title: 'Create eSIM order (spends balance)',
        description:
          'Buy one or more eSIMs of a package from the account balance. Two-step: first call returns a preview with the current balance and a generated idempotency_key; call again with confirm: true AND that idempotency_key to execute. Tell the user the cost before confirming.',
        inputSchema: {
          package_code: z.string().describe('Exact package_code from search_packages'),
          quantity: z.number().int().min(1).max(10).optional(),
          idempotency_key: z.string().max(200).optional().describe('From the preview; required with confirm: true'),
          confirm: confirmArg,
        },
        annotations: WRITE,
      },
      async ({ package_code, quantity, idempotency_key, confirm }) =>
        run(async () => {
          if (!confirm) {
            const balance = await client.balance.get();
            return text({
              preview: true,
              action: 'create_order',
              package_code,
              quantity: quantity ?? 1,
              balance_before: balance,
              idempotency_key: `mcp-${randomUUID()}`,
              next_step: 'Call create_order again with confirm: true and this idempotency_key to place the order. The API charges the current package price.',
            });
          }
          if (!idempotency_key) {
            throw new ESIMflyError('confirm: true requires the idempotency_key returned by the preview', { code: 'MISSING_FIELDS' });
          }
          const order = await client.orders.create({ packageCode: package_code, quantity, idempotencyKey: idempotency_key });
          return text({
            orderReference: order.orderReference,
            status: order.status,
            duplicate: order.duplicate ?? false,
            amount: order.amount,
            currency: order.currency,
            newBalance: order.newBalance,
            esims: order.esims.map((e) => ({
              iccid: e.iccid,
              lpaString: e.lpaString,
              directAppleInstallUrl: e.directAppleInstallUrl,
              directAndroidInstallUrl: e.directAndroidInstallUrl,
              expired_time: e.expired_time,
              isPending: e.isPending,
            })),
          });
        }),
    );

    server.registerTool(
      'topup_esim',
      {
        title: 'Top up an eSIM (spends balance)',
        description: 'Add a package to an existing eSIM. Two-step: without confirm returns the package name, cost and current balance; with confirm: true executes.',
        inputSchema: { iccid: iccidArg, package_code: z.string().describe('From get_topup_packages'), confirm: confirmArg },
        annotations: WRITE,
      },
      async ({ iccid, package_code, confirm }) =>
        run(async () => {
          if (!confirm) {
            const [pkgs, balance] = await Promise.all([client.topups.packages({ iccid, limit: 100 }), client.balance.get()]);
            const pkg = pkgs.packages.find((p) => p.package_code === package_code) ?? null;
            return text({
              preview: true,
              action: 'topup_esim',
              iccid,
              package: pkg ? { package_code: pkg.package_code, name: pkg.name, data_gb: pkg.data_amount_gb, validity_days: pkg.validity_days, cost: pkg.cost, currency: pkg.currency } : null,
              warning: pkg ? undefined : 'package_code is not in the top-up list for this eSIM; the call will fail',
              balance_before: balance,
              next_step: 'Call topup_esim again with confirm: true to execute.',
            });
          }
          return text(await client.topups.create({ iccid, packageCode: package_code }));
        }),
    );

    server.registerTool(
      'cancel_esim',
      {
        title: 'Cancel an unused eSIM (refund to balance)',
        description: 'Cancel an eSIM that has never been installed / activated and refund it to the balance. Cancels EVERY eligible eSIM in the same order. Two-step: confirm: true to execute.',
        inputSchema: { iccid: iccidArg, confirm: confirmArg },
        annotations: DESTRUCTIVE,
      },
      async ({ iccid, confirm }) =>
        run(async () => {
          if (!confirm) {
            const usage = await client.esims.usage({ iccid }).catch(() => null);
            return text({
              preview: true,
              action: 'cancel_esim',
              iccid,
              current: usage ? { status: usage.esim.status, order_id: usage.esim.order_id, activated_at: usage.validity.activated_at } : null,
              warning: 'All eligible eSIMs in the same order will be cancelled together. Installed or activated eSIMs are not eligible.',
              next_step: 'Call cancel_esim again with confirm: true to execute.',
            });
          }
          return text(await client.esims.cancel({ iccid }));
        }),
    );

    server.registerTool(
      'suspend_esim',
      {
        title: 'Suspend an eSIM (block network access)',
        description: 'Block network access for an eSIMfly-network eSIM (reversible with activate_esim). Two-step: confirm: true to execute.',
        inputSchema: { iccid: iccidArg, confirm: confirmArg },
        annotations: DESTRUCTIVE,
      },
      async ({ iccid, confirm }) =>
        run(async () => {
          if (!confirm) return text({ preview: true, action: 'suspend_esim', iccid, next_step: 'Call again with confirm: true to block network access.' });
          return text(await client.esims.suspend({ iccid }));
        }),
    );

    server.registerTool(
      'activate_esim',
      {
        title: 'Re-activate a suspended eSIM',
        description: 'Restore network access after suspend_esim. Two-step: confirm: true to execute.',
        inputSchema: { iccid: iccidArg, confirm: confirmArg },
        annotations: WRITE,
      },
      async ({ iccid, confirm }) =>
        run(async () => {
          if (!confirm) return text({ preview: true, action: 'activate_esim', iccid, next_step: 'Call again with confirm: true to restore network access.' });
          return text(await client.esims.activate({ iccid }));
        }),
    );

    server.registerTool(
      'send_sms',
      {
        title: 'Send an SMS to an eSIM',
        description: 'Send a text (max 500 characters) to the device holding the eSIM. Two-step: confirm: true to send.',
        inputSchema: { iccid: iccidArg, message: z.string().min(1).max(500), confirm: confirmArg },
        annotations: WRITE,
      },
      async ({ iccid, message, confirm }) =>
        run(async () => {
          if (!confirm) return text({ preview: true, action: 'send_sms', iccid, message, next_step: 'Call again with confirm: true to send.' });
          await client.esims.sendSms({ iccid }, message);
          return text({ sent: true, iccid });
        }),
    );

    server.registerTool(
      'set_webhook',
      {
        title: 'Set webhook URL and events',
        description: 'Configure (or rotate) the webhook URL and subscribed events. The response contains the signing secret — shown once. Two-step: confirm: true to apply.',
        inputSchema: {
          webhook_url: z.string().url(),
          events: z.array(z.enum(['esim.installed', 'esim.profile.updated', 'esim.status.changed', 'esim.usage.threshold', 'esim.provisioned', 'order.completed'])).optional(),
          confirm: confirmArg,
        },
        annotations: WRITE,
      },
      async ({ webhook_url, events, confirm }) =>
        run(async () => {
          if (!confirm) return text({ preview: true, action: 'set_webhook', webhook_url, events: events ?? null, next_step: 'Call again with confirm: true to apply. Store the returned secret securely.' });
          return text(await client.webhooks.set({ webhookUrl: webhook_url, events }));
        }),
    );
  }

  // ------------------------------------------------------------------ prompts
  server.registerPrompt(
    'esimfly_integration_guide',
    {
      title: 'eSIMfly integration guide',
      description: 'The complete, always-current prompt for building an eSIMfly integration (all endpoints, recommended architecture, webhooks, SDK). Fetched from docs.esimfly.net.',
      argsSchema: { stack: z.string().optional().describe('Your language / framework / database, e.g. "Node.js + Prisma + Postgres"') },
    },
    async ({ stack }) => {
      let guide: string;
      try {
        const res = await fetchImpl(FULL_PROMPT_URL);
        guide = res.ok ? await res.text() : '';
      } catch {
        guide = '';
      }
      if (!guide) guide = `(Could not fetch the guide. Read it at ${FULL_PROMPT_URL})`;
      const extra = stack ? `\n\nMy stack: ${stack}. Start with the shared client and the catalogue sync job.` : '';
      return { messages: [{ role: 'user', content: { type: 'text', text: guide + extra } }] };
    },
  );

  server.registerPrompt(
    'diagnose_esim',
    {
      title: 'Diagnose an eSIM connectivity problem',
      description: 'Walks through the live status, network events and usage of one eSIM and explains what the customer should do.',
      argsSchema: { iccid: z.string().describe('ICCID of the eSIM') },
    },
    async ({ iccid }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Diagnose eSIM ${iccid}.`,
            '1. Call get_esim_usage to see status, data left and validity.',
            '2. Call get_esim_live_status: is the profile installed (profile = Enabled)? which device? which network did it last attach to?',
            '3. Call get_network_events: any is_allowed = false events (wrong network)? recent data sessions?',
            'Then explain in plain language what is wrong (not installed / wrong network / depleted / expired / never connected) and the exact steps the customer should take (install, enable data roaming, airplane-mode toggle, manual network selection, top-up).',
          ].join('\n'),
        },
      }],
    }),
  );

  return server;
}
