const baseUrl = process.argv[2] ?? process.env.SBC_API_URL;
if (!baseUrl) {
  console.error('Set SBC_API_URL or pass the direct recommender API URL.');
  process.exit(1);
}

const url = new URL('/api/contract-rate-limit-probe', baseUrl);
const clientKey = `contract-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let rejected;

for (let attempt = 0; attempt < 121; attempt += 1) {
  const response = await fetch(url, { headers: { 'X-Diva-Client-Key': clientKey } });
  if (response.status === 429) {
    rejected = response;
    break;
  }
}

if (!rejected) throw new Error('The default rate-limit bucket did not reject the 121st request.');
if (rejected.headers.get('retry-after') !== '60') {
  throw new Error(`Retry-After header is missing or incorrect: ${rejected.headers.get('retry-after')}`);
}
if (rejected.headers.get('x-diva-rate-limit') !== 'default;120/min') {
  throw new Error(`X-Diva-Rate-Limit header is missing or incorrect: ${rejected.headers.get('x-diva-rate-limit')}`);
}
console.log('PASS API rate-limit contract (429, Retry-After, X-Diva-Rate-Limit)');
