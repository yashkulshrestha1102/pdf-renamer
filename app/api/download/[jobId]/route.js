import { NextResponse } from 'next/server';
import { readFile, readdir } from 'fs/promises';
import path from 'path';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    const { jobId } = await params;
    const dirPath = path.join('/tmp', 'pdf-renamer', jobId);

    // Folder me jo bhi .zip file hai, woh dhoondh
    const files = await readdir(dirPath);
    const zipFile = files.find((f) => f.endsWith('.zip') && f !== 'input.zip');

    if (!zipFile) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const filePath = path.join(dirPath, zipFile);
    const fileBuffer = await readFile(filePath);

    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFile}"`,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}