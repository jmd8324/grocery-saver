// Uploads a big PDF (over ~3 MB) straight to Vercel Blob, so it can skip
// Vercel's 4.5 MB request limit. Returns { media_type, url } to send to the
// reader instead of the file's bytes. The server deletes it after reading.
// Used by upload.html and update-prices.html.

const BLOB_CLIENT = 'https://cdn.jsdelivr.net/npm/@vercel/blob@2.8.1/client/+esm';
export const MAX_BIG_PDF_BYTES = 30 * 1024 * 1024;

export async function uploadBigPdf(file, onProgress) {
  if (file.size > MAX_BIG_PDF_BYTES) throw new Error('That PDF is too large (30 MB max). Try splitting it or sharing screenshots of the pages.');
  const { upload } = await import(BLOB_CLIENT);
  const safe = String(file.name || 'flyer.pdf').replace(/[^\w.-]+/g, '-').replace(/^-+/, '').slice(-60) || 'flyer.pdf';
  const name = /\.pdf$/i.test(safe) ? safe : safe + '.pdf';
  try {
    const blob = await upload('uploads/' + name, file, {
      access: 'public',
      handleUploadUrl: '/api/blob-upload',
      contentType: 'application/pdf',
      multipart: file.size > 8 * 1024 * 1024,
      onUploadProgress: onProgress ? (e) => onProgress(Math.round(e.percentage)) : undefined,
    });
    return { media_type: 'application/pdf', url: blob.url };
  } catch (err) {
    console.error('Big PDF upload failed:', err);
    throw new Error((err && err.message && !/^Vercel Blob/.test(err.message) ? err.message : "We couldn't upload that PDF.") + ' Please try again.');
  }
}
