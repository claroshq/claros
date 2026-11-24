/**
 * Pure comparison functions for `claros doctor`.
 *
 * Extracted so they can be unit-tested independently of the CLI runtime
 * (which uses top-level await and cannot be imported directly by tests).
 */

/**
 * Result shape for a single secret key from either the local env or the
 * container's /v1/diagnostics response.
 *
 * @typedef {Object} KeyInfo
 * @property {boolean}     present
 * @property {number|null} byteLength  - decoded byte count; null if absent or decode error
 * @property {string|null} fingerprint - first 8 hex chars of SHA-256 of decoded bytes
 * @property {string|null} decodeError - non-null when present but could not be decoded
 */

/**
 * Compare the local HEAD commit SHA against the deployed commit returned by
 * GET /version.
 *
 * Returns a verdict object:
 *   { verdict: "OK" | "MISMATCH" | "NO_SHA" | "UNREACHABLE" | "GIT_UNAVAILABLE" | "UNKNOWN" }
 *
 * Inputs:
 *   localHead     - string from git rev-parse HEAD, "UNKNOWN" when git failed
 *   deployedCommit - string from /version.commit, null when /version was unreachable
 *
 * Edge cases:
 *   deployedCommit === null           -> UNREACHABLE  (fetch failed or URL refused)
 *   deployedCommit === "unknown"      -> NO_SHA       (image built without --build-arg)
 *   localHead === "UNKNOWN" && deployed is a real sha -> GIT_UNAVAILABLE
 *   localHead === deployedCommit      -> OK
 *   localHead !== deployedCommit      -> MISMATCH
 */
export function compareCommits(localHead, deployedCommit) {
  if (deployedCommit === null) {
    return { verdict: "UNREACHABLE" };
  }
  if (deployedCommit === "unknown") {
    return { verdict: "NO_SHA" };
  }
  if (localHead === "UNKNOWN") {
    return { verdict: "GIT_UNAVAILABLE", deployedCommit };
  }
  if (localHead === deployedCommit) {
    return { verdict: "OK" };
  }
  return { verdict: "MISMATCH", localHead, deployedCommit };
}

/**
 * Compare a local key fingerprint against a container key fingerprint.
 *
 * Returns a verdict object:
 *   { verdict: "OK" | "MISMATCH" | "LOCAL_ABSENT" | "CONTAINER_ABSENT"
 *             | "LOCAL_DECODE_ERROR" | "CONTAINER_DECODE_ERROR"
 *             | "SKIPPED" | "UNKNOWN" }
 *
 * Inputs:
 *   localInfo     - KeyInfo from the operator's local env
 *   containerInfo - KeyInfo from /v1/diagnostics, or null if endpoint was not reached
 *
 * Edge cases treated as distinct (never silently collapsed into OK or MISMATCH):
 *   localInfo.present === false        -> LOCAL_ABSENT
 *   localInfo.decodeError              -> LOCAL_DECODE_ERROR
 *   containerInfo === null             -> SKIPPED  (endpoint unreachable or no token)
 *   containerInfo.present === false    -> CONTAINER_ABSENT
 *   containerInfo.decodeError          -> CONTAINER_DECODE_ERROR
 *   fingerprints equal (string ===)    -> OK
 *   fingerprints unequal               -> MISMATCH
 */
export function compareKeyFingerprints(localInfo, containerInfo) {
  // Local side
  if (!localInfo.present) {
    return { verdict: "LOCAL_ABSENT" };
  }
  if (localInfo.decodeError) {
    return { verdict: "LOCAL_DECODE_ERROR", error: localInfo.decodeError };
  }

  // Container side
  if (containerInfo === null) {
    return { verdict: "SKIPPED" };
  }
  if (!containerInfo.present) {
    return { verdict: "CONTAINER_ABSENT" };
  }
  if (containerInfo.decodeError) {
    return { verdict: "CONTAINER_DECODE_ERROR", error: containerInfo.decodeError };
  }

  // Both sides have decoded fingerprints: strict string equality
  if (localInfo.fingerprint === containerInfo.fingerprint) {
    return { verdict: "OK" };
  }
  return {
    verdict: "MISMATCH",
    localFingerprint:     localInfo.fingerprint,
    containerFingerprint: containerInfo.fingerprint,
  };
}

