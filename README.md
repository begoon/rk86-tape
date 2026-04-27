# python-wav — RK86 tape WAV decoder

Decodes the contents of a Radio-86RK (Радио-86РК, Soviet 8080-based home
computer) cassette-tape recording captured as a `.wav` file, producing the
original byte stream that the ROM monitor would have written or expected to
read.

The repo contains three interchangeable implementations of the same algorithm —
Python (`main.py`), Node/Bun (`main.js`), and a browser visualizer
(`viewer.html`) — plus a `Justfile` that runs all three on `in.wav` and diffs
the outputs to verify they agree byte-for-byte.

The reference for the encoding is the RK86 ROM monitor source
(`$HOME/github/rk86-monitor/monitor.asm` — the `WRBYTE` / `RDBYTE` /
`WRTAPE` / `RDTAPE` routines). This README is written so the format can be
reimplemented from this document alone.

---

## Project layout

- **`main.py`** — reference Python decoder. Reads `in.wav`, prints the hex
  dump, validates header + checksum.
- **`main.js`** — Node / Bun port of the same algorithm. Uses
  `als-wave-parser` for WAV parsing.
- **`viewer.html`** — self-contained browser visualizer. Drag a `.wav` file
  onto it to see the waveform, every bit transition, byte boundaries, and
  the structural regions (prologue / sync / header / data / gap / 2nd sync
  / checksum). No build step.
- **`in.wav`** — sample recording (8-bit unsigned mono PCM, 22050 Hz, ~13
  s, ~290 kB).
- **`in.hex`** — reference hex dump of the decoded contents of `in.wav`.
- **`Justfile`** — `just test` runs all three decoders and diffs them.
- **`output-python.txt`** / **`output-bun.txt`** / **`output-node.txt`** —
  captured decoder output, used as the diff baseline.

### Running

```bash
# Python
python3 main.py

# Node / Bun
node main.js
bun main.js

# All three, with cross-implementation diff
just test

# Browser
open viewer.html      # then drop in.wav onto the page
```

The Python and Node implementations look for a file literally named `in.wav` in
the working directory. The browser viewer accepts any `.wav` you drop on it.

---

## WAV format expectations

The decoder is a thin reader on top of raw 8-bit unsigned PCM samples:

- **Sample rate**: 22050 Hz (the `BIT_RATE` constant of 1100 bps gives
  `SAMPLES_PER_BIT = 22050 / 1100 ≈ 20.045`). Other rates work as long as
  `BIT_RATE` and `SAMPLES_PER_BIT` are recomputed consistently.
- **Channels**: mono. The Node implementation and the viewer take channel 0 if
  more channels are present.
- **Bit depth**: 8-bit unsigned (range 0..255, midpoint 128). The viewer also
  accepts 16-bit signed by taking the high byte: `s8 = (s16 >> 8) + 128`.
- **Decision threshold**: `0x80` (128). Anything `>= 128` is treated as
  logic HIGH, anything below as logic LOW. Squarewave-like signals work; sinusoidal
  signals work too as long as the swing crosses the threshold cleanly.

The decoder operates on a 1-D array of unsigned 8-bit sample levels and never
looks back at WAV metadata once parsing is done.

---

## Bit encoding — Manchester, IEEE 802.3 / G.E. Thomas convention

Each bit cell occupies one bit period (`T = 1 / BIT_RATE ≈ 909 µs` for the
included sample, ~20 samples at 22050 Hz). The ROM monitor's standard
timing constant `tape_write_const = 1Dh = 29` produces `T ≈ 812 µs`
(~1230 bps); the `1100 bps` value in this decoder is the empirical fit for
the bundled `in.wav`, and the 0.75 T advance is forgiving enough to absorb
~10% drift either way.

The encoder, **per `entry_outb` in `monitor.asm`** (lines 1067-1116),
writes each data bit `b` as two half-cells:

| half-cell   | level   |
| ----------- | ------- |
| first half  | `NOT b` |
| second half | `b`     |

So the level *direction in the middle of the cell* encodes the bit:

```text
     .---.         .---.
     |   |         |   |
 ----'   '---  vs  '---'   '---
   bit '1'           bit '0'
   LOW → HIGH        HIGH → LOW
   (rising mid-cell) (falling mid-cell)
```

- **`1`** = first half LOW, second half HIGH; mid-cell low-to-high;
  cell *ends* HIGH.
