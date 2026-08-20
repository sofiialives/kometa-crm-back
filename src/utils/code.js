import crypto from 'crypto'
import bcrypt from 'bcryptjs'

export function generateSixDigitCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

export async function hashCode(code) {
  return bcrypt.hash(code, 10)
}

export async function compareCode(code, hash) {
  if (!hash) return false
  return bcrypt.compare(code, hash)
}
