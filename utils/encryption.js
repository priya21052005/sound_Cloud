import crypto from "crypto";

// Derive a 32-byte key from environment PASSWORD_SECRET or SESSION_SECRET
const SECRET = process.env.PASSWORD_SECRET || process.env.SESSION_SECRET || "default_dev_secret_change_me";
const KEY = crypto.createHash("sha256").update(SECRET).digest(); // 32 bytes

// AES-256-GCM
function encrypt(text) {
  const iv = crypto.randomBytes(12); // 96-bit nonce
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store as base64 iv:tag:cipher
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(encryptedStr) {
  try {
    const [ivHex, tagHex, cipherHex] = encryptedStr.split(":");
    if (!ivHex || !tagHex || !cipherHex) return null;
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const encrypted = Buffer.from(cipherHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    console.warn("decrypt error:", err && err.message ? err.message : err);
    return null;
  }
}

export { encrypt, decrypt };