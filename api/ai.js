/**
 * CV Central — AI function (Vercel)
 * Handles all Anthropic API calls server-side.
 *
 * Endpoints (query param ?action=):
 *   enhance            — full analysis: rewrite CV, score, template, cover letter, ATS keywords, improvements
 *   score              — score the CV out of 100 with breakdown
 *   cover-letter       — cover letter from CV + job description
 *   interview-prep     — interview questions based on the CV + job description
 *   template-recommend — recommend one of: professional / modern / graduate
 *   ats-check          — ATS compatibility check
 *   parse-cv           — parse raw CV text into structured JSON for prefill
 *
 * Premium-only actions:
 *   career-coach         — AI career coaching (question → advice)
 *   mock-interview       — generate questions + evaluate a submitted answer
 *   star-answer          — STAR-format answer from experience bullet points
 *   recruiter-feedback   — CV through a recruiter's eyes
 *   salary-insights      — salary benchmarking for role/location/experience
 *   career-progression   — step-by-step plan from current role to target
 *   portfolio-review     — review portfolio/website description
 *   career-roadmap       — career roadmap with milestones
 *   linkedin-branding    — LinkedIn thought-leadership & personal brand strategy
 *   executive-cover-letter — premium executive-level cover letter
 *
 * Requires env var: ANTHROPIC_API_KEY
 */

const { authenticate } = require('./_auth');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL_HEAVY = 'claude-sonnet-4-6';      // writing, rewriting, complex reasoning
const MODEL_LIGHT = 'claude-haiku-4-5-20251001'; // parsing, scoring, simple extraction

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'https://cvcentral.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing its API key. Set ANTHROPIC_API_KEY in Vercel environment variables.' });
  }

  // Verify the caller is a real signed-in user and get their REAL plan from
  // the database — never trust `payload.plan` from the request body, since
  // that's fully attacker-controlled and previously granted free Sonnet-tier
  // access to anyone who scripted a request.
  let auth;
  try {
    auth = await authenticate(req);
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message || 'Authentication failed' });
  }

  const action = (req.query && req.query.action) || 'enhance';
  const payload = req.body || {};
  payload.plan = auth.plan; // overwrite anything the client sent

  const PREMIUM_ONLY = new Set([
    'career-coach', 'mock-interview', 'star-answer', 'recruiter-feedback',
    'salary-insights', 'career-progression', 'portfolio-review',
    'career-roadmap', 'linkedin-branding', 'executive-cover-letter'
  ]);

  const builders = {
    'enhance':                buildEnhancePrompt,
    'score':                  buildScorePrompt,
    'cover-letter':           buildCoverLetterPrompt,
    'interview-prep':         buildInterviewPrompt,
    'template-recommend':     buildTemplatePrompt,
    'ats-check':              buildAtsPrompt,
    'parse-cv':               buildParseCvPrompt,
    'compare-cv':             buildCompareCvPrompt,
    // Premium
    'career-coach':           buildCareerCoachPrompt,
    'mock-interview':         buildMockInterviewPrompt,
    'star-answer':            buildStarAnswerPrompt,
    'recruiter-feedback':     buildRecruiterFeedbackPrompt,
    'salary-insights':        buildSalaryInsightsPrompt,
    'career-progression':     buildCareerProgressionPrompt,
    'portfolio-review':       buildPortfolioReviewPrompt,
    'career-roadmap':         buildCareerRoadmapPrompt,
    'linkedin-branding':      buildLinkedInBrandingPrompt,
    'executive-cover-letter': buildExecutiveCoverLetterPrompt
  };

  if (PREMIUM_ONLY.has(action) && auth.plan !== 'premium') {
    return res.status(403).json({ error: 'This feature requires a Premium plan.' });
  }

  const builder = builders[action];
  if (!builder) return res.status(400).json({ error: 'Unknown action: ' + action });

  try {
    const prompt = builder(payload);

    // Model selection:
    //   Premium → always Sonnet (highest priority, even for light actions)
    //   Pro / day_pass → Sonnet for heavy actions, Haiku for light
    //   Free → always Haiku
    const plan = (payload.plan || 'free').toLowerCase();
    const isPremium = plan === 'premium';
    const isPaid = plan === 'pro' || plan === 'premium' || plan === 'day_pass';
    const alwaysLight = ['score', 'template-recommend', 'parse-cv'];
    const model = isPremium ? MODEL_HEAVY
      : alwaysLight.includes(action) ? MODEL_LIGHT
      : isPaid ? MODEL_HEAVY
      : MODEL_LIGHT;

    const result = await callClaude(prompt.system, prompt.user, prompt.maxTokens || 4000, model);
    let parsed = extractJson(result);

    // 'enhance' can get cut off mid-JSON for CVs with several experience
    // entries (rich content + cover letter + score + keywords all in one
    // response can exceed the token budget). Retry once with a tighter,
    // more compact instruction rather than failing the whole analysis.
    if (!parsed && action === 'enhance') {
      const retryPrompt = buildEnhancePrompt(Object.assign({}, payload, { _compact: true }));
      const retryResult = await callClaude(retryPrompt.system, retryPrompt.user, retryPrompt.maxTokens, model);
      parsed = extractJson(retryResult);
    }

    if (!parsed) return res.status(502).json({ error: 'The AI returned an unexpected format. Please try again.' });
    return res.status(200).json(parsed);
  } catch (err) {
    console.error('AI function error:', err);
    return res.status(502).json({ error: err.message || 'AI request failed' });
  }
};

