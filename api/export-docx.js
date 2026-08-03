/**
 * CV Central — DOCX Export (Vercel serverless)
 * POST /api/export-docx
 * Body: { personal, experience, education, skills, languages, certifications }
 * Returns: application/vnd.openxmlformats-officedocument.wordprocessingml.document
 *
 * Requires: Job Pass, Pro, or Premium plan.
 */

const {
  Document, Packer, Paragraph, TextRun,
  HeadingLevel, AlignmentType, BorderStyle,
  UnderlineType, TabStopType, TabStopLeader
} = require('docx');
const { authenticate } = require('./_auth');

const ALLOWED_PLANS = ['pro', 'premium', 'day_pass'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://cvcentral.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  let auth;
  try {
    auth = await authenticate(req);
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  if (!ALLOWED_PLANS.includes(auth.plan)) {
    return res.status(403).json({ error: 'DOCX export requires a Job Pass, Pro, or Premium plan.' });
  }

  const { personal = {}, experience = [], education = [], skills = [], languages = [], certifications = [] } = req.body || {};

  try {
    const doc = buildDocument({ personal, experience, education, skills, languages, certifications });
    const buffer = await Packer.toBuffer(doc);
    const filename = ((personal.fullName || 'CV').replace(/[^a-zA-Z0-9 ]/g, '') + ' - CV.docx').trim();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.status(200).end(buffer);
  } catch (e) {
    console.error('[export-docx]', e);
    return res.status(500).json({ error: 'Failed to generate DOCX: ' + e.message });
  }
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const VIOLET = '5B2D8E';
const BLACK  = '1A1625';
const MUTED  = '55506A';
const RULE   = 'D9D2EC';

function hr() {
  return new Paragraph({
    border: { bottom: { color: RULE, space: 1, size: 6, style: BorderStyle.SINGLE } },
    spacing: { after: 120 }
  });
}

function sectionHeading(text) {
  return new Paragraph({
    children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 20, color: VIOLET, font: 'Calibri', characterSpacing: 40 })],
    spacing: { before: 240, after: 80 }
  });
}

function bodyText(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, size: opts.size || 20, color: opts.color || BLACK, bold: opts.bold || false, italics: opts.italic || false, font: 'Calibri' })],
    spacing: { after: opts.after !== undefined ? opts.after : 60 }
  });
}

function bullet(text) {
  return new Paragraph({
    bullet: { level: 0 },
    children: [new TextRun({ text, size: 20, color: BLACK, font: 'Calibri' })],
    spacing: { after: 40 }
  });
}

function buildDocument({ personal, experience, education, skills, languages, certifications }) {
  const children = [];

  // ── Name ──
  children.push(new Paragraph({
    children: [new TextRun({ text: personal.fullName || 'Your Name', bold: true, size: 48, color: BLACK, font: 'Calibri' })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 }
  }));

  // ── Contact line ──
  const contactParts = [personal.email, personal.phone, personal.location, personal.website, personal.linkedin].filter(Boolean);
  if (contactParts.length) {
    children.push(new Paragraph({
      children: contactParts.map((p, i) => new TextRun({
        text: i < contactParts.length - 1 ? p + '  |  ' : p,
        size: 18, color: MUTED, font: 'Calibri'
      })),
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 }
    }));
  }

  // ── Summary ──
  if (personal.summary && personal.summary.trim()) {
    children.push(sectionHeading('Professional Summary'));
    children.push(hr());
    children.push(bodyText(personal.summary.trim(), { after: 120 }));
  }

  // ── Experience ──
  if (experience && experience.length) {
    children.push(sectionHeading('Experience'));
    children.push(hr());
    experience.forEach(function(job) {
      if (!job.company && !job.role) return;
      const dateStr = [job.start, job.current ? 'Present' : job.end].filter(Boolean).join(' – ');
      children.push(new Paragraph({
        children: [
          new TextRun({ text: (job.role || '') + (job.company ? ' — ' + job.company : ''), bold: true, size: 22, color: BLACK, font: 'Calibri' }),
        ],
        spacing: { before: 100, after: 20 }
      }));
      if (dateStr) {
        children.push(bodyText(dateStr, { color: MUTED, size: 18, italic: true, after: 60 }));
      }
      (job.bullets || []).filter(Boolean).forEach(function(b) {
        children.push(bullet(b));
      });
    });
  }

  // ── Education ──
  if (education && education.length) {
    children.push(sectionHeading('Education'));
    children.push(hr());
    education.forEach(function(edu) {
      if (!edu.institution && !edu.degree) return;
      const degreeStr = [edu.degree, edu.field].filter(Boolean).join(', ');
      const dateStr   = [edu.start, edu.end].filter(Boolean).join(' – ');
      children.push(new Paragraph({
        children: [new TextRun({ text: edu.institution || '', bold: true, size: 22, color: BLACK, font: 'Calibri' })],
        spacing: { before: 100, after: 20 }
      }));
      if (degreeStr) children.push(bodyText(degreeStr, { after: 20 }));
      if (dateStr)   children.push(bodyText(dateStr, { color: MUTED, size: 18, italic: true, after: 60 }));
      if (edu.grade) children.push(bodyText('Grade: ' + edu.grade, { after: 60 }));
    });
  }

  // ── Skills ──
  if (skills && skills.length) {
    children.push(sectionHeading('Skills'));
    children.push(hr());
    const skillStr = skills.map(function(s) { return typeof s === 'string' ? s : s.name || ''; }).filter(Boolean).join('  •  ');
    if (skillStr) children.push(bodyText(skillStr, { after: 120 }));
  }

  // ── Languages ──
  if (languages && languages.length) {
    children.push(sectionHeading('Languages'));
    children.push(hr());
    languages.forEach(function(l) {
      const name = typeof l === 'string' ? l : l.name || '';
      const level = typeof l === 'object' && l.level ? ' — ' + l.level : '';
      if (name) children.push(bodyText(name + level, { after: 40 }));
    });
  }

  // ── Certifications ──
  if (certifications && certifications.length) {
    children.push(sectionHeading('Certifications'));
    children.push(hr());
    certifications.forEach(function(c) {
      const name = typeof c === 'string' ? c : c.name || '';
      const meta = typeof c === 'object' ? [c.issuer, c.year].filter(Boolean).join(', ') : '';
      if (name) children.push(bodyText(name + (meta ? ' — ' + meta : ''), { after: 40 }));
    });
  }

  return new Document({
    creator: 'CV Central',
    title: (personal.fullName || 'CV') + ' - CV',
    description: 'Generated by CV Central (cvcentral.io)',
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 20, color: BLACK } }
      }
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 720, right: 900, bottom: 720, left: 900 }
        }
      },
      children
    }]
  });
}
