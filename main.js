import WaveParser from "als-wave-parser";
import fs from "node:fs";

const BIT_RATE = 1100;
const SAMPLE_RATE = 22050;
const SAMPLES_PER_BIT = SAMPLE_RATE / BIT_RATE;
const THRESHOLD = 0x80;

console.log(`SAMPLES_PER_BIT=${SAMPLES_PER_BIT}`);

function getBit(data, i) {
    const v = data[i];
    while (i < data.length && data[i] === v) i += 1;
    if (i >= data.length) return [null, i];
    const bit = data[i] >= THRESHOLD ? 1 : 0;
    return [bit, i + Math.floor(SAMPLES_PER_BIT * 0.75)];
}

function seekSyncByte(data, i) {
    let byte = 0;
    while (true) {
        byte <<= 1;
        const [bit, advance] = getBit(data, i);
        if (bit === null) return [null, advance];
        byte = (byte | bit) & 0xff;
        if (byte === 0xe6) return [byte, advance];
        i = advance;
    }
}

function getByte(data, i, print = true) {
    let byte = 0;
    for (let j = 7; j >= 0; j--) {
        const [bit, advance] = getBit(data, i);
        if (bit === null) return [null, advance];
        byte |= bit << j;
        i = advance;
    }
    if (print) process.stdout.write(byte.toString(16).padStart(2, "0").toUpperCase() + " ");
    return [byte, i];
}

function decodeData(frames, print = true) {
    const data = Array.from(frames, (x) => x & 0xff);
    let i = 0;

    const [bit, advance] = seekSyncByte(data, i);
    if (bit === null) {
        console.log("sync byte (E6) not found");
        return;
    }

    console.log(`sync byte (E6) found at offset ${(advance - 1).toString(16).padStart(8, "0")}`);
    i = advance;

    const result = [];
    let offset = 0;
    while (true) {
        if ((offset & 0x0f) === 0) {
            if (print) process.stdout.write(offset.toString(16).padStart(8, "0").toUpperCase() + " ");
        }
        const [byte, advance] = getByte(data, i, print);
        if (byte === null) break;
        i = advance;

        result.push(byte);

        if (print) {
            if ((offset & 0x07) === 0x07) process.stdout.write(" ");
            if ((offset & 0x0f) === 0x0f) process.stdout.write("\n");
        }
        offset++;
    }
    if (print) console.log();
    return result;
}

const hex8 = (v) =>
    v
        .toString(16)
        .padStart(v > 255 ? 4 : 2, "0")
        .toUpperCase();

const hex16 = (v) => v.toString(16).padStart(4, "0").toUpperCase();
function rk86_check_sum(v) {
    let sum = 0;
    let j = 0;
    while (j < v.length - 1) {
        const c = v[j];
        sum = (sum + c + (c << 8)) & 0xffff;
        j += 1;
    }
    const sum_h = sum & 0xff00;
    const sum_l = sum & 0xff;
    sum = sum_h | ((sum_l + v[j]) & 0xff);
    return sum;
}

function decodeBinary(decoded) {
    const start = decoded[1] | (decoded[0] << 8);
    const end = decoded[3] | (decoded[2] << 8);
    const size = end - start + 1;
    console.log(`${hex16(start)}-${hex16(end)}`, hex16(size));

    const trailer_0000 = decoded[4 + size] | (decoded[4 + size + 1] << 8);

    const trailer_e6 = decoded[4 + size + 2];
    console.log(hex16(trailer_0000), hex16(trailer_e6));

    if (trailer_e6 !== 0xe6) throw new Error(`trailer_e6=${hex16(trailer_e6)} != E6`);

    const checksum = decoded[4 + size + 2 + 2] | (decoded[4 + size + 2 + 1] << 8);
    console.log(`checksum=${hex16(checksum)}`);
    const actual_checksum = rk86_check_sum(decoded.slice(4, 4 + size));

    if (actual_checksum !== checksum) {
        throw new Error(`actual_checksum=${hex16(actual_checksum)} != checksum=${hex16(checksum)}`);
    }
}

function decodeBasic(decoded) {
    console.log("BASIC tape format detected (D3 D3 D3 D3 marker)");
    let i = 4;

    const nameBytes = [];
    while (i < decoded.length && decoded[i] !== 0x00) {
        nameBytes.push(decoded[i]);
        i++;
    }
    const name = String.fromCharCode(...nameBytes);
    console.log(`name="${name}" (${nameBytes.length} bytes)`);

    while (i < decoded.length && decoded[i] !== 0xe6) i++;
    if (i >= decoded.length) throw new Error("second E6 sync byte not found");
    console.log(`second E6 sync at decoded offset ${hex16(i)}`);
    i++;

    if (decoded[i] !== 0xd3 || decoded[i + 1] !== 0xd3 || decoded[i + 2] !== 0xd3) {
        throw new Error(
            `expected D3 D3 D3 after second E6, got ${hex8(decoded[i])} ${hex8(decoded[i + 1])} ${hex8(decoded[i + 2])}`,
        );
    }
    i += 3;

    const programStart = i;
    let lines = 0;
    while (i + 1 < decoded.length) {
        const link = decoded[i] | (decoded[i + 1] << 8);
        if (link === 0) {
            i += 2;
            break;
        }
        i += 4;
        while (i < decoded.length && decoded[i] !== 0x00) i++;
        if (i >= decoded.length) throw new Error("unterminated BASIC line");
        i++;
        lines++;
    }

    const programLen = i - programStart;
    console.log(`program length=${hex16(programLen)} (${lines} lines)`);
}

export async function main(path = "in.wav") {
    const print = path === "in.wav";
    const input = fs.readFileSync(path);
    const arrayBuffer = new Uint8Array(input).buffer;
    const wav = new WaveParser(arrayBuffer);
    console.log({ ...wav, samples: undefined });
    const data = wav.samples[0].map((x) => x * 256);
    const decoded = decodeData(data, print);

    const isBasic = decoded[0] === 0xd3 && decoded[1] === 0xd3 && decoded[2] === 0xd3 && decoded[3] === 0xd3;

    if (isBasic) {
        decodeBasic(decoded);
    } else {
        decodeBinary(decoded);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main(process.argv[2]);
}
