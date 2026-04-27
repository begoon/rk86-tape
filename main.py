import wave

BIT_RATE = 1100
SAMPLE_RATE = 22050
SAMPLES_PER_BIT = SAMPLE_RATE / BIT_RATE
print(f"{SAMPLES_PER_BIT=}")

threshold = 100


def get_bit(data: list[int], i: int) -> tuple[int | None, int]:
    v = data[i]
    while i < len(data) and data[i] == v:
        i += 1
    if i >= len(data):
        return None, i
    bit = 1 if data[i] >= threshold else 0
    return bit, i + int(SAMPLES_PER_BIT * 0.75)


def seek_sync_byte(data: list[int], i: int) -> tuple[int | None, int]:
    byte = 0
    while True:
        byte <<= 1
        bit, i = get_bit(data, i)
        if bit is None:
            return None, i
        byte = (byte | bit) & 0xFF
        if byte == 0xE6:
            return byte, i


def get_byte(data: list[int], i: int) -> tuple[int | None, int]:
    byte = 0
    for j in reversed(range(8)):
        bit, i = get_bit(data, i)
        if bit is None:
            return None, i
        byte |= bit << j
    print(f"{byte:02X} ", end="")
    return byte, i


def decode_data(frames: bytes) -> list[int] | None:
    data = list(frames)

    i = 0

    bit, i = seek_sync_byte(data, i)
    if bit is None:
        print("sync byte (E6) not found")
        return
    print(f"sync byte (E6) found at offset {i - 1:08X}")

    result = []

    offset = 0
    while True:
        if offset & 0x0F == 0:
            print(f"{offset:08X} ", end="")
        byte, i = get_byte(data, i)
        if byte is None:
            break
        result.append(byte)
        if (offset & 0x07) == 0x07:
            print(" ", end="")
        if (offset & 0x0F) == 0x0F:
            print()
        offset += 1
    print()

    return result


def rk86_check_sum(v: list[int]) -> int:
    sum_ = 0
    j = 0
    while j < len(v) - 1:
        c = v[j]
        sum_ = (sum_ + c + (c << 8)) & 0xFFFF
        j += 1
    sum_h = sum_ & 0xFF00
    sum_l = sum_ & 0xFF
    sum_ = sum_h | ((sum_l + v[j]) & 0xFF)
    return sum_


def main() -> None:
    with wave.open("in.wav", "rb") as f:
        print(f.getparams())
        data = f.readframes(f.getnframes())
        print(f"read {len(data)} frames")

        decoded: list[int] | None = decode_data(data)
        assert decoded is not None, "decoded data is None"

        start = decoded[1] | (decoded[0] << 8)
        end = decoded[3] | (decoded[2] << 8)
        size = end - start + 1
        print(f"{start:04X}-{end:04X} {size:04X}")
        trailer_0000 = decoded[4 + size] | (decoded[4 + size + 1] << 8)
        trailer_e6 = decoded[4 + size + 2]
        print(f"{trailer_0000:04X} {trailer_e6:02X}")
        assert trailer_0000 == 0x0000, f"{trailer_0000=:04X} != 0000"
        assert trailer_e6 == 0xE6, f"{trailer_e6=:02X} != E6"
        checksum = decoded[4 + size + 2 + 2] | (decoded[4 + size + 2 + 1] << 8)
        print(f"{checksum=:04X}")
        actual_checksum = rk86_check_sum(decoded[4 : 4 + size])
        assert (
            actual_checksum == checksum
        ), f"{actual_checksum=:04X} != {checksum=:04X}"


if __name__ == "__main__":
    main()
