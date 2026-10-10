import { createServer, type ServerResponse } from 'node:http';

/** Official SDK fixture: records actual HTTP traffic, including closed streaming connections. */
export async function scriptedModelServer() {
  const requests: Record<string, unknown>[] = [];
  const active = new Set<ServerResponse>();
  let totalRequests = 0;
  let probeRequests = 0;
  let mode: 'normal' | 'rate-limit' | 'bad-request' | 'hang' | 'disconnect' | 'probe-hang' = 'normal';
  const server = createServer((request, response) => { void (async () => {
    totalRequests += 1;
    if (totalRequests > 100) { response.writeHead(400).end(); return; }
    // 模型发现是无请求体的 GET /models：空 body 不是 JSON，夹具直接回答唯一的候选模型，
    // 让生产界面的「查询此连接的模型…」有真实响应可解析。它不是对话流量，不进 requests。
    if (request.method === 'GET' && request.url?.endsWith('/models') === true) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model', owned_by: 'fixture' }] }));
      return;
    }
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) { response.writeHead(413).end(); return; }
    }
    const input = JSON.parse(body) as Record<string, unknown>;
    const messages = input['messages'] as { role: string; content: unknown }[];
    const probe = messages.some(message => message.role === 'user' &&
      /^(ping|capability cancellation probe|Call the capability_probe tool\.)$/.test(String(message.content)));
    if (!probe) requests.push(input);
    active.add(response);
    response.on('close', () => active.delete(response));
    if (probe && messages.some(message => message.content === 'capability cancellation probe')) return;
    if (probe) {
      probeRequests += 1;
      // probe-hang 把能力核验卡在第一条，用来观察 Ctrl+C 落在核验窗口时的真实取消。
      if (mode === 'probe-hang') return;
    }
    if (!probe && (mode === 'rate-limit' || mode === 'bad-request')) {
      response.writeHead(mode === 'rate-limit' ? 429 : 400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'scripted failure', type: 'fixture_error' } }));
      return;
    }
    const tool = messages.some(message => message.role === 'tool');
    const wantedTool = !tool && (probe ? messages.some(message => message.content === 'Call the capability_probe tool.')
      : messages.some(message => String(message.content).includes('__TOOL__')));
    const toolCall = { id: 'fixture-call', type: 'function', function: {
      name: probe ? 'capability_probe' : 'read_file', arguments: probe ? '{}' : JSON.stringify({ path: 'sample.txt' }),
    } };
    const content = probe ? 'probe ok' : tool ? '工具结果已收到' : 'E2E回复';
    const common = { id: 'fixture-response', object: 'chat.completion', created: 1, model: 'fixture-model' };
    const usage = { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 };
    if (input['stream'] !== true) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...common, choices: [{ index: 0, message: { role: 'assistant',
        content: wantedTool ? '' : content, ...(wantedTool ? { tool_calls: [toolCall] } : {}) },
        finish_reason: wantedTool ? 'tool_calls' : 'stop' }], usage }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = (delta: unknown, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({
      ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
    event({ role: 'assistant', content: wantedTool ? '' : content,
      ...(wantedTool ? { tool_calls: [{ index: 0, ...toolCall }] } : {}) });
    if (!probe && mode === 'hang') return;
    if (!probe && mode === 'disconnect') { response.destroy(); return; }
    event({}, wantedTool ? 'tool_calls' : 'stop');
    response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [], usage })}\n\n`);
    response.end('data: [DONE]\n\n');
  })().catch(() => { response.writeHead(500).end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture server not listening');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests,
    setMode: (next: typeof mode) => { mode = next; },
    activeRequests: () => active.size,
    totalRequests: () => totalRequests,
    probeRequests: () => probeRequests,
    close: async () => {
      for (const response of active) response.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
