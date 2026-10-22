import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeImage,
  MAX_IMAGE_BYTES,
  preflightOutput,
  publishImage,
  resolveOutputDir,
  validateFilename,
} from "../src/artifacts.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
const realFs = await vi.importActual<typeof fs>("node:fs/promises");

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, checksum]);
}

// Two RGBA pixels: fully transparent red and half-transparent green.
const PIXELS = Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128]);
function png(width = 2, height = 1, raster = PIXELS): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raster)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A real one-component, 1x1 baseline JPEG: DC zero, EOB, and one-bit codes.
function jpeg(): Buffer {
  const segment = (marker: number, data: number[]) => {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(data.length + 2);
    return Buffer.concat([Buffer.from([255, marker]), size, Buffer.from(data)]);
  };
  const counts = [1, ...Array<number>(15).fill(0)];
  return Buffer.concat([
    Buffer.from([255, 216]),
    segment(0xdb, [0, ...Array<number>(64).fill(1)]),
    segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    segment(0xc4, [0, ...counts, 0, 0x10, ...counts, 0]),
    segment(0xda, [1, 1, 0, 0, 63, 0]),
    Buffer.from([0x3f, 255, 217]),
  ]);
}
const WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
// Generated from a half-transparent red pixel; no codec is needed at test time.
const WEBP_LOSSLESS = Buffer.from("UklGRhwAAABXRUJQVlA4TBAAAAAvAAAAEM1VICIC0f9oYAIA", "base64");
function extendedWebp(bytes: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(18);
  header.write("VP8X");
  header.writeUInt32LE(10, 4);
  header[8] = flags;
  const riff = Buffer.from(bytes.subarray(0, 12));
  const body = Buffer.concat([header, bytes.subarray(12)]);
  riff.writeUInt32LE(4 + body.length, 4);
  return Buffer.concat([riff, body]);
}
const PNG = png();
const decode = (bytes: Buffer) => decodeImage(bytes.toString("base64"));

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "pi-image-artifacts-"));
  vi.clearAllMocks();
  vi.mocked(fs.open).mockImplementation(realFs.open);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
