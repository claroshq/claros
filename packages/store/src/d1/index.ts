/**
 * SQLite / Cloudflare D1 Store.
 */
import type { Store } from "../types.js";
import type { D1Db } from "./db.js";
import { d1ApiAnalytics } from "./api-analytics.js";
import { d1ApiAuth } from "./api-auth.js";
import { d1ApiClaim } from "./api-claim.js";
import { d1ApiContacts } from "./api-contacts.js";
import { d1ApiEmailTemplates } from "./api-email-templates.js";
import { d1ApiEvents } from "./api-events.js";
import { d1ApiFlows } from "./api-flows.js";
import { d1ApiIngestAuth } from "./api-ingest-auth.js";
import { d1ApiIngest } from "./api-ingest.js";
import { d1ApiIngestion } from "./api-ingestion.js";
import { d1ApiInstance } from "./api-instance.js";
import { d1ApiInvite } from "./api-invite.js";
import { d1ApiKb } from "./api-kb.js";
import { d1ApiLibrary } from "./api-library.js";
import { d1ApiMessages } from "./api-messages.js";
import { d1ApiProducts } from "./api-products.js";
import { d1ApiProfile } from "./api-profile.js";
import { d1ApiResendWebhook } from "./api-resend-webhook.js";
import { d1ApiSentLog } from "./api-sent-log.js";
import { d1ApiSession } from "./api-session.js";
import { d1ApiSettings } from "./api-settings.js";
import { d1ApiSuppressions } from "./api-suppressions.js";
import { d1ApiTeam } from "./api-team.js";
import { d1ApiTemplates } from "./api-templates.js";
import { d1ApiUnsubscribe } from "./api-unsubscribe.js";
import { d1ServerMain } from "./server-main.js";
import { d1WorkerAdvanceMembership } from "./worker-advance-membership.js";
import { d1WorkerCompile } from "./worker-compile.js";
import { d1WorkerContent } from "./worker-content.js";
import { d1WorkerContextAssembler } from "./worker-context-assembler.js";
import { d1WorkerContextContact } from "./worker-context-contact.js";
import { d1WorkerContextEvents } from "./worker-context-events.js";
import { d1WorkerContextFlow } from "./worker-context-flow.js";
import { d1WorkerContextKb } from "./worker-context-kb.js";
import { d1WorkerCounterRollover } from "./worker-counter-rollover.js";
import { d1WorkerDrainMessage } from "./worker-drain-message.js";
import { d1WorkerDrain } from "./worker-drain.js";
import { d1WorkerEmbedKb } from "./worker-embed-kb.js";
import { d1WorkerEmbeddingClient } from "./worker-embedding-client.js";
import { d1WorkerEnroll } from "./worker-enroll.js";
import { d1WorkerIndex } from "./worker-index.js";
import { d1WorkerPartitionMaintenance } from "./worker-partition-maintenance.js";
import { d1WorkerProcessMessage } from "./worker-process-message.js";
import { d1WorkerProviderResolver } from "./worker-provider-resolver.js";
import { d1WorkerReap } from "./worker-reap.js";
import { d1WorkerScanEngagementDepth } from "./worker-scan-engagement-depth.js";
import { d1WorkerScanEnrollment } from "./worker-scan-enrollment.js";
import { d1WorkerScanSegmentEnrollment } from "./worker-scan-segment-enrollment.js";
import { d1WorkerDates } from "./worker-dates.js";
import { d1ApiImport } from "./api-import.js";
import { d1WorkerScanStepAdvancement } from "./worker-scan-step-advancement.js";
import { d1WorkerScanTimeTransitions } from "./worker-scan-time-transitions.js";
import { d1WorkerSnapshotRetentionGrid } from "./worker-snapshot-retention-grid.js";
import { d1WorkerTransportResolver } from "./worker-transport-resolver.js";
import { d1WorkerTriggerCheck } from "./worker-trigger-check.js";
import { d1ApiTopics } from "./api-topics.js";
import { d1Ops } from "./ops.js";
import { d1ApiAdminAuth } from "./api-admin-auth.js";
import { d1WorkerWebhooks } from "./worker-webhooks.js";
import { d1ApiConfig } from "./api-config.js";

