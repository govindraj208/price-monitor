function cleanPrice(priceText) {
  if (!priceText) return null;
  const cleaned = priceText.replace(/[^\d.]/g, '');
  const number = parseFloat(cleaned);
  return isNaN(number) ? null : number;
}

function randomDelay(min = 3000, max = 7000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

function getTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

module.exports = { cleanPrice, randomDelay, getTimestamp };
