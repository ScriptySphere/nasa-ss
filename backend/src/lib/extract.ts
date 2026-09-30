import { skyToPixel, type SkyPosition } from "./astro.ts";
import { RemoteMef } from "./remote-mef.ts";
import { bandwidthAt, PIXEL_SOLID_ANGLE_SR, readWavelengthGrid, wavelengthAt } from "./spectra.ts";

export interface ObservationFrame {
    readonly centre: SkyPosition;
    readonly nx: number;
    readonly ny: number;
    readonly pixelScaleArcsec: number;

    readonly detector: number;
}

export interface Peak {
    readonly x: number;
    readonly y: number;

    readonly surfaceBrightness: number;

    readonly snr: number;
}

/** locate brightest sources across the detector without absolute astrometry. */
export async function findPeaks(options: {
    url: string;
    maxPeaks?: number;
    rowStep?: number;
    minSeparationPx?: number;
    blockRows?: number;
}): Promise<Peak[]> {
    const { url } = options;
    const maxPeaks = options.maxPeaks ?? 5;
    const rowStep = options.rowStep ?? 2;
    const minSeparationPx = options.minSeparationPx ?? 12;

    const blockRows = options.blockRows ?? 128;

    const mef = await RemoteMef.open(url);
    const imageHdu = await mef.hdu("IMAGE");
    const varianceHdu = await mef.hdu("VARIANCE");
    const nx = imageHdu.axes[0] as number;
    const ny = imageHdu.axes[1] as number;

    interface Candidate {
        x: number;
        y: number;
        v: number;
    }

    const shortlist: Candidate[] = [];
    const shortlistSize = maxPeaks * 4;
    const weakest = (): number =>
        shortlist.length < shortlistSize ? Number.NEGATIVE_INFINITY : (shortlist[shortlist.length - 1] as Candidate).v;

    const offer = (x: number, y: number, v: number): void => {
        if (!Number.isFinite(v) || v <= weakest()) return;
        let at = shortlist.length;
        while (at > 0 && (shortlist[at - 1] as Candidate).v < v) at -= 1;
        shortlist.splice(at, 0, { x, y, v });
        if (shortlist.length > shortlistSize) shortlist.length = shortlistSize;
    };

    for (let start = 1; start <= ny; start += blockRows) {
        const end = Math.min(ny, start + blockRows - 1);
        const box = await mef.readBox(imageHdu, { x0: 1, x1: nx, y0: start, y1: end });
        for (let r = 0; r < box.ny; r += rowStep) {
            const y = box.y0 + r;
            const base = r * box.nx;
            for (let c = 0; c < nx; c += 1) offer(c + 1, y, box.data[base + c] as number);
        }
    }

    const candidates = shortlist;

    const chosen: Candidate[] = [];
    for (const c of candidates) {
        if (chosen.length >= maxPeaks * 4) break;
        if (chosen.some(k => Math.hypot(k.x - c.x, k.y - c.y) < minSeparationPx)) continue;
        chosen.push(c);
        if (chosen.length >= maxPeaks) break;
    }

    const peaks: Peak[] = [];
    for (const c of chosen) {
        const image = await mef.readBox(imageHdu, {
            x0: c.x - 3,
            x1: c.x + 3,
            y0: c.y - 3,
            y1: c.y + 3,
        });
        const variance = await mef.readBox(varianceHdu, {
            x0: c.x - 3,
            x1: c.x + 3,
            y0: c.y - 3,
            y1: c.y + 3,
        });
        let best: { v: number; x: number; y: number; var: number } = {
            v: Number.NEGATIVE_INFINITY,
            x: c.x,
            y: c.y,
            var: Number.NaN,
        };
        for (let r = 0; r < image.ny; r += 1) {
            for (let col = 0; col < image.nx; col += 1) {
                const v = image.data[r * image.nx + col] as number;
                const vv = variance.data[r * variance.nx + col] as number;
                if (Number.isFinite(v) && v > best.v) {
                    best = { v, x: image.x0 + col, y: image.y0 + r, var: vv };
                }
            }
        }
        peaks.push({
            x: best.x,
            y: best.y,
            surfaceBrightness: best.v,
            snr: Number.isFinite(best.var) && best.var > 0 ? best.v / Math.sqrt(best.var) : 0,
        });
    }

    return peaks.sort((a, b) => b.surfaceBrightness - a.surfaceBrightness);
}