- **`0`** = first half HIGH, second half LOW; mid-cell high-to-low;
  cell *ends* LOW.

This is the IEEE 802.3 / G.E. Thomas convention.

Bytes are transmitted **MSB first** (`rlc` rotates the high bit out into the
LSB position before each pair of half-cell writes, see `monitor.asm:1070`).

When two consecutive bits have opposite values (e.g. `10`, `01`) there is no
level change at the bit boundary — the cell happens to end and the next one
starts at the same level. When two consecutive bits have the same value
(e.g. `11`, `00`) the level *must* flip back at the bit boundary so that the
next mid-cell transition can again go in the bit-defining direction; this
produces an extra "boundary" transition in addition to the mid-cell one.

The frequency content matches what the ROM source comment (`monitor.asm:1089-1093`)
spells out:

- All-`0` (or all-`1`) byte stream → boundary + mid-cell transition every
  half-bit → square wave at the bit rate (~1.2 kHz at the standard tempo).
- Alternating `0101...` → only mid-cell transitions, period = 2 bits → square
  wave at half the bit rate (~600 Hz).
- Random data → spectrum spread between those two frequencies.

The decoder must always lock onto the mid-cell transition and ignore the
optional boundary transition. The trick used here is to advance by
**0.75 × bit period** past each detected transition: that lands safely past
any boundary transition (which is at +0.5 T from the previous mid-cell) but
short of the next mid-cell transition (which is at +1.0 T). The next "first
sample whose value differs" found after that point is the next mid-cell
transition.

### Why exactly 0.75 T?

It's the **maximum-margin** landing point. After detecting a mid-cell
transition, the decoder needs to skip ahead to a sample that is:

- **past** the optional boundary transition at `+0.5 T` — otherwise, when
  two consecutive bits are equal, the boundary flip gets misread as the
  mid-cell transition of the next bit;
- **before** the next mid-cell transition at `+1.0 T` — otherwise that
  transition gets skipped and the decoder loses sync.

So the safe window for the advance is the open interval `(0.5 T, 1.0 T)`.
Its midpoint is `0.75 T`, which gives the maximum slack on both sides —
`±0.25 T` of tolerance against:

- Bit-rate drift between encoder and decoder (the bundled WAV is at ~1100 bps;
  the ROM standard is ~1230 bps — `0.75 T` comfortably absorbs that 10%
  mismatch).
- Sample-quantization jitter — `get_bit` reports the transition at the first
  sample whose level differs from the entry value, which can land ±1 sample
  off the true crossing.
- Slow rise/fall on tape — the *actual* threshold crossing in time may not
  be exactly at `+0.5 T`.
- Tape stretch, wow & flutter, and analog-path phase non-linearity.

At 22050 Hz / 1100 bps, `T ≈ 20 samples`, so the per-bit tolerance is
roughly `±5 samples` — generous.

The RK86 ROM happens to use **~0.66 T** instead (`tape_read_const = 2Ah = 42`
loops × 14 µs each ≈ 588 µs vs. the standard 909 µs bit period). That's
also inside the safe window, just biased a bit toward "soon after the
boundary"; it works for the same reason. Anything in `(0.5 T, 1.0 T)`
would decode correctly — `0.75 T` is simply the centered, maximum-margin
choice.

### `getBit` walk-through

```python
def get_bit(data, i):
    v = data[i]                              # current level
    while i < len(data) and data[i] == v:    # skip equal samples
        i += 1
    if i >= len(data):
        return None, i
    bit = 1 if data[i] >= 0x80 else 0        # post-transition level = bit
    return bit, i + int(SAMPLES_PER_BIT * 0.75)
```

Concretely, with `SAMPLES_PER_BIT = 20.045`:

- `floor(0.75 × 20.045) = 15` samples advance after each detected transition.
- Starting somewhere in a bit cell, the routine scans forward for the **first
  sample whose level differs** from the level at the entry index. That index
  is the mid-cell transition. The new level there is the bit value.
- Then it jumps forward 15 samples — past any optional boundary transition —
  to land deep inside the next bit cell, ready to find the next mid-cell
  transition the same way.

Because the routine looks for the first inequality after the entry sample,
small ripples and jitter inside one half-bit do not derail it: as long as the
signal stays cleanly above or below the threshold within a half-cell, the
routine will only re-trigger when the half-cell changes sides.

### Implication for re-encoders

To produce a tape image readable by this decoder (and by the RK86 ROM monitor):