const options = (filename?: string) => ({ cwd: directory, outputDir: "output", filename });

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("image decoding", () => {
  it.each([
    ["PNG", PNG, "image/png", "png", 2],
    ["JPEG", jpeg(), "image/jpeg", "jpg", 1],
    ["WebP", WEBP, "image/webp", "webp", 1],
    ["lossless WebP", WEBP_LOSSLESS, "image/webp", "webp", 1],
    ["extended WebP", extendedWebp(WEBP), "image/webp", "webp", 1],
    ["extended lossless WebP", extendedWebp(WEBP_LOSSLESS, 16), "image/webp", "webp", 1],
  ] as const)("identifies %s bytes, dimensions, and suffix", (_name, bytes, mimeType, extension, width) => {
    expect(decode(bytes)).toEqual({ bytes, mimeType, extension, width, height: 1 });
  });

  it("preserves the exact RGBA source bytes, including transparent pixels", () => {
    expect(decode(PNG).bytes.equals(PNG)).toBe(true);
    expect(PIXELS).toEqual(Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128]));
  });

  it.each([
    "",
    " ",
    "a",
    "aaa",
    "a===",
    "====",
    "AA=A",
    "AA==AA==",
    "AB==",
    "AAB=",
    "AA-_",
    "AA==\n",
    "data:image/png;base64,AA==",
  ])("rejects malformed/noncanonical base64 %j", (base64) => {
    expect(() => decodeImage(base64)).toThrow();
  });

  it("bounds encoded and decoded sizes before image parsing", () => {
    expect(MAX_IMAGE_BYTES).toBe(32 * 1024 * 1024);
    expect(() => decodeImage("A".repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 4))).toThrow(/32 MiB/);
    // At the encoded length limit, a lack of padding would exceed the decoded cap.
    expect(() => decodeImage("A".repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3)))).toThrow(/32 MiB/);
  });

  it.each([Buffer.from("not an image"), Buffer.from("GIF89a1234567890"), Buffer.from("<svg width='1'/>")])(
    "rejects unsupported media",
    (bytes) => {
      expect(() => decode(bytes)).toThrow(/image/);
    },
  );

  it.each([PNG, jpeg(), WEBP, WEBP_LOSSLESS, extendedWebp(WEBP)])(
    "rejects truncation at every container boundary",
    (bytes) => {
      for (let size = 1; size < bytes.length; size++) expect(() => decode(bytes.subarray(0, size))).toThrow();
      expect(() => decode(Buffer.concat([bytes, Buffer.from([0])]))).toThrow();
    },
  );

  it.each([
    [0, 1],
    [1, 0],
    [16_385, 1],
    [1, 16_385],
    [4097, 4096],
  ])("rejects dimensions %s x %s", (width, height) => {
    expect(() => decode(png(width, height))).toThrow(/dimensions/);
  });

  it("accepts the side limit when the pixel budget permits", () => {
    expect(decode(png(16_384, 1, Buffer.alloc(1 + 16_384 * 4)))).toMatchObject({ width: 16_384 });
  });

  it("rejects PNG CRC damage, bad filters, short/long rasters, and invalid zlib", () => {
    const damaged = Buffer.from(PNG);
    damaged[29] = damaged.readUInt8(29) ^ 1;
    const invalidFilter = Buffer.from(PIXELS);
    invalidFilter[0] = 5;
    for (const bytes of [
      damaged,
      png(2, 1, invalidFilter),
      png(2, 1, PIXELS.subarray(1)),
      png(2, 1, Buffer.concat([PIXELS, Buffer.from([0])])),
    ]) {
      expect(() => decode(bytes)).toThrow();
    }
    const idat = PNG.indexOf("IDAT");
    const invalidZlib = Buffer.concat([
      PNG.subarray(0, idat - 4),
      chunk("IDAT", Buffer.from("invalid")),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(() => decode(invalidZlib)).toThrow();
  });

  it("rejects PNG animation and unknown critical chunks", () => {
    for (const type of ["acTL", "fcTL", "fdAT", "ABCD"]) {
      expect(() =>
        decode(Buffer.concat([PNG.subarray(0, 33), chunk(type, Buffer.alloc(8)), PNG.subarray(33)])),
      ).toThrow();
    }
  });

  it("rejects JPEG dimension-only headers and invalid segment lengths", () => {
    const bytes = jpeg();
    const startScan = bytes.indexOf(Buffer.from([255, 218]));
    expect(() => decode(Buffer.concat([bytes.subarray(0, startScan), Buffer.from([255, 217])]))).toThrow();
    bytes.writeUInt16BE(1, 4);
    expect(() => decode(bytes)).toThrow();
  });

  it("rejects animated WebP, invalid lossless versions, and mismatched extended canvas sizes", () => {
    expect(() => decode(extendedWebp(WEBP, 2))).toThrow();
    const lossless = Buffer.from(WEBP_LOSSLESS);
    lossless[24] = lossless.readUInt8(24) | 0xe0;
    expect(() => decode(lossless)).toThrow();
    const mismatch = extendedWebp(WEBP);
    mismatch[24] = 1;
    expect(() => decode(mismatch)).toThrow();
  });

  it("rejects WebP bad frame signatures, RIFF sizes, and partition sizes", () => {
    for (const index of [4, 23, 22]) {
      const bytes = Buffer.from(WEBP);
      bytes[index] = bytes.readUInt8(index) ^ 0xff;
      expect(() => decode(bytes)).toThrow();
    }
  });
});

