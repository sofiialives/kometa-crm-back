import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, select: false },
    googleId: { type: String, select: false },

    role: { type: String, enum: ['admin', 'lead', 'staff'], default: 'staff', required: true },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },

    active: { type: Boolean, default: true },
  },
  { timestamps: true },
)

userSchema.index({ departmentId: 1 })

export const User = mongoose.model('User', userSchema)
