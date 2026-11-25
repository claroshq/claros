/**
 * Postgres Store.
 */
import type { Store } from "../types.js";
import type { PgDb } from "./db.js";
import { pgApiSettings } from "./api-settings.js";
import { pgApiIngest } from "./api-ingest.js";
import { pgWorkerContent } from "./worker-content.js";
import { pgWorkerDrain } from "./worker-drain.js";
import { pgApiFlows } from "./api-flows.js";
import { pgWorkerScanStepAdvancement } from "./worker-scan-step-advancement.js";
import { pgApiKb } from "./api-kb.js";
import { pgApiAuth } from "./api-auth.js";
import { pgApiResendWebhook } from "./api-resend-webhook.js";
import { pgWorkerIndex } from "./worker-index.js";
import { pgApiAnalytics } from "./api-analytics.js";
import { pgApiMessages } from "./api-messages.js";
import { pgServerMain } from "./server-main.js";
import { pgWorkerAdvanceMembership } from "./worker-advance-membership.js";
import { pgApiContacts } from "./api-contacts.js";
import { pgApiUnsubscribe } from "./api-unsubscribe.js";
import { pgApiTeam } from "./api-team.js";
import { pgApiSentLog } from "./api-sent-log.js";
import { pgWorkerContextContact } from "./worker-context-contact.js";
import { pgApiSuppressions } from "./api-suppressions.js";
import { pgApiProfile } from "./api-profile.js";
import { pgWorkerContextEvents } from "./worker-context-events.js";
import { pgWorkerContextKb } from "./worker-context-kb.js";
import { pgWorkerContextAssembler } from "./worker-context-assembler.js";
import { pgWorkerEnroll } from "./worker-enroll.js";
import { pgApiIngestion } from "./api-ingestion.js";
import { pgWorkerScanEngagementDepth } from "./worker-scan-engagement-depth.js";
import { pgWorkerScanSegmentEnrollment } from "./worker-scan-segment-enrollment.js";
import { pgWorkerDates } from "./worker-dates.js";
import { pgApiImport } from "./api-import.js";
import { pgWorkerReap } from "./worker-reap.js";
import { pgWorkerContextFlow } from "./worker-context-flow.js";
import { pgApiInvite } from "./api-invite.js";
import { pgWorkerEmbeddingClient } from "./worker-embedding-client.js";
import { pgWorkerScanTimeTransitions } from "./worker-scan-time-transitions.js";
import { pgApiEmailTemplates } from "./api-email-templates.js";
import { pgApiClaim } from "./api-claim.js";
import { pgWorkerEmbedKb } from "./worker-embed-kb.js";
import { pgApiIngestAuth } from "./api-ingest-auth.js";
import { pgApiTemplates } from "./api-templates.js";
import { pgWorkerScanEnrollment } from "./worker-scan-enrollment.js";
import { pgWorkerSnapshotRetentionGrid } from "./worker-snapshot-retention-grid.js";
import { pgWorkerCompile } from "./worker-compile.js";
import { pgApiLibrary } from "./api-library.js";
import { pgWorkerPartitionMaintenance } from "./worker-partition-maintenance.js";
import { pgWorkerTriggerCheck } from "./worker-trigger-check.js";
import { pgWorkerDrainMessage } from "./worker-drain-message.js";
import { pgWorkerTransportResolver } from "./worker-transport-resolver.js";
import { pgWorkerProviderResolver } from "./worker-provider-resolver.js";
import { pgWorkerApprovalsDigest } from "./worker-approvals-digest.js";
import { pgWorkerProcessMessage } from "./worker-process-message.js";
import { pgApiSession } from "./api-session.js";
import { pgWorkerCounterRollover } from "./worker-counter-rollover.js";
import { pgApiEvents } from "./api-events.js";
import { pgApiProducts } from "./api-products.js";
import { pgApiInstance } from "./api-instance.js";
import { pgApiTopics } from "./api-topics.js";
import { pgOps } from "./ops.js";
import { pgApiAdminAuth } from "./api-admin-auth.js";
import { pgWorkerWebhooks } from "./worker-webhooks.js";
import { pgApiConfig } from "./api-config.js";
import { pgApiWebhooks } from "./api-webhooks.js";
import { pgApiBrand } from "./api-brand.js";
import { pgEmailLayouts } from "./email-layouts.js";

