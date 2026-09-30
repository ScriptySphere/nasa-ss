import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import ejs from "ejs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_SPIKE = join(HERE, "..", "backend", ".cache", "spike", "latest.json");
const PUBLIC_DIR = join(HERE, "public");
const VIEWS_DIR = join(HERE, "views");
const PORT = Number(process.env["PORT"] ?? "3000");

const MIME: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
};

interface Channel {
    lambdaMicron: number;
    bandwidthMicron: number;
    resolvingPower: number;
    detector: number;
    fluxMilliJy: number;
    fluxErrMilliJy: number;
    snr: number;
    sourceUri: string;
    dateObs: string;
}

interface SpikeRecord {
    target: { ra: number; dec: number; name: string };
    release: string;
    discoveredMefs: number;
    measured: Channel[];
    generatedAt: string;
}

async function loadSpike(): Promise<SpikeRecord | null> {
    if (!existsSync(BACKEND_SPIKE)) return null;
    try {
        return JSON.parse(await readFile(BACKEND_SPIKE, "utf8")) as SpikeRecord;
    } catch {
        return null;
    }
}

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
        const path = url.pathname;

        if (path === "/" || path === "/index.html") {
            const spike = await loadSpike();
            const html = await ejs.renderFile(join(VIEWS_DIR, "index.ejs"), {
                spike,
                title: "SPHEREx Spectral Sleuth — spike",
            });
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(html);
            return;
        }

        if (path === "/api/spike") {
            const spike = await loadSpike();
            res.writeHead(spike ? 200 : 503, { "content-type": MIME[".json"] as string });
            res.end(JSON.stringify(spike ?? { error: "no spike artifact yet; run the backend spike" }));
            return;
        }

        // Static files, confined to public/.
        const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
        const file = join(PUBLIC_DIR, safe);
        if (file.startsWith(PUBLIC_DIR) && existsSync(file)) {
            res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
            res.end(await readFile(file));
            return;
        }

        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
    } catch (error) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`server error: ${error instanceof Error ? error.message : String(error)}`);
    }
});

server.listen(PORT, () => {
    process.stdout.write(`frontend listening on http://localhost:${PORT}\n`);
});
