import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface LotRow {
  id: string;
  noticeId: string;
  lotNumber: number;
  title: string | null;
  description: string | null;
  estimatedValue: number | null;
  awardedValue: number | null;
  cpvCodes: string[];
  status: string | null;
}

export interface NoticeHit {
  id: string;
  source: "ted" | "anac";
  kind: "call" | "award" | "other";
  noticeType: string;
  title: string;
  description: string | null;
  buyerId: string | null;
  buyerName: string | null;
  buyerCity: string | null;
  region: string | null;
  province: string | null;
  placeCity: string | null;
  cpvCodes: string[];
  estimatedValue: number | null;
  awardedValue: number | null;
  discountPct: number | null;
  publishedAt: string | null;
  deadlineAt: string | null;
  url: string | null;
  similarity: number | null;
  why: string | null;
  signal: "hide" | "interest" | null;
  awardCount: number;
  lotCount: number;
  cig: string | null;
  cup: string | null;
  pnrr: boolean;
  pnrrPnc: boolean;
  esito: string | null;
  esitoAt: string | null;
  lots: LotRow[];
}

export interface SearchFilters {
  kind?: string;
  source?: string;
  region?: string;
  province?: string;
  cpvPrefix?: string;
  category?: string;
  soaCategory?: string;
  buyer?: string;
  buyerId?: string;
  supplierId?: string;
  minValue?: number | null;
  maxValue?: number | null;
  minDiscount?: number | null;
  maxDiscount?: number | null;
  deadlineFrom?: string;
  deadlineTo?: string;
  publishedFrom?: string;
  publishedTo?: string;
  onlyAwarded?: boolean;
  hideExpired?: boolean;
  onlyOpen?: boolean;
  minSimilarity?: number | null;
}

export interface SearchRequest {
  query: string;
  filters: SearchFilters;
  limit?: number;
  offset?: number;
  sort?: string;
  keywordOnly?: boolean;
  mode?: "auto" | "semantic" | "filtered" | "keyword" | "predictions";
  entityType?: "supplier" | "buyer";
  entityId?: string;
  noticeId?: string;
}

export interface SearchOutcome {
  items: NoticeHit[];
  total: number;
  semantic: boolean;
  warning: string | null;
  tookMs: number;
  mode: "filtered" | "semantic" | "keyword" | "predictions";
  label: string | null;
}

export type EntityType = "supplier" | "buyer";

/** Richiesta di previsione inoltrata da una scheda gara o da un profilo ente. */
export type SearchSeed =
  | { kind: "notice"; noticeId: string; title: string }
  | { kind: "entity"; entityType: EntityType; entityId: string; name: string };

export interface AwardRow {
  id: string;
  supplierId: string | null;
  supplierName: string;
  awardedValue: number | null;
  estimatedValue: number | null;
  discountPct: number | null;
  awardedAt: string | null;
  noticeId: string;
  noticeTitle: string;
  region: string | null;
  cpvCodes: string[];
  url: string | null;
}

export interface SimilarAward {
  noticeId: string;
  title: string;
  buyerName: string | null;
  region: string | null;
  awardedValue: number | null;
  estimatedValue: number | null;
  discountPct: number | null;
  publishedAt: string | null;
  suppliers: string[];
  similarity: number;
  url: string | null;
}

export interface TimelineEvent {
  label: string;
  date: string;
  kind: string;
}

export interface IntelRow {
  key: string;
  label: string;
  contracts: number;
  totalValue: number;
  avgDiscount: number | null;
  bestDiscount: number | null;
  worstDiscount: number | null;
  lastAward: string | null;
}

export interface IntelOutcome {
  groupBy: string;
  rows: IntelRow[];
  totalAwards: number;
  totalValue: number;
  avgDiscount: number | null;
  years: { year: string; contracts: number; totalValue: number; avgDiscount: number | null }[];
  topContracts: IntelRow[];
}

export interface NoticeDetail {
  notice: NoticeHit;
  cpvContext: IntelRow[];
  procedureType: string | null;
  contractNature: string | null;
  awards: AwardRow[];
  similar: SimilarAward[];
  timeline: TimelineEvent[];
}

