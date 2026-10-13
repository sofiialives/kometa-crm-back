import { asyncHandler } from '../utils/asyncHandler.js'
import * as overview from '../services/motivation/overview.service.js'
import * as team from '../services/motivation/team.service.js'
import * as bank from '../services/motivation/bank.service.js'
import * as events from '../services/motivation/events.service.js'
import * as settings from '../services/motivation/settings.service.js'
import * as review from '../services/motivation/review.service.js'
import * as journal from '../services/motivation/callJournal.service.js'

// ---- Про себя: сотрудник и руководитель ------------------------------------

export const getMine = asyncHandler(async (req, res) => {
  res.json(await overview.getMyOverview(req.user, req.query.month))
})

export const getMyConditions = asyncHandler(async (req, res) => {
  res.json(await overview.getMyConditions(req.user))
})

export const markSeen = asyncHandler(async (req, res) => {
  res.json(await overview.markSeen(req.user, req.body))
})

// ---- Команда: руководитель смотрит, владелец начисляет ---------------------

export const getTeam = asyncHandler(async (req, res) => {
  res.json(await team.getTeam(req.user, req.query))
})

export const getTeamMonths = asyncHandler(async (req, res) => {
  res.json(await team.teamMonths(req.user))
})

export const getEmployees = asyncHandler(async (req, res) => {
  res.json(await team.managedEmployees(req.user))
})

export const getEmployee = asyncHandler(async (req, res) => {
  res.json(await overview.getOverview(req.user, req.params.id, req.query.month))
})

export const getEmployeeConditions = asyncHandler(async (req, res) => {
  res.json(await overview.getConditions(req.user, req.params.id))
})

export const getManualOptions = asyncHandler(async (req, res) => {
  res.json(await events.manualOptions(req.user, req.params.id))
})

export const topUp = asyncHandler(async (req, res) => {
  res.status(201).json(await bank.topUp(req.user, req.body))
})

export const writeOff = asyncHandler(async (req, res) => {
  res.status(201).json(await bank.writeOff(req.user, req.body))
})

export const addManual = asyncHandler(async (req, res) => {
  res.status(201).json(await events.addManual(req.user, req.body))
})

export const addProduct = asyncHandler(async (req, res) => {
  res.status(201).json(await events.addProduct(req.user, req.body))
})

export const cancelEvent = asyncHandler(async (req, res) => {
  res.json(await events.cancelEvent(req.user, req.params.id, req.body))
})

// ---- Очередь «На проверке» (владелец) --------------------------------------

export const listReviews = asyncHandler(async (req, res) => {
  res.json(await review.listReviews(req.user, req.query))
})

export const reviewsCount = asyncHandler(async (req, res) => {
  res.json(await review.pendingCount(req.user))
})

export const approveReview = asyncHandler(async (req, res) => {
  res.json(await review.approveReview(req.user, req.params.id, req.body))
})

export const rejectReview = asyncHandler(async (req, res) => {
  res.json(await review.rejectReview(req.user, req.params.id, req.body))
})

// ---- Журнал звонка и форс-мажор (владелец) ---------------------------------

export const getCallJournal = asyncHandler(async (req, res) => {
  res.json(await journal.getJournal(req.user, req.params.day))
})

export const setCallMark = asyncHandler(async (req, res) => {
  res.json(await journal.setMark(req.user, req.params.day, req.params.userId, req.body.status))
})

export const setAway = asyncHandler(async (req, res) => {
  res.status(201).json(await journal.setAway(req.user, req.body))
})

export const endAway = asyncHandler(async (req, res) => {
  res.json(await journal.endAway(req.user, req.params.id))
})

// ---- Настройки (владелец) --------------------------------------------------

export const getSettings = asyncHandler(async (req, res) => {
  res.json(await settings.getSettings(req.user))
})

export const updateGeneral = asyncHandler(async (req, res) => {
  res.json(await settings.updateGeneral(req.user, req.body))
})

export const createProfile = asyncHandler(async (req, res) => {
  res.status(201).json(await settings.createProfile(req.user, req.body))
})

export const updateProfile = asyncHandler(async (req, res) => {
  res.json(await settings.updateProfile(req.user, req.params.id, req.body))
})

export const deleteProfile = asyncHandler(async (req, res) => {
  await settings.deleteProfile(req.user, req.params.id)
  res.status(204).send()
})

export const saveProfileScale = asyncHandler(async (req, res) => {
  res.json(await settings.saveScale(req.user, req.params.id, req.body.levels))
})

export const createEventType = asyncHandler(async (req, res) => {
  res.status(201).json(await settings.createEventType(req.user, req.params.id, req.body))
})

export const updateEventType = asyncHandler(async (req, res) => {
  res.json(await settings.updateEventType(req.user, req.params.id, req.body))
})

export const deleteEventType = asyncHandler(async (req, res) => {
  res.json(await settings.deleteEventType(req.user, req.params.id))
})

export const saveGlobalScale = asyncHandler(async (req, res) => {
  res.json(await settings.saveScale(req.user, null, req.body.levels))
})

export const saveWorkLevels = asyncHandler(async (req, res) => {
  res.json(await settings.saveWorkLevels(req.user, req.body.levels))
})

export const assignProfile = asyncHandler(async (req, res) => {
  res.json(await settings.assignProfile(req.user, req.params.userId, req.body.profileId))
})
