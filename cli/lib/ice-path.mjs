/** Classify selected ICE path from RTCPeerConnection stats (receiver-side). */

const PATH_RANK = { relay: 3, srflx: 2, host: 1, unknown: 0 };

function rankType(t) {
  if (t === 'relay') return 'relay';
  if (t === 'srflx' || t === 'prflx') return 'srflx';
  if (t === 'host') return 'host';
  return 'unknown';
}

function pickPath(types) {
  let best = 'unknown';
  for (const t of types) {
    const p = rankType(t);
    if (PATH_RANK[p] > PATH_RANK[best]) best = p;
  }
  return best;
}

/** @param {RTCPeerConnection|null|undefined} pc */
export async function getIcePath(pc) {
  if (!pc || typeof pc.getStats !== 'function') return 'unknown';
  try {
    const stats = await pc.getStats();
    let pairId = null;
    const types = [];

    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        pairId = report.selectedCandidatePairId;
      }
    });
    if (!pairId) {
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && (report.selected || report.nominated)) {
          pairId = report.id;
        }
      });
    }
    if (!pairId) return 'unknown';

    let localId = null;
    let remoteId = null;
    stats.forEach((report) => {
      if (report.id === pairId && report.type === 'candidate-pair') {
        localId = report.localCandidateId;
        remoteId = report.remoteCandidateId;
      }
    });

    for (const id of [localId, remoteId]) {
      if (!id) continue;
      stats.forEach((report) => {
        if (report.id === id && (report.type === 'local-candidate' || report.type === 'remote-candidate')) {
          types.push(report.candidateType);
        }
      });
    }

    return pickPath(types);
  } catch {
    return 'unknown';
  }
}
