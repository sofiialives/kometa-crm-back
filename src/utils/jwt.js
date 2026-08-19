import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, departmentId: user.departmentId },
    env.jwtAccessSecret,
    { expiresIn: env.accessTokenTtl },
  )
}

export function signRefreshToken(user) {
  return jwt.sign({ sub: user.id }, env.jwtRefreshSecret, { expiresIn: env.refreshTokenTtl })
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret)
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwtRefreshSecret)
}
