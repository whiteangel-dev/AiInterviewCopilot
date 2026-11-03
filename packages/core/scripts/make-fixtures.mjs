// Generates the test resumes in fixtures/ (fictional candidate from Phase 0).
// Run with Electron (it prints the PDFs): npx electron scripts/make-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { strToU8, zipSync } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));
const out = (name) => join(here, '..', 'fixtures', name);

const resume = {
  name: 'Jordan Rivera',
  contact: 'Austin, TX · jordan.rivera@example.com · github.com/jrivera-dev',
  title: 'Senior Backend Engineer',
  summary:
    'Backend engineer focused on high-throughput, event-driven systems, reliability, and developer tooling. Tech lead for squads of 4–6 engineers. Strongest in TypeScript/Node.js, Go, PostgreSQL, Kafka, and AWS.',
  jobs: [
    {
      head: 'Quayside Logistics — Senior Software Engineer, Platform',
      dates: 'Mar 2021 – Present',
      bullets: [
        'Led the redesign of the shipment-event pipeline from a cron-based batch system to Kafka streaming on AWS MSK; cut tracking-update latency from about 15 minutes to under 5 seconds.',
        'The pipeline handles roughly 40,000 events per second at holiday peak and held 99.95% availability across 2023–2024.',
        'Introduced idempotent consumers and a transactional outbox in PostgreSQL; duplicate customer notifications dropped by 97%.',
        'Ran the incident review program; led the response to the November 2022 Black Friday consumer-lag incident.',
        'Tech lead for a 5-person squad; mentored 3 engineers to promotion.',
        'Built "Replay", an internal tool that replays production Kafka topics into staging for load tests.',
      ],
      stack:
        'TypeScript (Node.js), Go, Kafka (AWS MSK), PostgreSQL, Redis, AWS ECS on Fargate, Terraform, Datadog',
    },
    {
      head: 'Tallgrass Health — Software Engineer II, promoted to Senior',
      dates: 'Jun 2017 – Feb 2021',
      bullets: [
        'Built the appointment-scheduling API (Node.js, Express, PostgreSQL) used by 120 clinics; brought p95 latency from 900 ms to 180 ms through query tuning and caching.',
        'Implemented HIPAA audit logging; passed two external audits with zero findings in the logging scope.',
        "Moved monolith billing jobs to AWS Lambda and SQS, cutting that workload's infrastructure cost by about 30%.",
        'Led the on-call rotation and wrote the runbook template the team still uses.',
      ],
    },
    {
      head: 'Pinecrest Labs — Junior Software Engineer',
      dates: 'Jul 2015 – May 2017',
      bullets: [
        'Ruby on Rails and React for a B2B survey product; built a CSV importer that handled 1-million-row files.',
        'Moved deployments from manual scripts to Jenkins pipelines.',
      ],
    },
  ],
  projects: [
    'openslo-lint (open source, Go): a CLI that validates SLO definition files; about 600 GitHub stars.',
    'Replay (internal, Quayside): Kafka topic replay into staging for load and regression tests.',
  ],
  skills: [
    ['Languages', 'TypeScript, Go, SQL, Python (scripting), Ruby (not recent)'],
    ['Data and streaming', 'Kafka, PostgreSQL, Redis, SQS'],
    [
      'Cloud and infrastructure',
      'AWS (ECS Fargate, MSK, Lambda, RDS), Terraform, Docker, GitHub Actions',
    ],
    ['Observability', 'Datadog, OpenTelemetry, Prometheus, Grafana'],
  ],
  education: 'B.S. Computer Science, University of Texas at Austin, 2015',
  certifications: 'AWS Certified Solutions Architect – Associate (2022)',
};

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function html() {
  const jobs = resume.jobs
    .map(
      (
        j,
      ) => `<div class="job"><div class="row"><b>${esc(j.head)}</b><span>${esc(j.dates)}</span></div>
      <ul>${j.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
      ${j.stack ? `<p class="stack">Stack: ${esc(j.stack)}</p>` : ''}</div>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:10.5pt/1.35 Georgia,serif;color:#111;margin:0;padding:36px 48px}
    h1{font-size:22pt;margin:0} .contact{color:#444;margin:4px 0 2px} .title{font-weight:bold;color:#2b3a8a}
    h2{font-size:11pt;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid #999;margin:16px 0 6px}
    .row{display:flex;justify-content:space-between} ul{margin:4px 0 8px 18px;padding:0} li{margin:2px 0}
    .stack{margin:0 0 6px;color:#333;font-style:italic} p{margin:4px 0}
  </style></head><body>
  <h1>${esc(resume.name)}</h1><div class="contact">${esc(resume.contact)}</div><div class="title">${esc(resume.title)}</div>
  <h2>Summary</h2><p>${esc(resume.summary)}</p>
  <h2>Experience</h2>${jobs}
  <h2>Projects</h2><ul>${resume.projects.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
  <h2>Skills</h2>${resume.skills.map(([k, v]) => `<p><b>${esc(k)}:</b> ${esc(v)}</p>`).join('')}
  <h2>Education</h2><p>${esc(resume.education)}</p>
  <h2>Certifications</h2><p>${esc(resume.certifications)}</p>
  </body></html>`;
}

function docx() {
  const p = (text, opts = {}) => {
    const rPr = [opts.bold ? '<w:b/>' : '', opts.size ? `<w:sz w:val="${opts.size}"/>` : ''].join(
      '',
    );
    const pPr = opts.bullet ? '<w:pPr><w:pStyle w:val="ListBullet"/></w:pPr>' : '';
    return `<w:p>${pPr}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  };
  const body = [
    p(resume.name, { bold: true, size: 44 }),
    p(resume.contact),
    p(resume.title, { bold: true }),
    p('Summary', { bold: true }),
    p(resume.summary),
    p('Experience', { bold: true }),
    ...resume.jobs.flatMap((j) => [
      // A tab between role and dates, like most Word resumes.
      `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(j.head)}</w:t></w:r><w:r><w:tab/><w:t>${esc(j.dates)}</w:t></w:r></w:p>`,
      ...j.bullets.map((b) => p(b, { bullet: true })),
      ...(j.stack ? [p(`Stack: ${j.stack}`)] : []),
    ]),
    p('Projects', { bold: true }),
    ...resume.projects.map((x) => p(x, { bullet: true })),
    p('Skills', { bold: true }),
    // Skills as a two-column table.
    `<w:tbl>${resume.skills
      .map(([k, v]) => `<w:tr><w:tc>${p(k, { bold: true })}</w:tc><w:tc>${p(v)}</w:tc></w:tr>`)
      .join('')}</w:tbl>`,
    p('Education', { bold: true }),
    p(resume.education),
    p('Certifications', { bold: true }),
    p(resume.certifications),
  ].join('');
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), {
    mtime: new Date('2026-01-01T00:00:00Z'),
  });
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 816,
    height: 1056,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html())}`);
  const pdf = await win.webContents.printToPDF({
    pageSize: 'Letter',
    printBackground: false,
    margins: { marginType: 'none' },
  });
  writeFileSync(out('resume-jordan-rivera.pdf'), pdf);

  // "Scanned" resume: the same page as an image only, with no text layer.
  const shot = await win.webContents.capturePage();
  const img = `data:image/png;base64,${shot.toPNG().toString('base64')}`;
  await win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0"><img src="${img}" style="width:100%"></body></html>`)}`,
  );
  const scanned = await win.webContents.printToPDF({
    pageSize: 'Letter',
    margins: { marginType: 'none' },
  });
  writeFileSync(out('resume-scanned.pdf'), scanned);

  writeFileSync(out('resume-jordan-rivera.docx'), docx());
  console.log('fixtures written');
  app.quit();
});
