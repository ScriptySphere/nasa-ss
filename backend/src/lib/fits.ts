export const BLOCK = 2880;
export const CARD = 80;

export type Bitpix = 8 | 16 | 32 | 64 | -32 | -64;

export interface FitsHeader {
    readonly values: ReadonlyMap<string, string>;

    readonly cards: readonly string[];

    readonly dataStart: number;
}

export interface Hdu {
    readonly index: number;
    readonly name: string;
    readonly header: FitsHeader;
    readonly bitpix: Bitpix;
    readonly axes: readonly number[];
    readonly dataStart: number;
    readonly dataBytes: number;

    readonly nextStart: number;
}

const BITPIX_BYTES: Readonly<Record<number, number>> = {
    8: 1,
    16: 2,
    32: 4,
    64: 8,
    "-32": 4,
    "-64": 8,
};

function cleanValue(raw: string): string {
    let out = raw;
    if (out.startsWith("'")) {
        const close = out.indexOf("'", 1);
        return close === -1 ? out.slice(1).trim() : out.slice(1, close).trim();
    }
    const slash = out.indexOf("/");
    if (slash !== -1) out = out.slice(0, slash);
    return out.trim();
}

export function readHeader(buf: Buffer, start: number): FitsHeader {
    const values = new Map<string, string>();
    const cards: string[] = [];
    let offset = start;
    let done = false;

    while (offset + BLOCK <= buf.length && !done) {
        for (let i = 0; i < BLOCK; i += CARD) {
            const card = buf.toString("ascii", offset + i, offset + i + CARD);
            if (card.startsWith("END")) {
                done = true;
                break;
            }
            const key = card.slice(0, 8).trim();
            if (key === "" || key === "COMMENT" || key === "HISTORY" || key === "CONTINUE") {
                continue;
            }
            cards.push(card);
            const value = cleanValue(card.slice(10));
            if (key === "HIERARCH") {
                const eq = card.indexOf("=");
                if (eq !== -1) values.set(card.slice(9, eq).trim(), value);
            } else {
                values.set(key, value);
            }
        }
        offset += BLOCK;
    }

    if (!done) throw new Error(`FITS: unterminated header at byte ${start}`);
    return { values, cards, dataStart: offset };
}

function axisCount(header: FitsHeader): number {
    const n = Number(header.values.get("NAXIS") ?? "0");
    if (!Number.isInteger(n) || n < 0 || n > 999) {
        throw new Error(`FITS: bad NAXIS "${header.values.get("NAXIS")}"`);
    }
    return n;
}

function elementCount(header: FitsHeader, naxis: number): number {
    if (naxis === 0) return 0;
    let total = 1;
    for (let a = 1; a <= naxis; a += 1) {
        const raw = header.values.get(`NAXIS${a}`);
        if (raw === undefined) throw new Error(`FITS: missing NAXIS${a}`);
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) throw new Error(`FITS: bad NAXIS${a}="${raw}"`);
        total *= n;
    }
    return total;
}

function tableRowBytes(header: FitsHeader, naxis1: number, naxis2: number): number {
    return naxis1 * naxis2 + Number(header.values.get("PCOUNT") ?? "0");
}

function padUp(bytes: number): number {
    return bytes % BLOCK === 0 ? bytes : Math.ceil(bytes / BLOCK) * BLOCK;
}

export function readHduTable(buf: Buffer): Hdu[] {
    const hdus: Hdu[] = [];
    let offset = 0;
    let index = 0;

    while (offset < buf.length) {
        const header = readHeader(buf, offset);
        const naxis = axisCount(header);
        const bitpix = Number(header.values.get("BITPIX") ?? "8") as Bitpix;
        const width = BITPIX_BYTES[bitpix];
        if (width === undefined) throw new Error(`FITS: unsupported BITPIX ${bitpix}`);

        const axes: number[] = [];
        for (let a = 1; a <= naxis; a += 1) axes.push(Number(header.values.get(`NAXIS${a}`)));

        let dataBytes: number;
        if (header.values.get("XTENSION") === "BINTABLE") {
            dataBytes = tableRowBytes(header, axes[0] ?? 0, axes[1] ?? 0);
        } else {
            dataBytes = width * elementCount(header, naxis);
        }

        const hdu: Hdu = {
            index,
            name: (header.values.get("EXTNAME") ?? "PRIMARY").trim(),
            header,
            bitpix,
            axes,
            dataStart: header.dataStart,
            dataBytes,
            nextStart: header.dataStart + (dataBytes > 0 ? padUp(dataBytes) : 0),
        };
        hdus.push(hdu);
        offset = hdu.nextStart;
        index += 1;
    }

    return hdus;
}

export function findHdu(hdus: readonly Hdu[], name: string): Hdu {
    if (name === "") return hdus[0] as Hdu;
    const target = name.toUpperCase();
    const hit = hdus.find(h => h.name.toUpperCase() === target);
    if (!hit) {
        throw new Error(`FITS: no HDU named "${name}" (have: ${hdus.map(h => h.name).join(", ")})`);
    }
    return hit;
}