export function createD1Store(db: D1Db): Store {
  return {
    dialect: "sqlite",
    apiAnalytics: d1ApiAnalytics(db),
    apiAuth: d1ApiAuth(db),
    apiClaim: d1ApiClaim(db),
    apiContacts: d1ApiContacts(db),
    apiEmailTemplates: d1ApiEmailTemplates(db),
    apiEvents: d1ApiEvents(db),
    apiFlows: d1ApiFlows(db),
    apiIngestAuth: d1ApiIngestAuth(db),
    apiIngest: d1ApiIngest(db),
    apiIngestion: d1ApiIngestion(db),
    apiInstance: d1ApiInstance(db),
    apiInvite: d1ApiInvite(db),
    apiKb: d1ApiKb(db),
    apiLibrary: d1ApiLibrary(db),
    apiMessages: d1ApiMessages(db),
    apiProducts: d1ApiProducts(db),
    apiProfile: d1ApiProfile(db),
    apiResendWebhook: d1ApiResendWebhook(db),
    apiSentLog: d1ApiSentLog(db),
    apiSession: d1ApiSession(db),
    apiSettings: d1ApiSettings(db),
    apiSuppressions: d1ApiSuppressions(db),
    apiTeam: d1ApiTeam(db),
    apiTemplates: d1ApiTemplates(db),
    apiUnsubscribe: d1ApiUnsubscribe(db),
    serverMain: d1ServerMain(db),
    workerAdvanceMembership: d1WorkerAdvanceMembership(db),
    workerCompile: d1WorkerCompile(db),
    workerContent: d1WorkerContent(db),
    workerContextAssembler: d1WorkerContextAssembler(db),
    workerContextContact: d1WorkerContextContact(db),
    workerContextEvents: d1WorkerContextEvents(db),
    workerContextFlow: d1WorkerContextFlow(db),
    workerContextKb: d1WorkerContextKb(db),
    workerCounterRollover: d1WorkerCounterRollover(db),
    workerDrainMessage: d1WorkerDrainMessage(db),
    workerDrain: d1WorkerDrain(db),
    workerEmbedKb: d1WorkerEmbedKb(db),
    workerEmbeddingClient: d1WorkerEmbeddingClient(db),
    workerEnroll: d1WorkerEnroll(db),
    workerIndex: d1WorkerIndex(db),
    workerPartitionMaintenance: d1WorkerPartitionMaintenance(db),
    workerProcessMessage: d1WorkerProcessMessage(db),
    workerProviderResolver: d1WorkerProviderResolver(db),
    workerReap: d1WorkerReap(db),
    workerScanEngagementDepth: d1WorkerScanEngagementDepth(db),
    workerScanEnrollment: d1WorkerScanEnrollment(db),
    workerScanSegmentEnrollment: d1WorkerScanSegmentEnrollment(db),
    workerDates: d1WorkerDates(db),
    apiImport: d1ApiImport(db),
    workerScanStepAdvancement: d1WorkerScanStepAdvancement(db),
    workerScanTimeTransitions: d1WorkerScanTimeTransitions(db),
    workerSnapshotRetentionGrid: d1WorkerSnapshotRetentionGrid(db),
    workerTransportResolver: d1WorkerTransportResolver(db),
    workerTriggerCheck: d1WorkerTriggerCheck(db),
    apiTopics: d1ApiTopics(db),
    ops: d1Ops(db),
    apiAdminAuth: d1ApiAdminAuth(db),
    workerWebhooks: d1WorkerWebhooks(db),
    apiConfig: d1ApiConfig(db),
  };
}