describe("filename and output path validation", () => {
  it.each([undefined, "image", "日本語 🖼️.png", "é.jpg", "IMAGE.PNG", ".image", "a..b.webp", "image.jpeg"])(
    "accepts safe Unicode basename %j",
    (filename) => {
      expect(() => validateFilename(filename)).not.toThrow();
    },
  );

  it.each([
    "",
    ".",
    "..",
    "...",
    "../image.png",
    "a/../b.png",
    "/image.png",
    "a\\b.png",
    "C:\\image.png",
    "~/image.png",
    "a\n.png",
    "a\r.png",
    "a\0.png",
    "a\u001b.png",
    "a\u0085.png",
    "a\u202e.png",
    "a\ud800.png",
    "image.gif",
    "image.svg",
    "a.",
    "a ",
    " a.png",
    "CON.png",
    "a:stream.png",
    "a".repeat(251),
    `${"é".repeat(126)}.png`,
  ])("rejects unsafe basename %j", (filename) => {
    expect(() => validateFilename(filename)).toThrow();
  });

  it("counts filename bytes and reserves room for MIME-derived suffixes", () => {
    expect(() => validateFilename("a".repeat(250))).not.toThrow();
    expect(() => validateFilename(`${"a".repeat(251)}.png`)).not.toThrow();
    expect(() => validateFilename(`${"a".repeat(252)}.png`)).toThrow(/long/);
  });

  it("resolves relative, absolute, and home paths without a fixed default or filesystem writes", async () => {
    expect(resolveOutputDir(directory, "images")).toBe(join(directory, "images"));
    expect(resolveOutputDir(directory, "../images")).toBe(resolve(directory, "../images"));
    expect(resolveOutputDir("/elsewhere", join(directory, "absolute"))).toBe(join(directory, "absolute"));
    expect(resolveOutputDir(directory, "~/images")).toBe(join(homedir(), "images"));
    expect(resolveOutputDir(directory, "~")).toBe(homedir());
    expect(resolveOutputDir(directory, "~other")).toBe(join(directory, "~other"));
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(["", " ", "\0", "images\n"])("rejects invalid output directory %j", (outputDir) => {
    expect(() => resolveOutputDir(directory, outputDir)).toThrow();
  });
});

describe("output preflight", () => {
  it("requires write and search permission without creating an image file", async () => {
    const access = vi.spyOn(fs, "access");
    await preflightOutput(options());
    expect(access).toHaveBeenCalledWith(join(directory, "output"), constants.W_OK | constants.X_OK);
    expect(await fs.readdir(join(directory, "output"))).toEqual([]);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("propagates a denied access check before publication", async () => {
    vi.spyOn(fs, "access").mockRejectedValueOnce(Object.assign(new Error("Access denied"), { code: "EACCES" }));
    await expect(preflightOutput(options("image"))).rejects.toMatchObject({ code: "EACCES" });
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after the access wait", async () => {
    const controller = new AbortController();
    vi.spyOn(fs, "access").mockImplementationOnce(async () => controller.abort());
    await expect(preflightOutput({ ...options(), signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fs.open).not.toHaveBeenCalled();
  });
});

describe("image publication", () => {
  it("creates directories only during publication and writes exact private image bytes", async () => {
    const result = await publishImage(decode(PNG), { ...options("透明 🖼️"), outputDir: "nested/output" });
    expect(result.path).toBe(join(directory, "nested/output/透明 🖼️.png"));
    expect(await fs.readFile(result.path)).toEqual(PNG);
    if (process.platform !== "win32") expect((await fs.stat(result.path)).mode & 0o777).toBe(0o600);
    expect(vi.mocked(fs.open).mock.calls[0]?.[1]).toBe(
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    );
  });

  it("accepts an absolute output directory independent of cwd", async () => {
    const result = await publishImage(decode(PNG), { cwd: "/not-used", outputDir: join(directory, "absolute") });
    expect(dirname(result.path)).toBe(join(directory, "absolute"));
    expect(await fs.readFile(result.path)).toEqual(PNG);
  });

  it.each([
    [PNG, "png"],
    [jpeg(), "jpg"],
    [WEBP, "webp"],
  ] as const)("uses a unique MIME-derived filename", async (bytes, extension) => {
    const result = await publishImage(decode(bytes), options());
    expect(result.path).toMatch(new RegExp(`/image-[a-f0-9-]{36}\\.${extension}$`));
    expect(await fs.readFile(result.path)).toEqual(bytes);
  });

  it("accepts matching uppercase and JPEG alternative suffixes", async () => {
    for (const [bytes, filename] of [
      [PNG, "image.PNG"],
      [jpeg(), "image.jpeg"],
    ] as const) {
      const result = await publishImage(decode(bytes), options(filename));
      expect(result.path).toBe(join(directory, "output", filename));
    }
  });

  it("rejects explicit MIME mismatches and traversal before creating directories", async () => {
    for (const filename of ["image.jpg", "image.webp", "../escape.png", "a/b.png"]) {
      await expect(publishImage(decode(PNG), options(filename))).rejects.toThrow();
    }
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("never overwrites an existing regular file", async () => {
    await fs.mkdir(join(directory, "output"));
    const target = join(directory, "output/image.png");
    await fs.writeFile(target, "user file");
    await expect(publishImage(decode(PNG), options("image.png"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(target, "utf8")).toBe("user file");
  });

  it.each(["root", "ancestor", "destination", "dangling"])(
    "rejects %s symlinks without writing through them",
    async (kind) => {
      const external = join(directory, "external");
      await fs.mkdir(external);
      if (kind === "root" || kind === "ancestor") {
        await fs.symlink(external, join(directory, "output"), "dir");
        await expect(
          publishImage(decode(PNG), { ...options("image"), outputDir: kind === "root" ? "output" : "output/nested" }),
        ).rejects.toThrow(/symlink/);
      } else {
        await fs.mkdir(join(directory, "output"));
        const userFile = join(external, "user.png");
        if (kind === "destination") await fs.writeFile(userFile, "user file");
        const link = join(directory, "output/image.png");
        await fs.symlink(userFile, link);
        await expect(publishImage(decode(PNG), options("image"))).rejects.toThrow();
        expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
        if (kind === "destination") expect(await fs.readFile(userFile, "utf8")).toBe("user file");
      }
      expect(await fs.readdir(external)).toEqual(kind === "destination" ? ["user.png"] : []);
    },
  );

  it("handles concurrent explicit-name collisions without overwriting", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => publishImage(decode(PNG), options("same"))),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await fs.readdir(join(directory, "output"))).toEqual(["same.png"]);
    expect(await fs.readFile(join(directory, "output/same.png"))).toEqual(PNG);
  });

  it("creates distinct names for concurrent publications with no filename", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => publishImage(decode(PNG), options())));
    expect(new Set(results.map((result) => result.path)).size).toBe(8);
  });

  it("uses Pi's mutation queue and rechecks ownership after a queued wait", async () => {
    const acquired = deferred();
    const release = deferred();
    const target = join(directory, "output/image.png");
    const blocking = withFileMutationQueue(target, async () => {
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    let current = true;
    const publication = publishImage(decode(PNG), { ...options("image"), isCurrent: () => current });
    current = false;
    release.resolve();
    await blocking;
    await expect(publication).rejects.toMatchObject({ name: "AbortError" });
    expect(await fs.readdir(directory)).toEqual([]);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it.each(["cancel", "stale"])("rejects %s work before any filesystem side effect", async (kind) => {
    const controller = new AbortController();
    if (kind === "cancel") controller.abort();
    await expect(
      publishImage(decode(PNG), { ...options(), signal: controller.signal, isCurrent: () => kind !== "stale" }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("cleans a partial owned write, releases the handle, and leaves the queue usable", async () => {
    let closed = false;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await realFs.open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closed = true;
        await close();
      });
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
        await handle.write(PNG.subarray(0, 16));
        throw new Error("simulated disk failure");
      });
      return handle;
    });
    await expect(publishImage(decode(PNG), options("image"))).rejects.toThrow(/disk failure/);
    expect(closed).toBe(true);
    expect(await fs.readdir(join(directory, "output"))).toEqual([]);
    const result = await publishImage(decode(PNG), options("image"));
    expect(await fs.readFile(result.path)).toEqual(PNG);
  });

  it("cleans an owned file and closes its handle after an initial stat failure", async () => {
    let closed = false;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await realFs.open(...args);
      vi.spyOn(handle, "stat").mockRejectedValueOnce(new Error("stat failed"));
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        closed = true;
      });
      return handle;
    });
    await expect(publishImage(decode(PNG), options("image"))).rejects.toThrow(/stat failed/);
    expect(closed).toBe(true);
    expect(await fs.readdir(join(directory, "output"))).toEqual([]);
  });

  it("rechecks cancellation after directory creation without opening a file", async () => {
    const controller = new AbortController();
    vi.spyOn(fs, "mkdir").mockImplementationOnce(async (path) => {
      await realFs.mkdir(path);
      controller.abort();
      return undefined;
    });
    await expect(publishImage(decode(PNG), { ...options(), signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fs.open).not.toHaveBeenCalled();
    expect(await fs.readdir(join(directory, "output"))).toEqual([]);
  });

  it("rejects stale ownership after file creation and removes the incomplete file", async () => {
    let current = true;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await realFs.open(...args);
      current = false;
      return handle;
    });
    await expect(publishImage(decode(PNG), { ...options("image"), isCurrent: () => current })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await fs.readdir(join(directory, "output"))).toEqual([]);
  });

  it("rejects a destination replaced by a symlink during open without writing the target", async () => {
    const target = join(directory, "output/image.png");
    const userFile = join(directory, "user-file");
    await fs.writeFile(userFile, "user data");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await realFs.open(...args);
      await fs.unlink(target);
      await fs.symlink(userFile, target);
      return handle;
    });
    await expect(publishImage(decode(PNG), options("image"))).rejects.toThrow(/destination changed/);
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(userFile, "utf8")).toBe("user data");
  });

  it("does not remove another writer's replacement after a write failure", async () => {
    const target = join(directory, "output/image.png");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await realFs.open(...args);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
        await fs.unlink(target);
        await fs.writeFile(target, "replacement");
        throw new Error("write failed after replacement");
      });
      return handle;
    });
    await expect(publishImage(decode(PNG), options("image"))).rejects.toThrow(/write failed/);
    expect(await fs.readFile(target, "utf8")).toBe("replacement");
  });

  it.each(["open", "stat", "write", "sync", "close"])(
    "handles cancellation during %s and preserves only completed output",
    async (phase) => {
      const controller = new AbortController();
      let closed = false;
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await realFs.open(...args);
        if (phase === "open") controller.abort();
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async () => {
          const result = await stat();
          if (phase === "stat") controller.abort();
          return result;
        });
        const writeFile = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation(async (...parameters) => {
          await writeFile(...parameters);
          if (phase === "write") controller.abort();
        });
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          await sync();
          if (phase === "sync") controller.abort();
        });
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          closed = true;
          if (phase === "close") controller.abort();
        });
        return handle;
      });
      await expect(publishImage(decode(PNG), { ...options("image"), signal: controller.signal })).rejects.toMatchObject(
        { name: "AbortError" },
      );
      expect(closed).toBe(true);
      expect(await fs.readdir(join(directory, "output"))).toEqual(
        phase === "sync" || phase === "close" ? ["image.png"] : [],
      );
      if (phase === "sync" || phase === "close")
        expect(await fs.readFile(join(directory, "output/image.png"))).toEqual(PNG);
    },
  );

  it("cleans incomplete output when fsync fails", async () => {
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await realFs.open(...args);
      vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("sync failed"));
      return handle;
    });
    await expect(publishImage(decode(PNG), options("image"))).rejects.toThrow(/sync failed/);
    expect(await fs.readdir(join(directory, "output"))).toEqual([]);
  });
});