export interface NoticeDocument {
  id: string;
  noticeId: string;
  filename: string;
  pages: number;
  chars: number;
  addedAt: string;
  analyzed: boolean;
}

export interface DocumentAnalysisItem {
  label: string;
  note: string | null;
  page: number;
  quote: string;
}

export interface DocumentAnalysisSection {
  id: string;
  label: string;
  hint: string;
  summary: string;
  found: boolean;
  items: DocumentAnalysisItem[];
}

export interface DocumentAnalysis {
  filename: string;
  pages: number;
  analyzerVersion: number;
  generatedAt: string;
  sections: DocumentAnalysisSection[];
  warnings: string[];
}

export interface Stats {
  notices: number;
  calls: number;
  awarded: number;
  awards: number;
  suppliers: number;
  buyers: number;
  embedded: number;
  earliest: string | null;
  latest: string | null;
  avgDiscount: number | null;
  boardItems: number;
  ted: number;
  anac: number;
  pnrr: number;
  hidden: number;
  followed: number;
  lots: number;
}

export interface BoardItem {
  notice: NoticeHit;
  columnKey: string;
  position: number;
  note: string | null;
  updatedAt: string;
}

export interface SavedSearch {
  id: number;
  name: string;
  query: string;
  filters: SearchFilters;
  frequency: string;
  active: boolean;
  minSimilarity: number;
  lastRunAt: string | null;
  createdAt: string;
  hasEmbedding: boolean;
  matches: number;
}

export interface DigestNotice {
  id: string;
  source: "ted" | "anac";
  kind: string;
  title: string;
  buyerName: string | null;
  region: string | null;
  deadlineAt: string | null;
  estimatedValue: number | null;
  discountPct: number | null;
  similarity: number | null;
  url: string | null;
  cig: string | null;
}

export interface DigestSection {
  kind: "search" | "entity";
  id: string;
  name: string;
  detail: string | null;
  notices: DigestNotice[];
}

export interface Digest {
  subject: string;
  sections: DigestSection[];
  notices: DigestNotice[];
  total: number;
  html: string;
}

export interface DigestReport {
  sent: boolean;
  skipped: boolean;
  notices: number;
  sections: number;
  recipient: string | null;
  error: string | null;
}

export interface Criterion {
  id: string;
  label: string;
  weight: number;
  requirements: string[];
  manualScore?: number | null;
}

export interface CriterionResult {
  id: string;
  label: string;
  weight: number;
  coverage: number;
  suggestedScore: number;
  appliedScore: number;
  evidence: { sentence: string; matched: string[] }[];
  gaps: string[];
}

export interface Evaluation {
  criteria: CriterionResult[];
  totalScore: number;
  maxScore: number;
  coverage: number;
  wordCount: number;
  signals: { label: string; value: string }[];
  gaps: string[];
  summary: string;
}

export interface EvaluationOutput {
  evaluation: Evaluation;
  criteria: Criterion[];
  savedId: number | null;
}

export interface SavedEvaluation {
  id: number;
  noticeId: string | null;
  reportTitle: string | null;
  reportText: string;
  createdAt: string;
  totalScore: number;
  maxScore: number;
  criteria: Criterion[];
  result: Evaluation;
}

export interface ExportResult {
  path: string;
  rows: number;
  total: number;
  truncated: boolean;
}

export interface Settings {
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "starttls" | "tls" | "none";
  smtpUser: string;
  smtpPassword: string;
  smtpFrom: string;
  alertRecipient: string;
  alertHour: number;
  digestTimezone: "local" | "utc";
  embeddingProvider: "local" | "api";
  apiBaseUrl: string;
  apiKey: string;
  apiModel: string;
  digestDays: number;
  digestMaxNotices: number;
  hideExpiredDefault: boolean;
}

export interface EmbeddingStatus {
  provider: string;
  model: string;
  dims: number;
  ready: boolean;
  error: string | null;
}

