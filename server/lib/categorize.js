// Categorizes bug summaries in one OpenRouter chat request.
// Kept transport-injectable (fetchImpl) so tests never hit the network.

export const CATEGORIES = [
  'UI', 'Functional', 'Performance', 'Crash',
  'Data', 'Security', 'Integration', 'Other',
];

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function categorizeSummaries(summaries, { fetchImpl = fetch, env = process.env } = {}) {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw Object.assign(new Error('OPENROUTER_API_KEY is not configured'), { status: 503 });

  const model = env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku';
  let res;
  try {
    res = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              `You classify bug reports. Allowed categories: ${CATEGORIES.join(', ')}. ` +
              'Reply with ONLY a JSON array of category strings, one per input bug, same order. No prose.',
          },
          {
            role: 'user',
            content: summaries.map((s, i) => `${i + 1}. ${s}`).join('\n'),
          },
        ],
        temperature: 0,
      }),
    });
  } catch (e) {
    throw Object.assign(new Error(`OpenRouter request failed: ${e.message}`), { status: 502 });
  }

  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw Object.assign(new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`), { status: 502 });
  }

  let cats;
  try {
    const content = JSON.parse(text).choices[0].message.content;
    // Tolerate markdown code fences around the JSON array.
    cats = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw Object.assign(new Error('OpenRouter returned unparseable content'), { status: 502 });
  }
  if (!Array.isArray(cats)) {
    throw Object.assign(new Error('OpenRouter did not return an array'), { status: 502 });
  }

  // One category per summary; anything off-list becomes 'Other'.
  return summaries.map((_, i) => (CATEGORIES.includes(cats[i]) ? cats[i] : 'Other'));
}
