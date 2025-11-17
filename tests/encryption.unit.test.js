import { encrypt, decrypt } from "../utils/encryption.js";
import mongoose from "mongoose";

describe("Encryption minimal unit tests", () => {
  test("encrypt returns hex iv:tag:cipher format", () => {
    const out = encrypt("password123");
    expect(typeof out).toBe("string");
    // simple structural check: two colons separating three hex-ish parts
    const parts = out.split(":");
    expect(parts.length).toBe(3);
    // iv and tag should be hex strings of non-zero length
    expect(parts[0]).toMatch(/^[0-9a-f]+$/i);   //iv
    expect(parts[1]).toMatch(/^[0-9a-f]+$/i);   //tag
    // cipher part may be non-empty for normal input
    expect(parts[2]).toMatch(/^[0-9a-f]*$/i);   //cipar
  });

  test("encrypt/decrypt roundtrip works for ASCII", () => {
    const plain = "hello-world-42";
    const enc = encrypt(plain);
    const dec = decrypt(enc);
    expect(dec).toBe(plain);
  });

  test("decrypt returns null for tampered data", () => {
    const plain = "s3cr3t";
    const enc = encrypt(plain);
    // tamper with last character (flip one hex char if possible)
    const tampered = enc.slice(0, -1) + (enc.slice(-1) === "0" ? "1" : "0");
    const dec = decrypt(tampered);
    expect(dec).toBeNull();
  });

  test("handles unicode strings", () => {
    const plain = "pässwörd-测试-😊";
    const enc = encrypt(plain);
    const dec = decrypt(enc);
    expect(dec).toBe(plain);
  });
});

// Ensure mongoose (if connected by other tests) is disconnected so Jest can exit
afterAll(async () => {
  try {
    await mongoose.disconnect();
  } catch (e) {
    // ignore
  }
});