/**
 * Format a commit comparison verdict into output lines.
 * Returns an array of strings (never mutates input).
 */
export function formatCommitVerdict(result) {
  switch (result.verdict) {
    case "OK":
      return ["", "    PROVENANCE:  OK - local HEAD matches deployed commit"];
    case "MISMATCH":
      return [
        "",
        "    PROVENANCE:  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
        "                 !! MISMATCH: deployed commit differs from local HEAD !!",
        "                 !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
        `                 local:    ${result.localHead}`,
        `                 deployed: ${result.deployedCommit}`,
      ];
    case "NO_SHA":
      return ["", "    PROVENANCE:  *** DEPLOYED IMAGE HAS NO COMMIT SHA - was it built without --build-arg COMMIT_SHA? ***"];
    case "GIT_UNAVAILABLE":
      return ["", `    PROVENANCE:  deployed commit is ${result.deployedCommit} (git not available here; compare against your local checkout)`];
    case "UNREACHABLE":
      return [];  // already printed by the fetch error handler
    default:
      return [];
  }
}

/**
 * Format a key comparison verdict into output lines for printKeyComparison.
 * Returns an array of strings.
 */
export function formatKeyVerdict(name, localInfo, containerInfo, skipReason) {
  const lines = [`    ${name}:`];

  // --- Local side ---
  if (!localInfo.present) {
    lines.push(`      LOCAL:     ABSENT`);
  } else if (localInfo.decodeError) {
    lines.push(`      LOCAL:     present but decode failed - ${localInfo.decodeError}`);
  } else {
    lines.push(`      LOCAL:     present  ${localInfo.byteLength} bytes  fingerprint=${localInfo.fingerprint}...`);
  }

  // --- Container side + STATUS ---
  const result = compareKeyFingerprints(localInfo, containerInfo);

  switch (result.verdict) {
    case "SKIPPED":
      lines.push(`      CONTAINER: ${skipReason ?? "unavailable"}`);
      break;
    case "LOCAL_ABSENT":
      if (containerInfo === null) {
        lines.push(`      CONTAINER: ${skipReason ?? "unavailable"}`);
      } else if (!containerInfo.present) {
        lines.push(`      CONTAINER: ABSENT`);
        lines.push(`      STATUS:    both absent`);
      } else {
        lines.push(`      CONTAINER: present  ${containerInfo.byteLength} bytes  fingerprint=${containerInfo.fingerprint}...`);
        lines.push(`      STATUS:    !! MISMATCH: key absent locally but present in container !!`);
      }
      break;
    case "LOCAL_DECODE_ERROR":
      if (containerInfo !== null && containerInfo.present && !containerInfo.decodeError) {
        lines.push(`      CONTAINER: present  ${containerInfo.byteLength} bytes  fingerprint=${containerInfo.fingerprint}...`);
      } else if (containerInfo === null) {
        lines.push(`      CONTAINER: ${skipReason ?? "unavailable"}`);
      }
      lines.push(`      STATUS:    UNKNOWN (local decode error prevents comparison)`);
      break;
    case "CONTAINER_ABSENT":
      lines.push(`      CONTAINER: ABSENT`);
      lines.push(`      STATUS:    !! MISMATCH: key present locally but absent in container !!`);
      break;
    case "CONTAINER_DECODE_ERROR":
      lines.push(`      CONTAINER: present but decode failed - ${result.error}`);
      lines.push(`      STATUS:    UNKNOWN (container decode error prevents comparison)`);
      break;
    case "OK":
      lines.push(`      CONTAINER: present  ${containerInfo.byteLength} bytes  fingerprint=${containerInfo.fingerprint}...`);
      lines.push(`      STATUS:    OK - fingerprints match`);
      break;
    case "MISMATCH":
      lines.push(`      CONTAINER: present  ${containerInfo.byteLength} bytes  fingerprint=${containerInfo.fingerprint}...`);
      lines.push(`      STATUS:    !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
      lines.push(`                 !! MISMATCH: container has a different ${name} than local !!`);
      lines.push(`                 !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
      lines.push(`                 This means the container was not restarted after the`);
      lines.push(`                 secret was rotated, or the wrong value is deployed.`);
      break;
  }

  return lines;
}
