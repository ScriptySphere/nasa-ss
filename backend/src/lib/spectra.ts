/** extract spectra from SPHEREx cutouts using MEF WCS-WAVE wavelengths. */
import {
    findHdu,
    parentPixelOrigin,
    readHduTable,
    readImageF64,
    readImageI32,
    readTableColumnF64,
    readTableColumns,
    type Hdu,
} from "./fits.ts";

export const PIXEL_SCALE_ARCSEC = 6.15;

export const PIXEL_SOLID_ANGLE_SR = ((PIXEL_SCALE_ARCSEC * (Math.PI / 180)) / 3600) ** 2;

export const BANDS = [
    { detector: 1, min: 0.75, max: 1.09, r: 39 },
    { detector: 2, min: 1.1, max: 1.62, r: 41 },
    { detector: 3, min: 1.63, max: 2.41, r: 41 },
    { detector: 4, min: 2.42, max: 3.82, r: 35 },
    { detector: 5, min: 3.83, max: 4.41, r: 112 },
    { detector: 6, min: 4.42, max: 5.0, r: 128 },
] as const;

export function bandForDetector(detector: number): (typeof BANDS)[number] | undefined {
    return BANDS.find(b => b.detector === detector);
}

/** molecular and solid-state features within SPHEREx's 0.75–5.0 μm range. */
export const FEATURES = [
    { key: "h2oGas", label: "H2O (gas)", micron: 2.7, band: 4 },
    { key: "h2oIce", label: "H2O (ice)", micron: 3.05, band: 4 },
    { key: "ch4", label: "CH4 (methane)", micron: 3.3, band: 4 },
    { key: "co2", label: "CO2", micron: 4.26, band: 5 },
    { key: "amorphC", label: "Amorphous carbon", micron: 4.75, band: 6 },
] as const;

export interface WavelengthGrid {
    readonly xs: Float64Array;

    readonly ys: Float64Array;

    readonly lambda: Float64Array;

    readonly bandwidth: Float64Array;
    readonly nx: number;
    readonly ny: number;
}

export function readWavelengthGrid(buf: Buffer, hdu: Hdu): WavelengthGrid {
    const columns = readTableColumns(hdu);
    const xsCol = columns.find(c => c.name.toUpperCase() === "X");
    const ysCol = columns.find(c => c.name.toUpperCase() === "Y");
    const valuesCol = columns.find(c => c.name.toUpperCase() === "VALUES");
    if (!xsCol || !ysCol || !valuesCol) {
        throw new Error(`FITS: WCS-WAVE must have X, Y, VALUES columns (got ${columns.map(c => c.name).join(", ")})`);
    }

    const xs = readTableColumnF64(buf, hdu, xsCol);
    const ys = readTableColumnF64(buf, hdu, ysCol);
    const values = readTableColumnF64(buf, hdu, valuesCol);

    const nx = xs.length;
    const ny = ys.length;
    if (values.length !== nx * ny * 2) {
        throw new Error(
            `FITS: WCS-WAVE VALUES has ${values.length} entries, expected ${nx * ny * 2} (interleaved pairs)`,
        );
    }

    const lambda = new Float64Array(nx * ny);
    const bandwidth = new Float64Array(nx * ny);
    for (let i = 0; i < nx * ny; i += 1) {
        lambda[i] = values[2 * i] as number;
        bandwidth[i] = values[2 * i + 1] as number;
    }

    return { xs, ys, lambda, bandwidth, nx, ny };
}