/* ---------------- Anthropic call ---------------- */

async function callClaude(system, user, maxTokens, model) {
  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || MODEL_HEAVY,
      max_tokens: maxTokens,
      system: system,
      messages: [{ role: 'user', content: user }]
    })
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error('Anthropic API error', response.status, errBody);
    if (response.status === 429) throw new Error('The AI is a bit busy right now — try again in a minute');
    if (response.status === 401) throw new Error('AI service authentication failed');
    throw new Error('AI service error (' + response.status + ')');
  }

  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('AI returned no text');
  return textBlock.text;
}

function extractJson(text) {
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

/* ---------------- Shared context ---------------- */

const UK_STYLE = 'You are a senior European recruitment consultant and CV writer, experienced across UK, EU, and wider European hiring conventions. Use English throughout (British spelling by default — CV not resume, organisation not organization, -ise endings). Write in a confident, professional but human tone. Never invent employers, dates, or qualifications that are not in the data — you may only rephrase and strengthen what is given.';

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
  var lang = p.coverLetterLanguage || 'English';
  var langInstruction = lang === 'English'
    ? 'Write the cover letter in British English.'
    : 'Write the cover letter entirely in ' + lang + ' — no English text in the cover letter itself.';
  var compact = !!p._compact;
  return {
    maxTokens: 8000,
    system: UK_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      compact
        ? 'Do ALL of the following in one pass. IMPORTANT: your previous attempt at this got cut off before the JSON was complete — this time, be noticeably more concise everywhere (shorter bullets, shorter cover letter) so the full response fits comfortably within the token budget.'
        : 'Do ALL of the following in one pass. Keep the whole response inside the token budget — for candidates with several experience entries, favour fewer, punchier bullets over hitting the top of every range below.',
      '1. Rewrite the professional summary to a polished 3–4 sentence CV profile.',
      '2. For each experience entry, rewrite responsibilities and achievements into ' + (compact ? '2–3 concise' : '3–4 strong') + ', ATS-friendly bullet points (action verb first, quantify where the data allows).',
      '3. Score the CV out of 100 with a breakdown for: formatting, keywords, achievements, ats, length (each 0–100). Base keywords/ats on the job description if provided, otherwise on the target role.',
      '4. Recommend exactly one template: "professional" (finance/legal/corporate), "modern" (tech/marketing/creative), or "graduate" (first jobs, graduate schemes, limited experience).',
      '5. Write a tailored cover letter (' + (compact ? '~150 words' : '~250 words') + ') addressed for the job description if given, otherwise for the target role. Use the candidate\'s real name. ' + langInstruction,
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
      'Score this CV out of 100 for the European job market, with a breakdown for formatting, keywords, achievements, ats, and length (each 0–100). Explain the total briefly.',
      jsonOnly('{ "score": { "total": 0, "breakdown": { "formatting": 0, "keywords": 0, "achievements": 0, "ats": 0, "length": 0 } }, "summary": "one-paragraph explanation" }')
    ].join('\n')
  };
}

