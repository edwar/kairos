import type { APIRoute } from 'astro';
import { CV_MAX_CHARS, pdfToText } from '../../lib/cv.ts';

export const prerender = false;

const MAX_BYTES = 5 * 1024 * 1024;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Extracts text from an uploaded PDF. Nothing is stored on the server. */
export const POST: APIRoute = async ({ request }) => {
  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get('file');
  } catch {
    return json({ error: 'Petición inválida' }, 400);
  }
  if (!(file instanceof File)) return json({ error: 'Falta el archivo' }, 400);
  if (file.size > MAX_BYTES) return json({ error: 'El PDF supera 5 MB' }, 413);

  const buf = await file.arrayBuffer();
  if (new TextDecoder().decode(buf.slice(0, 5)) !== '%PDF-') return json({ error: 'El archivo no es un PDF' }, 415);

  try {
    const text = await pdfToText(buf);
    if (text.length < 200) {
      return json({ error: 'No pude leer texto del PDF (¿es una imagen escaneada?)' }, 422);
    }
    return json({ name: file.name, text: text.slice(0, CV_MAX_CHARS), chars: text.length, truncated: text.length > CV_MAX_CHARS });
  } catch (err) {
    return json({ error: `No se pudo leer el PDF: ${(err as Error).message}` }, 422);
  }
};