export async function measureAtPixel(options: {
    url: string;
    pixel: { x: number; y: number };
    detector: number;
    apertureRadiusPx?: number;
    halfBoxPx?: number;
}): Promise<RemoteMeasurement> {
    const { url, pixel, detector } = options;
    const apertureRadiusPx = options.apertureRadiusPx ?? 2.0;
    const halfBoxPx = options.halfBoxPx ?? 7;

    const mef = await RemoteMef.open(url);
    const imageHdu = await mef.hdu("IMAGE");
    const varianceHdu = await mef.hdu("VARIANCE");
    const zodiHdu = await mef.hdu("ZODI");
    const gridHdu = await mef.hdu("WCS-WAVE");

    const cx = Math.round(pixel.x);
    const cy = Math.round(pixel.y);
    const box = { x0: cx - halfBoxPx, x1: cx + halfBoxPx, y0: cy - halfBoxPx, y1: cy + halfBoxPx };

    const [image, variance, zodi] = await Promise.all([
        mef.readBox(imageHdu, box),
        mef.readBox(varianceHdu, box),
        mef.readBox(zodiHdu, box),
    ]);

    const tableBuf = await mef.readTable(gridHdu);
    const grid = readWavelengthGrid(tableBuf, { ...gridHdu, dataStart: 0 });
    const lambdaMicron = wavelengthAt(grid, pixel.x, pixel.y);
    const bandwidthMicron = bandwidthAt(grid, pixel.x, pixel.y);

    const r2 = apertureRadiusPx * apertureRadiusPx;
    let fluxSum = 0;
    let varianceSum = 0;
    let aperturePixels = 0;
    let rejected = 0;
    for (let y = cy - Math.ceil(apertureRadiusPx); y <= cy + Math.ceil(apertureRadiusPx); y += 1) {
        for (let x = cx - Math.ceil(apertureRadiusPx); x <= cx + Math.ceil(apertureRadiusPx); x += 1) {
            const dx = x - cx;
            const dy = y - cy;
            if (dx * dx + dy * dy > r2) continue;
            const sb = sample(image, x, y);
            const vv = sample(variance, x, y);
            if (!Number.isFinite(sb) || !Number.isFinite(vv) || vv <= 0) {
                rejected += 1;
                continue;
            }
            aperturePixels += 1;
            fluxSum += sb - sample(zodi, x, y);
            varianceSum += vv;
        }
    }
    if (aperturePixels === 0) throw new Error("no usable pixels in the aperture");

    const toMilliJy = PIXEL_SOLID_ANGLE_SR * 1e3;
    const fluxMilliJy = fluxSum * toMilliJy;
    const fluxErrMilliJy = Math.sqrt(Math.max(varianceSum, 0)) * toMilliJy;

    return {
        lambdaMicron,
        bandwidthMicron,
        resolvingPower: bandwidthMicron > 0 ? lambdaMicron / bandwidthMicron : 0,
        detector,
        fluxMilliJy,
        fluxErrMilliJy,
        snr: fluxErrMilliJy > 0 ? fluxMilliJy / fluxErrMilliJy : 0,
        peakSnr: aperturePixels > 0 ? fluxMilliJy / fluxErrMilliJy : 0,
        predictedX: pixel.x,
        predictedY: pixel.y,
        foundX: cx,
        foundY: cy,
        peakOffsetPx: 0,
        apertureRadiusPx,
        aperturePixels,
        rejectedFraction: rejected / (aperturePixels + rejected),
        flagBits: 0,
        dateObs: imageHdu.header.values.get("DATE-OBS") ?? "",
        sourceUri: url,
        stamp: [],
        stampMax: 0,
    };
}

