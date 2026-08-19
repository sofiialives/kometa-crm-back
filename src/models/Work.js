import mongoose from 'mongoose'

const workSchema = new mongoose.Schema(
  {
    clientName: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },

    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    assignees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    status: { type: String, enum: ['active', 'done', 'archived'], default: 'active' },
  },
  { timestamps: true },
)

workSchema.index({ departmentId: 1 })

export const Work = mongoose.model('Work', workSchema)