function buildCoverLetterPrompt(p) {
  var lang = p.coverLetterLanguage || 'English';
  var langInstruction = lang === 'English'
    ? 'Write in British English.'
    : 'Write entirely in ' + lang + '. Do not include any English text in the cover letter itself.';
  return {
    maxTokens: 1500,
    system: UK_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'Write a tailored cover letter (~250 words) for the job description in jobTarget.description (or the target role if no description). Confident, specific, no clichés like "I am writing to apply". ' + langInstruction,
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

function buildParseCvPrompt(p) {
  return {
    maxTokens: 3000,
    system: 'You are an expert CV parser. Extract structured data from raw CV text accurately. Use British English. Never invent information not present in the text. If a field is not found, return an empty string or empty array.',
    user: [
      'Extract all available information from the following CV text and return it as structured JSON.',
      '',
      'CV TEXT:',
      '---',
      (p.text || '').slice(0, 12000),
      '---',
      '',
      jsonOnly(JSON.stringify({
        personal: {
          fullName: 'string',
          email: 'string',
          phone: 'string',
          location: 'string (city only)',
          address: 'string (full address if present)',
          linkedin: 'string (URL if present)',
          summary: 'string (professional summary/profile if present)'
        },
        experience: [{
          jobTitle: 'string',
          company: 'string',
          startDate: 'string (e.g. Jan 2020)',
          endDate: 'string (e.g. Mar 2023 or "Present")',
          current: 'boolean',
          description: 'string (responsibilities and achievements as plain text)'
        }],
        education: [{
          degree: 'string (qualification and subject)',
          institution: 'string',
          startDate: 'string',
          endDate: 'string',
          grade: 'string (grade/result if present)'
        }],
        skills: ['string'],
        languages: ['string (language name only, e.g. "French")'],
        certifications: ['string']
      }))
    ].join('\n')
  };
}


function buildCompareCvPrompt(p) {
  return {
    maxTokens: 3000,
    system: UK_STYLE,
    user: [
      'OLD CV (raw text extracted from uploaded file):',
      '---',
      (p.oldCvText || '(no old CV provided)').slice(0, 8000),
      '---',
      '',
      'NEW CV (structured data):',
      cvSummaryBlock(p),
      '',
      'Compare the old CV against the new one. Identify what has improved, what is new, what was removed, and flag anything that looks worse or missing. Be specific — reference actual content from both CVs.',
      jsonOnly('{ "improvements": [{ "category": "string", "old": "string", "new": "string", "verdict": "better | worse | new | removed" }], "summary": "string (2-3 sentence overall verdict)", "score": { "old": 0, "new": 0 } }')
    ].join('\n')
  };
}

/* ─────────────────── PREMIUM PROMPT BUILDERS ─────────────────── */

const PREMIUM_STYLE = UK_STYLE + ' You are advising a premium-tier professional who expects specific, evidence-based guidance — not generic advice. Be direct, honest, and concrete.';

function buildCareerCoachPrompt(p) {
  return {
    maxTokens: 2000,
    system: PREMIUM_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'COACHING QUESTION FROM THE CANDIDATE:',
      (p.question || '').slice(0, 2000),
      '',
      'Give a thorough, personalised coaching response. Reference specifics from their CV where relevant. Structure your response with clear sections if needed.',
      jsonOnly('{ "response": "string (full coaching response, markdown-formatted)", "actionItems": ["string — 3-5 concrete next steps"], "followUpQuestions": ["string — 2-3 questions to deepen the coaching session"] }')
    ].join('\n')
  };
}

function buildMockInterviewPrompt(p) {
  var mode = p.mode || 'generate'; // 'generate' | 'evaluate'
  if (mode === 'evaluate') {
    return {
      maxTokens: 2000,
      system: PREMIUM_STYLE,
      user: [
        cvSummaryBlock(p),
        '',
        'INTERVIEW QUESTION ASKED:',
        (p.interviewQuestion || '').slice(0, 1000),
        '',
        'CANDIDATE\'S ANSWER:',
        (p.candidateAnswer || '').slice(0, 3000),
        '',
        'Evaluate this answer as a senior interviewer would. Score it, identify what was strong and what was weak, and provide a model answer for comparison.',
        jsonOnly('{ "score": 0, "verdict": "Strong | Good | Needs Work | Weak", "strengths": ["string"], "weaknesses": ["string"], "modelAnswer": "string (~150 words — what a great answer looks like)", "tip": "string (single most important improvement)" }')
      ].join('\n')
    };
  }
  return {
    maxTokens: 2500,
    system: PREMIUM_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'TARGET ROLE / JOB DESCRIPTION:',
      (p.jobTarget && p.jobTarget.description ? p.jobTarget.description : (p.jobTarget && p.jobTarget.title ? p.jobTarget.title : 'Not specified')).slice(0, 2000),
      '',
      'Generate 10 realistic interview questions this candidate will likely face. Include a mix: competency/STAR (3), technical/role-specific (3), CV-probing (2), situational (1), closing/motivation (1). For each, give the interviewer\'s hidden intent.',
      jsonOnly('{ "questions": [{ "question": "string", "type": "competency | technical | cv-probing | situational | motivation", "intent": "string — what the interviewer is really assessing", "hint": "string — one-line tip for this specific candidate" }] }')
    ].join('\n')
  };
}