function bilinear(grid: WavelengthGrid, x: number, y: number, pick: (index: number) => number): number {
    const { xs, ys, nx, ny } = grid;
    const lastX = nx - 1;
    const lastY = ny - 1;

    // locate the bracketing control indices along each axis.
    let i = 0;
    while (i < lastX - 1 && (xs[i + 1] as number) < x) i += 1;
    let j = 0;
    while (j < lastY - 1 && (ys[j + 1] as number) < y) j += 1;

    const x0 = xs[i] as number;
    const x1 = xs[Math.min(i + 1, lastX)] as number;
    const y0 = ys[j] as number;
    const y1 = ys[Math.min(j + 1, lastY)] as number;

    const tx = x1 === x0 ? 0 : Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
    const ty = y1 === y0 ? 0 : Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));

    const at = (a: number, b: number): number => pick(Math.min(b, lastY) * nx + Math.min(a, lastX));
    const top = at(i, j) * (1 - tx) + at(i + 1, j) * tx;
    const bottom = at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx;
    return top * (1 - ty) + bottom * ty;
}

export function wavelengthAt(grid: WavelengthGrid, x: number, y: number): number {
    return bilinear(grid, x, y, i => grid.lambda[i] as number);
}

export function bandwidthAt(grid: WavelengthGrid, x: number, y: number): number {
    return bilinear(grid, x, y, i => grid.bandwidth[i] as number);
}

export interface ChannelMeasurement {
    readonly lambdaMicron: number;

    readonly bandwidthMicron: number;

    readonly resolvingPower: number;
    readonly detector: number;

    readonly fluxMilliJy: number;

    readonly fluxErrMilliJy: number;
    readonly snr: number;

    readonly apertureRadiusPx: number;
    readonly aperturePixels: number;

    readonly x: number;
    readonly y: number;

    readonly parentX: number;
    readonly parentY: number;

    readonly peakSnr: number;

    readonly rejectedFraction: number;

    readonly flagBits: number;
    readonly dateObs: string;
    readonly sourceUri: string;
}

export interface CutoutExtraction {
    readonly measurement: ChannelMeasurement;

    readonly stamp: number[][];
    readonly stampMax: number;
}

function median(values: readonly number[]): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 0
        ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
        : (sorted[mid] as number);
}

