'use strict';

/**
 * 口令散列模块
 * ------------------------------------------------------------------
 * 使用 Node 内置 crypto.scrypt（内存硬函数，抗 GPU 暴力破解），
 * 存储格式：scrypt$N$r$p$saltHex$hashHex
 * 校验使用 timingSafeEqual，避免计时侧信道。
 */

const crypto = require('node:crypto');

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;

function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 6) {
    throw new Error('口令长度至少 6 位');
  }
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, KEY_LEN, { N, r: R, p: P, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(plain, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
      maxmem: 256 * 1024 * 1024,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 生成 6 位数字签到码（用于现场核验，防止"占位不到场"） */
function generateCheckinCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/** 生成 32 字节十六进制 token */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { hashPassword, verifyPassword, generateCheckinCode, generateToken };
