// Little-endian reader over one region of a pak. Reads past the end throw a RangeError from DataView,
// which the decoders turn into a PakFormatError.
export class ByteCursor {
  #position = 0;
  readonly #bytes: Uint8Array;
  readonly #view: DataView;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  seek(position: number) {
    this.#position = position;
  }

  u8() {
    const value = this.#view.getUint8(this.#position);

    this.#position += 1;

    return value;
  }

  u32() {
    const value = this.#view.getUint32(this.#position, true);

    this.#position += 4;

    return value;
  }

  i32() {
    const value = this.#view.getInt32(this.#position, true);

    this.#position += 4;

    return value;
  }

  // Offsets and sizes in a pak fit in a double; anything larger means the bytes are not a pak.
  u64() {
    const value = this.#view.getBigUint64(this.#position, true);

    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`64-bit value ${value} at byte ${this.#position} is out of range`);
    }

    this.#position += 8;

    return Number(value);
  }

  // Unreal archives store bool as a 32-bit integer.
  bool() {
    return this.u32() !== 0;
  }

  bytes(length: number) {
    if (this.#position + length > this.#bytes.byteLength) {
      throw new RangeError(`${length} bytes at byte ${this.#position} run past the end`);
    }

    const slice = this.#bytes.subarray(this.#position, this.#position + length);

    this.#position += length;

    return slice;
  }

  // FString: a positive length counts single-byte characters, a negative one UTF-16 code units; both include the terminator.
  fstring() {
    const length = this.i32();

    if (length === 0) {
      return "";
    }

    if (length > 0) {
      return new TextDecoder("latin1").decode(this.bytes(length).subarray(0, length - 1));
    }

    return new TextDecoder("utf-16le").decode(
      this.bytes(-length * 2).subarray(0, (-length - 1) * 2),
    );
  }
}
