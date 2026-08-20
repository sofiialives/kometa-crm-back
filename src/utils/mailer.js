import nodemailer from 'nodemailer'
import { env } from '../config/env.js'

const transporter = env.smtp.host
  ? nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.port === 465,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
    })
  : null

export async function sendMail(to, subject, text) {
  if (!transporter) {
    console.log(`[mailer:dev] SMTP не настроен, письмо только в консоль → ${to} | ${subject}\n${text}`)
    return
  }
  await transporter.sendMail({ from: env.smtp.from, to, subject, text })
}

export function resetCodeEmailText(code) {
  return `Код для восстановления пароля KOMETA CRM: ${code}\nДействует 10 минут. Если это были не вы, проигнорируйте письмо.`
}
