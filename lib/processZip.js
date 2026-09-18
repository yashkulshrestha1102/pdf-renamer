import AdmZip from 'adm-zip';
import fs from 'fs-extra';
import path from 'path';
import { extractText, getDocumentProxy } from 'unpdf';

export async function processZip(zipPath, jobId, tmpDir) {
  const extractDir = path.join(tmpDir, 'extracted');
  const renamedDir = path.join(tmpDir, 'renamed');
  const outputZipPath = path.join(tmpDir, 'output.zip');

  await fs.ensureDir(extractDir);
  await fs.ensureDir(renamedDir);

  // 1. Extract ZIP
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractDir, true);

  // 2. Process each PDF
  const files = await fs.readdir(extractDir);
  let processedCount = 0;
  const companyCount = {}; // Kaunsi company kitni baar aayi

  for (const file of files) {
    if (!file.toLowerCase().endsWith('.pdf')) continue;

    const pdfPath = path.join(extractDir, file);
    const dataBuffer = await fs.readFile(pdfPath);

    try {
      const pdf = await getDocumentProxy(new Uint8Array(dataBuffer));
      const { text } = await extractText(pdf, { mergePages: true });

      // --- Company ka pehla word ---
      let company = 'UNKNOWN';
      const compMatch = text.match(/([A-Z]{3,})\s+Technologies/);
      if (compMatch) company = compMatch[1];

      // Company count badhao
      if (company !== 'UNKNOWN') {
        companyCount[company] = (companyCount[company] || 0) + 1;
      }

      // --- Invoice No ---
      let invoiceNo = 'UNKNOWN';
      const invMatch = text.match(/TF\/\d{2}-\d{2}\/\d+/);
      if (invMatch) invoiceNo = invMatch[0];

      // --- New filename ---
      const safeInvoice = invoiceNo.replace(/\//g, '-');
      const newName = `${company} ${safeInvoice}.pdf`;
      const newPath = path.join(renamedDir, newName);

      await fs.copy(pdfPath, newPath);
      processedCount++;
      console.log(`✅ ${file} -> ${newName}`);
    } catch (err) {
      console.error(`❌ Error processing ${file}:`, err.message);
    }
  }

  // 3. Sabse zyada wali company ka naam nikal
  let mainCompany = 'UNKNOWN';
  let maxCount = 0;
  for (const [comp, count] of Object.entries(companyCount)) {
    if (count > maxCount) {
      maxCount = count;
      mainCompany = comp;
    }
  }

  console.log(`🏢 Main Company: ${mainCompany} (${maxCount} files)`);

  // 4. Create output ZIP with company name
  const outputZip = new AdmZip();
  const renamedFiles = await fs.readdir(renamedDir);
  for (const file of renamedFiles) {
    outputZip.addLocalFile(path.join(renamedDir, file));
  }

  // ZIP ka naam company ke naam se
  const finalZipName = `${mainCompany}.zip`;
  const finalZipPath = path.join(tmpDir, finalZipName);
  outputZip.writeZip(finalZipPath);

  // 5. Cleanup
  await fs.remove(extractDir);
  await fs.remove(renamedDir);

  console.log(`🎉 Total ${processedCount} PDFs processed. ZIP: ${finalZipName}`);
  return finalZipPath;
}