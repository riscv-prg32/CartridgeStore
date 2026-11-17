import type { z } from "zod";
import type {
  apiErrorSchema,
  authLogoutResponseSchema,
  authOperationResponseSchema,
  authProfileResponseSchema,
  authProvidersResponseSchema,
  authTokenCreatedResponseSchema,
  authTokenSchema,
  authTokenUpdatedResponseSchema,
  authTokensResponseSchema,
  authUserResponseSchema,
  csrfResponseSchema,
  gameSchema,
  gamesResponseSchema,
  paginationSchema,
  principalSchema,
  registrationRequestedResponseSchema,
  passkeyOptionsResponseSchema,
  metricsRunSchema,
  metricsSummarySchema,
  metricsRunDetailSchema,
  userProfileResponseSchema,
  userRunsResponseSchema,
  userRunResponseSchema,
  scoreRecordSchema,
  scoreStatsSchema,
  runStatsSchema,
  discoveryDocumentSchema,
  downloadSeriesPointSchema,
  downloadStatsSchema,
  gameDownloadStatsSchema,
  workflowSubmissionSchema,
  workflowSubmissionListResponseSchema,
  workflowSubmissionResponseSchema,
  workflowSubmissionResultSchema,
  ownedSubmissionSummarySchema,
  ownedSubmissionListResponseSchema,
  publisherDraftSchema,
  draftResponseSchema,
  draftListResponseSchema,
} from "./schemas";

export type Principal = z.infer<typeof principalSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type CsrfResponse = z.infer<typeof csrfResponseSchema>;
export type AuthProvider = z.infer<typeof authProvidersResponseSchema>["providers"][number];
export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;
export type AuthUserResponse = z.infer<typeof authUserResponseSchema>;
export type AuthProfileResponse = z.infer<typeof authProfileResponseSchema>;
export type AuthLogoutResponse = z.infer<typeof authLogoutResponseSchema>;
export type AuthOperationResponse = z.infer<typeof authOperationResponseSchema>;
export type AuthToken = z.infer<typeof authTokenSchema>;
export type AuthTokensResponse = z.infer<typeof authTokensResponseSchema>;
export type AuthTokenCreatedResponse = z.infer<typeof authTokenCreatedResponseSchema>;
export type AuthTokenUpdatedResponse = z.infer<typeof authTokenUpdatedResponseSchema>;
export type RegistrationRequestedResponse = z.infer<typeof registrationRequestedResponseSchema>;
export type PasskeyOptionsResponse = z.infer<typeof passkeyOptionsResponseSchema>;

export type WorkflowSubmission = z.infer<typeof workflowSubmissionSchema>;
export type WorkflowSubmissionListResponse = z.infer<typeof workflowSubmissionListResponseSchema>;
export type WorkflowSubmissionResponse = z.infer<typeof workflowSubmissionResponseSchema>;
export type WorkflowSubmissionResult = z.infer<typeof workflowSubmissionResultSchema>;
export type OwnedSubmissionSummary = z.infer<typeof ownedSubmissionSummarySchema>;
export type OwnedSubmissionListResponse = z.infer<typeof ownedSubmissionListResponseSchema>;
export type PublisherDraft = z.infer<typeof publisherDraftSchema>;
export type DraftResponse = z.infer<typeof draftResponseSchema>;
export type DraftListResponse = z.infer<typeof draftListResponseSchema>;

export type Pagination = z.infer<typeof paginationSchema>;
export type Game = z.infer<typeof gameSchema>;
export type GamesResponse = z.infer<typeof gamesResponseSchema>;

export type DiscoveryDocument = z.infer<typeof discoveryDocumentSchema>;
export type DownloadSeriesPoint = z.infer<typeof downloadSeriesPointSchema>;
export type DownloadStats = z.infer<typeof downloadStatsSchema>;
export type GameDownloadStats = z.infer<typeof gameDownloadStatsSchema>;
export type ScoreRecord = z.infer<typeof scoreRecordSchema>;
export type ScoreStats = z.infer<typeof scoreStatsSchema>;
export type RunStats = z.infer<typeof runStatsSchema>;
export type MetricsRun = z.infer<typeof metricsRunSchema>;
export type MetricsSummary = z.infer<typeof metricsSummarySchema>;
export type MetricsRunDetail = z.infer<typeof metricsRunDetailSchema>;
export type UserProfileResponse = z.infer<typeof userProfileResponseSchema>;
export type UserRunsResponse = z.infer<typeof userRunsResponseSchema>;
export type UserRunResponse = z.infer<typeof userRunResponseSchema>;
