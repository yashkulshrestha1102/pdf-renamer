import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import fs from 'fs-extra';
import { processZip } from '@/lib/processZip';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request) {
  try {
    const { blobUrl, fileName } = await request.json();

    if (!blobUrl) {
      return NextResponse.json({ error: 'No blob URL provided' }, { status: 400 });
    }

    const jobId = uuidv4();
    const tmpDir = path.join('/tmp', 'pdf-renamer', jobId);
    await mkdir(tmpDir, { recursive: true });

    // Blob se ZIP download kar
    const zipPath = path.join(tmpDir, 'input.zip');
    const response = await fetch(blobUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(zipPath, buffer);

    console.log(`📦 Processing job: ${jobId}`);
    const result = await processZip(zipPath, jobId, tmpDir);

    return NextResponse.json({
      success: true,
      downloadUrl: result.blobUrl,
      fileName: result.fileName,
      companyName: result.companyName,
      jobId,
    });
  } catch (error) {
    console.error('❌ Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}