function scaler(hdu: Hdu): { bscale: number; bzero: number } {
    return {
        bscale: Number(hdu.header.values.get("BSCALE") ?? "1"),
        bzero: Number(hdu.header.values.get("BZERO") ?? "0"),
    };
}

export function readImageF64(buf: Buffer, hdu: Hdu): Float64Array {
    const count = hdu.dataBytes / BITPIX_BYTES[hdu.bitpix]!;
    const out = new Float64Array(count);
    const view = new DataView(buf.buffer, buf.byteOffset + hdu.dataStart, hdu.dataBytes);
    const { bscale, bzero } = scaler(hdu);
    const identity = bscale === 1 && bzero === 0;

    for (let i = 0; i < count; i += 1) {
        const off = i * BITPIX_BYTES[hdu.bitpix]!;
        let raw: number;
        switch (hdu.bitpix) {
            case 8:
                raw = view.getUint8(off);
                break;
            case 16:
                raw = view.getInt16(off, false);
                break;
            case 32:
                raw = view.getInt32(off, false);
                break;
            case 64:
                raw = Number(view.getBigInt64(off, false));
                break;
            case -32:
                raw = view.getFloat32(off, false);
                break;
            case -64:
                raw = view.getFloat64(off, false);
                break;
            default:
                throw new Error(`FITS: unsupported BITPIX ${hdu.bitpix}`);
        }
        out[i] = identity ? raw : bscale * raw + bzero;
    }
    return out;
}

export function readImageI32(buf: Buffer, hdu: Hdu): Int32Array {
    const width = BITPIX_BYTES[hdu.bitpix]!;
    const count = hdu.dataBytes / width;
    const out = new Int32Array(count);
    const view = new DataView(buf.buffer, buf.byteOffset + hdu.dataStart, hdu.dataBytes);
    for (let i = 0; i < count; i += 1) {
        const off = i * width;
        out[i] =
            hdu.bitpix === 32
                ? view.getInt32(off, false)
                : hdu.bitpix === 16
                  ? view.getInt16(off, false)
                  : view.getUint8(off);
    }
    return out;
}

export interface TableColumn {
    readonly name: string;
    readonly tform: string;
    readonly repeat: number;
    readonly offset: number;
    readonly width: number;
}

const TFORM_WIDTH: Readonly<Record<string, number>> = {
    L: 1,
    B: 1,
    A: 1,
    I: 2,
    J: 4,
    K: 8,
    E: 4,
    D: 8,
    C: 8,
    M: 16,
};

export function readTableColumns(hdu: Hdu): TableColumn[] {
    const nfields = Number(hdu.header.values.get("TFIELDS") ?? "0");
    const columns: TableColumn[] = [];
    let offset = 0;
    for (let t = 1; t <= nfields; t += 1) {
        const tform = (hdu.header.values.get(`TFORM${t}`) ?? "").trim();
        const match = /^(\d*)([A-Z])/.exec(tform);
        if (!match) throw new Error(`FITS: bad TFORM${t}="${tform}"`);
        const repeat = match[1] === "" ? 1 : Number(match[1]);
        const code = match[2] as string;
        const unitWidth = TFORM_WIDTH[code];
        if (unitWidth === undefined) throw new Error(`FITS: unsupported TFORM code "${code}"`);
        const width = repeat * unitWidth;
        columns.push({
            name: (hdu.header.values.get(`TTYPE${t}`) ?? `col${t}`).trim(),
            tform,
            repeat,
            offset,
            width,
        });
        offset += width;
    }
    return columns;
}

export function readTableColumnF64(buf: Buffer, hdu: Hdu, column: TableColumn): Float64Array {
    const nrows = hdu.axes[1] ?? 0;
    const rowBytes = hdu.axes[0] ?? 0;
    const out = new Float64Array(nrows * column.repeat);
    const view = new DataView(buf.buffer, buf.byteOffset + hdu.dataStart, hdu.dataBytes);
    const code = column.tform.replace(/^\d*/, "")[0] as string;
    const unit = TFORM_WIDTH[code]!;

    for (let r = 0; r < nrows; r += 1) {
        const base = r * rowBytes;
        for (let k = 0; k < column.repeat; k += 1) {
            const off = base + column.offset + k * unit;
            let value: number;
            switch (code) {
                case "E":
                    value = view.getFloat32(off, false);
                    break;
                case "D":
                    value = view.getFloat64(off, false);
                    break;
                case "J":
                    value = view.getInt32(off, false);
                    break;
                case "I":
                    value = view.getInt16(off, false);
                    break;
                case "K":
                    value = Number(view.getBigInt64(off, false));
                    break;
                case "B":
                case "L":
                case "A":
                    value = view.getUint8(off);
                    break;
                default:
                    throw new Error(`FITS: cannot read TFORM code "${code}" as float64`);
            }
            out[r * column.repeat + k] = value;
        }
    }
    return out;
}

export function parentPixelOrigin(hdu: Hdu): { x: number; y: number } | null {
    const a = hdu.header.values.get("CRPIX1A");
    const b = hdu.header.values.get("CRPIX2A");
    if (a === undefined || b === undefined) return null;
    return { x: Number(a), y: Number(b) };
}
