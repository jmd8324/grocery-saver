// POST /api/blob-upload — lets the browser upload a big PDF (like a full
// weekly ad) straight to Vercel Blob, past Vercel's 4.5 MB request limit.
// The receipt reader then reads it from there and deletes it right away
// (see api/_reader.js), so files aren't kept. Anything left behind is deleted
// after an hour (sweepStale below).
//
// Needs a Vercel Blob store connected to the project (sets BLOB_READ_WRITE_TOKEN).

import { del, list } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import { overLimit } from './_redis.js';
import { MAX_PDF_BYTES } from './_reader.js';

// Uploads that were never read (page closed mid-way) are swept up here: any
// file in uploads/ older than an hour is deleted when someone starts a new upload.
const STALE_MS = 60 * 60 * 1000;
async function sweepStale() {
  try {
    const { blobs } = await list({ prefix: 'uploads/', limit: 100 });
    const old = blobs.filter((b) => Date.now() - new Date(b.uploadedAt).getTime() > STALE_MS).map((b) => b.url);
    if (old.length) await del(old);
  } catch (err) {
    console.error('blob-upload sweep:', err.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('blob-upload: BLOB_READ_WRITE_TOKEN is not set (connect a Blob store in Vercel).');
    return res.status(503).json({ error: "Large PDF uploads aren't set up yet. Try a PDF under 3 MB." });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (body.type === 'blob.generate-client-token' && await overLimit(req, 'blob-upload', 30, 60 * 60)) {
    return res.status(429).json({ error: 'That is a lot of uploads this hour. Please try again later.' });
  }

  if (body.type === 'blob.generate-client-token') await sweepStale();

  try {
    const result = await handleUpload({
      request: req,
      body,
      onBeforeGenerateToken: async (pathname) => {
        if (!/^uploads\/[\w.-]+\.pdf$/i.test(pathname)) throw new Error('Only PDFs can be uploaded.');
        return {
          allowedContentTypes: ['application/pdf'],
          maximumSizeInBytes: MAX_PDF_BYTES,
          addRandomSuffix: true,
          validUntil: Date.now() + 10 * 60 * 1000,
        };
      },
      onUploadCompleted: async () => {},
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error('blob-upload:', err.message);
    return res.status(400).json({ error: err.message || "We couldn't start the upload." });
  }
}
