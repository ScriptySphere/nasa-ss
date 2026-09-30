import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { findHdu, readHeader, type FitsHeader, type Hdu } from "./fits.ts";

const USER_AGENT = "planet-x-spherx-sleuth/0.1 (NASA Space Apps 2026)";
const HEADER_CHUNK = 36 * 2880;

export class RemoteMef {
    readonly url: string;
    private readonly sizeBytes: number;
    private hdus: Hdu[] | null;

    private constructor(url: string, sizeBytes: number) {
        this.url = url;
        this.sizeBytes = sizeBytes;
        this.hdus = null;
    }

    static async open(url: string): Promise<RemoteMef> {
        const head = await fetch(url, { method: "HEAD", headers: { "user-agent": USER_AGENT } });
        if (!head.ok) throw new Error(`HEAD ${url} -> HTTP ${head.status}`);
        const length = Number(head.headers.get("content-length") ?? "0");
        return new RemoteMef(url, Number.isFinite(length) ? length : 0);
    }

    private async readRange(start: number, end: number): Promise<Buffer> {
        const from = Math.max(0, start);
        const to = this.sizeBytes > 0 ? Math.min(this.sizeBytes - 1, end) : end;
        if (to < from) return Buffer.alloc(0);
        const response = await fetch(this.url, {
            headers: { "user-agent": USER_AGENT, range: `bytes=${from}-${to}` },
        });

        if (response.status !== 206 && response.status !== 200) {
            throw new Error(`range ${from}-${to} of ${this.url} -> HTTP ${response.status}`);
        }
        return Buffer.from(await response.arrayBuffer());
    }

    async layout(): Promise<Hdu[]> {
        if (this.hdus) return this.hdus;

        const cacheFile = RemoteMef.layoutCachePath(this.url);
        try {
            const cached = JSON.parse(await readFile(cacheFile, "utf8")) as {
                dataStart: number;
                dataBytes: number;
                nextStart: number;
                axes: number[];
                bitpix: number;
                name: string;
                headerValues: Record<string, string>;
            }[];
            this.hdus = cached.map((h, index) => ({
                index,
                name: h.name,
                header: { values: new Map(Object.entries(h.headerValues)), cards: [], dataStart: 0 },
                bitpix: h.bitpix as Hdu["bitpix"],
                axes: h.axes,
                dataStart: h.dataStart,
                dataBytes: h.dataBytes,
                nextStart: h.nextStart,
            }));
            return this.hdus;
        } catch {}

        const hdus: Hdu[] = [];
        let offset = 0;

        for (let guard = 0; guard < 12; guard += 1) {
            const chunk = await this.readRange(offset, offset + HEADER_CHUNK);
            if (chunk.length === 0) break;
            let header: FitsHeader;
            try {
                header = readHeader(chunk, 0);
            } catch {
                break;
            }

            const naxis = Number(header.values.get("NAXIS") ?? "0");
            const bitpix = Number(header.values.get("BITPIX") ?? "8");
            const width = Math.abs(bitpix) / 8;
            const axes: number[] = [];
            for (let a = 1; a <= naxis; a += 1) axes.push(Number(header.values.get(`NAXIS${a}`)));

            let elements = 1;
            if (naxis === 0) elements = 0;
            else for (const n of axes) elements *= n;

            let dataBytes = width * elements;
            if (header.values.get("XTENSION") === "BINTABLE") {
                dataBytes = (axes[0] ?? 0) * (axes[1] ?? 0) + Number(header.values.get("PCOUNT") ?? "0");
            }
            const padded = dataBytes > 0 ? Math.ceil(dataBytes / 2880) * 2880 : 0;
            const absoluteDataStart = offset + header.dataStart;

            hdus.push({
                index: hdus.length,
                name: (header.values.get("EXTNAME") ?? "PRIMARY").trim(),
                header,
                bitpix: bitpix as Hdu["bitpix"],
                axes,
                dataStart: absoluteDataStart,
                dataBytes,
                nextStart: absoluteDataStart + padded,
            });
            offset = absoluteDataStart + padded;
        }

        try {
            await mkdir(dirname(cacheFile), { recursive: true });
            await writeFile(
                cacheFile,
                JSON.stringify(
                    hdus.map(h => ({
                        name: h.name,
                        axes: h.axes,
                        bitpix: h.bitpix,
                        dataStart: h.dataStart,
                        dataBytes: h.dataBytes,
                        nextStart: h.nextStart,
                        headerValues: Object.fromEntries(h.header.values),
                    })),
                ),
            );
        } catch {}

        this.hdus = hdus;
        return hdus;
    }

    private static layoutCachePath(url: string): string {
        const dir = process.env["SPHEREX_CACHE"] ?? join(process.cwd(), ".cache", "layout");
        const key = createHash("sha1").update(url).digest("hex").slice(0, 24);
        return join(dir, `${key}.json`);
    }

    async hdu(name: string): Promise<Hdu> {
        return findHdu(await this.layout(), name);
    }

    /** read and clamp a rectangular image box in FITS coordinates. */
    async readBox(
        hdu: Hdu,
        box: { x0: number; x1: number; y0: number; y1: number },
    ): Promise<{ data: Float64Array; nx: number; ny: number; x0: number; y0: number }> {
        const nx = hdu.axes[0] as number;
        const ny = hdu.axes[1] as number;
        const bytesPerPixel = Math.abs(hdu.bitpix) / 8;

        const x0 = Math.max(1, Math.floor(box.x0));
        const x1 = Math.min(nx, Math.ceil(box.x1));
        const y0 = Math.max(1, Math.floor(box.y0));
        const y1 = Math.min(ny, Math.ceil(box.y1));
        if (x1 < x0 || y1 < y0) throw new Error(`readBox: empty box for ${hdu.name}`);

        const outWidth = x1 - x0 + 1;
        const outHeight = y1 - y0 + 1;

        const byteStart = hdu.dataStart + (y0 - 1) * nx * bytesPerPixel;
        const byteEnd = hdu.dataStart + y1 * nx * bytesPerPixel - 1;
        const raw = await this.readRange(byteStart, byteEnd);
        if (raw.length < (y1 - y0 + 1) * nx * bytesPerPixel) {
            throw new Error(`readBox: short read for ${hdu.name} (${raw.length} bytes)`);
        }

        const data = new Float64Array(outWidth * outHeight);
        for (let row = 0; row < outHeight; row += 1) {
            for (let col = 0; col < outWidth; col += 1) {
                const srcIndex = row * nx + (x0 - 1 + col);
                const byteOffset = srcIndex * bytesPerPixel;
                let value: number;
                if (hdu.bitpix === -32) value = raw.readFloatBE(byteOffset);
                else if (hdu.bitpix === -64) value = raw.readDoubleBE(byteOffset);
                else if (hdu.bitpix === 32) value = raw.readInt32BE(byteOffset);
                else if (hdu.bitpix === 16) value = raw.readInt16BE(byteOffset);
                else value = raw.readUInt8(byteOffset);
                data[row * outWidth + col] = value;
            }
        }
        return { data, nx: outWidth, ny: outHeight, x0, y0 };
    }

    async readTable(hdu: Hdu): Promise<Buffer> {
        return this.readRange(hdu.dataStart, hdu.dataStart + hdu.dataBytes - 1);
    }
}
