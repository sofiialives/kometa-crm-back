import mongoose from 'mongoose'

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    deadline: { type: Date, required: true },

    status: { type: String, enum: ['today', 'progress', 'done'], default: 'today' },
    doneAt: { type: Date, default: null },

    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
    workId: { type: mongoose.Schema.Types.ObjectId, ref: 'Work', default: null },
  },
  { timestamps: true },
)

taskSchema.index({ ownerId: 1, status: 1 })
taskSchema.index({ departmentId: 1, status: 1 })

export const Task = mongoose.model('Task', taskSchema)
