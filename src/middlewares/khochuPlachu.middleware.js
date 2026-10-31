import { ApiError } from '../utils/ApiError.js'
import { ACCOUNT_MANAGER_POSITION, MANAGER_POSITION, resolveDepartmentId } from '../services/khochuPlachu.service.js'

export async function khochuPlachuAccess(req, res, next) {
  try {
    const departmentId = await resolveDepartmentId()

    if (req.user.role === 'admin') {
      req.khochuPlachu = { scope: 'admin', departmentId, userId: req.user.id }
      return next()
    }

    if (!departmentId || req.user.departmentId !== departmentId) {
      return next(ApiError.forbidden('Раздел «Хочу Плачу!» недоступен'))
    }

    if (req.user.position === MANAGER_POSITION) {
      req.khochuPlachu = { scope: 'manager', departmentId, userId: req.user.id }
      return next()
    }

    if (req.user.position === ACCOUNT_MANAGER_POSITION) {
      req.khochuPlachu = { scope: 'accountManager', departmentId, userId: req.user.id }
      return next()
    }

    return next(ApiError.forbidden('Раздел «Хочу Плачу!» недоступен'))
  } catch (e) {
    next(e)
  }
}

export function khochuPlachuRequireManager(req, res, next) {
  if (req.khochuPlachu?.scope !== 'manager') return next(ApiError.forbidden('Доступно только менеджеру'))
  next()
}

export function khochuPlachuRequireAccountManager(req, res, next) {
  if (req.khochuPlachu?.scope !== 'accountManager') return next(ApiError.forbidden('Доступно только аккаунт-менеджеру'))
  next()
}
