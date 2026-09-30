import { setTimeout as delay } from "node:timers/promises";

export const IRSA_ORIGIN = "https://irsa.ipac.caltech.edu";
export const SIA_ENDPOINT = `${IRSA_ORIGIN}/SIA`;

export const COLLECTIONS = {
    qr2: "spherex_qr2",
    qr3: "spherex_qr3",
} as const;

export type Release = keyof typeof COLLECTIONS;

export type Detector = 1 | 2 | 3 | 4 | 5 | 6;

export interface MefRecord {
    readonly accessUrl: string;

    readonly cloudAccess: string;
    readonly detector: Detector;
    readonly bandMinMicron: number;
    readonly bandMaxMicron: number;
    readonly resolvingPower: number;
    readonly pixelScaleArcsec: number;
    readonly observationId: string;
    readonly tMinMjd: number;

    readonly centreRaDeg: number;
    readonly centreDecDeg: number;
    readonly nx: number;
    readonly ny: number;
}

const USER_AGENT = "planet-x-spherx-sleuth/0.1 (NASA Space Apps 2026)";

async function fetchWithRetry(
    url: string | URL,
    init: RequestInit,
    { attempts = 3, timeoutMs = 120_000 }: { attempts?: number; timeoutMs?: number } = {},
): Promise<Response> {
    const href = url.toString();
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                ...init,
                signal: controller.signal,
                headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
            });
            if (response.ok) return response;

            if (response.status < 500 && response.status !== 429) {
                throw new Error(`HTTP ${response.status} for ${href}`);
            }
            lastError = new Error(`HTTP ${response.status} for ${href}`);
        } catch (error) {
            lastError = error;
        } finally {
            clearTimeout(timer);
        }
        if (attempt < attempts) await delay(500 * 2 ** (attempt - 1));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function parseCsv(text: string): Record<string, string>[] {
    const lines = text
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0);
    if (lines.length === 0) return [];
    const header = (lines[0] as string).split(",");
    return lines.slice(1).map(line => {
        const cells = line.split(",");
        const row: Record<string, string> = {};
        header.forEach((key, i) => {
            row[key] = cells[i] ?? "";
        });
        return row;
    });
}

function num(value: string | undefined, fallback = Number.NaN): number {
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export async function queryMefs(options: {
    ra: number;
    dec: number;
    radiusDeg: number;
    release?: Release;
    maxRecords?: number;
}): Promise<MefRecord[]> {
    const { ra, dec, radiusDeg, release = "qr3", maxRecords = 2000 } = options;
    const url = new URL(SIA_ENDPOINT);
    url.searchParams.set("COLLECTION", COLLECTIONS[release]);
    url.searchParams.set("POS", `circle ${ra} ${dec} ${radiusDeg}`);
    url.searchParams.set("MAXREC", String(maxRecords));
    url.searchParams.set("RESPONSEFORMAT", "CSV");

    const response = await fetchWithRetry(url, {}, { timeoutMs: 180_000 });
    const rows = parseCsv(await response.text());

    const seen = new Set<string>();
    const records: MefRecord[] = [];

    for (const row of rows) {
        const accessUrl = row["access_url"];
        if (!accessUrl) continue;

        if (seen.has(accessUrl)) continue;
        seen.add(accessUrl);

        const fromBand = /D(\d)/.exec(row["energy_bandpassname"] ?? "")?.[1];
        const fromUrl = /_(\d)D(\d)_/.exec(accessUrl)?.[2];
        const detector = Number(fromBand ?? fromUrl ?? "0");
        records.push({
            accessUrl,
            cloudAccess: row["cloud_access"] ?? "",
            detector: (detector >= 1 && detector <= 6 ? detector : 1) as Detector,
            bandMinMicron: num(row["em_min"]) * 1e6,
            bandMaxMicron: num(row["em_max"]) * 1e6,
            resolvingPower: num(row["em_res_power"]),
            pixelScaleArcsec: num(row["s_pixel_scale"], 6.15),
            observationId: row["obs_id"] ?? "",
            tMinMjd: num(row["t_min"]),
            centreRaDeg: num(row["s_ra"]),
            centreDecDeg: num(row["s_dec"]),
            nx: num(row["s_xel1"], 2040),
            ny: num(row["s_yel1"] ?? row["s_xel2"], 2040),
        });
    }

    return records;
}

export async function fetchCutout(options: {
    accessUrl: string;
    ra: number;
    dec: number;
    sizeDeg: number;
}): Promise<Buffer> {
    const { accessUrl, ra, dec, sizeDeg } = options;
    const url = new URL(accessUrl);
    url.searchParams.set("center", `${ra},${dec}`);
    url.searchParams.set("size", String(sizeDeg));

    const response = await fetchWithRetry(url, {}, { timeoutMs: 180_000 });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error(`IRSA: empty cutout from ${url}`);
    return buffer;
}
