import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ESIMflyError, type ESIMfly } from '@esimfly/sdk';
import { createEsimflyMcpServer } from '../src/server.js';

const pkg = { package_code: 'P1', name: 'Turkey 1 GB 7 Days', region: 'Turkey', type: 'local', data_amount_gb: 1, validity_days: 7, cost: 2.72, currency: 'USD', features: {}, is_unlimited: false, countries: ['TR'], networks: [{}, {}] };

function fakeClient(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const rec = (name: string, value: unknown) => async (...args: unknown[]) => { calls.push(`${name}:${JSON.stringify(args)}`); return value; };
  const client = {
    balance: { get: rec('balance.get', { balance: 100, currency: 'USD' }) },
    packages: { list: rec('packages.list', { packages: [pkg], pagination: { page: 1, limit: 20, total: 1, total_pages: 1 } }) },
    esims: {
      list: rec('esims.list', { esims: [], pagination: { page: 1, limit: 20, total: 0, total_pages: 0 } }),
      usage: rec('esims.usage', { esim: { iccid: '8948', order_id: 'o1', status: 'NEW' }, data: {}, validity: { activated_at: null } }),
      status: rec('esims.status', { iccid: '8948', status: 'ACTIVE' }),
      networkEvents: rec('esims.networkEvents', { events: [] }),
      usageReport: rec('esims.usageReport', { period_days: 7 }),
      cancel: rec('esims.cancel', { cancelled_esims: 1 }),
      suspend: rec('esims.suspend', { esim_status: 'Disconnected' }),
      activate: rec('esims.activate', { esim_status: 'Active' }),
      sendSms: rec('esims.sendSms', undefined),
    },
    orders: {
      list: rec('orders.list', { orders: [] }),
      get: rec('orders.get', { orderReference: 'o1' }),
      create: rec('orders.create', { orderReference: 'o9', status: 'completed', amount: 2.72, currency: 'USD', newBalance: 97.28, esims: [{ iccid: '1', lpaString: 'LPA:1$x$y', isPending: false }] }),
    },
    topups: {
      packages: rec('topups.packages', { packages: [{ package_code: 'T1', name: 'Top 1GB', data_amount_gb: 1, validity_days: 7, cost: 2, currency: 'USD' }] }),
      create: rec('topups.create', { orderReference: 't1' }),
    },
    webhooks: { get: rec('webhooks.get', { webhook: null }), set: rec('webhooks.set', { webhook: { secret: 'whsec_x' } }) },
    ...overrides,
  };
  return { client: client as unknown as ESIMfly, calls };
}

async function connect(opts: Parameters<typeof createEsimflyMcpServer>[0]) {
  const server = createEsimflyMcpServer(opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(clientT);
  return mcp;
}

const textOf = (r: unknown) => ((r as { content: Array<{ type: string; text: string }> }).content[0]!).text;
const jsonOf = (r: unknown) => JSON.parse(textOf(r));

describe('read-only server', () => {
  it('exposes only read tools by default, all marked read-only', async () => {
    const { client } = fakeClient();
    const mcp = await connect({ client });
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_balance', 'get_esim_live_status', 'get_esim_usage', 'get_network_events', 'get_order', 'get_topup_packages',
      'get_usage_report', 'get_webhook_settings', 'list_esims', 'list_orders', 'search_packages',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const { prompts } = await mcp.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['diagnose_esim', 'esimfly_integration_guide']);
  });

  it('search_packages returns compact rows and applies a default limit', async () => {
    const { client, calls } = fakeClient();
    const mcp = await connect({ client });
    const res = jsonOf(await mcp.callTool({ name: 'search_packages', arguments: { search: 'Turkey' } }));
    expect(res.packages[0]).toMatchObject({ package_code: 'P1', cost: 2.72, currency: 'USD', networks: 2, countries: ['TR'] });
    expect(calls[0]).toContain('"limit":20');
  });

  it('maps API errors to isError results with the code', async () => {
    const { client } = fakeClient({ balance: { get: async () => { throw new ESIMflyError('Rate limit exceeded', { code: 'RATE_LIMIT_EXCEEDED', status: 401 }); } } });
    const mcp = await connect({ client });
    const res = await mcp.callTool({ name: 'get_balance', arguments: {} });
    expect(res.isError).toBe(true);
    expect(jsonOf(res)).toMatchObject({ error: 'RATE_LIMIT_EXCEEDED', status: 401 });
  });

  it('get_esim_usage accepts iccid or order_reference and rejects neither', async () => {
    const { client, calls } = fakeClient();
    const mcp = await connect({ client });
    await mcp.callTool({ name: 'get_esim_usage', arguments: { order_reference: 'o1' } });
    expect(calls[0]).toBe('esims.usage:[{"orderId":"o1"}]');
    const res = await mcp.callTool({ name: 'get_esim_usage', arguments: {} });
    expect(res.isError).toBe(true);
  });

  it('serves the integration guide prompt from the docs (with offline fallback)', async () => {
    const { client } = fakeClient();
    const mcp = await connect({ client, fetch: (async () => new Response('GUIDE TEXT', { status: 200 })) as typeof fetch });
    const p = await mcp.getPrompt({ name: 'esimfly_integration_guide', arguments: { stack: 'Node' } });
    expect((p.messages[0]!.content as { text: string }).text).toContain('GUIDE TEXT');
    expect((p.messages[0]!.content as { text: string }).text).toContain('My stack: Node');
    const offline = await connect({ client, fetch: (async () => { throw new Error('offline'); }) as typeof fetch });
    const q = await offline.getPrompt({ name: 'esimfly_integration_guide', arguments: {} });
    expect((q.messages[0]!.content as { text: string }).text).toContain('docs.esimfly.net');
  });
});