export interface RemoteMeasurement {
    readonly lambdaMicron: number;
    readonly bandwidthMicron: number;
    readonly resolvingPower: number;
    readonly detector: number;

    readonly fluxMilliJy: number;
    readonly fluxErrMilliJy: number;
    readonly snr: number;
    readonly peakSnr: number;

    readonly predictedX: number;
    readonly predictedY: number;
    readonly foundX: number;
    readonly foundY: number;

    readonly peakOffsetPx: number;
    readonly apertureRadiusPx: number;
    readonly aperturePixels: number;
    readonly rejectedFraction: number;
    readonly flagBits: number;
    readonly dateObs: string;
    readonly sourceUri: string;

    readonly stamp: number[][];
    readonly stampMax: number;
}

interface Box {
    data: Float64Array;
    nx: number;
    ny: number;
    x0: number;
    y0: number;
}

function sample(box: Box, x: number, y: number): number {
    const col = x - box.x0;
    const row = y - box.y0;
    if (col < 0 || row < 0 || col >= box.nx || row >= box.ny) return Number.NaN;
    return box.data[row * box.nx + col] as number;
}

export async function measureSource(options: {
    url: string;
    target: SkyPosition;
    frame: ObservationFrame;
    apertureRadiusPx?: number;
    peakSearchRadiusPx?: number;
    halfBoxPx?: number;
}): Promise<RemoteMeasurement> {
    const { url, target, frame } = options;
    const apertureRadiusPx = options.apertureRadiusPx ?? 2.0;
    const peakSearchRadiusPx = options.peakSearchRadiusPx ?? 4;
    const halfBoxPx = options.halfBoxPx ?? 7;

    const mef = await RemoteMef.open(url);
    const imageHdu = await mef.hdu("IMAGE");
    const varianceHdu = await mef.hdu("VARIANCE");
    const zodiHdu = await mef.hdu("ZODI");
    const gridHdu = await mef.hdu("WCS-WAVE");

    const flagsHdu = await mef.hdu("FLAGS").catch(() => null);
    const useFlags =
        flagsHdu !== null &&
        flagsHdu.axes[0] === imageHdu.axes[0] &&
        flagsHdu.axes[1] === imageHdu.axes[1] &&
        flagsHdu.header.values.get("ZIMAGE") === undefined
            ? flagsHdu
            : null;

    const predicted = skyToPixel(target, {
        crpix1: (frame.nx + 1) / 2,
        crpix2: (frame.ny + 1) / 2,
        raDeg: frame.centre.raDeg,
        decDeg: frame.centre.decDeg,
        nx: frame.nx,
        ny: frame.ny,
        pixelScaleArcsec: frame.pixelScaleArcsec,

        flipX: true,
        flipY: true,
    });

    if (predicted.x < 1 || predicted.x > frame.nx || predicted.y < 1 || predicted.y > frame.ny) {
        throw new Error(
            `target falls outside the detector (predicted ${predicted.x.toFixed(1)},${predicted.y.toFixed(1)} in ${frame.nx}x${frame.ny})`,
        );
    }

    const cx = Math.round(predicted.x);
    const cy = Math.round(predicted.y);
    const box = {
        x0: cx - halfBoxPx,
        x1: cx + halfBoxPx,
        y0: cy - halfBoxPx,
        y1: cy + halfBoxPx,
    };

    const [image, variance, zodi, flags] = await Promise.all([
        mef.readBox(imageHdu, box),
        mef.readBox(varianceHdu, box),
        mef.readBox(zodiHdu, box),
        useFlags ? mef.readBox(useFlags, box) : Promise.resolve(null),
    ]);

    const tableBuf = await mef.readTable(gridHdu);
    const grid = readWavelengthGrid(tableBuf, { ...gridHdu, dataStart: 0 });
    const lambdaMicron = wavelengthAt(grid, predicted.x, predicted.y);
    const bandwidthMicron = bandwidthAt(grid, predicted.x, predicted.y);

    let bestX = cx;
    let bestY = cy;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let y = cy - peakSearchRadiusPx; y <= cy + peakSearchRadiusPx; y += 1) {
        for (let x = cx - peakSearchRadiusPx; x <= cx + peakSearchRadiusPx; x += 1) {
            const value = sample(image, x, y) - sample(zodi, x, y);
            if (Number.isFinite(value) && value > bestValue) {
                bestValue = value;
                bestX = x;
                bestY = y;
            }
        }
    }

    const r2 = apertureRadiusPx * apertureRadiusPx;
    let fluxSum = 0;
    let varianceSum = 0;
    let aperturePixels = 0;
    let rejected = 0;
    let flagBits = 0;
    for (let y = bestY - Math.ceil(apertureRadiusPx); y <= bestY + Math.ceil(apertureRadiusPx); y += 1) {
        for (let x = bestX - Math.ceil(apertureRadiusPx); x <= bestX + Math.ceil(apertureRadiusPx); x += 1) {
            const dx = x - bestX;
            const dy = y - bestY;
            if (dx * dx + dy * dy > r2) continue;
            const sb = sample(image, x, y);
            const vv = sample(variance, x, y);
            if (!Number.isFinite(sb) || !Number.isFinite(vv) || vv <= 0) {
                rejected += 1;
                continue;
            }
            const flag = flags ? sample(flags, x, y) : Number.NaN;
            if (Number.isFinite(flag)) flagBits |= flag >>> 0;
            aperturePixels += 1;
            fluxSum += sb - sample(zodi, x, y);
            varianceSum += vv;
        }
    }

    if (aperturePixels === 0) {
        throw new Error("no usable pixels in the aperture (all variance non-positive)");
    }

    const toMilliJy = PIXEL_SOLID_ANGLE_SR * 1e3;
    const fluxMilliJy = fluxSum * toMilliJy;
    const fluxErrMilliJy = Math.sqrt(Math.max(varianceSum, 0)) * toMilliJy;
    const snr = fluxErrMilliJy > 0 ? fluxMilliJy / fluxErrMilliJy : 0;

    const peakVariance = sample(variance, bestX, bestY);
    const peakSnr =
        peakVariance > 0 ? (sample(image, bestX, bestY) - sample(zodi, bestX, bestY)) / Math.sqrt(peakVariance) : 0;

    const zodiValues: number[] = [];
    for (let i = 0; i < zodi.data.length; i += 1) {
        const v = zodi.data[i] as number;
        if (Number.isFinite(v)) zodiValues.push(v);
    }
    zodiValues.sort((a, b) => a - b);
    const zodiMedian = zodiValues[zodiValues.length >> 1] ?? 0;

    const stamp: number[][] = [];
    let stampMax = 0;
    for (let y = bestY - 3; y <= bestY + 3; y += 1) {
        const row: number[] = [];
        for (let x = bestX - 3; x <= bestX + 3; x += 1) {
            const value = sample(image, x, y) - sample(zodi, x, y) - zodiMedian;
            row.push(Number.isFinite(value) ? value : 0);
            if (value > stampMax) stampMax = value;
        }
        stamp.push(row);
    }

    return {
        lambdaMicron,
        bandwidthMicron,
        resolvingPower: bandwidthMicron > 0 ? lambdaMicron / bandwidthMicron : 0,
        detector: frame.detector,
        fluxMilliJy,
        fluxErrMilliJy,
        snr,
        peakSnr,
        predictedX: predicted.x,
        predictedY: predicted.y,
        foundX: bestX,
        foundY: bestY,
        peakOffsetPx: Math.hypot(bestX - predicted.x, bestY - predicted.y),
        apertureRadiusPx,
        aperturePixels,
        rejectedFraction: rejected / (aperturePixels + rejected),
        flagBits,
        dateObs: imageHdu.header.values.get("DATE-OBS") ?? "",
        sourceUri: url,
        stamp,
        stampMax,
    };
}