export interface IngestStats {
  fetched: number;
  saved: number;
  skipped: number;
  awards: number;
  perType: Record<string, number>;
  startedAt: string;
  finishedAt: string | null;
}

export interface IngestProgress {
  phase: string;
  message: string;
  fetched: number;
  saved: number;
  awards: number;
  noticeType: string | null;
  current: number;
  total: number;
}

export interface EmbedProgress {
  done: number;
  total: number;
  message: string;
}

export interface IngestRunRow {
  id: number;
  source: "ted" | "anac";
  startedAt: string;
  finishedAt: string | null;
  fromDate: string | null;
  toDate: string | null;
  fetched: number;
  saved: number;
  skipped: number;
  awards: number;
  status: string;
  message: string | null;
}

export interface DataSummary {
  stats: Stats;
  runs: IngestRunRow[];
}

export interface FollowedEntity {
  id: number;
  entityType: "supplier" | "buyer";
  entityId: string;
  name: string;
  minSimilarity: number;
  active: boolean;
  createdAt: string;
  openNotices: number;
}

export interface ProfileCount {
  key: string;
  label: string;
  count: number;
  value: number;
}

export interface EntityHistoryRow {
  id: string;
  source: string;
  kind: string;
  title: string;
  buyerName: string | null;
  region: string | null;
  cpvCodes: string[];
  estimatedValue: number | null;
  awardedValue: number | null;
  discountPct: number | null;
  publishedAt: string | null;
  deadlineAt: string | null;
  url: string | null;
  suppliers: string[];
}

export interface EntityProfile {
  entityType: "supplier" | "buyer";
  entityId: string;
  name: string;
  followed: boolean;
  contracts: number;
  totalValue: number;
  avgDiscount: number | null;
  medianDiscount: number | null;
  minDiscount: number | null;
  maxDiscount: number | null;
  firstAt: string | null;
  lastAt: string | null;
  topCpv: ProfileCount[];
  topRegions: ProfileCount[];
  topCounterparties: ProfileCount[];
  history: EntityHistoryRow[];
  openNotices: NoticeHit[];
}

