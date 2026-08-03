/**
 * CV Central — LinkedIn Profile Optimiser (Vercel serverless)
 * POST /api/linkedin-optimiser
 *
 * Body:
 *   { headline, about, experience, skills, targetRole, cvData }
 *   - headline:   current LinkedIn headline (string)
 *   - about:      current About / Summary section (string)
 *   - experience: array of { title, company, description } (optional)
 *   - skills:     array of skill strings (optional)
 *   - targetRole: role/industry the user is targeting (string)
 *   - cvData:     structured CV JSON from the builder (optional, for context)
 *
 * Returns JSON:
 *   { headline, about, skills, experienceTips, profileTips, keywords }
 *
 * Requires: Pro or Premium plan (or active day_pass).
 */

const { authenticate } = require('./_auth');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const ALLOWED_PLANS = ['pro', 'premium', 'day_pass'];

async function callClaude(system, user, maxTokens) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Claude API error: ' + err);
  }
  const data = await res.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON found in response');
  return JSON.parse(m[0]);
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'https://cvcentral.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing its API key.' });
  }

  let auth;
  try { auth = await authenticate(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  if (!ALLOWED_PLANS.includes(auth.plan)) {
    return res.status(403).json({ error: 'LinkedIn Optimiser requires a Pro or Premium plan.' });
  }

  const {
    headline   = '',
    about      = '',
    experience = [],
    skills     = [],
    targetRole = '',
    cvData     = null
  } = req.body || {};

  const hasInput = headline.trim() || about.trim() || (experience && experience.length) || (cvData && cvData.personal);
  if (!hasInput) {
    return res.status(400).json({ error: 'Please provide at least your current headline, about section, or CV data.' });
  }

  const SYSTEM = `You are a senior LinkedIn profile coach and recruiter with 15 years of experience helping professionals in the UK and Europe land roles through optimised LinkedIn profiles.
You understand LinkedIn's search algorithm, recruiter search behaviour, and how to write compelling professional copy. Use British English throughout.
Never invent employers, qualifications, or credentials not present in the input data. You may only rephrase and strengthen what is given.`;

  const profileContext = [
    cvData ? 'CV DATA (JSON):\n' + JSON.stringify(cvData, null, 2) : null,
    headline ? 'CURRENT HEADLINE:\n' + headline : null,
    about ? 'CURRENT ABOUT SECTION:\n' + about : null,
    experience && experience.length ? 'EXPERIENCE ENTRIES:\n' + JSON.stringify(experience, null, 2) : null,
    skills && skills.length ? 'CURRENT SKILLS: ' + skills.join(', ') : null,
    targetRole ? 'TARGET ROLE/INDUSTRY: ' + targetRole : null
  ].filter(Boolean).join('\n\n');

  const userPrompt = [
    profileContext,
    '',
    'Analyse the LinkedIn profile data above and return optimisation recommendations.',
    '',
    'Respond with ONLY a valid JSON object matching this schema exactly:',
    JSON.stringify({
      headline: 'Rewritten LinkedIn headline (max 220 chars). Should include target role, key differentiator, and relevant keywords. No buzzwords like "passionate" or "guru".',
      about: 'Rewritten About section (~300 words). Open with a hook. Cover value proposition, key achievements, skills, and end with a call to action. Use short paragraphs. British English.',
      skills: {
        toAdd: ['Up to 10 LinkedIn skills to ADD based on the target role and profile — strings'],
        toRemove: ['Up to 5 skills that are outdated, redundant, or hurting credibility — strings']
      },
      experienceTips: [
        {
          company: 'company name string',
          tip: 'Specific, actionable rewrite suggestion for this role\'s description — 1–2 sentences'
        }
      ],
      profileTips: [
        'Specific, actionable profile improvement tip — e.g. photo, banner, featured section, connections, creator mode, recommendations'
      ],
      keywords: ['Top 8 keywords/phrases a recruiter searching for this profile would use — include in headline and about']
    }, null, 2)
  ].join('\n');

  try {
    const raw = await callClaude(SYSTEM, userPrompt, 4000);
    const result = extractJson(raw);
    return res.status(200).json(result);
  } catch (e) {
    console.error('[linkedin-optimiser]', e);
    return res.status(500).json({ error: 'Failed to generate optimisation: ' + e.message });
  }
};
