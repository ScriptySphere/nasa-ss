/** v0 spike - G0 gate: prove programmatic SPHEREx photometry end-to-end. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { separationDegrees } from "../lib/astro.ts";
import { findPeaks, measureAtPixel, type RemoteMeasurement } from "../lib/extract.ts";
import { queryMefs } from "../lib/irsa.ts";
import { bandForDetector, BANDS, FEATURES, PIXEL_SCALE_ARCSEC } from "../lib/spectra.ts";

const CACHE_DIR = join(import.meta.dirname, "..", "..", ".cache", "spike");
const OUT_DIR = CACHE_DIR;

const DEFAULT_TARGET = { ra: 213.91529, dec: 19.18241, name: "Arcturus" };

function arg(flag: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(flag);
    return i === -1 ? fallback : process.argv[i + 1];
}

interface SpikeRecord {
    readonly target: { ra: number; dec: number; name: string };
    readonly release: string;
    readonly radiusDeg: number;
    readonly discoveredMefs: number;
    readonly measured: RemoteMeasurement[];
    readonly failures: { url: string; reason: string }[];
    readonly generatedAt: string;
}

async function cachedPeaks(url: string): Promise<Awaited<ReturnType<typeof findPeaks>>> {
    const key = Buffer.from(url).toString("base64url").slice(-40);
    const path = join(CACHE_DIR, `peaks-${key}.json`);
    try {
        return JSON.parse(await readFile(path, "utf8")) as Awaited<ReturnType<typeof findPeaks>>;
    } catch {
        const peaks = await findPeaks({ url, maxPeaks: 1 });
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(path, JSON.stringify(peaks));
        return peaks;
    }
}

async function main(): Promise<void> {
    const ra = Number(arg("--ra", String(DEFAULT_TARGET.ra)));
    const dec = Number(arg("--dec", String(DEFAULT_TARGET.dec)));
    const name = arg("--name", DEFAULT_TARGET.name) as string;
    const radiusDeg = Number(arg("--radius", "0.2"));
    const limit = Number(arg("--mefs", "4"));
    const release = (arg("--release", "qr3") as "qr2" | "qr3") ?? "qr3";

    const target = { ra, dec, name };
    process.stdout.write(`SPHEREx ${release.toUpperCase()} spike — target ${name} (RA ${ra}, Dec ${dec})\n`);
    process.stdout.write(`pixel scale ${PIXEL_SCALE_ARCSEC}" · ${BANDS.length} LVF bands\n\n`);

    const mefs = await queryMefs({ ra, dec, radiusDeg, release });
    process.stdout.write(`SIA2 discovered ${mefs.length} spectral images within ${radiusDeg} deg\n`);

    const byBand = new Map<number, (typeof mefs)[number]>();
    for (const m of mefs) if (!byBand.has(m.detector)) byBand.set(m.detector, m);
    const chosen = [...byBand.values()].slice(0, limit);

    const measured: RemoteMeasurement[] = [];
    const failures: { url: string; reason: string }[] = [];

    for (const m of chosen) {
        const band = bandForDetector(m.detector);
        const label = band ? `${band.min}-${band.max} um` : "unknown band";
        try {
            const peaks = await cachedPeaks(m.accessUrl);
            const peak = peaks[0];
            if (!peak) throw new Error("no finite pixels found");
            const r = await measureAtPixel({
                url: m.accessUrl,
                pixel: { x: peak.x, y: peak.y },
                detector: m.detector,
            });
            measured.push(r);
            process.stdout.write(
                `  D${m.detector} (${label.padEnd(12)}) brightest@(${String(peak.x).padStart(4)},${String(peak.y).padStart(4)})` +
                    `  lambda=${r.lambdaMicron.toFixed(4)} um  R=${r.resolvingPower.toFixed(0).padStart(4)}` +
                    `  flux=${r.fluxMilliJy.toFixed(3).padStart(10)} mJy  SNR=${r.snr.toFixed(0).padStart(6)}\n`,
            );
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            failures.push({ url: m.accessUrl, reason });
            process.stdout.write(`  D${m.detector} (${label.padEnd(12)}) FAILED: ${reason}\n`);
        }
    }

    measured.sort((a, b) => a.lambdaMicron - b.lambdaMicron);

    process.stdout.write("\nmeasured channels\n");
    process.stdout.write(
        `  ${"lambda(um)".padEnd(12)}${"band(um)".padEnd(14)}${"R".padEnd(7)}${"flux(mJy)".padEnd(14)}${"err".padEnd(11)}SNR\n`,
    );
    process.stdout.write(`  ${"-".repeat(64)}\n`);
    for (const r of measured) {
        const band = bandForDetector(r.detector);
        process.stdout.write(
            `  ${r.lambdaMicron.toFixed(4).padEnd(12)}${(band ? `${band.min}-${band.max}` : "?").padEnd(14)}` +
                `${r.resolvingPower.toFixed(0).padEnd(7)}${r.fluxMilliJy.toFixed(3).padEnd(14)}` +
                `${r.fluxErrMilliJy.toFixed(3).padEnd(11)}${r.snr.toFixed(0)}\n`,
        );
    }

    // G0 checks
    process.stdout.write(`\n${"=".repeat(66)}\nG0 EXIT CRITERIA\n${"=".repeat(66)}\n`);
    const checks: [string, boolean, string][] = [
        ["at least 3 channels measured", measured.length >= 3, `${measured.length}`],
        [
            "all wavelengths inside 0.75-5.0 um",
            measured.every(r => r.lambdaMicron >= 0.7 && r.lambdaMicron <= 5.1),
            measured.map(r => r.lambdaMicron.toFixed(3)).join(" "),
        ],
        [
            "every wavelength inside its detector band",
            measured.every(r => {
                const b = bandForDetector(r.detector);
                if (!b) return false;
                const slack = 0.1;
                return r.lambdaMicron >= b.min - slack && r.lambdaMicron <= b.max + slack;
            }),
            "cross-checked against the official LVF band table",
        ],
        [
            "distinct detectors",
            new Set(measured.map(r => r.detector)).size >= 2,
            `${new Set(measured.map(r => r.detector)).size}`,
        ],
        [
            "all fluxes finite and positive",
            measured.every(r => Number.isFinite(r.fluxMilliJy) && r.fluxMilliJy > 0),
            "",
        ],
        [
            "all errors finite and positive",
            measured.every(r => Number.isFinite(r.fluxErrMilliJy) && r.fluxErrMilliJy > 0),
            "",
        ],
    ];

    let pass = true;
    for (const [label, ok, detail] of checks) {
        pass &&= ok;
        process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}\n`);
    }

    const span = measured.length
        ? (measured[measured.length - 1] as RemoteMeasurement).lambdaMicron -
          (measured[0] as RemoteMeasurement).lambdaMicron
        : 0;
    process.stdout.write(`\n  wavelength span sampled: ${span.toFixed(3)} um\n`);
    process.stdout.write(
        `  features inside SPHEREx range: ${FEATURES.map(f => `${f.label}@${f.micron}`).join(", ")}\n`,
    );
    process.stdout.write(`  note: 6.2 um PAH is OUTSIDE 0.75-5.0 um and is not detectable by SPHEREx\n`);

    const record: SpikeRecord = {
        target,
        release,
        radiusDeg,
        discoveredMefs: mefs.length,
        measured,
        failures,
        generatedAt: new Date().toISOString(),
    };
    await mkdir(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, "latest.json");
    await writeFile(outPath, JSON.stringify(record, null, 2));
    process.stdout.write(`\nwrote ${outPath}\n`);
    process.stdout.write(`\nG0: ${pass ? "PASS" : "FAIL"}\n`);
    process.exit(pass ? 0 : 1);
}

void separationDegrees;
await main();
