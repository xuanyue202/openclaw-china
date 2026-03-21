/**
 * 企业微信加解密工具（从 wecom-app extension 复制）
 */
import crypto from "node:crypto";

function decodeEncodingAESKey(encodingAESKey: string): Buffer {
  const trimmed = encodingAESKey.trim();
  if (!trimmed) throw new Error("encodingAESKey missing");
  const withPadding = trimmed.endsWith("=") ? trimmed : `${trimmed}=`;
  const key = Buffer.from(withPadding, "base64");
  if (key.length !== 32) {
    throw new Error(`invalid encodingAESKey (expected 32 bytes, got ${key.length})`);
  }
  return key;
}

const BLOCK_SIZE = 32;

function pkcs7Pad(buf: Buffer, blockSize: number): Buffer {
  const mod = buf.length % blockSize;
  const pad = mod === 0 ? blockSize : blockSize - mod;
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function pkcs7Unpad(buf: Buffer, blockSize: number): Buffer {
  if (buf.length === 0) throw new Error("invalid pkcs7 payload");
  const pad = buf[buf.length - 1]!;
  if (pad < 1 || pad > blockSize || pad > buf.length) throw new Error("invalid pkcs7 padding");
  for (let i = 1; i <= pad; i++) {
    if (buf[buf.length - i] !== pad) throw new Error("invalid pkcs7 padding");
  }
  return buf.subarray(0, buf.length - pad);
}

function sha1Hex(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

export function computeMsgSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return sha1Hex([token, timestamp, nonce, encrypt].map((v) => String(v ?? "")).sort().join(""));
}

export function verifySignature(token: string, timestamp: string, nonce: string, encrypt: string, signature: string): boolean {
  return computeMsgSignature(token, timestamp, nonce, encrypt) === signature;
}

export function decrypt(encodingAESKey: string, receiveId: string, encrypt: string): string {
  const aesKey = decodeEncodingAESKey(encodingAESKey);
  const iv = aesKey.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = pkcs7Unpad(
    Buffer.concat([decipher.update(Buffer.from(encrypt, "base64")), decipher.final()]),
    BLOCK_SIZE,
  );
  if (decrypted.length < 20) throw new Error("invalid decrypted payload");
  const msgLen = decrypted.readUInt32BE(16);
  const msg = decrypted.subarray(20, 20 + msgLen).toString("utf8");
  if (receiveId) {
    const trailing = decrypted.subarray(20 + msgLen).toString("utf8");
    if (trailing !== receiveId) throw new Error(`receiveId mismatch (expected "${receiveId}", got "${trailing}")`);
  }
  return msg;
}

export function encrypt(encodingAESKey: string, receiveId: string, plaintext: string): string {
  const aesKey = decodeEncodingAESKey(encodingAESKey);
  const iv = aesKey.subarray(0, 16);
  const random16 = crypto.randomBytes(16);
  const msg = Buffer.from(plaintext, "utf8");
  const msgLen = Buffer.alloc(4);
  msgLen.writeUInt32BE(msg.length, 0);
  const raw = Buffer.concat([random16, msgLen, msg, Buffer.from(receiveId, "utf8")]);
  const padded = pkcs7Pad(raw, BLOCK_SIZE);
  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}
