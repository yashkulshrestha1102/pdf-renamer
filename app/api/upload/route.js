import { NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { processZip } from '@/lib/processZip';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('zipFile');

    if (!file) {
      return NextResponse.json({ error: 'No ZIP uploaded' }, { status: 400 });
    }

    const jobId = uuidv4();
    const tmpDir = path.join('/tmp', 'pdf-renamer', jobId);
    await mkdir(tmpDir, { recursive: true });

    const zipPath = path.join(tmpDir, 'input.zip');
    const bytes = await file.arrayBuffer();
    await writeFile(zipPath, Buffer.from(bytes));

    console.log(`📦 Processing job: ${jobId}`);
    const outputZipPath = await processZip(zipPath, jobId, tmpDir);

    return NextResponse.json({
      success: true,
      downloadUrl: `/api/download/${jobId}`,
      jobId,
    });
  } catch (error) {
    console.error('❌ Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}