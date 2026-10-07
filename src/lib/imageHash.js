// Perceptual image hashing (dHash) for the "product photos similar" signal.
//
// Images are downloaded through Playwright's request client and re-injected as
// data URLs. Drawing a cross-origin URL straight into a canvas would taint it
// and make getImageData() throw, and most retail CDNs do not send CORS headers.

const HASH_BITS = 64;

// Runs inside the browser: draws the image to a 9x8 canvas and returns a
// 64-bit difference hash as a hex string.
function computeHashInPage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 9;
        canvas.height = 8;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 9, 8);
        const { data } = ctx.getImageData(0, 0, 9, 8);

        const grey = [];
        for (let i = 0; i < data.length; i += 4) {
          grey.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        }

        let bits = '';
        for (let row = 0; row < 8; row++) {
          for (let col = 0; col < 8; col++) {
            const left = grey[row * 9 + col];
            const right = grey[row * 9 + col + 1];
            bits += left > right ? '1' : '0';
          }
        }

        let hex = '';
        for (let i = 0; i < bits.length; i += 4) {
          hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
        }
        resolve(hex);
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function mimeFromContentType(contentType = '') {
  if (/png/i.test(contentType)) return 'image/png';
  if (/webp/i.test(contentType)) return 'image/webp';
  if (/gif/i.test(contentType)) return 'image/gif';
  if (/avif/i.test(contentType)) return 'image/avif';
  return 'image/jpeg';
}

// 0 = identical, 64 = completely different.
function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return null;
  let distance = 0;
  for (let i = 0; i < hexA.length; i++) {
    let xor = Number.parseInt(hexA[i], 16) ^ Number.parseInt(hexB[i], 16);
    while (xor) { distance += xor & 1; xor >>= 1; }
  }
  return distance;
}

// 1 = identical images, 0 = nothing in common. Returns null when unhashable.
function imageSimilarity(hexA, hexB) {
  const distance = hammingDistance(hexA, hexB);
  if (distance === null) return null;
  return 1 - distance / HASH_BITS;
}

class ImageHasher {
  constructor(context, page) {
    this.context = context;
    this.page = page;
    this.cache = new Map();
  }

  async hash(url) {
    if (!url) return null;
    const key = url.split('?')[0];
    if (this.cache.has(key)) return this.cache.get(key);

    const promise = this._hash(key, url).catch(() => null);
    this.cache.set(key, promise);
    return promise;
  }

  async _hash(key, url) {
    const response = await this.context.request.get(url, {
      timeout: 20000,
      headers: { Referer: new URL(url).origin + '/' },
    });
    if (!response.ok()) return null;

    const buffer = await response.body();
    if (!buffer || buffer.length < 512) return null; // placeholder pixel / broken image

    const mime = mimeFromContentType(response.headers()['content-type']);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    return this.page.evaluate(computeHashInPage, dataUrl);
  }
}

module.exports = { ImageHasher, imageSimilarity, hammingDistance, HASH_BITS };
