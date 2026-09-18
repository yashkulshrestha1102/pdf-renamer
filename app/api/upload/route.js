import { handleUpload } from '@vercel/blob/client';
import { NextResponse } from 'next/server';

export async function POST(request) {
  const body = await request.json();

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        return {
          allowedContentTypes: ['application/zip'],
          maximumSizeInBytes: 500 * 1024 * 1024, // 500MB
          addRandomSuffix: false,
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.log('✅ ZIP uploaded to Blob:', blob.url);
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}