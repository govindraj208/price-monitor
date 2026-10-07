// Reading the daily "Dump" CSV and writing the "Result" CSV.
//
// The Result column order is fixed by the user's template and must not change.

const fs = require('fs');
const path = require('path');
const csvParser = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');

// Exact order of the Result template.
const RESULT_COLUMNS = [
  'Section',
  'SKU',
  'Product Title',
  'OurShopee Price',
  'Noon Price',
  'Amazon Price',
  'Best Competitor Price',
  'Price Difference',
  'OurShopee Link',
  'Noon Link',
  'Amazon Link',
];

// Extra columns appended after the template ones so matches can be audited.
const EXTRA_COLUMNS = [
  'Amazon ASIN',
  'Noon Product ID',
  'Amazon Matched Title',
  'Noon Matched Title',
  'Amazon Confidence',
  'Noon Confidence',
  'Amazon Score',
  'Noon Score',
  'Price Flag',
  'Status',
];

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Newest CSV in a directory, ignoring our own output and temp/hidden files.
function newestCsv(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => /\.csv$/i.test(f) && !f.startsWith('.'))
    .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(dir, files[0].f) : null;
}

function slug(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Google Sheets exports vary: stray spaces, different casing, a leading BOM.
// Resolve each logical column against whatever header text is present.
function buildColumnMap(headers) {
  const aliases = {
    section: ['section', 'category', 'department'],
    sku: ['sku', 'skuid', 'itemcode', 'code', 'productid'],
    title: ['producttitle', 'title', 'productname', 'name', 'itemname'],
    ourPrice: ['ourshopeeprice', 'ourprice', 'ourshopee', 'sellingprice', 'price'],
    noonPrice: ['noonprice', 'noon'],
    amazonPrice: ['amazonprice', 'amazon'],
    ourLink: ['ourshopeelink', 'ourlink', 'ourshopeeurl', 'productlink'],
    noonLink: ['noonlink', 'noonurl'],
    amazonLink: ['amazonlink', 'amazonurl'],
    barcode: ['barcode', 'ean', 'ean13', 'upc', 'gtin', 'barcodeno'],
  };

  const normalized = headers.map(h => ({ raw: h, key: slug(String(h).replace(/^\uFEFF/, '')) }));
  const map = {};

  for (const [field, candidates] of Object.entries(aliases)) {
    for (const candidate of candidates) {
      const hit = normalized.find(h => h.key === candidate);
      if (hit) { map[field] = hit.raw; break; }
    }
  }
  return map;
}

function readDump(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let columnMap = null;

    fs.createReadStream(filePath, { encoding: 'utf8' })
      .pipe(csvParser({ mapHeader: ({ header }) => header.trim() }))
      .on('headers', headers => { columnMap = buildColumnMap(headers); })
      .on('data', row => {
        const get = field => (columnMap[field] ? String(row[columnMap[field]] ?? '').trim() : '');
        let barcode = get('barcode');
        const title = get('title');
        const sku = get('sku');

        if (!barcode) {
          const m = title.match(/\b(\d{12,14})\b/) || sku.match(/\b(\d{12,14})\b/);
          if (m) barcode = m[1];
        }

        // Restore leading zero dropped by Excel for EAN-13 barcodes
        if (barcode && /^\d{12}$/.test(barcode)) {
          barcode = '0' + barcode;
        }

        const record = {
          section: get('section'),
          sku,
          title,
          barcode,
          ourPriceRaw: get('ourPrice'),
          noonPriceRaw: get('noonPrice'),
          amazonPriceRaw: get('amazonPrice'),
          ourLink: get('ourLink'),
          noonLink: get('noonLink'),
          amazonLink: get('amazonLink'),
        };
        // Skip blank spacer rows that Google Sheets often leaves behind.
        if (!record.sku && !record.title) return;
        rows.push(record);
      })
      .on('end', () => resolve({ rows, columnMap }))
      .on('error', reject);
  });
}

async function writeResult(filePath, records, { exactOnly = false } = {}) {
  const columns = exactOnly ? RESULT_COLUMNS : [...RESULT_COLUMNS, ...EXTRA_COLUMNS];
  const writer = createObjectCsvWriter({
    path: filePath,
    header: columns.map(title => ({ id: title, title })),
  });
  await writer.writeRecords(records);
  return filePath;
}

function defaultOutputPath(resultsDir) {
  return path.join(resultsDir, `Result_${timestamp()}.csv`);
}

module.exports = {
  RESULT_COLUMNS,
  EXTRA_COLUMNS,
  readDump,
  writeResult,
  newestCsv,
  defaultOutputPath,
  timestamp,
};