export const api = {
  stats: () => invoke<Stats>("get_stats"),
  search: (request: SearchRequest) => invoke<SearchOutcome>("search_notices", { request }),
  noticeDetail: (id: string) => invoke<NoticeDetail | null>("notice_detail", { id }),
  noticeDocuments: (noticeId: string) =>
    invoke<NoticeDocument[]>("notice_documents", { noticeId }),
  addNoticeDocument: (noticeId: string, path: string) =>
    invoke<NoticeDocument>("add_notice_document", { noticeId, path }),
  removeNoticeDocument: (documentId: string) =>
    invoke<void>("remove_notice_document", { documentId }),
  analyzeNoticeDocument: (documentId: string, refresh = false) =>
    invoke<DocumentAnalysis>("analyze_notice_document", { documentId, refresh }),
  setUserSignal: (noticeId: string, signal: "hide" | "interest") =>
    invoke<void>("set_user_signal", { noticeId, signal }),
  clearUserSignal: (noticeId: string, signal?: "hide" | "interest") =>
    invoke<void>("clear_user_signal", { noticeId, signal: signal ?? null }),
  followEntity: (entityType: "supplier" | "buyer", entityId: string, name?: string) =>
    invoke<void>("follow_entity", { entityType, entityId, name: name ?? null }),
  unfollowEntity: (entityType: "supplier" | "buyer", entityId: string) =>
    invoke<void>("unfollow_entity", { entityType, entityId }),
  listFollowedEntities: () => invoke<FollowedEntity[]>("list_followed_entities"),
  updateFollowedEntity: (
    entityType: "supplier" | "buyer",
    entityId: string,
    minSimilarity?: number,
    active?: boolean,
  ) =>
    invoke<void>("update_followed_entity", {
      entityType,
      entityId,
      minSimilarity: minSimilarity ?? null,
      active: active ?? null,
    }),
  entityProfile: (entityType: "supplier" | "buyer", entityId: string) =>
    invoke<EntityProfile>("entity_profile", { entityType, entityId }),
  entitySuggestions: (entityType: "supplier" | "buyer", query: string) =>
    invoke<ProfileCount[]>("entity_suggestions", { entityType, query }),
  predictFromEntity: (
    entityType: "supplier" | "buyer",
    entityId: string,
    filters?: SearchFilters,
    limit?: number,
    minSimilarity?: number,
    offset?: number,
  ) =>
    invoke<SearchOutcome>("predict_from_entity", {
      entityType,
      entityId,
      filters: filters ?? null,
      limit: limit ?? null,
      minSimilarity: minSimilarity ?? null,
      offset: offset ?? null,
    }),
  awardIntel: (filters: SearchFilters, groupBy: string) =>
    invoke<IntelOutcome>("award_intel", { filters, groupBy }),
  geoFilters: () =>
    invoke<{ regions: string[]; provinces: { code: string; region: string }[] }>("geo_filters"),
  boardList: () => invoke<BoardItem[]>("board_list"),
  boardAdd: (noticeId: string, column?: string) =>
    invoke<void>("board_add", { noticeId, column }),
  boardUpdate: (
    noticeId: string,
    patch: { column?: string; position?: number; note?: string },
  ) => invoke<void>("board_update", { noticeId, ...patch }),
  boardRemove: (noticeId: string) => invoke<void>("board_remove", { noticeId }),
  exportBoard: () => invoke<string>("export_board"),
  exportNotice: (id: string) => invoke<string>("export_notice", { id }),
  exportSearch: (request: SearchRequest, name?: string) =>
    invoke<ExportResult>("export_search", { request, name }),
  hiddenNotices: () => invoke<NoticeHit[]>("hidden_notices"),
  saveSearch: (name: string, query: string, filters: SearchFilters, minSimilarity?: number) =>
    invoke<number>("save_search", { name, query, filters, minSimilarity }),
  savedSearches: () => invoke<SavedSearch[]>("list_saved_searches"),
  deleteSavedSearch: (id: number) => invoke<void>("delete_saved_search", { id }),
  setSavedSearchActive: (id: number, active: boolean) =>
    invoke<void>("set_saved_search_active", { id, active }),
  previewDigest: (searchId?: number) =>
    invoke<Digest | null>("preview_digest", { searchId: searchId ?? null }),
  sendDigest: (searchId?: number) =>
    invoke<DigestReport>("send_digest", { searchId: searchId ?? null }),
  sendTestEmail: () => invoke<void>("send_test_email"),
  evaluate: (input: {
    report: string;
    criteria: Criterion[];
    noticeId?: string | null;
    reportTitle?: string | null;
    save?: boolean;
  }) => invoke<EvaluationOutput>("evaluate_report", { input }),
  listEvaluations: () => invoke<SavedEvaluation[]>("list_evaluations"),
  deleteEvaluation: (id: number) => invoke<void>("delete_evaluation", { id }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  embeddingStatus: () => invoke<EmbeddingStatus>("embedding_status"),
  embedPending: () => invoke<EmbedProgress>("embed_pending"),
  ingestRange: (from: string, to: string, noticeTypes?: string[]) =>
    invoke<IngestStats>("ingest_range", { from, to, noticeTypes }),
  ingestAnacRange: (from: string, to: string, includeUpdates?: boolean) =>
    invoke<IngestStats>("ingest_anac_range", { from, to, includeUpdates }),
  dataSummary: () => invoke<DataSummary>("data_summary"),
};

export function onIngestProgress(handler: (progress: IngestProgress) => void): Promise<UnlistenFn> {
  return listen<IngestProgress>("ingest-progress", (event) => handler(event.payload));
}

export function onEmbedProgress(handler: (progress: EmbedProgress) => void): Promise<UnlistenFn> {
  return listen<EmbedProgress>("embed-progress", (event) => handler(event.payload));
}

export function onAlertStatus(handler: (message: string) => void): Promise<UnlistenFn> {
  return listen<string>("alert-status", (event) => handler(event.payload));
}
