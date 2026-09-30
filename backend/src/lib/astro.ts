const DEG = Math.PI / 180;
const ARCSEC_PER_RAD = (180 / Math.PI) * 3600;

export interface SkyPosition {
    readonly raDeg: number;
    readonly decDeg: number;
}

export interface TangentPlane {
    readonly xiDeg: number;

    readonly etaDeg: number;
}

export function projectTan(position: SkyPosition, tangent: SkyPosition): TangentPlane {
    const ra = position.raDeg * DEG;
    const dec = position.decDeg * DEG;
    const ra0 = tangent.raDeg * DEG;
    const dec0 = tangent.decDeg * DEG;

    const cosDec0 = Math.cos(dec0);
    const sinDec0 = Math.sin(dec0);
    const cosDec = Math.cos(dec);
    const sinDec = Math.sin(dec);
    const deltaRa = ra - ra0;

    const cosC = sinDec0 * sinDec + cosDec0 * cosDec * Math.cos(deltaRa);

    if (cosC <= 0) throw new Error(`astro: ${position.raDeg},${position.decDeg} is >90deg from the tangent point`);

    const xi = (cosDec * Math.sin(deltaRa)) / cosC;
    const eta = (sinDec * cosDec0 - cosDec * sinDec0 * Math.cos(deltaRa)) / cosC;

    return { xiDeg: (xi * ARCSEC_PER_RAD) / 3600, etaDeg: (eta * ARCSEC_PER_RAD) / 3600 };
}

export interface PixelFrame {
    readonly crpix1: number;
    readonly crpix2: number;

    readonly raDeg: number;
    readonly decDeg: number;

    readonly nx: number;
    readonly ny: number;

    readonly pixelScaleArcsec: number;

    readonly flipX: boolean;
    readonly flipY: boolean;
}

export function skyToPixel(position: SkyPosition, frame: PixelFrame): { x: number; y: number } {
    const { xiDeg, etaDeg } = projectTan(position, { raDeg: frame.raDeg, decDeg: frame.decDeg });
    const scaleDeg = frame.pixelScaleArcsec / 3600;
    const dx = xiDeg / scaleDeg;
    const dy = etaDeg / scaleDeg;
    return {
        x: frame.flipX ? frame.crpix1 - dx : frame.crpix1 + dx,
        y: frame.flipY ? frame.crpix2 - dy : frame.crpix2 + dy,
    };
}

/** angular separation between two sky positions, in degrees. */
export function separationDegrees(a: SkyPosition, b: SkyPosition): number {
    const ra1 = a.raDeg * DEG;
    const dec1 = a.decDeg * DEG;
    const ra2 = b.raDeg * DEG;
    const dec2 = b.decDeg * DEG;
    const cosSep = Math.sin(dec1) * Math.sin(dec2) + Math.cos(dec1) * Math.cos(dec2) * Math.cos(ra1 - ra2);
    return Math.acos(Math.min(1, Math.max(-1, cosSep))) / DEG;
}