describe('write tools', () => {
  it('are absent unless allowWrites is set', async () => {
    const { client } = fakeClient();
    const mcp = await connect({ client, allowWrites: true });
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['create_order', 'topup_esim', 'cancel_esim', 'suspend_esim', 'activate_esim', 'send_sms', 'set_webhook']));
  });

  it('create_order previews without confirm, requires the idempotency key, then executes', async () => {
    const { client, calls } = fakeClient();
    const mcp = await connect({ client, allowWrites: true });
    const preview = jsonOf(await mcp.callTool({ name: 'create_order', arguments: { package_code: 'P1' } }));
    expect(preview.preview).toBe(true);
    expect(preview.idempotency_key).toMatch(/^mcp-/);
    expect(calls.some((c) => c.startsWith('orders.create'))).toBe(false);

    const noKey = await mcp.callTool({ name: 'create_order', arguments: { package_code: 'P1', confirm: true } });
    expect(noKey.isError).toBe(true);
    expect(calls.some((c) => c.startsWith('orders.create'))).toBe(false);

    const done = jsonOf(await mcp.callTool({ name: 'create_order', arguments: { package_code: 'P1', confirm: true, idempotency_key: preview.idempotency_key } }));
    expect(done.orderReference).toBe('o9');
    expect(calls.find((c) => c.startsWith('orders.create'))).toContain(`"idempotencyKey":"${preview.idempotency_key}"`);
  });

  it('topup_esim preview resolves the package and cost; confirm executes', async () => {
    const { client, calls } = fakeClient();
    const mcp = await connect({ client, allowWrites: true });
    const preview = jsonOf(await mcp.callTool({ name: 'topup_esim', arguments: { iccid: '8948010010036785060', package_code: 'T1' } }));
    expect(preview.package).toMatchObject({ name: 'Top 1GB', cost: 2 });
    expect(calls.some((c) => c.startsWith('topups.create'))).toBe(false);
    await mcp.callTool({ name: 'topup_esim', arguments: { iccid: '8948010010036785060', package_code: 'T1', confirm: true } });
    expect(calls.some((c) => c.startsWith('topups.create'))).toBe(true);
  });

  it('destructive tools never execute without confirm', async () => {
    const { client, calls } = fakeClient();
    const mcp = await connect({ client, allowWrites: true });
    for (const name of ['cancel_esim', 'suspend_esim', 'activate_esim']) {
      const r = jsonOf(await mcp.callTool({ name, arguments: { iccid: '8948010010036785060' } }));
      expect(r.preview).toBe(true);
    }
    await mcp.callTool({ name: 'send_sms', arguments: { iccid: '8948010010036785060', message: 'hi' } });
    expect(calls.filter((c) => /cancel|suspend|activate|sendSms/.test(c))).toHaveLength(0);
  });
});
