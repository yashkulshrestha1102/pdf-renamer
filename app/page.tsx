'use client';

import { useState } from 'react';

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] || null);
    setStatus('');
    setDownloadUrl('');
    setFileName('');
  };

 const handleUpload = async () => {
  if (!file) {
    setStatus('❌ Pehle ZIP file select kar bhai!');
    return;
  }

  setLoading(true);
  setStatus('⏳ Upload ho raha hai... thoda wait kar.');

  try {
    // 1. Browser se seedha Blob pe upload
    const blob = await upload(file.name, file, {
      access: 'public',
      handleUploadUrl: '/api/upload/client-upload',
    });

    setStatus('⏳ ZIP process ho raha hai...');
    setDownloadUrl('');
    setFileName('');

    // 2. Ab Blob URL ko processing API pe bhej
    const response = await fetch('/api/upload/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blobUrl: blob.url, fileName: file.name }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    setStatus(`✅ Kaam ho gaya! Company: ${data.companyName}`);
    setDownloadUrl(data.downloadUrl);
    setFileName(data.fileName);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    setStatus('❌ Error: ' + errMsg);
  } finally {
    setLoading(false);
  }
};

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md text-center">
        <h1 className="text-2xl font-bold text-gray-800 mb-2">
          📄 PDF Bulk Renamer
        </h1>
        <p className="text-gray-500 mb-6 text-sm">
          Apni ZIP file upload karo, saari PDFs automatically rename ho jayengi.
        </p>

        <input
          type="file"
          accept=".zip"
          onChange={handleFileChange}
          className="block w-full text-sm text-gray-600 border-2 border-dashed border-gray-300 rounded-lg p-3 mb-4 cursor-pointer hover:border-blue-400"
        />

        <button
          onClick={handleUpload}
          disabled={loading}
          className={`w-full py-3 rounded-lg font-semibold text-white transition ${
            loading
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-green-600 hover:bg-green-700'
          }`}
        >
          {loading ? 'Processing...' : 'Upload & Rename'}
        </button>

        {status && <p className="mt-4 text-gray-600 text-sm">{status}</p>}

        {downloadUrl && (
          <a
            href={downloadUrl}
            download={fileName}
            className="inline-block mt-4 text-blue-600 font-semibold hover:underline"
          >
            ⬇️ Download {fileName}
          </a>
        )}
      </div>
    </main>
  );
}