/** measure a source at the cutout centre and refine to its local peak. */
export function extractFromCutout(
    buf: Buffer,
    options: {
        detector: number;
        sourceUri: string;
        apertureRadiusPx?: number;
        peakSearchRadiusPx?: number;
    },
): CutoutExtraction {
    const { detector, sourceUri } = options;
    const apertureRadiusPx = options.apertureRadiusPx ?? 2.0;
    const peakSearchRadiusPx = options.peakSearchRadiusPx ?? 3;

    const hdus = readHduTable(buf);
    const imageHdu = findHdu(hdus, "IMAGE");
    const varianceHdu = findHdu(hdus, "VARIANCE");
    const zodiHdu = findHdu(hdus, "ZODI");
    const flagsHdu = hdus.find(h => h.name.toUpperCase() === "FLAGS");
    const gridHdu = findHdu(hdus, "WCS-WAVE");

    const naxis1 = imageHdu.axes[0] as number;
    const naxis2 = imageHdu.axes[1] as number;
    const image = readImageF64(buf, imageHdu);
    const variance = readImageF64(buf, varianceHdu);
    const zodi = readImageF64(buf, zodiHdu);
    const flags = flagsHdu ? readImageI32(buf, flagsHdu) : null;

    const grid = readWavelengthGrid(buf, gridHdu);
    const cx = (naxis1 + 1) / 2;
    const cy = (naxis2 + 1) / 2;

    const origin = parentPixelOrigin(imageHdu);
    const toParent = (x: number, y: number): { x: number; y: number } => {
        if (!origin) return { x, y };
        return { x: x - origin.x + 1, y: y - origin.y + 1 };
    };

    const at = (x: number, y: number): number => image[(y - 1) * naxis1 + (x - 1)] as number;
    const zodiAt = (x: number, y: number): number => zodi[(y - 1) * naxis1 + (x - 1)] as number;

    let bestX = Math.round(cx);
    let bestY = Math.round(cy);
    let bestValue = Number.NEGATIVE_INFINITY;
    for (
        let y = Math.max(1, Math.floor(cy - peakSearchRadiusPx));
        y <= Math.min(naxis2, Math.ceil(cy + peakSearchRadiusPx));
        y += 1
    ) {
        for (
            let x = Math.max(1, Math.floor(cx - peakSearchRadiusPx));
            x <= Math.min(naxis1, Math.ceil(cx + peakSearchRadiusPx));
            x += 1
        ) {
            const value = at(x, y) - zodiAt(x, y);
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
    for (
        let y = Math.max(1, bestY - Math.ceil(apertureRadiusPx));
        y <= Math.min(naxis2, bestY + Math.ceil(apertureRadiusPx));
        y += 1
    ) {
        for (
            let x = Math.max(1, bestX - Math.ceil(apertureRadiusPx));
            x <= Math.min(naxis1, bestX + Math.ceil(apertureRadiusPx));
            x += 1
        ) {
            const dx = x - bestX;
            const dy = y - bestY;
            if (dx * dx + dy * dy > r2) continue;
            const index = (y - 1) * naxis1 + (x - 1);
            const sb = image[index] as number;
            const vv = variance[index] as number;
            if (!Number.isFinite(sb) || !Number.isFinite(vv) || vv <= 0) {
                rejected += 1;
                continue;
            }
            if (flags) flagBits |= (flags[index] as number) >>> 0;
            aperturePixels += 1;
            fluxSum += sb - (zodi[index] as number);
            varianceSum += vv;
        }
    }

    if (aperturePixels === 0) {
        throw new Error(`SPHEREx: no usable pixels in the aperture (detector ${detector}, all variance non-positive)`);
    }

    const fluxMilliJy = fluxSum * PIXEL_SOLID_ANGLE_SR * aperturePixels * 1e3;
    const fluxErrMilliJy = Math.sqrt(Math.max(varianceSum, 0)) * PIXEL_SOLID_ANGLE_SR * aperturePixels * 1e3;
    const snr = fluxErrMilliJy > 0 ? fluxMilliJy / fluxErrMilliJy : 0;

    const peakIndex = (bestY - 1) * naxis1 + (bestX - 1);
    const peakVariance = variance[peakIndex] as number;
    const peakSnr =
        peakVariance > 0 ? ((image[peakIndex] as number) - zodiAt(bestX, bestY)) / Math.sqrt(peakVariance) : 0;

    const parent = toParent(bestX, bestY);
    const lambdaMicron = wavelengthAt(grid, parent.x, parent.y);
    const bandwidthMicron = bandwidthAt(grid, parent.x, parent.y);

    const zodiMedian = median([...zodi].filter(v => Number.isFinite(v)));
    let stampMax = 0;
    const stamp: number[][] = [];
    for (let y = Math.max(1, bestY - 4); y <= Math.min(naxis2, bestY + 4); y += 1) {
        const row: number[] = [];
        for (let x = Math.max(1, bestX - 4); x <= Math.min(naxis1, bestX + 4); x += 1) {
            const value = at(x, y) - zodiAt(x, y) - zodiMedian;
            row.push(value);
            if (value > stampMax) stampMax = value;
        }
        stamp.push(row);
    }

    return {
        measurement: {
            lambdaMicron,
            bandwidthMicron,
            resolvingPower: bandwidthMicron > 0 ? lambdaMicron / bandwidthMicron : 0,
            detector,
            fluxMilliJy,
            fluxErrMilliJy,
            snr,
            apertureRadiusPx,
            aperturePixels,
            x: bestX,
            y: bestY,
            parentX: parent.x,
            parentY: parent.y,
            peakSnr,
            rejectedFraction: rejected / (aperturePixels + rejected),
            flagBits,
            dateObs: imageHdu.header.values.get("DATE-OBS") ?? "",
            sourceUri,
        },
        stamp,
        stampMax,
    };
}
