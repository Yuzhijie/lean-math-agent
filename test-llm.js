// Minimal test script to verify LLM API connectivity
const apiKey = process.env.LLM_API_KEY || '';
const baseUrl = (process.env.LLM_BASE_URL || '').replace(/\/$/, '');
const model = process.env.LLM_MODEL || '';

console.log('Testing LLM API...');
console.log('Base URL:', baseUrl);
console.log('Model:', model);
console.log('API Key:', apiKey ? '***set***' : 'NOT SET');

if (!apiKey) {
  console.error('ERROR: LLM_API_KEY not set');
  process.exit(1);
}

const url = `${baseUrl}/chat/completions`;
console.log('Request URL:', url);

fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: model,
    messages: [{ role: 'user', content: 'Say "hello" in one word' }],
    max_tokens: 10,
  }),
  signal: AbortSignal.timeout(30000),
})
  .then(async (res) => {
    console.log('HTTP Status:', res.status);
    const text = await res.text();
    console.log('Response:', text.substring(0, 500));
    if (res.ok) {
      console.log('✓ LLM API is working');
    } else {
      console.log('✗ LLM API returned error');
    }
  })
  .catch((err) => {
    console.error('✗ Request failed:', err.name, err.message);
  });