function buildStarAnswerPrompt(p) {
  return {
    maxTokens: 2000,
    system: PREMIUM_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'INTERVIEW QUESTION:',
      (p.question || '').slice(0, 500),
      '',
      'RELEVANT EXPERIENCE / BULLET POINTS TO DRAW ON:',
      (p.experienceNotes || '').slice(0, 2000),
      '',
      'Write a polished STAR-format answer (~250 words) tailored to this question using the experience provided. Natural, first-person, confident. British English.',
      jsonOnly('{ "situation": "string (~50 words)", "task": "string (~40 words)", "action": "string (~100 words — the bulk of the answer)", "result": "string (~60 words — quantify where possible)", "fullAnswer": "string (the complete flowing answer combining all four parts)", "keywords": ["string — 5 keywords/phrases this answer should contain to score well"] }')
    ].join('\n')
  };
}

function buildRecruiterFeedbackPrompt(p) {
  return {
    maxTokens: 2500,
    system: PREMIUM_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'You are a senior UK recruiter at a major search firm. You have 10 seconds to decide whether to call this candidate. Give your honest, unfiltered assessment of the CV — strengths, red flags, what would make you put it in the YES pile vs the NO pile.',
      jsonOnly('{ "firstImpression": "string (gut reaction in 1-2 sentences — what a recruiter thinks in the first 10 seconds)", "verdict": "Strong Yes | Yes | Maybe | No", "strengths": [{ "point": "string", "impact": "string" }], "redFlags": [{ "flag": "string", "howToFix": "string" }], "whatsMissing": ["string"], "phoneScreenQuestions": ["string — 3 questions a recruiter would ask based on this CV"], "overallAdvice": "string (2-3 sentences of straight-talking advice)" }')
    ].join('\n')
  };
}

function buildSalaryInsightsPrompt(p) {
  return {
    maxTokens: 2000,
    system: PREMIUM_STYLE,
    user: [
      'ROLE: ' + (p.role || (p.jobTarget && p.jobTarget.title) || 'Not specified'),
      'LOCATION: ' + (p.location || (p.personal && p.personal.location) || 'United Kingdom'),
      'YEARS OF EXPERIENCE: ' + (p.yearsExperience || 'Not specified'),
      'INDUSTRY/SECTOR: ' + (p.industry || 'Not specified'),
      'COMPANY SIZE: ' + (p.companySize || 'Not specified'),
      'CURRENT SALARY (optional): ' + (p.currentSalary || 'Not provided'),
      '',
      cvSummaryBlock(p),
      '',
      'Provide salary benchmarking for this role in the UK/European market. Give ranges for junior, mid, and senior levels. Include negotiation advice specific to this candidate\'s profile. Base data on typical market rates — be realistic, not aspirational.',
      jsonOnly('{ "currency": "GBP", "ranges": { "junior": { "min": 0, "max": 0, "label": "string" }, "mid": { "min": 0, "max": 0, "label": "string" }, "senior": { "min": 0, "max": 0, "label": "string" } }, "candidateEstimate": { "min": 0, "max": 0, "rationale": "string" }, "factors": [{ "factor": "string", "impact": "positive | negative | neutral", "detail": "string" }], "negotiationTips": ["string"], "marketContext": "string (2-3 sentences on market conditions for this role)", "disclaimer": "Salary data is estimated based on publicly available market information and should be used as a guide only." }')
    ].join('\n')
  };
}

function buildCareerProgressionPrompt(p) {
  return {
    maxTokens: 3000,
    system: PREMIUM_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'TARGET ROLE/LEVEL: ' + (p.targetRole || (p.jobTarget && p.jobTarget.title) || 'Not specified'),
      'TARGET TIMELINE: ' + (p.targetTimeline || '2-3 years'),
      '',
      'Create a realistic, step-by-step career progression plan from the candidate\'s current position to their target. Be specific about skills to build, experience to gain, qualifications to consider, and network moves to make.',
      jsonOnly('{ "currentLevel": "string", "targetLevel": "string", "estimatedTimeline": "string", "steps": [{ "phase": "string (e.g. \'Months 1-6\')", "title": "string", "focus": "string", "actions": ["string"], "milestones": ["string"] }], "skillGaps": [{ "skill": "string", "priority": "Critical | Important | Nice-to-have", "howToAcquire": "string" }], "qualifications": [{ "name": "string", "value": "string", "urgency": "string" }], "networkingMoves": ["string"], "risks": ["string — potential blockers and how to mitigate them"], "quickWins": ["string — things to do in the next 30 days"] }')
    ].join('\n')
  };
}

