import type { AttachmentCategory, ChangeType, DocType, FamilyStatus, Housing, IncomeKind, Relation, Tag } from './labels';

export interface DocumentView { type: DocType; numberMasked: string; register: string | null; page: string | null; portfolio: string | null }
export interface MemberView {
  id: string; relation: Relation; status: 'ACTIVE' | 'DECEASED'; fullName: string; motherName: string | null;
  gender: 'M' | 'F'; birthDate: string | null; isOrphan: boolean; disability: string | null; chronicIllness: string | null;
  documents: DocumentView[];
}
export interface FlagView { id: string; reason: string; score: number; status: string; note: string | null; personName: string; matchedPersonName: string; matchedFamilyNo: string }
export interface ScoreBrief { points: number; class: 'A' | 'B' | 'C' | 'D' }
export interface ScoreLine { key: string; label: string; got: number; max: number; why: string }
export interface Family {
  id: string; familyNo: string; status: FamilyStatus; score: ScoreBrief | null; tags: Tag[]; phone1: string | null; phone2: string | null;
  address: { mahalla: string | null; street: string | null; house: string | null; landmark: string | null };
  housing: Housing | null; housingOther: string | null; prevAddress: string | null; prevLandmark: string | null;
  residenceCard: { number: string; issuedAt: string | null; issuedBy: string | null } | null;
  rationCard: { numberMasked: string; issuedAt: string | null; center: string | null } | null;
  notes: string | null; counts: { members: number; males: number; females: number };
  monthlyIncomeIqd: number; perCapitaIncomeIqd: number | null; povertyLineIqd: number; belowPovertyLine: boolean | null;
  members: MemberView[]; membersWithoutDocument: string[];
  incomes: { kind: IncomeKind; amountIqd: number; note: string | null }[];
  proxies: { id: string; fullName: string; phone: string | null; relation: string | null; active: boolean }[];
  duplicateFlags: FlagView[];
  createdBy: string; createdAt: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null;
}
export interface FamilyRow { id: string; familyNo: string; status: FamilyStatus; tags: Tag[]; phone1: string | null; headName: string | null; members: number; createdAt: string; score: ScoreBrief | null }
export interface Attachment { id: string; personId: string | null; category: AttachmentCategory; originalName: string; mime: string; sizeBytes: number; uploadedBy: string; createdAt: string }
export interface ChangeRequest {
  id: string; familyId: string; familyNo: string; type: ChangeType; payload: Record<string, any>; reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED'; requestedBy: string; requestedAt: string;
  decidedBy: string | null; decidedAt: string | null; decisionNote: string | null;
}
export interface OpenFlag { id: string; reason: string; score: number; familyId: string; familyNo: string; personName: string; matchedPersonName: string; matchedFamilyId: string; matchedFamilyNo: string }
export interface Conflict { kind: 'DOCUMENT' | 'RATION_CARD'; memberIndex?: number; documentType?: DocType; familyNo: string; familyStatus: FamilyStatus; personName?: string }
