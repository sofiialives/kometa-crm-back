import { downloadFile } from '../telegram.js'
import { fileWord } from './memory.js'

/**
 * Файлы, которые прислал человек, — модели: фото и картинки она видит,
 * PDF читает. Видео, голосовые и прочее она не разберёт, но бот перешлёт
 * их Яну в отчёте. Картинок за раз не больше четырёх: каждая — около
 * 1 600 единиц текста.
 */

const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
// PDF — один на сообщение, до 2 МБ и 20 страниц: страница стоит модели
// 1 500–3 000 единиц текста, сотня страниц съела бы дневной бюджет.
const MAX_PDFS = 1
const MAX_PDF_BYTES = 2 * 1024 * 1024
const MAX_PDF_PAGES = 20

/** Сколько страниц в PDF — по разметке страниц внутри файла, примерно. */
export function pdfPages(buffer) {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length
}

/** Что за файл по первым байтам: имени и типу от телеграма не верим. */
export function sniff(buffer) {
  const b = buffer.subarray(0, 12)
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b.toString('ascii', 0, 4) === '%PDF') return 'application/pdf'
  return null
}

/** Можно ли показать файл модели — до скачивания, по тому, что сказал телеграм. */
export function readable(file) {
  if (file.kind === 'photo') return 'image'
  if (file.kind === 'document' && /^image\/(jpeg|png|gif|webp)$/.test(file.mime ?? '')) return 'image'
  if (file.kind === 'document' && file.mime === 'application/pdf') return 'pdf'
  return null
}

/**
 * Блоки для модели: картинки и PDF, а про остальное — пометка текстом.
 * Не скачалось — тоже пометка: агент скажет, что не открылось.
 */
export async function fileBlocks(files = []) {
  const blocks = []
  const notes = []
  let images = 0
  let pdfs = 0
  for (const f of files) {
    const how = readable(f)
    if (!how) {
      notes.push(`прислал ${fileWord(f.kind)}, его ты посмотреть не можешь, но бот перешлёт его в отчёте`)
      continue
    }
    if ((how === 'image' && images >= MAX_IMAGES) || (how === 'pdf' && pdfs >= MAX_PDFS)) {
      notes.push(`ещё ${how === 'pdf' ? 'PDF' : 'фото'}, его ты не видишь, но бот перешлёт его в отчёте`)
      continue
    }
    const got = await downloadFile(f.fileId, { maxBytes: how === 'pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES })
    // Тип — по самому файлу: PDF под видом картинки идёт по правилам PDF.
    const type = got ? sniff(got.buffer) : null
    if (type?.startsWith('image/') && images < MAX_IMAGES) {
      images += 1
      blocks.push({ type: 'image', source: { type: 'base64', media_type: type, data: got.buffer.toString('base64') } })
    } else if (type === 'application/pdf' && pdfs < MAX_PDFS && got.buffer.length <= MAX_PDF_BYTES && pdfPages(got.buffer) <= MAX_PDF_PAGES) {
      pdfs += 1
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: got.buffer.toString('base64') } })
    } else {
      notes.push(type === 'application/pdf'
        ? `прислал PDF больше ${MAX_PDF_PAGES} страниц или 2 МБ, его ты не читаешь, но бот перешлёт его в отчёте`
        : `прислал ${fileWord(f.kind)}, но он не открылся или слишком большой`)
    }
  }
  return { blocks, notes }
}