- For each input bit `b`, output the half-cell `not b` followed by the
  half-cell `b`. (`b == 1` → LOW for T/2, then HIGH for T/2;
  `b == 0` → HIGH for T/2, then LOW for T/2.)
- Bytes go out MSB first.
- Equivalently: place the mid-cell transition at +T/2 with the bit-defining
  direction; the boundary (next-cell start) flips to the next bit's initial
  level, which produces a boundary transition iff `b_curr == b_next`.

This is exactly what `entry_outb` in `monitor.asm` does, and the ROM uses
`tape_write_const` (default `1Dh = 29`, giving a ~406 µs half-cell delay at
the RK86's 1.78 MHz CPU clock) to time it.

---

## Frame structure

A complete tape block, exactly as written by `entry_outblock` in
`monitor.asm` (line 838 onward; the source comment at line 834-836 is the
authoritative spec):

```text
+---------------------------+
| 0x00 × 256                |   leader ("раккорд") — 256 zero bytes
+---------------------------+
| 0xE6           (1 byte)   |   first sync byte
+---------------------------+
| start_hi       (1 byte)   |   header: load address, big-endian
| start_lo       (1 byte)   |
| end_hi         (1 byte)   |   end address (inclusive), big-endian
| end_lo         (1 byte)   |
+---------------------------+
| data           (size B)   |   size = end - start + 1
+---------------------------+
| 0x00           (1 byte)   |   trailing leader (2 zero bytes)
| 0x00           (1 byte)   |
+---------------------------+
| 0xE6           (1 byte)   |   second sync byte
+---------------------------+
| checksum_hi    (1 byte)   |   16-bit checksum, big-endian
| checksum_lo    (1 byte)   |
+---------------------------+
```

Total length: `256 + 1 + 4 + size + 2 + 1 + 2 = size + 266` bytes on the wire,
or `(size + 266) × 8` bit cells, or `(size + 266) × 8 × T` seconds.

### Zero leader (256 × `0x00`)

A fixed-length run of 256 zero bytes — `entry_outblock` writes them with a
literal `dcr b` loop after `lxi b, 0` (line 840-848), so the count is
deterministic, not "as many as the user holds the key down for".

#### Why 256, and why zeros?

Nothing in the protocol requires exactly 256 — the decoder doesn't count
leader bytes, it just hunts for the first `0xE6`. The choice of 256 is
"implementation-free" rather than protocol-magical, and works out to
roughly the right wall-clock duration for tape mechanics:

- **256 is what `dcr b` gives you for free.** The 8080 has no
  compare-immediate-with-counter; the cheapest loop is "decrement an 8-bit
  register until it wraps to zero", which always counts exactly 256. Any
  other count would need an explicit `mvi b, N` and isn't more natural
  than 256.
- **256 bytes ≈ 1.66 s** of preroll at the ROM's standard timing
  (256 × 8 × 812 µs). That's enough for the tape transport to reach stable
  speed after PLAY, for the input AGC/level circuit to settle, for any
  splice or leader-tape gap to pass the head, and for the user to hear and
  confirm the tone. Other 8-bit-era tape formats (ZX Spectrum, BBC Micro,
  MSX, Apple II) use comparable 1-5 s pilot tones for exactly the same
  mechanical reasons.
- **The decoder itself needs almost nothing.** With no PLL — just
  "wait for the next transition" — even ~10-20 zero bits would be enough
  to lock the bit clock. The remaining ~2030 bits exist purely for the
  analog/mechanical settling above, not to help the receiver.

Why **zero** bytes specifically, rather than e.g. `0xAA`:

1. **Sync safety.** The leader's bit pattern, viewed through the receiver's
   sliding 8-bit window, must never equal `0xE6` (direct sync) or `0x19`
   (inverted sync — see the polarity section below) — otherwise the
   receiver would false-lock on the leader. All-zero is the simplest such
   pattern: every 8-bit window is `0x00`.
2. **Highest, cleanest carrier frequency.** All-zero data produces the
   most-periodic square wave the encoder is capable of (~1.2 kHz at
   standard tempo — boundary + mid-cell transition every half-bit, see
   "Bit encoding" above). That's the easiest possible signal for the input
   AGC and level slicer to stabilize on.
3. **Quiescent level is LOW.** A `0` bit ends LOW, so the line sits at the
   standard quiescent level when the leader ends and the first sync bit
   arrives.

The decoder in this repo does **not** count leader bytes — it just hunts for
the first `0xE6`. So a tape with a longer or shorter leader is also
accepted, as long as it's long enough to lock the receiver's clock.

### Sync-byte hunt — `0xE6 = 0b11100110`

The receiver shifts bits one at a time into an 8-bit sliding window and stops
the moment the window equals `0xE6`:

```python
def seek_sync_byte(data, i):
    byte = 0
    while True:
        bit, i = get_bit(data, i)
        if bit is None:
            return None, i
        byte = ((byte << 1) | bit) & 0xFF
        if byte == 0xE6:
            return byte, i
```

Choice of `0xE6` is deliberate: its bit pattern `1110 0110` cannot appear
inside the all-zero leader (which only ever produces the bit window
`0000 0000`), and the leading `111` is the first time the receiver sees
three consecutive `1` bits.

After the first `0xE6` the receiver switches to **byte mode**: read 8 bits,
emit a byte, repeat.

### Polarity inversion (ROM-only)

The RK86 ROM monitor (`entry_inpb`, lines 988-1000) actually accepts **two**
sync bytes: `0xE6` (direct polarity) and `0x19 = ~0xE6` (inverted polarity).
Whichever pattern matches first determines a polarity flag (lines 992-1000),
and every subsequent decoded byte is XOR'd with `0xFF` if the flag is set
(lines 1031-1032). This compensates for recordings where the audio path has
inverted phase (e.g. through certain cables, mixers, or sound cards).

The Python and JS decoders in this repo only match `0xE6` directly. If you
have an inverted recording you can either invert the WAV samples first or
extend `seek_sync_byte` to also match `0x19` and invert all downstream bytes.

### Header (4 bytes)

Two big-endian 16-bit words: the start and end addresses (inclusive) of the
memory block being transferred. The data block that follows is exactly
`size = end - start + 1` bytes long. There is no separate length field — the
length is implied by the address range.

In the bundled `in.wav` this is `1100..129F` → `size = 0x1A0 = 416` bytes.

### Data

`size` opaque bytes, in load order (the byte loaded into address `start` comes
first, then `start+1`, …, then `end`).

### Trailer: gap + 2nd sync + checksum

After the data, the format writes:

- Two bytes of `0x00`. These are not strictly required for the decoder — they
  serve as a brief lull that lets the encoder/decoder transition out of
  data-dense bytes before the next sync. The Python decoder asserts they are
  exactly `0x0000`.
- A second `0xE6` sync byte. Resyncs the byte boundary before reading the
  checksum, in case bit-counting drift accumulated through a long data
  block.
- A 16-bit big-endian checksum of the data block.

### Stream length

The Python and Node decoders simply read until the WAV runs out of samples,
then use the header to slice out exactly the meaningful bytes. Anything past
the 2-byte checksum (silence, noise, residual tape hiss) is ignored.

---

## Checksum — `rk86_check_sum`

Computed over the **data** bytes only (`decoded[4 .. 4+size]`), *not* the
header or the trailer.

```python
def rk86_check_sum(v):
    s = 0
    j = 0
    while j < len(v) - 1:                 # all bytes except the last one
        c = v[j]
        s = (s + c + (c << 8)) & 0xFFFF   # add c to BOTH high and low halves
        j += 1
    s_hi = s & 0xFF00
    s_lo = s & 0xFF
    s = s_hi | ((s_lo + v[j]) & 0xFF)   # last byte → LOW half only
    return s
```

Reading off the result in halves:

- `checksum_hi = (sum of v[0 .. n-2]) mod 256`
- `checksum_lo = (sum of v[0 .. n-1]) mod 256`
  (i.e. `(checksum_hi + v[n-1]) mod 256`)

Equivalently: `checksum_lo - checksum_hi ≡ v[n-1]  (mod 256)`. This is the
standard RK86 / Mikrosha / Apogey ROM-monitor checksum: cheap to compute
incrementally on an 8080 (one `ADD A`, one `ADC H` per byte, with a special
case for the last byte that skips the high-byte addition).

For the bundled sample, the checksum is `0x3FB0` over the 0x1A0 data bytes.

---

## Reference decoder (pseudocode)

A clean, minimal implementation reads a stream of unsigned-byte samples and
yields a list of decoded bytes plus the parsed header / checksum. The two
hooks a re-implementer needs are below; everything in `main.py` is a thin
literal version of this.

```text
# Constants
BIT_RATE       = 1100            # bits per second
SAMPLE_RATE    = 22050           # samples per second
SAMPLES_PER_BIT = SR / BR        # ≈ 20.045 here
STEP           = floor(0.75 * SAMPLES_PER_BIT)   # 15 samples
THRESHOLD      = 128             # midpoint of unsigned 8-bit range

# Bit-level: scan forward until the level changes; return that new level as
# the bit, then jump 0.75 of a bit period ahead.
function getBit(samples, i):
    v = samples[i]
    while i < len(samples) and samples[i] == v:
        i += 1
    if i >= len(samples):
        return None, i
    bit = 1 if samples[i] >= THRESHOLD else 0
    return bit, i + STEP

# Hunt the first 0xE6 by shifting bits into an 8-bit sliding window.
function seekSync(samples, i):
    byte = 0
    while True:
        bit, i = getBit(samples, i)
        if bit is None: return None, i
        byte = ((byte << 1) | bit) & 0xFF
        if byte == 0xE6: return 0xE6, i

# Read whole bytes after the first sync.
function getByte(samples, i):
    byte = 0
    for j from 7 downto 0:
        bit, i = getBit(samples, i)
        if bit is None: return None, i
        byte |= bit << j
    return byte, i

# Top-level
samples = parseWav(input)            # 0..255 unsigned, mono
i = 0
sync, i = seekSync(samples, i)       # consumes the prologue + first 0xE6
bytes  = []
while True:
    b, i = getByte(samples, i)
    if b is None: break
    bytes.append(b)

start    = (bytes[0] << 8) | bytes[1]
end      = (bytes[2] << 8) | bytes[3]
size     = end - start + 1
data     = bytes[4 : 4 + size]
trailer0 = (bytes[4 + size] << 8) | bytes[4 + size + 1]
trailerE = bytes[4 + size + 2]
checksum = (bytes[4 + size + 3] << 8) | bytes[4 + size + 4]
assert trailer0 == 0x0000
assert trailerE == 0xE6
assert rk86_check_sum(data) == checksum
```

---

## Visualizer notes (`viewer.html`)

Drop a WAV onto the page. The visualizer:

1. Parses the WAV manually so the original sample rate is preserved (browser
   `decodeAudioData` resamples to the audio context rate, which would change
   `SAMPLES_PER_BIT` and break the decoder).
2. Runs the same decoder as `main.py` / `main.js`, but instrumented to record
   every detected mid-cell transition and the sample position of every bit.
3. Renders:
   - A region bar (full-file overview) with one colored segment per
     structural region — prologue, 1st sync, header, data, gap, 2nd sync,
     checksum, trailing.
   - A zoomable / pannable waveform with the decision threshold as a dashed
     line, yellow ticks at every detected transition, dots at each bit's
     sample point (when zoomed in), vertical lines at each byte boundary,
     and the decoded byte value labeled at the top of each cell.
   - A hex dump where each byte is colored by region; clicking a byte
     centers the waveform on its sample range.

Useful for visually understanding how the prologue, sync hunt and Manchester
mid-cell rule come together.

---

## Verifying cross-implementation parity

`just test` runs `main.py`, `bun main.js`, and `node main.js` against
`in.wav`, captures the offset-prefixed dump lines, and diffs them. Any bit-
or byte-level disagreement between the three shows up immediately.

```bash
just test
```

Useful when porting the decoder to a new language: drop a fourth column into
the Justfile, point it at the new tool, and confirm clean diffs.

---

## References

- `monitor.asm` (RK86 ROM monitor source) — authoritative reference for the
  encoding. Specifically:
  - `entry_outblock` (line 838) — full block-level frame structure, with the
    summary comment at lines 834-836.
  - `entry_outb` (line 1052) — bit-level encoder: emits `(NOT b)` then `b`
    for each bit.
  - `entry_inpb` / `seek_change` / `next_bit` (line 906 onward) — bit-level
    decoder: waits for level change, samples new level as bit, delays
    `tape_read_const × 14 µs` (~588 µs at the standard `2Ah`).
  - Polarity-inversion handling: lines 988-1000 (sync detection),
    1031-1032 (per-byte XOR with polarity).
  - Timing comments: lines 1080-1093.
- IEEE 802.3 / G.E. Thomas Manchester-encoding convention (the convention
  this decoder uses: `1` = rising mid-cell, `0` = falling mid-cell).