export function createPgStore(db: PgDb): Store {
  return {
    dialect: "pg",
    apiSettings: pgApiSettings(db),
    apiIngest: pgApiIngest(db),
    workerContent: pgWorkerContent(db),
    workerDrain: pgWorkerDrain(db),
    apiFlows: pgApiFlows(db),
    workerScanStepAdvancement: pgWorkerScanStepAdvancement(db),
    apiKb: pgApiKb(db),
    apiAuth: pgApiAuth(db),
    apiResendWebhook: pgApiResendWebhook(db),
    workerIndex: pgWorkerIndex(db),
    apiAnalytics: pgApiAnalytics(db),
    apiMessages: pgApiMessages(db),
    serverMain: pgServerMain(db),
    workerAdvanceMembership: pgWorkerAdvanceMembership(db),
    apiContacts: pgApiContacts(db),
    apiUnsubscribe: pgApiUnsubscribe(db),
    apiTeam: pgApiTeam(db),
    apiSentLog: pgApiSentLog(db),
    workerContextContact: pgWorkerContextContact(db),
    apiSuppressions: pgApiSuppressions(db),
    apiProfile: pgApiProfile(db),
    workerContextEvents: pgWorkerContextEvents(db),
    workerContextKb: pgWorkerContextKb(db),
    workerContextAssembler: pgWorkerContextAssembler(db),
    workerEnroll: pgWorkerEnroll(db),
    apiIngestion: pgApiIngestion(db),
    workerScanEngagementDepth: pgWorkerScanEngagementDepth(db),
    workerScanSegmentEnrollment: pgWorkerScanSegmentEnrollment(db),
    workerDates: pgWorkerDates(db),
    apiImport: pgApiImport(db),
    workerReap: pgWorkerReap(db),
    workerContextFlow: pgWorkerContextFlow(db),
    apiInvite: pgApiInvite(db),
    workerEmbeddingClient: pgWorkerEmbeddingClient(db),
    workerScanTimeTransitions: pgWorkerScanTimeTransitions(db),
    apiEmailTemplates: pgApiEmailTemplates(db),
    apiClaim: pgApiClaim(db),
    workerEmbedKb: pgWorkerEmbedKb(db),
    apiIngestAuth: pgApiIngestAuth(db),
    apiTemplates: pgApiTemplates(db),
    workerScanEnrollment: pgWorkerScanEnrollment(db),
    workerSnapshotRetentionGrid: pgWorkerSnapshotRetentionGrid(db),
    workerCompile: pgWorkerCompile(db),
    apiLibrary: pgApiLibrary(db),
    workerPartitionMaintenance: pgWorkerPartitionMaintenance(db),
    workerTriggerCheck: pgWorkerTriggerCheck(db),
    workerDrainMessage: pgWorkerDrainMessage(db),
    workerTransportResolver: pgWorkerTransportResolver(db),
    workerProviderResolver: pgWorkerProviderResolver(db),
    workerApprovalsDigest: pgWorkerApprovalsDigest(db),
    workerProcessMessage: pgWorkerProcessMessage(db),
    apiSession: pgApiSession(db),
    workerCounterRollover: pgWorkerCounterRollover(db),
    apiEvents: pgApiEvents(db),
    apiProducts: pgApiProducts(db),
    apiInstance: pgApiInstance(db),
    apiTopics: pgApiTopics(db),
    ops: pgOps(db),
    apiAdminAuth: pgApiAdminAuth(db),
    workerWebhooks: pgWorkerWebhooks(db),
    apiConfig: pgApiConfig(db),
    apiWebhooks: pgApiWebhooks(db),
    apiBrand: pgApiBrand(db),
    emailLayouts: pgEmailLayouts(db),
  };
}
