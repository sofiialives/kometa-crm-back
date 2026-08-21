import { asyncHandler } from '../utils/asyncHandler.js'
import * as taskService from '../services/task.service.js'

export const listTasks = asyncHandler(async (req, res) => {
  const tasks = await taskService.listTasksVisibleTo(req.user, { scope: req.query.scope })
  res.json(tasks.map((t) => ({ ...t, overdue: taskService.isOverdue(t) })))
})

export const createTask = asyncHandler(async (req, res) => {
  const task = await taskService.createTask({ ...req.body, user: req.user })
  res.status(201).json(task)
})

export const updateTaskStatus = asyncHandler(async (req, res) => {
  const task = await taskService.updateTaskStatus(req.params.id, req.body.status, req.user)
  res.json(task)
})

export const extendDeadline = asyncHandler(async (req, res) => {
  const task = await taskService.extendDeadline(req.params.id, req.body.deadline, req.user)
  res.json({ ...task, overdue: taskService.isOverdue(task) })
})

export const editTask = asyncHandler(async (req, res) => {
  const task = await taskService.editTask(req.params.id, req.body, req.user)
  res.json({ ...task, overdue: taskService.isOverdue(task) })
})

export const deleteTask = asyncHandler(async (req, res) => {
  await taskService.deleteTask(req.params.id, req.user)
  res.status(204).send()
})