function buildPortfolioReviewPrompt(p) {
  return {
    maxTokens: 2500,
    system: PREMIUM_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'PORTFOLIO URL: ' + (p.portfolioUrl || 'Not provided'),
      'PORTFOLIO DESCRIPTION / PROJECTS:',
      (p.portfolioDescription || '').slice(0, 3000),
      '',
      'TARGET ROLE/AUDIENCE: ' + (p.targetRole || 'Not specified'),
      '',
      'Review this professional portfolio against what hiring managers and recruiters actually look for. Be specific, honest, and actionable.',
      jsonOnly('{ "overallScore": 0, "verdict": "string (one-sentence overall impression)", "strengths": [{ "area": "string", "detail": "string" }], "weaknesses": [{ "area": "string", "detail": "string", "fix": "string" }], "mustAdd": ["string — things that are missing and should be added"], "mustRemove": ["string — things that are hurting the portfolio"], "firstImpression": "string (what a hiring manager thinks in the first 30 seconds)", "recommendations": ["string — 5 prioritised, specific recommendations"], "standoutProject": "string (which project to lead with and why)" }')
    ].join('\n')
  };
}

function buildCareerRoadmapPrompt(p) {
  return {
    maxTokens: 3000,
    system: PREMIUM_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'ULTIMATE CAREER GOAL: ' + (p.careerGoal || p.targetRole || 'Not specified'),
      'TIMELINE HORIZON: ' + (p.timeline || '5 years'),
      '',
      'Build a detailed career roadmap with clear milestones, skill nodes, and decision points. Think of it as a visual career map — each milestone should be concrete and achievable.',
      jsonOnly('{ "currentPosition": "string", "destination": "string", "totalTimeline": "string", "milestones": [{ "id": "M1", "title": "string", "timeframe": "string (e.g. \'6 months\')", "description": "string", "keyDeliverables": ["string"], "skills": ["string"], "type": "role | qualification | project | network | pivot" }], "criticalPath": ["M1", "M2"], "alternativePaths": [{ "name": "string", "description": "string", "triggerCondition": "string" }], "earlyIndicators": ["string — signs you\'re on track at 3 months"], "risks": [{ "risk": "string", "mitigation": "string" }] }')
    ].join('\n')
  };
}

function buildLinkedInBrandingPrompt(p) {
  return {
    maxTokens: 3000,
    system: PREMIUM_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'TARGET AUDIENCE: ' + (p.targetAudience || p.targetRole || 'Not specified'),
      'CURRENT LINKEDIN FOLLOWERS/CONNECTIONS: ' + (p.connections || 'Not specified'),
      'CONTENT CREATION EXPERIENCE: ' + (p.contentExperience || 'Not specified'),
      '',
      'Build a LinkedIn personal brand strategy for this professional. Focus on thought leadership, positioning, and content that attracts the right opportunities.',
      jsonOnly('{ "brandStatement": "string (their core personal brand in 1-2 sentences)", "positioning": "string (how to position themselves uniquely in their space)", "contentPillars": [{ "pillar": "string", "rationale": "string", "exampleTopics": ["string"] }], "contentCalendar": [{ "frequency": "string (e.g. \'2x per week\')", "format": "string (e.g. \'Text post\')", "pillar": "string", "example": "string (example post topic or hook)" }], "profileOptimisations": ["string — specific profile changes beyond headline/about"], "engagementStrategy": ["string — how to grow visibility and connections"], "30DayPlan": ["string — week-by-week actions for the first month"], "voiceGuidelines": { "tone": "string", "doUse": ["string"], "avoid": ["string"] } }')
    ].join('\n')
  };
}

function buildExecutiveCoverLetterPrompt(p) {
  var lang = p.coverLetterLanguage || 'English';
  var langInstruction = lang === 'English'
    ? 'Write in sophisticated British English.'
    : 'Write entirely in ' + lang + '.';
  return {
    maxTokens: 2000,
    system: PREMIUM_STYLE,
    user: [
      cvSummaryBlock(p),
      '',
      'Write a premium executive cover letter (~350 words) for the job description in jobTarget.description (or target role if no description). This is for a senior professional — the tone should be authoritative, strategic, and confident. No clichés. Open with a compelling hook that demonstrates business acumen. Reference specific achievements with numbers. Close with a clear, assertive call to action. ' + langInstruction,
      jsonOnly('{ "coverLetter": "string", "subjectLine": "string (email subject line for sending this application)", "keySellingPoints": ["string — 3 headline achievements used in the letter"] }')
    ].join('\n')
  };
}
