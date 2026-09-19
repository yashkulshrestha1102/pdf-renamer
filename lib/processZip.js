import AdmZip from 'adm-zip';
import fs from 'fs-extra';
import path from 'path';
import { extractText, getDocumentProxy } from 'unpdf';
import { put } from '@vercel/blob';

/* =========================================================
   CONFIG
========================================================= */

const PDF_EXTENSIONS = new Set(['.pdf']);

/*
 * IMPORTANT:
 * Do NOT use generic words like "from" here.
 * They can accidentally match normal invoice text.
 */
const COMPANY_LABELS = [
  'company name',
  'company',
  'vendor name',
  'vendor',
  'supplier name',
  'supplier',
  'seller name',
  'seller',
  'issued by',
  'billed by',
];

const INVOICE_LABEL_PATTERNS = [
  /invoice\s*(?:no|number|#)\s*[:\-]?\s*([^\n\r]+)/i,

  /tax\s*invoice\s*(?:no|number|#)?\s*[:\-]?\s*([^\n\r]+)/i,

  /invoice\s*id\s*[:\-]?\s*([^\n\r]+)/i,

  /bill\s*(?:no|number|#)\s*[:\-]?\s*([^\n\r]+)/i,

  /document\s*(?:no|number|#)\s*[:\-]?\s*([^\n\r]+)/i,

  /reference\s*(?:no|number|#)\s*[:\-]?\s*([^\n\r]+)/i,

  /ref\s*(?:no|number|#)\s*[:\-]?\s*([^\n\r]+)/i,
];

/* =========================================================
   TEXT HELPERS
========================================================= */

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getLines(text) {
  return cleanText(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeSpaces(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* =========================================================
   COMPANY DETECTION
========================================================= */

/*
 * Business suffixes / words commonly present in actual
 * company names.
 *
 * The uploaded PDF has:
 *
 * CARRETX Technologies Private Limited
 *
 * So this detector will pick that line first.
 */
const COMPANY_BUSINESS_PATTERN =
  /\b(?:private\s+limited|pvt\.?\s*ltd\.?|limited|ltd\.?|llp|llc|inc\.?|incorporated|corporation|corp\.?|technologies|technology|solutions|services|industries|enterprises)\b/i;

/*
 * Lines which are obviously NOT company names.
 */
const COMPANY_BLOCKLIST = [
  'tax invoice',
  'invoice',
  'invoice no',
  'invoice number',
  'invoice date',
  'delivery note',
  'reference no',
  'buyer',
  'buyer order',
  'consignee',
  'ship to',
  'bill to',
  'amount',
  'amount chargeable',
  'description',
  'quantity',
  'rate',
  'total',
  'gstin',
  'gstin/uin',
  'pan',
  'cin',
  'state name',
  'declaration',
  'authorised signatory',
  'authorized signatory',
  'computer generated invoice',
];

function isBlockedCompanyLine(line) {
  const normalized = normalizeSpaces(line).toLowerCase();

  return COMPANY_BLOCKLIST.some(
    (blocked) =>
      normalized === blocked ||
      normalized.startsWith(`${blocked}:`)
  );
}

function isValidCompanyCandidate(value) {
  const text = normalizeSpaces(value);

  if (!text) {
    return false;
  }

  /*
   * Never accept tiny candidates like "s", "a", etc.
   */
  if (text.length < 4) {
    return false;
  }

  /*
   * Company names normally contain letters.
   */
  if (!/[a-zA-Z]/.test(text)) {
    return false;
  }

  /*
   * Avoid obvious invoice fields.
   */
  if (isBlockedCompanyLine(text)) {
    return false;
  }

  /*
   * Avoid lines that are only numbers.
   */
  if (/^\d+$/.test(text)) {
    return false;
  }

  return true;
}

/*
 * Extract the company from a line like:
 *
 * CARRETX Technologies Private Limited
 *
 * or:
 *
 * ABC Solutions Pvt Ltd
 */
function detectCompanyFromBusinessLine(text) {
  const lines = getLines(text);

  /*
   * First inspect the top portion because invoice issuer
   * normally appears near the top.
   */
  const topLines = lines.slice(0, 40);

  for (const line of topLines) {
    const cleaned = normalizeSpaces(line);

    if (!isValidCompanyCandidate(cleaned)) {
      continue;
    }

    if (COMPANY_BUSINESS_PATTERN.test(cleaned)) {
      return {
        value: cleaned,
        confidence: 1.0,
        source: 'business-name-line',
      };
    }
  }

  /*
   * If not found in first 40 lines, search entire document.
   */
  for (const line of lines) {
    const cleaned = normalizeSpaces(line);

    if (!isValidCompanyCandidate(cleaned)) {
      continue;
    }

    if (COMPANY_BUSINESS_PATTERN.test(cleaned)) {
      return {
        value: cleaned,
        confidence: 0.95,
        source: 'business-name-line-anywhere',
      };
    }
  }

  return null;
}

/*
 * Label-based detection.
 *
 * Example:
 *
 * Company: ABC Technologies Pvt Ltd
 */
function detectCompanyFromLabels(text) {
  const lines = getLines(text);

  for (const line of lines) {
    const cleaned = normalizeSpaces(line);

    for (const label of COMPANY_LABELS) {
      const escapedLabel = label.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      );

      const regex = new RegExp(
        `^${escapedLabel}\\s*[:\\-#]\\s*(.+)$`,
        'i'
      );

      const match = cleaned.match(regex);

      if (!match) {
        continue;
      }

      const candidate =
        normalizeSpaces(match[1]);

      if (!isValidCompanyCandidate(candidate)) {
        continue;
      }

      return {
        value: candidate,
        confidence: 0.92,
        source: `label:${label}`,
      };
    }
  }

  return null;
}

/*
 * Top-of-document fallback.
 *
 * This is intentionally conservative.
 */
function detectCompanyFromTop(text) {
  const lines = getLines(text);

  for (const line of lines.slice(0, 15)) {
    const cleaned = normalizeSpaces(line);

    if (!isValidCompanyCandidate(cleaned)) {
      continue;
    }

    if (
      COMPANY_BUSINESS_PATTERN.test(
        cleaned
      )
    ) {
      return {
        value: cleaned,
        confidence: 0.90,
        source: 'top-business-line',
      };
    }
  }

  return null;
}

/*
 * MAIN COMPANY DETECTOR
 *
 * Priority:
 *
 * 1. Business-name line
 * 2. Explicit company label
 * 3. Top business line
 */
function detectCompany(text) {
  const candidates = [
    detectCompanyFromBusinessLine(text),
    detectCompanyFromLabels(text),
    detectCompanyFromTop(text),
  ].filter(Boolean);

  if (!candidates.length) {
    return null;
  }

  candidates.sort(
    (a, b) =>
      b.confidence - a.confidence
  );

  return candidates[0];
}

/*
 * Convert:
 *
 * CARRETX Technologies Private Limited
 *
 * to:
 *
 * CARRETX
 */
function getShortCompanyName(companyName) {
  if (!companyName) {
    return null;
  }

  const cleaned =
    normalizeSpaces(companyName);

  const words =
    cleaned.split(/\s+/);

  if (!words.length) {
    return null;
  }

  /*
   * First actual word only.
   */
  const firstWord = words[0]
    .replace(
      /[^a-zA-Z0-9&.-]/g,
      ''
    )
    .trim();

  /*
   * Safety:
   * Never allow "s", "a", etc.
   */
  if (firstWord.length < 2) {
    return null;
  }

  return firstWord;
}

/* =========================================================
   INVOICE NUMBER DETECTION
========================================================= */

function cleanInvoiceCandidate(value) {
  if (!value) {
    return null;
  }

  let result =
    normalizeSpaces(value);

  /*
   * Remove leading punctuation.
   */
  result = result
    .replace(
      /^[#:.,;\/\-\s]+/,
      ''
    )
    .trim();

  /*
   * Remove obvious text that belongs to
   * the next field.
   */
  result = result
    .replace(
      /\s+(?:invoice\s*date|date|due\s*date|gstin|gst|pan|amount|total)\s*[:#-].*$/i,
      ''
    )
    .trim();

  return result || null;
}

/*
 * Convert:
 *
 * TF/26-27/219
 *
 * to:
 *
 * TF 26-27 219
 *
 * But DO NOT reduce it to only 219.
 */
function normalizeInvoiceForFileName(
  invoiceNumber
) {
  if (!invoiceNumber) {
    return null;
  }

  let value =
    normalizeSpaces(invoiceNumber);

  /*
   * Slash becomes a space.
   *
   * TF/26-27/219
   *
   * ->
   *
   * TF 26-27 219
   */
  value = value.replace(
    /[\/\\]+/g,
    ' '
  );

  /*
   * Keep hyphens because:
   *
   * 26-27
   *
   * must stay:
   *
   * 26-27
   */
  value = value.replace(
    /\s+/g,
    ' '
  );

  /*
   * Remove characters Windows doesn't
   * allow in filenames.
   */
  value = value.replace(
    /[<>:"|?*\x00-\x1F]/g,
    ' '
  );

  value = normalizeSpaces(
    value
  );

  return value || null;
}

/*
 * Explicit invoice label.
 *
 * Example:
 *
 * Invoice No.
 * TF/26-27/219
 *
 * OR:
 *
 * Invoice No. TF/26-27/219
 */
function detectInvoiceFromLabels(text) {
  const lines = getLines(text);

  /*
   * First handle same-line patterns.
   */
  for (const line of lines) {
    const cleaned =
      normalizeSpaces(line);

    for (
      const pattern of INVOICE_LABEL_PATTERNS
    ) {
      const match =
        cleaned.match(pattern);

      if (!match || !match[1]) {
        continue;
      }

      const candidate =
        cleanInvoiceCandidate(
          match[1]
        );

      if (!candidate) {
        continue;
      }

      if (!/\d/.test(candidate)) {
        continue;
      }

      return {
        value: candidate,
        confidence: 1.0,
        source: 'explicit-invoice-label',
      };
    }
  }

  /*
   * IMPORTANT:
   *
   * Many Indian invoices have:
   *
   * Invoice No.
   * TF/26-27/219
   *
   * on two separate lines.
   */
  for (
    let i = 0;
    i < lines.length - 1;
    i++
  ) {
    const current =
      lines[i].toLowerCase();

    if (
      current === 'invoice no.' ||
      current === 'invoice no' ||
      current === 'invoice number' ||
      current === 'invoice #' ||
      current === 'tax invoice no.' ||
      current === 'tax invoice no' ||
      current === 'tax invoice number'
    ) {
      const next =
        cleanInvoiceCandidate(
          lines[i + 1]
        );

      if (
        next &&
        /\d/.test(next)
      ) {
        return {
          value: next,
          confidence: 1.0,
          source:
            'explicit-invoice-label-next-line',
        };
      }
    }
  }

  return null;
}

/*
 * Detect structured invoice numbers even
 * when there is no "Invoice No." label.
 *
 * Examples:
 *
 * TF/26-27/219
 * TF 26-27 219
 * TF-26-27-219
 * TI/26-27/219
 * INV/26-27/219
 */
function detectInvoiceFromStructuredPatterns(
  text
) {
  const lines = getLines(text);

  const patterns = [
    /*
     * TF/26-27/219
     * TF 26-27 219
     * TF-26-27-219
     */
    /\bTF\s*[\/\-_]?\s*\d{2,4}\s*-\s*\d{2,4}\s*[\/\-_]?\s*\d+\b/i,

    /*
     * TI/26-27/219
     */
    /\bTI\s*[\/\-_]?\s*\d{2,4}\s*-\s*\d{2,4}\s*[\/\-_]?\s*\d+\b/i,

    /*
     * INV/26-27/219
     */
    /\bINV(?:OICE)?\s*[\/\-_]?\s*\d{2,4}\s*-\s*\d{2,4}\s*[\/\-_]?\s*\d+\b/i,

    /*
     * BILL/26-27/219
     */
    /\bBILL\s*[\/\-_]?\s*\d{2,4}\s*-\s*\d{2,4}\s*[\/\-_]?\s*\d+\b/i,
  ];

  for (const line of lines) {
    for (
      const pattern of patterns
    ) {
      const match =
        line.match(pattern);

      if (!match) {
        continue;
      }

      const candidate =
        cleanInvoiceCandidate(
          match[0]
        );

      if (
        candidate &&
        /\d/.test(candidate)
      ) {
        return {
          value: candidate,
          confidence: 0.95,
          source:
            'structured-invoice-pattern',
        };
      }
    }
  }

  return null;
}

/*
 * Filename fallback.
 *
 * Only used when PDF text doesn't contain
 * an invoice number.
 */
function detectInvoiceFromFilename(
  fileName
) {
  const baseName =
    path.basename(
      fileName,
      path.extname(fileName)
    );

  const patterns = [
    /*
     * TF/26-27/219
     */
    /\bTF\s*[\/\-_ ]?\s*\d{2,4}\s*-\s*\d{2,4}\s*[\/\-_ ]?\s*\d+\b/i,

    /*
     * INV-219
     */
    /\b(?:invoice|inv|bill)\s*[-_ ]?\s*\d+\b/i,

    /*
     * Last numeric sequence.
     */
    /(?:^|[-_\s])(\d{2,})$/,
  ];

  for (
    const pattern of patterns
  ) {
    const match =
      baseName.match(pattern);

    if (!match) {
      continue;
    }

    const candidate =
      cleanInvoiceCandidate(
        match[0]
      );

    if (
      candidate &&
      /\d/.test(candidate)
    ) {
      return {
        value: candidate,
        confidence: 0.50,
        source:
          'filename-fallback',
      };
    }
  }

  return null;
}

function detectInvoiceNumber(
  text,
  fileName
) {
  const candidates = [
    detectInvoiceFromLabels(text),
    detectInvoiceFromStructuredPatterns(text),
    detectInvoiceFromFilename(fileName),
  ].filter(Boolean);

  if (!candidates.length) {
    return null;
  }

  candidates.sort(
    (a, b) =>
      b.confidence - a.confidence
  );

  return candidates[0];
}

/* =========================================================
   FILENAME HELPERS
========================================================= */

function sanitizeFileName(value) {
  return String(value || '')
    .replace(
      /[<>:"/\\|?*\x00-\x1F]/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/g, '');
}

function getUniqueFileName(
  fileName,
  usedNames
) {
  const parsed =
    path.parse(fileName);

  let candidate =
    fileName;

  let counter = 2;

  while (
    usedNames.has(
      candidate.toLowerCase()
    )
  ) {
    candidate =
      `${parsed.name} (${counter})${parsed.ext}`;

    counter += 1;
  }

  usedNames.add(
    candidate.toLowerCase()
  );

  return candidate;
}

/* =========================================================
   PDF TEXT EXTRACTION
========================================================= */

async function extractPdfText(
  buffer
) {
  try {
    const pdf =
      await getDocumentProxy(
        new Uint8Array(buffer)
      );

    const result =
      await extractText(pdf, {
        mergePages: true,
      });

    if (
      typeof result === 'string'
    ) {
      return cleanText(result);
    }

    if (
      result &&
      typeof result.text ===
        'string'
    ) {
      return cleanText(
        result.text
      );
    }

    return '';
  } catch (error) {
    console.error(
      '❌ PDF text extraction failed:',
      error?.message || error
    );

    return '';
  }
}

/* =========================================================
   PROCESS ONE PDF
========================================================= */

async function processPdfEntry(
  entry,
  usedNames
) {
  const originalName =
    entry.entryName;

  const buffer =
    entry.getData();

  const text =
    await extractPdfText(
      buffer
    );

  /*
   * DEBUGGING:
   *
   * This will show what company detector
   * actually sees if something goes wrong.
   */
  const companyDetection =
    detectCompany(text);

  const invoiceDetection =
    detectInvoiceNumber(
      text,
      originalName
    );

  /*
   * SAFETY:
   *
   * If company cannot be detected,
   * NEVER create "s TF..." or another
   * garbage filename.
   */
  if (
    !companyDetection
  ) {
    const fallbackName =
      getUniqueFileName(
        path.basename(
          originalName
        ),
        usedNames
      );

    return {
      buffer,

      outputName:
        fallbackName,

      renamed: false,

      needsReview: true,

      companyName: null,

      shortCompanyName: null,

      invoiceNumber:
        invoiceDetection?.value ||
        null,

      invoiceFilePart:
        invoiceDetection
          ? normalizeInvoiceForFileName(
              invoiceDetection.value
            )
          : null,

      originalName,

      reason:
        'Company name could not be detected safely.',
    };
  }

  /*
   * Get ONLY first company word.
   *
   * CARRETX Technologies Private Limited
   *
   * ->
   *
   * CARRETX
   */
  const shortCompanyName =
    getShortCompanyName(
      companyDetection.value
    );

  /*
   * SAFETY:
   *
   * If first word somehow becomes "s",
   * reject it rather than creating a bad filename.
   */
  if (
    !shortCompanyName ||
    shortCompanyName.length < 2
  ) {
    const fallbackName =
      getUniqueFileName(
        path.basename(
          originalName
        ),
        usedNames
      );

    return {
      buffer,

      outputName:
        fallbackName,

      renamed: false,

      needsReview: true,

      companyName:
        companyDetection.value,

      shortCompanyName:
        shortCompanyName || null,

      invoiceNumber:
        invoiceDetection?.value ||
        null,

      originalName,

      reason:
        'Detected company name was not safe enough to use.',
    };
  }

  /*
   * Invoice must exist.
   */
  if (
    !invoiceDetection
  ) {
    const fallbackName =
      getUniqueFileName(
        path.basename(
          originalName
        ),
        usedNames
      );

    return {
      buffer,

      outputName:
        fallbackName,

      renamed: false,

      needsReview: true,

      companyName:
        companyDetection.value,

      shortCompanyName,

      invoiceNumber: null,

      originalName,

      reason:
        'Invoice number could not be detected safely.',
    };
  }

  /*
   * Normalize:
   *
   * TF/26-27/219
   *
   * ->
   *
   * TF 26-27 219
   */
  const invoiceFilePart =
    normalizeInvoiceForFileName(
      invoiceDetection.value
    );

  if (
    !invoiceFilePart
  ) {
    const fallbackName =
      getUniqueFileName(
        path.basename(
          originalName
        ),
        usedNames
      );

    return {
      buffer,

      outputName:
        fallbackName,

      renamed: false,

      needsReview: true,

      companyName:
        companyDetection.value,

      shortCompanyName,

      invoiceNumber:
        invoiceDetection.value,

      invoiceFilePart: null,

      originalName,

      reason:
        'Invoice number was detected but could not be safely converted into a filename.',
    };
  }

  /*
   * =======================================================
   * FINAL NAME
   * =======================================================
   *
   * CARRETX
   * +
   * TF 26-27 219
   *
   * =
   *
   * CARRETX TF 26-27 219.pdf
   * =======================================================
   */

  const desiredName =
    sanitizeFileName(
      `${shortCompanyName} ${invoiceFilePart}.pdf`
    );

  const outputName =
    getUniqueFileName(
      desiredName,
      usedNames
    );

  return {
    buffer,

    outputName,

    renamed: true,

    needsReview: false,

    companyName:
      companyDetection.value,

    shortCompanyName,

    invoiceNumber:
      invoiceDetection.value,

    invoiceFilePart,

    originalName,

    companyConfidence:
      companyDetection.confidence,

    companySource:
      companyDetection.source,

    invoiceConfidence:
      invoiceDetection.confidence,

    invoiceSource:
      invoiceDetection.source,
  };
}

/* =========================================================
   MAIN PROCESSOR
========================================================= */

export async function processZip(
  zipPath,
  jobId,
  tmpDir
) {
  console.log(
    `📦 Processing job: ${jobId}`
  );

  const extractDir =
    path.join(
      tmpDir,
      `extracted-${jobId}`
    );

  await fs.ensureDir(
    extractDir
  );

  const results = [];

  const companies =
    new Set();

  let pdfCount = 0;

  let renamedCount = 0;

  let needsReviewCount = 0;

  try {
    /* =====================================================
       READ ZIP
    ====================================================== */

    const zip =
      new AdmZip(zipPath);

    console.log(
      `📦 Extracting ZIP for job: ${jobId}`
    );

    zip.extractAllTo(
      extractDir,
      true
    );

    /* =====================================================
       RECURSIVE FILE SEARCH
    ====================================================== */

    const allFiles = [];

    async function walkDirectory(
      directory
    ) {
      const entries =
        await fs.readdir(
          directory,
          {
            withFileTypes: true,
          }
        );

      for (
        const entry of entries
      ) {
        const fullPath =
          path.join(
            directory,
            entry.name
          );

        if (
          entry.isDirectory()
        ) {
          await walkDirectory(
            fullPath
          );
        } else {
          allFiles.push(
            fullPath
          );
        }
      }
    }

    await walkDirectory(
      extractDir
    );

    const pdfFiles =
      allFiles.filter(
        (file) =>
          PDF_EXTENSIONS.has(
            path.extname(
              file
            ).toLowerCase()
          )
      );

    pdfCount =
      pdfFiles.length;

    console.log(
      `📄 Found ${pdfCount} PDF file(s)`
    );

    /* =====================================================
       UNIQUE OUTPUT NAMES
    ====================================================== */

    const usedNames =
      new Set();

    /* =====================================================
       PROCESS ALL PDFS
    ====================================================== */

    for (
      const filePath of pdfFiles
    ) {
      const relativePath =
        path.relative(
          extractDir,
          filePath
        );

      const entry = {
        entryName:
          relativePath,

        getData: () =>
          fs.readFileSync(
            filePath
          ),
      };

      const result =
        await processPdfEntry(
          entry,
          usedNames
        );

      results.push(
        result
      );

      if (
        result.renamed
      ) {
        renamedCount += 1;

        if (
          result.shortCompanyName
        ) {
          companies.add(
            result.shortCompanyName
          );
        }

        console.log(
          `✅ ${relativePath} -> ${result.outputName}`
        );
      } else {
        needsReviewCount += 1;

        console.warn(
          `⚠️ Needs review: ${relativePath} -> ${result.outputName}`
        );

        if (
          result.reason
        ) {
          console.warn(
            `   Reason: ${result.reason}`
          );
        }
      }
    }

    /* =====================================================
       CREATE OUTPUT ZIP
    ====================================================== */

    const outputZip =
      new AdmZip();

    /*
     * Add renamed / original PDFs.
     */
    for (
      const result of results
    ) {
      outputZip.addFile(
        result.outputName,
        result.buffer
      );
    }

    /*
     * Preserve non-PDF files.
     */
    const originalZip =
      new AdmZip(zipPath);

    const originalEntries =
      originalZip.getEntries();

    for (
      const entry of originalEntries
    ) {
      if (
        entry.isDirectory
      ) {
        continue;
      }

      if (
        PDF_EXTENSIONS.has(
          path.extname(
            entry.entryName
          ).toLowerCase()
        )
      ) {
        continue;
      }

      outputZip.addFile(
        entry.entryName,
        entry.getData()
      );
    }

    const outputBuffer =
      outputZip.toBuffer();

    /* =====================================================
       OUTPUT ZIP NAME
    ====================================================== */

    const companyList =
      Array.from(
        companies
      );

    let outputCompanyName =
      'Renamed';

    if (
      companyList.length === 1
    ) {
      /*
       * CARRETX
       *
       * NOT:
       *
       * CARRETX Technologies Private Limited
       */
      outputCompanyName =
        companyList[0];
    } else if (
      companyList.length > 1
    ) {
      outputCompanyName =
        'Multiple Companies';
    }

    const outputFileName =
      sanitizeFileName(
        `${outputCompanyName}.zip`
      );

    /* =====================================================
       VERCEL BLOB UPLOAD
    ====================================================== */

    const blobPath =
      `renamed/${jobId}/${outputFileName}`;

    const blob =
      await put(
        blobPath,
        outputBuffer,
        {
          access: 'public',
          addRandomSuffix: true,
          contentType:
            'application/zip',
        }
      );

    console.log(
      `☁️ Uploaded output ZIP: ${blob.url}`
    );

    /* =====================================================
       SUMMARY
    ====================================================== */

    console.log(
      '========================================'
    );

    console.log(
      '📊 PROCESSING SUMMARY'
    );

    console.log(
      '========================================'
    );

    console.log(
      `📄 PDFs found:       ${pdfCount}`
    );

    console.log(
      `✅ Renamed:          ${renamedCount}`
    );

    console.log(
      `⚠️ Needs review:     ${needsReviewCount}`
    );

    console.log(
      `🏢 Companies found:  ${companyList.length}`
    );

    console.log(
      `📦 Output:           ${outputFileName}`
    );

    console.log(
      '========================================'
    );

    /* =====================================================
       RETURN
    ====================================================== */

    return {
      success: true,

      jobId,

      blobUrl:
        blob.url,

      fileName:
        outputFileName,

      companyName:
        companyList.length === 1
          ? companyList[0]
          : null,

      companies:
        companyList,

      counts: {
        totalPdfs:
          pdfCount,

        renamed:
          renamedCount,

        needsReview:
          needsReviewCount,
      },

      pdfCount,

      renamedCount,

      needsReviewCount,

      results:
        results.map(
          (result) => ({
            originalName:
              result.originalName,

            outputName:
              result.outputName,

            renamed:
              result.renamed,

            needsReview:
              result.needsReview,

            companyName:
              result.companyName ||
              null,

            shortCompanyName:
              result.shortCompanyName ||
              null,

            invoiceNumber:
              result.invoiceNumber ||
              null,

            invoiceFilePart:
              result.invoiceFilePart ||
              null,

            reason:
              result.reason ||
              null,

            companyConfidence:
              result.companyConfidence ||
              null,

            companySource:
              result.companySource ||
              null,

            invoiceConfidence:
              result.invoiceConfidence ||
              null,

            invoiceSource:
              result.invoiceSource ||
              null,
          })
        ),
    };
  } finally {
    /* =====================================================
       CLEAN TEMP FILES
    ====================================================== */

    try {
      await fs.remove(
        extractDir
      );
    } catch (error) {
      console.warn(
        '⚠️ Failed to remove extracted directory:',
        error?.message ||
          error
      );
    }
  }
}