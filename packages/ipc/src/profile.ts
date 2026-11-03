import { z } from 'zod';

/**
 * The structured candidate profile extracted from a resume, then reviewed and
 * edited by the user. Stored as immutable versions; compiled into the
 * Candidate Brief that answer prompts use.
 */

const str = (max: number) => z.string().trim().max(max);
const optional = (max: number) => str(max).nullable();

/**
 * Where a statement comes from:
 * - verified: the model quoted the resume and the quote was found in it;
 * - unverified: the quote wasn't found (review it);
 * - unchecked: the resume has no text layer (e.g. scanned), so quotes can't be checked;
 * - inferred: an interpretation (e.g. strengths), not a resume fact;
 * - user: written or edited by the user.
 */
export const EvidenceStatusSchema = z.enum([
  'verified',
  'unverified',
  'unchecked',
  'inferred',
  'user',
]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const PointSchema = z.object({
  text: str(600),
  quote: optional(800),
  status: EvidenceStatusSchema,
});

export const ExperienceSchema = z.object({
  company: str(160),
  title: str(160),
  location: optional(120),
  /** "YYYY-MM" or "YYYY". */
  start: optional(20),
  end: optional(20),
  current: z.boolean(),
  summary: str(1200),
  highlights: z.array(PointSchema).max(30),
  technologies: z.array(str(80)).max(60),
});

export const ProjectSchema = z.object({
  name: str(160),
  context: optional(160),
  description: str(1200),
  highlights: z.array(PointSchema).max(20),
  technologies: z.array(str(80)).max(60),
});

export const EducationSchema = z.object({
  institution: str(200),
  degree: optional(160),
  field: optional(160),
  start: optional(20),
  end: optional(20),
  details: optional(600),
});

export const SkillGroupSchema = z.object({
  category: str(100),
  items: z.array(str(80)).max(80),
});

export const CertificationSchema = z.object({
  name: str(200),
  issuer: optional(160),
  year: optional(20),
});

export const StrengthSchema = z.object({
  text: str(300),
  evidence: str(800),
  status: z.enum(['inferred', 'user']),
});

export const CandidateProfileSchema = z.object({
  name: str(120),
  headline: str(200),
  location: optional(120),
  summary: str(2000),
  totalYearsExperience: z.number().min(0).max(70).nullable(),
  experience: z.array(ExperienceSchema).max(40),
  projects: z.array(ProjectSchema).max(40),
  education: z.array(EducationSchema).max(15),
  skills: z.array(SkillGroupSchema).max(30),
  certifications: z.array(CertificationSchema).max(40),
  achievements: z.array(PointSchema).max(40),
  strengths: z.array(StrengthSchema).max(12),
  languages: z.array(str(60)).max(15),
});

export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;
export type ProfilePoint = z.infer<typeof PointSchema>;
export type ProfileExperience = z.infer<typeof ExperienceSchema>;
export type ProfileProject = z.infer<typeof ProjectSchema>;

export const EMPTY_PROFILE: CandidateProfile = {
  name: '',
  headline: '',
  location: null,
  summary: '',
  totalYearsExperience: null,
  experience: [],
  projects: [],
  education: [],
  skills: [],
  certifications: [],
  achievements: [],
  strengths: [],
  languages: [],
};

export type ProfileVersionOrigin = 'extracted' | 'edited' | 'restored';
export type DocumentKind = 'pdf' | 'docx';
export type TextQuality = 'good' | 'low' | 'none';

export interface ResumeDocumentInfo {
  id: string;
  fileName: string;
  kind: DocumentKind;
  sizeBytes: number;
  pageCount: number | null;
  /** `none`: no text layer (e.g. scanned), so quotes can't be checked. */
  textQuality: TextQuality;
  importedAt: number;
}

export interface ProfileVersionInfo {
  id: string;
  version: number;
  origin: ProfileVersionOrigin;
  createdAt: number;
  /** AI model that produced it (extracted versions only). */
  model: string | null;
}

export interface ProfileSummary {
  id: string;
  name: string;
  headline: string;
  updatedAt: number;
  version: number;
  document: Pick<ResumeDocumentInfo, 'fileName' | 'kind'> | null;
  /** Statements whose quote wasn't found in the resume. */
  unverifiedCount: number;
}

export interface ProfileDetail {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  current: ProfileVersionInfo & {
    data: CandidateProfile;
    /** Compact text the answer model sees. */
    brief: string;
    briefTokens: number;
  };
  document: ResumeDocumentInfo | null;
  versions: ProfileVersionInfo[];
}

export interface JobProgress {
  jobId: string;
  stage: string;
  message: string;
}

/** Statements whose quote wasn't found in the resume (need the user's review). */
export function countUnverified(profile: CandidateProfile): number {
  const points = [
    ...profile.experience.flatMap((e) => e.highlights),
    ...profile.projects.flatMap((p) => p.highlights),
    ...profile.achievements,
  ];
  return points.filter((p) => p.status === 'unverified').length;
}
