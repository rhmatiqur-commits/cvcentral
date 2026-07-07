/**
 * CV Central — AI function
 * Handles all Anthropic API calls server-side (no CORS, no exposed key).
 *
 * Endpoints (query param ?action=):
 *   enhance            — full analysis: rewrite CV, score, template, cover letter, ATS keywords, improvements
 *   score              — score the CV out of 100 with breakdown
 *   cover-letter       — cover letter from CV + job description
 *   interview-prep     — interview questions based on the CV + job description
 *   template-recommend — recommend one of: professional / modern / graduate
 *   ats-check          — ATS compatibility check
 *
 * Requires env var: ANTHROPIC_API_KEY
 */

// Netlify runs Node 18+, where fetch is global; fall back to node-fetch for older runtimes.
const fetchFn = typeof fetch === 'function' ? fetch : require('node-fetch');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: JSON_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Use POST' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return respond(500, { error: 'Server is missing its API key. Set ANTHROPIC_API_KEY in Netlify environment variables.' });
  }

  const action = (event.queryStringParameters && event.queryStringParameters.action) || 'enhance';

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const builders = {
    'enhance': buildEnhancePrompt,
    'score': buildScorePrompt,
    'cover-letter': buildCoverLetterPrompt,
    'interview-prep': buildInterviewPrompt,
    'template-recommend': buildTemplatePrompt,
    'ats-check': buildAtsPrompt
  };

  const builder = builders[action];
  if (!builder) {
    return respond(400, { error: 'Unknown action: ' + action });
  }

  try {
    const prompt = builder(payload);
    const result = await callClaude(prompt.system, prompt.user, prompt.maxTokens || 4000);
    const parsed = extractJson(result);
    if (!parsed) {
      return respond(502, { error: 'The AI returned an unexpected format. Please try again.' });
    }
    return respond(200, parsed);
  } catch (err) {
    console.error('AI function error:', err);
    return respond(502, { error: err.message || 'AI request failed' });
  }
};

/* ---------------- Anthropic call ---------------- */

async function callClaude(system, user, maxTokens) {
  const res = await fetchFn(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: system,
      messages: [{ role: 'user', content: user }]
    })
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('Anthropic API error', res.status, errBody);
    if (res.status === 429) throw new Error('The AI is a bit busy right now — try again in a minute');
    if (res.status === 401) throw new Error('AI service authentication failed');
    throw new Error('AI service error (' + res.status + ')');
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('AI returned no text');
  return textBlock.text;
}

function extractJson(text) {
  // Strip markdown fences if present, then take the outermost JSON object.
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

function respond(status, body) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/* ---------------- Shared context ---------------- */

const UK_STYLE = 'You are a senior UK recruitment consultant and CV writer. Always use British English (CV not resume, organisation not organization, -ise endings). Write in a confident, professional but human tone. Never invent employers, dates, or qualifications that are not in the data — you may only rephrase and strengthen what is given.';

function cvSummaryBlock(p) {
  return [
    'CANDIDATE DATA (JSON):',
    JSON.stringify({
      personal: p.personal || {},
      experience: p.experience || [],
      education: p.education || [],
      skills: p.skills || [],
      languages: p.languages || [],
      certifications: p.certifications || [],
      jobTarget: p.jobTarget || {}
    }, null, 2)
  ].join('\n');
}

function jsonOnly(schemaDescription) {
  return 'Respond with ONLY a valid JSON object, no markdown, no commentary. Schema:\n' + schemaDescription;
}

/* ---------------- Prompt builders ---------------- */

function buildEnhancePrompt(p) {
  return {
    maxTokens: 6000,
    system: UK_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'Do ALL of the following in one pass:',
      '1. Rewrite the professional summary to a polished 3–4 sentence UK CV profile.',
      '2. For each experience entry, rewrite responsibilities and achievements into 3–5 strong, ATS-friendly bullet points (action verb first, quantify where the data allows).',
      '3. Score the CV out of 100 with a breakdown for: formatting, keywords, achievements, ats, length (each 0–100). Base keywords/ats on the job description if provided, otherwise on the target role.',
      '4. Recommend exactly one template: "professional" (finance/legal/corporate), "modern" (tech/marketing/creative), or "graduate" (first jobs, graduate schemes, limited experience).',
      '5. Write a tailored UK-style cover letter (~250 words) addressed for the job description if given, otherwise for the target role. Use the candidate\'s real name.',
      '6. List the top 5 ATS keywords the candidate should include, drawn from the job description or typical adverts for the target role.',
      '7. Give 3 specific, actionable improvements to raise the score.',
      '',
      jsonOnly(JSON.stringify({
        enhanced: {
          summary: 'string',
          experience: [{ bullets: ['string'] }]
        },
        score: {
          total: 0,
          breakdown: { formatting: 0, keywords: 0, achievements: 0, ats: 0, length: 0 }
        },
        recommendedTemplate: 'professional | modern | graduate',
        coverLetter: 'string',
        atsKeywords: ['string'],
        improvements: ['string']
      })),
      'The "enhanced.experience" array must have exactly one entry per experience entry in the candidate data, in the same order.'
    ].join('\n')
  };
}

function buildScorePrompt(p) {
  return {
    maxTokens: 1500,
    system: UK_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'Score this CV out of 100 for the UK job market, with a breakdown for formatting, keywords, achievements, ats, and length (each 0–100). Explain the total briefly.',
      jsonOnly('{ "score": { "total": 0, "breakdown": { "formatting": 0, "keywords": 0, "achievements": 0, "ats": 0, "length": 0 } }, "summary": "one-paragraph explanation" }')
    ].join('\n')
  };
}

function buildCoverLetterPrompt(p) {
  return {
    maxTokens: 1500,
    system: UK_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'Write a tailored UK-style cover letter (~250 words) for the job description in jobTarget.description (or the target role if no description). Confident, specific, no clichés like "I am writing to apply".',
      jsonOnly('{ "coverLetter": "string" }')
    ].join('\n')
  };
}

function buildInterviewPrompt(p) {
  return {
    maxTokens: 2500,
    system: UK_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'Generate 8 interview questions this candidate is likely to face, based on their actual CV and the job description. Mix competency (STAR), technical/role-specific, and CV-probing questions (gaps, changes, claims). For each, add a one-sentence tip on how THIS candidate should answer given their background.',
      jsonOnly('{ "questions": [{ "question": "string", "type": "competency | technical | cv-probing", "tip": "string" }] }')
    ].join('\n')
  };
}

function buildTemplatePrompt(p) {
  return {
    maxTokens: 600,
    system: UK_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'Recommend exactly one CV template for this candidate and job: "professional" (clean single column — finance/legal/corporate), "modern" (two column with skills sidebar — tech/marketing/creative), or "graduate" (education-first — first jobs and graduate schemes).',
      jsonOnly('{ "recommendedTemplate": "professional | modern | graduate", "reason": "one sentence" }')
    ].join('\n')
  };
}

function buildAtsPrompt(p) {
  return {
    maxTokens: 2000,
    system: UK_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'Check this CV\'s ATS compatibility against the job description in jobTarget.description (or typical adverts for the target role). Identify missing keywords, formatting risks, and a pass likelihood.',
      jsonOnly('{ "atsScore": 0, "missingKeywords": ["string"], "presentKeywords": ["string"], "risks": ["string"], "verdict": "one-paragraph plain-English verdict" }')
    ].join('\n')
  };
}
